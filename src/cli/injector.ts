/**
 * type-injector
 *
 * Scans a TypeScript/Deno project for `const` declarations that don't have
 * an explicit type annotation, uses the TypeScript compiler API to infer
 * their type (including types coming from external dependencies), and
 * prints the results to the console.
 *
 * Usage:
 *   deno run --allow-read --allow-env main.ts [projectDir]
 */

import ts from "typescript";
import { basename, dirname, join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_EXCLUDES = new Set([
  "node_modules",
  ".git",
  ".deno",
  "dist",
  "build",
  "coverage",
  ".vscode",
]);

/** Recursively collect all .ts/.tsx source files under `dir`. */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      if (DEFAULT_EXCLUDES.has(entry.name)) continue;

      const fullPath = join(current, entry.name);

      if (entry.isDirectory) {
        await walk(fullPath);
      } else if (
        entry.isFile &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".d.ts")
      ) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results;
}

interface ConstAnnotation {
  /** Absolute source file position right after the declaration's name/pattern, where the type annotation should be inserted. */
  insertPos: number;
  /** The declared name or destructuring pattern text, e.g. "count" or "{ a, b }". */
  displayName: string;
  inferredType: string;
  line: number;
  column: number;
  /** True if `inferredType` is a safe fallback (e.g. "unknown") because the real inferred type was unusable. */
  isFallback?: boolean;
}

/**
 * Recursively checks whether `type` (or any of its alias/reference type
 * arguments) is or contains a bare, unresolved type parameter — a symptom
 * of an upstream type error (e.g. a broken generic instantiation caused by
 * a dependency version mismatch) rather than a real, nameable type. Such a
 * type parameter has no matching declaration in scope at the annotation
 * site, so printing it verbatim would produce invalid TypeScript.
 */
function containsUnresolvedTypeParameter(type: ts.Type): boolean {
  const seen = new Set<ts.Type>();

  function scan(t: ts.Type, depth: number): boolean {
    if (depth > 8 || seen.has(t)) return false;
    seen.add(t);

    if (t.flags & ts.TypeFlags.TypeParameter) return true;

    if (t.aliasTypeArguments?.some((a) => scan(a, depth + 1))) return true;

    const typeArguments = (t as ts.TypeReference).typeArguments;
    if (typeArguments?.some((a) => scan(a, depth + 1))) return true;

    if (t.flags & ts.TypeFlags.UnionOrIntersection) {
      if ((t as ts.UnionOrIntersectionType).types.some((p) => scan(p, depth + 1))) {
        return true;
      }
    }

    return false;
  }

  return scan(type, 0);
}

