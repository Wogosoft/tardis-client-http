import { execSync } from "node:child_process"
import { ServiceRegistry } from "./plugin/service-registry.ts";
import { join, resolve } from "@std/path";
import { Effect } from "effect";
import { ModuleBuilder } from "./services/module-builder.ts";
import { FileService } from "./services/file-service.ts";
import { ProjectService } from "./services/project-service.ts";
import { NodeRuntime, NodeServices } from "@effect/platform-node"

const projectRoot = resolve(import.meta.dirname ?? ".", "..");
const dataFolder = join(projectRoot, ".data");
Deno.env.set("WOGO_GEN_PROJECT_ROOT", projectRoot)
Deno.env.set("WOGO_GEN_DATA_HOME", dataFolder)
ServiceRegistry.createPersistance()
try {
    execSync("deno run ci:build", { stdio: "inherit" })
    console.log("Finished generating files!")
} catch {
    console.log("Something went wrong with file generation...")
}

const program = Effect.gen(function*(){
    const registry = yield* ServiceRegistry.acquire()
    const builder = new ModuleBuilder();
    const fileService = yield* FileService;
    const project = yield* ProjectService;

    builder.addImport("ServiceMap", "@wogo/tardis-integration-prelude")
    builder.addTypeOnlyImport("Effect","effect")
    builder.addTypeOnlyImport("HttpClient","effect/unstable/http")
    builder.addImport("Layer","effect")
    builder.addImport("Context","effect")
    builder.addTypeOnlyImport("Scope","effect")

    for(const service of registry.services){
        builder.addImport(service.name, service.path);
    }

    builder.printLn("/**")
    builder.printLn(" * Type that maps Service Name to URL")
    builder.printLn(" */")
    builder.scope("export type ServiceURLs = ", builder => {
        for(const service of registry.services){
            builder.printLn(`${service.name}?: string,`)
        }
    })

    builder.printLn("/**")
    builder.printLn(" * Object that maps Service Name to Service Id")
    builder.printLn(" */")
    builder.scope("export const ServiceIds = ", builder => {
        for(const service of registry.services){
            builder.printLn(`${service.name}: "${service.typeName}",`)
        }
    }, " as const")

    builder.printLn("/**")
    builder.printLn(" * Object that maps Service Id to Service Name")
    builder.printLn(" */")
    builder.scope("export const ServiceNames = ", builder => {
        for(const service of registry.services){
            builder.printLn(`"${service.typeName}": "${service.name}",`)
        }
    }, " as const")

    builder.scope("export ", builder => {
        for(const service of registry.services){
            builder.printLn(`${service.name},`)
        }
    })

    
    builder.printLn("/**")
    builder.printLn(" * Object containing all Tardis services")
    builder.printLn(" */")
    builder.scope("export const Tardis = ", builder => {
        for(const service of registry.services){
            builder.printLn(`${service.name},`)
        }
    })

    builder.printLn("/**")
    builder.printLn(" * Layer with all Tardis Layers")
    builder.printLn(" */")
    const tardisLayer = `Layer.Layer<\n`
    + [...registry.services].map(s => `\t| ${s.name}\n`).join("")
    + `, ServiceMap.ServiceError,\n`
    + `HttpClient.HttpClient | ServiceMap.ServiceMap>`
    builder.paren(`export const TardisLayer: ${tardisLayer} = Layer.mergeAll`, builder => {
        for(const service of registry.services){
            builder.printLn(`${service.name}.layer,`)
        }
    })

    builder.printLn("/**")
    builder.printLn(" * Utility to create a ServiceMap from an Effect")
    builder.printLn(" */")
    const t = "<E, R>(effect: Effect.Effect<ServiceURLs, E, R>) =>\n\t\tLayer.Layer<ServiceMap.ServiceMap, E, Exclude<R, Scope.Scope>>"
    builder.printLn(`export const makeServiceMapFromEffect:\n\t${t} =\n\tServiceMap.makeServiceMapFactory<ServiceURLs>(ServiceNames);\n`)

    builder.printLn("/**")
    builder.printLn(" * Helper layer to create a ServiceMap from a Layer")
    builder.printLn(" */")
    builder.printLn("export const RuntimeServiceMap: Context.Service<ServiceURLs, ServiceURLs> = Context.Service<ServiceURLs>(\"RuntimeServiceMap\");")

    const file = yield* fileService.makeFileHandle(yield* project.fromRoot("gen", "mod.ts"))
    yield* file.write(builder.build());
}).pipe(
    Effect.scoped,
    Effect.provide(FileService.layer),
    Effect.provide(ProjectService.layer),
    Effect.provide(NodeServices.layer),
)

NodeRuntime.runMain(program);