function findUntypedConsts(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ConstAnnotation[] {
  const found: ConstAnnotation[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isVariableStatement(node) &&
      (node.declarationList.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const declaration of node.declarationList.declarations) {
        // Skip declarations that already have an explicit type annotation.
        if (declaration.type) continue;
        // Skip ambient declarations with no initializer (nothing to infer from).
        if (!declaration.initializer) continue;

        const nameNode = declaration.name;
        // A single type annotation applies to the whole name/pattern (TS
        // doesn't allow annotating individual destructured bindings), so we
        // infer and annotate at that granularity.
        const type = checker.getTypeAtLocation(nameNode);
        const isFallback = containsUnresolvedTypeParameter(type);
        // If the real inferred type leaks a bare, out-of-scope type
        // parameter (usually caused by a type error further up the
        // dependency chain), printing it verbatim would produce invalid
        // TypeScript. Fall back to `unknown`, a type that is always valid
        // and safe, rather than emitting broken code.
        const inferredType = isFallback
          ? "unknown"
          : checker.typeToString(
            type,
            nameNode,
            ts.TypeFormatFlags.NoTruncation |
              ts.TypeFormatFlags.UseFullyQualifiedType,
          );

        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          nameNode.getStart(sourceFile),
        );

        found.push({
          insertPos: nameNode.getEnd(),
          displayName: nameNode.getText(sourceFile),
          inferredType,
          line: line + 1,
          column: character + 1,
          isFallback,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/** Locates Deno's on-disk module cache directory (DENO_DIR). */
async function getDenoDir(): Promise<string | undefined> {
  const envDir = Deno.env.get("DENO_DIR");
  if (envDir) return resolve(envDir);

  try {
    const command = new Deno.Command("deno", {
      args: ["info"],
      stdout: "piped",
      stderr: "null",
      env: { NO_COLOR: "1" },
    });
    const { stdout } = await command.output();
    const text = new TextDecoder().decode(stdout);
    const match = text.match(/DENO_DIR location:\s*(.+)/);
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Reads and parses a package's package.json, if present. */
function readPackageJson(pkgDir: string): Record<string, unknown> | undefined {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return undefined;
  try {
    return JSON.parse(Deno.readTextFileSync(pkgJsonPath));
  } catch {
    return undefined;
  }
}

/** Resolves the "types" entry point for a cached npm package directory. */
/** Look inside an `exports` map node for a `types`/`typings` condition, recursively. */
function findTypesInExports(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.types === "string") return obj.types;
    if (typeof obj.typings === "string") return obj.typings;
    for (const key of ["import", "require", "default", "node"]) {
      const found = findTypesInExports(obj[key]);
      if (found) return found;
    }
  }
  return undefined;
}

/** Swaps a JS/MJS/CJS extension for its `.d.ts` sibling form. */
function jsPathToDts(p: string): string {
  return p.replace(/\.(m|c)?js$/, ".d.$1ts");
}

/**
 * Finds the `exports` map entry (supporting a single wildcard `*`) matching
 * `key` (e.g. `"."` or `"./Schema"`), returning the matched node and the
 * substring the wildcard captured, if any.
 */
function findExportsEntry(
  exportsMap: Record<string, unknown>,
  key: string,
): { node: unknown; wildcard?: string } | undefined {
  if (key in exportsMap) return { node: exportsMap[key] };
  for (const mapKey of Object.keys(exportsMap)) {
    const starIdx = mapKey.indexOf("*");
    if (starIdx === -1) continue;
    const prefix = mapKey.slice(0, starIdx);
    const suffix = mapKey.slice(starIdx + 1);
    if (
      key.startsWith(prefix) && key.endsWith(suffix) &&
      key.length >= prefix.length + suffix.length
    ) {
      return {
        node: exportsMap[mapKey],
        wildcard: key.slice(prefix.length, key.length - suffix.length),
      };
    }
  }
  return undefined;
}

function resolvePackageTypesEntry(pkgDir: string): string | undefined {
  const pkg = readPackageJson(pkgDir);
  if (!pkg) return undefined;

  const tryCandidate = (rel: string | undefined): string | undefined => {
    if (!rel) return undefined;
    const candidate = join(pkgDir, rel);
    return existsSync(candidate) ? candidate : undefined;
  };

  if (pkg.exports && typeof pkg.exports === "object") {
    const exportsMap = pkg.exports as Record<string, unknown>;
    const root = exportsMap["."] ?? exportsMap;
    const rawTarget = findTypesInExports(root);
    // Prefer the `.d.ts` sibling of the resolved target unless the target
    // is already a declaration file (an explicit `types`/`typings`
    // condition points straight at one; a bare `import`/`default`/`require`
    // condition points at runtime JS that needs the `.d.ts` swap).
    const found = rawTarget
      ? tryCandidate(jsPathToDts(rawTarget)) ?? tryCandidate(rawTarget)
      : undefined;
    if (found) return found;
  }

  const direct = tryCandidate(pkg.types as string | undefined) ??
    tryCandidate(pkg.typings as string | undefined);
  if (direct) return direct;

  // Fall back to the JS main entry, swapping the extension for a .d.ts sibling.
  const main = (pkg.main as string | undefined) ?? "index.js";
  const mainPath = join(pkgDir, main);
  const dtsGuess = jsPathToDts(mainPath);
  if (existsSync(dtsGuess)) return dtsGuess;
  if (existsSync(mainPath)) return mainPath;

  return tryCandidate("index.d.ts");
}

/**
 * Resolves the types entry for a specific subpath import of an npm package
 * (e.g. `subpath = "Schema"` for `effect/Schema`), using the package's
 * `exports` map (including wildcard entries like `"./*": "./dist/*.js"`).
 * Falls back to the package's root types entry when `subpath` is empty, or
 * to a best-effort guess when the `exports` map doesn't cover the subpath.
 */
function resolvePackageTypesEntryForSubpath(
  pkgDir: string,
  subpath: string,
): string | undefined {
  if (!subpath) return resolvePackageTypesEntry(pkgDir);

  const pkg = readPackageJson(pkgDir);
  if (!pkg) return undefined;

  const tryCandidate = (rel: string | undefined): string | undefined => {
    if (!rel) return undefined;
    const candidate = join(pkgDir, rel);
    return existsSync(candidate) ? candidate : undefined;
  };

  if (pkg.exports && typeof pkg.exports === "object") {
    const exportsMap = pkg.exports as Record<string, unknown>;
    const keys = Object.keys(exportsMap);
    const isSubpathMap = keys.every((k) => k === "." || k.startsWith("./"));
    if (isSubpathMap) {
      const entry = findExportsEntry(exportsMap, "./" + subpath);
      if (entry) {
        const typesTarget = findTypesInExports(entry.node);
        if (typesTarget) {
          const filled = entry.wildcard !== undefined
            ? typesTarget.replace("*", entry.wildcard)
            : typesTarget;
          const found = tryCandidate(jsPathToDts(filled)) ?? tryCandidate(filled);
          if (found) return found;
        }
      }
    }
  }

  // Best-effort fallback: guess a `.d.ts` file directly at the subpath.
  return tryCandidate(`${subpath}.d.ts`) ?? tryCandidate(`dist/${subpath}.d.ts`);
}

/** Strips a JS/TS(.d.ts) extension from a path for extension-agnostic matching. */
function stripKnownExtension(p: string): string {
  return p.replace(/\.d\.(m|c)?ts$/, "").replace(/\.(m|c)?[jt]s$/, "");
}

interface ExportPair {
  key: string;
  target: string;
}

/** Collects every (subpath key, relative target) pair from a package's `exports` map, recursively. */
function collectExportPairs(pkgDir: string): ExportPair[] {
  const pairs: ExportPair[] = [];
  const pkg = readPackageJson(pkgDir);
  const exportsField = pkg?.exports;
  if (!exportsField) return pairs;

  const record = (key: string, node: unknown) => {
    if (typeof node === "string") {
      pairs.push({ key, target: node });
    } else if (node && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) {
        record(key, value);
      }
    }
  };

  if (typeof exportsField === "string") {
    record(".", exportsField);
  } else if (typeof exportsField === "object") {
    const obj = exportsField as Record<string, unknown>;
    const keys = Object.keys(obj);
    const isSubpathMap = keys.every((k) => k === "." || k.startsWith("./"));
    if (isSubpathMap) {
      for (const key of keys) record(key, obj[key]);
    } else {
      record(".", obj);
    }
  }

  return pairs;
}

/**
 * Finds the public export subpath (e.g. "." or "./Schema") that resolves to
 * `absFile` on disk, supporting both literal and wildcard (`"./*"`) export
 * entries. Exact (non-wildcard) matches are always preferred over wildcard
 * matches.
 */
function findExportSubpath(
  pairs: ExportPair[],
  pkgDir: string,
  absFile: string,
): string | undefined {
  const relFile = stripKnownExtension(
    relative(pkgDir, absFile).replace(/\\/g, "/"),
  );

  let wildcardMatch: string | undefined;

  for (const { key, target } of pairs) {
    if (key === "./package.json" || target === null) continue;
    const targetRel = stripKnownExtension(target.replace(/^\.\//, ""));

    if (!targetRel.includes("*") && !key.includes("*")) {
      if (targetRel === relFile) return key;
      continue;
    }

    if (targetRel.includes("*") && key.includes("*")) {
      const starIdx = targetRel.indexOf("*");
      const prefix = targetRel.slice(0, starIdx);
      const suffix = targetRel.slice(starIdx + 1);
      if (
        relFile.startsWith(prefix) && relFile.endsWith(suffix) &&
        relFile.length >= prefix.length + suffix.length
      ) {
        const captured = relFile.slice(
          prefix.length,
          relFile.length - suffix.length,
        );
        wildcardMatch ??= key.replace("*", captured);
      }
    }
  }

  return wildcardMatch;
}


interface DenoModule {
  specifier: string;
  local?: string;
  kind?: string;
  mediaType?: string;
  npmPackage?: string;
  dependencies?: Array<{
    specifier: string;
    npmPackage?: string;
    code?: { specifier: string };
    type?: { specifier: string };
  }>;
}

/** Maps Deno's `mediaType` values to a TypeScript `ScriptKind`. */
function scriptKindForMediaType(mediaType: string | undefined): ts.ScriptKind {
  switch (mediaType) {
    case "JavaScript":
    case "Mjs":
    case "Cjs":
      return ts.ScriptKind.JS;
    case "Jsx":
      return ts.ScriptKind.JSX;
    case "Tsx":
      return ts.ScriptKind.TSX;
    case "Json":
      return ts.ScriptKind.JSON;
    case "TypeScript":
    case "Mts":
    case "Cts":
    case "Dts":
    case "Dmts":
    case "Dcts":
    default:
      return ts.ScriptKind.TS;
  }
}

/** Maps Deno's `mediaType` values to a TypeScript `Extension`. */
function extensionForMediaType(mediaType: string | undefined): ts.Extension {
  switch (mediaType) {
    case "JavaScript":
      return ts.Extension.Js;
    case "Mjs":
      return ts.Extension.Mjs;
    case "Cjs":
      return ts.Extension.Cjs;
    case "Jsx":
      return ts.Extension.Jsx;
    case "Tsx":
      return ts.Extension.Tsx;
    case "Json":
      return ts.Extension.Json;
    case "Mts":
      return ts.Extension.Mts;
    case "Cts":
      return ts.Extension.Cts;
    case "Dts":
      return ts.Extension.Dts;
    case "Dmts":
      return ts.Extension.Dmts;
    case "Dcts":
      return ts.Extension.Dcts;
    case "TypeScript":
    default:
      return ts.Extension.Ts;
  }
}

interface ResolvedTarget {
  fileName: string;
  scriptKind: ts.ScriptKind;
  extension: ts.Extension;
}

interface ExternalResolution {
  /** containingFile (absolute local path) -> raw specifier text -> resolved target */
  importsByFile: Map<string, Map<string, ResolvedTarget>>;
  scriptKinds: Map<string, ts.ScriptKind>;
  /**
   * Given an absolute on-disk path (e.g. one embedded in a
   * `import("/abs/path")` type reference), returns a clean, portable module
   * specifier that can be used in a real static `import` statement —
   * preferring a `jsr:` specifier when one is known, falling back to a
   * normalized `npm:name@version[/subpath]` specifier for npm packages.
   * Returns undefined if no better specifier could be determined.
   */
  resolveSpecifierForPath: (absPath: string) => string | undefined;
}

/**
 * Uses `deno info --json` to resolve every module's import specifiers
 * (relative, npm:, jsr:, https:) to real, on-disk files (source or
 * declaration files) so the TypeScript compiler can infer types that
 * originate from external dependencies, including transitive ones.
 */
async function resolveExternalPaths(
  rootFiles: string[],
): Promise<ExternalResolution> {
  const importsByFile = new Map<string, Map<string, ResolvedTarget>>();
  const scriptKinds = new Map<string, ts.ScriptKind>();

  // Build a single throwaway entry file that imports every root file, so a
  // single `deno info` invocation gives us the full transitive module graph.
  const tempEntry = await Deno.makeTempFile({ suffix: ".ts" });
  const importLines = rootFiles
    .map((f, i) => `import * as _${i} from ${JSON.stringify("file://" + resolve(f))};`)
    .join("\n");
  await Deno.writeTextFile(tempEntry, importLines);

  let graph: { modules: DenoModule[]; redirects?: Record<string, string> };
  try {
    const command = new Deno.Command("deno", {
      args: ["info", "--json", tempEntry],
      stdout: "piped",
      stderr: "null",
      env: { NO_COLOR: "1" },
    });
    const { stdout } = await command.output();
    graph = JSON.parse(new TextDecoder().decode(stdout));
  } catch {
    return {
      importsByFile,
      scriptKinds,
      resolveSpecifierForPath: () => undefined,
    };
  } finally {
    await Deno.remove(tempEntry).catch(() => {});
  }

  const denoDir = await getDenoDir();
  const redirects = graph.redirects ?? {};
  const moduleBySpecifier = new Map<string, DenoModule>();
  for (const mod of graph.modules ?? []) {
    moduleBySpecifier.set(mod.specifier, mod);
    if (mod.local) {
      scriptKinds.set(mod.local, scriptKindForMediaType(mod.mediaType));
    }
  }

  /** Follows the redirects chain to the final resolved specifier. */
  const resolveRedirect = (specifier: string): string => {
    const seen = new Set<string>();
    let current = specifier;
    while (redirects[current] && !seen.has(current)) {
      seen.add(current);
      current = redirects[current];
    }
    return current;
  };

  /**
   * Extracts the subpath portion of an npm specifier (e.g. `"Schema"` from
   * `"npm:/effect@beta/Schema"`, or `""` for the package root as in
   * `"npm:effect@beta"`).
   */
  const extractNpmSubpath = (specifierText: string, name: string): string => {
    const stripped = specifierText.replace(/^npm:\/?/, "");
    const prefix = `${name}@`;
    if (!stripped.startsWith(prefix)) return "";
    const afterVersion = stripped.slice(prefix.length);
    const slashIdx = afterVersion.indexOf("/");
    if (slashIdx === -1) return "";
    return afterVersion.slice(slashIdx + 1);
  };

  /** Resolves a single dependency entry to an on-disk target, if possible. */
  const resolveDependency = (
    dep: NonNullable<DenoModule["dependencies"]>[number],
  ): ResolvedTarget | undefined => {
    const rawResolved = dep.code?.specifier ?? dep.type?.specifier;
    const resolvedSpecifier = rawResolved ? resolveRedirect(rawResolved) : undefined;
    const resolvedModule = resolvedSpecifier
      ? moduleBySpecifier.get(resolvedSpecifier)
      : undefined;

    // A dependency reached through an import-map alias (e.g. `"effect"` ->
    // `"npm:effect@x.y.z"` in deno.json) doesn't carry `npmPackage` on the
    // dependency entry itself — only the redirected/resolved graph module
    // (a separate flat "kind": "npm" node) does. Check both.
    const npmPackage = dep.npmPackage ?? resolvedModule?.npmPackage;
    if (npmPackage && denoDir) {
      const atIndex = npmPackage.lastIndexOf("@");
      const name = npmPackage.slice(0, atIndex);
      const version = npmPackage.slice(atIndex + 1);
      const pkgDir = join(denoDir, "npm", "registry.npmjs.org", name, version);
      // The subpath may be embedded in the raw dependency specifier (e.g.
      // "npm:/effect@beta/Schema") or only visible on the resolved module's
      // own specifier (e.g. "npm:/effect@4.0.0-beta.100" for a root import
      // reached via an import-map alias like bare "effect").
      const subpath = extractNpmSubpath(dep.specifier, name) ||
        (resolvedModule?.specifier
          ? extractNpmSubpath(resolvedModule.specifier, name)
          : "");
      const typesEntry = resolvePackageTypesEntryForSubpath(pkgDir, subpath);
      if (typesEntry) {
        return {
          fileName: typesEntry,
          scriptKind: ts.ScriptKind.TS,
          extension: ts.Extension.Dts,
        };
      }
    }

    if (resolvedModule?.local) {
      return {
        fileName: resolvedModule.local,
        scriptKind: scriptKindForMediaType(resolvedModule.mediaType),
        extension: extensionForMediaType(resolvedModule.mediaType),
      };
    }
    return undefined;
  };

  for (const mod of graph.modules ?? []) {
    if (!mod.local) continue;
    const specifierMap = new Map<string, ResolvedTarget>();
    for (const dep of mod.dependencies ?? []) {
      const target = resolveDependency(dep);
      if (target) specifierMap.set(dep.specifier, target);
    }
    if (specifierMap.size > 0) {
      importsByFile.set(resolve(mod.local), specifierMap);
    }
  }

  // --- Build a resolver that maps arbitrary on-disk paths (as embedded in
  // TypeScript's `import("/abs/path")` type references) back to a clean,
  // portable specifier, preferring `jsr:` over raw filesystem paths. ---

  /** Finds a `jsr:` redirect key that points at this module's specifier, if any. */
  const findJsrAlias = (mod: DenoModule): string | undefined => {
    for (const key of Object.keys(redirects)) {
      if (key.startsWith("jsr:") && redirects[key] === mod.specifier) return key;
    }
    return undefined;
  };

  const preferredByLocal = new Map<string, string>();
  for (const mod of graph.modules ?? []) {
    if (!mod.local) continue;
    const localPath = resolve(mod.local);
    const jsrAlias = findJsrAlias(mod);
    if (jsrAlias) {
      preferredByLocal.set(localPath, jsrAlias);
    } else if (
      mod.specifier.startsWith("https://") ||
      mod.specifier.startsWith("http://")
    ) {
      preferredByLocal.set(localPath, mod.specifier);
    }
  }

  const npmExportPairsCache = new Map<string, ExportPair[]>();

  /** Maps an absolute file inside an npm package's cache dir to a `npm:` specifier. */
  const specifierForNpmFile = (
    pkgDir: string,
    name: string,
    version: string,
    absFile: string,
  ): string => {
    let pairs = npmExportPairsCache.get(pkgDir);
    if (!pairs) {
      pairs = collectExportPairs(pkgDir);
      npmExportPairsCache.set(pkgDir, pairs);
    }

    const key = findExportSubpath(pairs, pkgDir, absFile);
    if (key !== undefined) {
      const subpath = key === "." ? "" : "/" + key.replace(/^\.\//, "");
      return `npm:${name}@${version}${subpath}`;
    }

    // Best-effort fallback: use the file's path relative to the package
    // root (minus its extension) as the subpath.
    const rel = stripKnownExtension(
      relative(pkgDir, absFile).replace(/\\/g, "/"),
    );
    return `npm:${name}@${version}/${rel}`;
  };

  const npmCacheRoot = denoDir
    ? resolve(join(denoDir, "npm", "registry.npmjs.org"))
    : undefined;

  const resolveSpecifierForPath = (absPathRaw: string): string | undefined => {
    const absPath = resolve(absPathRaw);

    const direct = preferredByLocal.get(absPath);
    if (direct) return direct;

    if (npmCacheRoot && absPath.startsWith(npmCacheRoot + "/")) {
      const rest = absPath.slice(npmCacheRoot.length + 1);
      const segments = rest.split("/");
      let name: string;
      let version: string;
      if (segments[0]?.startsWith("@")) {
        name = `${segments[0]}/${segments[1]}`;
        version = segments[2];
      } else {
        name = segments[0];
        version = segments[1];
      }
      if (name && version) {
        const pkgDir = join(npmCacheRoot, ...name.split("/"), version);
        return specifierForNpmFile(pkgDir, name, version, absPath);
      }
    }

    return undefined;
  };

  return { importsByFile, scriptKinds, resolveSpecifierForPath };
}

async function createProgram(
  rootFiles: string[],
): Promise<{ program: ts.Program; resolveSpecifierForPath: (absPath: string) => string | undefined }> {
  const { importsByFile, scriptKinds, resolveSpecifierForPath } =
    await resolveExternalPaths(rootFiles);

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    isolatedModules: true,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
  };

  const host = ts.createCompilerHost(compilerOptions, true);

  // Force the correct ScriptKind for cached remote files, which have no
  // recognizable file extension (they're named by content hash on disk).
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const forcedKind = scriptKinds.get(resolve(fileName));
    if (forcedKind !== undefined) {
      const text = host.readFile(fileName);
      if (text === undefined) {
        onError?.(`Could not read file '${fileName}'.`);
        return undefined;
      }
      return ts.createSourceFile(
        fileName,
        text,
        languageVersionOrOptions,
        true,
        forcedKind,
      );
    }
    return originalGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    );
  };

  // Resolve each import relative to the *specific file* that imports it,
  // using Deno's module graph. This correctly handles cached remote files
  // that use relative imports amongst themselves (their on-disk names are
  // content hashes, unrelated to their logical module paths).
  host.resolveModuleNames = (moduleNames, containingFile) => {
    const specifierMap = importsByFile.get(resolve(containingFile));
    return moduleNames.map((name) => {
      const target = specifierMap?.get(name);
      if (target) {
        return {
          resolvedFileName: target.fileName,
          extension: target.extension,
          isExternalLibraryImport: true,
        } satisfies ts.ResolvedModuleFull;
      }
      // Fall back to normal (relative/node) resolution for anything not
      // covered by the Deno module graph.
      const result = ts.resolveModuleName(
        name,
        containingFile,
        compilerOptions,
        host,
      );
      return result.resolvedModule;
    });
  };

  return {
    program: ts.createProgram({
      rootNames: rootFiles,
      options: compilerOptions,
      host,
    }),
    resolveSpecifierForPath,
  };
}

/** Finds the character offset right after the last top-level import declaration (0 if none). */
function findImportInsertPos(sourceFile: ts.SourceFile): number {
  let pos = 0;
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      pos = stmt.getEnd();
    } else {
      break;
    }
  }
  return pos;
}

/** Derives a readable, unique namespace-import identifier for a module specifier. */
function generateAlias(specifier: string, used: Set<string>): string {
  let stripped = specifier.replace(/^(jsr:|npm:|https?:\/\/)/, "");
  const parts = stripped.split("/").filter(Boolean);
  let base = parts[parts.length - 1] ?? "Module";
  // Strip a trailing "@version" suffix (e.g. "effect@4.0.0-beta.19" -> "effect").
  base = base.replace(/@[^/]+$/, "");
  if (!base && parts.length > 1) {
    base = parts[parts.length - 2].replace(/@[^/]+$/, "");
  }
  base = base.replace(/[^A-Za-z0-9_$]/g, "_") || "Module";
  if (/^[0-9]/.test(base)) base = "_" + base;
  base = base.charAt(0).toUpperCase() + base.slice(1);

  let alias = base;
  let counter = 2;
  while (used.has(alias)) {
    alias = `${base}${counter++}`;
  }
  used.add(alias);
  return alias;
}

const IMPORT_TYPE_RE = /import\("([^"]+)"\)/g;

/** Collects every top-level identifier bound by this file's import declarations. */
function collectExistingImportNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  for (const stmt of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(stmt)) {
      names.add(stmt.name.text);
      continue;
    }
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;

    const clause = stmt.importClause;
    if (clause.name) names.add(clause.name.text);

    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      names.add(bindings.name.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.add(el.name.text);
    }
  }

  return names;
}

/**
 * Rewrites inline `import("/abs/path")` type references found in this
 * file's annotations into aliases backed by real static imports, preferring
 * `jsr:`/`npm:` specifiers over raw filesystem paths. Mutates the
 * annotations' `inferredType` in place and returns the specifier -> alias
 * pairs that need a static import line at the top of the file.
 */
function extractStaticImports(
  sourceFile: ts.SourceFile,
  annotations: ConstAnnotation[],
  resolveSpecifierForPath: (absPath: string) => string | undefined,
): Array<{ specifier: string; alias: string }> {
  const aliasBySpecifier = new Map<string, string>();
  const usedAliases = collectExistingImportNames(sourceFile);

  for (const annotation of annotations) {
    annotation.inferredType = annotation.inferredType.replace(
      IMPORT_TYPE_RE,
      (fullMatch, path: string) => {
        const specifier = resolveSpecifierForPath(path);
        if (!specifier) return fullMatch; // leave inline import(...) as-is

        let alias = aliasBySpecifier.get(specifier);
        if (!alias) {
          alias = generateAlias(specifier, usedAliases);
          aliasBySpecifier.set(specifier, alias);
        }
        return alias;
      },
    );
  }

  return [...aliasBySpecifier.entries()].map(([specifier, alias]) => ({
    specifier,
    alias,
  }));
}

type Mode = "overwrite" | "debug";

/**
 * Parses CLI args: a positional path, an optional --mode overwrite|debug
 * (defaults to overwrite), and an optional --out-dir for writing edited
 * files to a separate location instead of overwriting the originals.
 */
function parseArgs(
  args: string[],
): { path: string; mode: Mode; outDir?: string } {
  let mode: Mode = "overwrite";
  let outDir: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--mode" || arg === "-m") {
      const rawMode = args[++i];
      if (rawMode !== "overwrite" && rawMode !== "debug") {
        console.error(
          `Error: invalid --mode "${rawMode}" (expected "overwrite" or "debug")`,
        );
        Deno.exit(1);
      }
      mode = rawMode;
    } else if (arg.startsWith("--mode=")) {
      const rawMode = arg.slice("--mode=".length);
      if (rawMode !== "overwrite" && rawMode !== "debug") {
        console.error(
          `Error: invalid --mode "${rawMode}" (expected "overwrite" or "debug")`,
        );
        Deno.exit(1);
      }
      mode = rawMode;
    } else if (arg === "--out-dir" || arg === "-o") {
      outDir = args[++i];
    } else if (arg.startsWith("--out-dir=")) {
      outDir = arg.slice("--out-dir=".length);
    } else {
      positional.push(arg);
    }
  }

  return { path: positional[0] ?? ".", mode, outDir };
}

async function main() {
  const { path: rawPath, mode, outDir } = parseArgs(Deno.args);
  const inputPath = resolve(rawPath);

  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(inputPath);
  } catch {
    console.error(`Error: path not found: ${inputPath}`);
    Deno.exit(1);
  }

  const isSingleFile = !stat!.isDirectory;
  const projectDir = isSingleFile ? dirname(inputPath) : inputPath;

  console.log(
    `Scanning ${inputPath} for untyped const declarations (mode: ${mode})...\n`,
  );

  const files = isSingleFile
    ? [inputPath]
    : await collectSourceFiles(projectDir);
  if (files.length === 0) {
    console.log("No TypeScript files found.");
    return;
  }

  const { program, resolveSpecifierForPath } = await createProgram(files);
  const checker = program.getTypeChecker();

  const fileSet = new Set(files.map((f) => resolve(f)));

  interface FileAnnotations {
    sourceFile: ts.SourceFile;
    annotations: ConstAnnotation[];
  }

  const fileAnnotationsList: FileAnnotations[] = [];
  let totalFound = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!fileSet.has(resolve(sourceFile.fileName))) continue; // skip lib/deps

    const annotations = findUntypedConsts(sourceFile, checker);
    if (annotations.length === 0) continue;

    totalFound += annotations.length;
    fileAnnotationsList.push({ sourceFile, annotations });
  }

  if (totalFound === 0) {
    console.log("No untyped const declarations found.");
    return;
  }

  for (const { sourceFile, annotations } of fileAnnotationsList) {
    const relPath = relative(projectDir, sourceFile.fileName);
    const originalText = sourceFile.getFullText();

    // Rewrite any inline `import("/abs/path")` type references into
    // aliases backed by real static imports (preferring jsr:/npm: over raw
    // filesystem paths), collecting the import lines to add at the top.
    const staticImports = extractStaticImports(
      sourceFile,
      annotations,
      resolveSpecifierForPath,
    );

    // Apply insertions from the end of the file backwards so earlier
    // offsets remain valid as we go.
    type Edit = { pos: number; text: string };
    const edits: Edit[] = annotations.map((a) => ({
      pos: a.insertPos,
      text: `: ${a.inferredType}`,
    }));

    if (staticImports.length > 0) {
      const importBlock = staticImports
        .map((i) => `import * as ${i.alias} from ${JSON.stringify(i.specifier)};`)
        .join("\n");
      const insertPos = findImportInsertPos(sourceFile);
      edits.push({
        pos: insertPos,
        text: insertPos === 0 ? `${importBlock}\n\n` : `\n${importBlock}`,
      });
    }

    const sortedByPos = [...edits].sort((a, b) => b.pos - a.pos);
    let updatedText = originalText;
    for (const e of sortedByPos) {
      updatedText = updatedText.slice(0, e.pos) + e.text +
        updatedText.slice(e.pos);
    }

    if (mode === "debug") {
      console.log(`=== ${relPath} (dry run, not written) ===`);
      console.log(updatedText);
      const fallbacks = annotations.filter((a) => a.isFallback);
      for (const a of fallbacks) {
        console.log(
          `  ⚠ ${a.line}:${a.column} const ${a.displayName}: fell back to "unknown" — the real inferred type was unusable, likely due to an upstream dependency type error.`,
        );
      }
      console.log();
    } else {
      const targetPath = outDir
        ? join(outDir, isSingleFile ? basename(relPath) : relPath)
        : sourceFile.fileName;

      if (outDir) {
        await Deno.mkdir(dirname(targetPath), { recursive: true });
      }
      await Deno.writeTextFile(targetPath, updatedText);

      const displayPath = outDir ? targetPath : relPath;
      console.log(`Wrote ${displayPath}:`);
      for (const a of annotations) {
        const warning = a.isFallback
          ? "  (fallback: real inferred type was unusable, likely due to an upstream dependency type error)"
          : "";
        console.log(`  ${a.line}:${a.column}  const ${a.displayName}: ${a.inferredType}${warning}`);
      }
    }
  }

  const verb = mode === "debug" ? "would be annotated" : "annotated";
  console.log(
    `\n${totalFound} untyped const declaration(s) ${verb} across ${fileAnnotationsList.length} file(s).`,
  );
}

if (import.meta.main) {
  main();
}
