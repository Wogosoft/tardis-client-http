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
    execSync("deno run build", { stdio: "inherit" })
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

    for(const service of registry.services){
        builder.addImport(service.name, service.path);
    }

    builder.scope("export type ServiceURLs = ", builder => {
        for(const service of registry.services){
            builder.printLn(`${service.name}?: string,`)
        }
    })

    builder.scope("export const ServiceIds = ", builder => {
        for(const service of registry.services){
            builder.printLn(`${service.name}: "${service.typeName}",`)
        }
    }, " as const")

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
    
    builder.addTypeOnlyImport("Effect","effect")
    builder.addTypeOnlyImport("Layer","effect")
    builder.addTypeOnlyImport("Scope","effect")
    const t = "<E, R>(effect: Effect.Effect<ServiceURLs, E, R>) =>\n\t\tLayer.Layer<ServiceMap.ServiceMap, E, Exclude<R, Scope.Scope>>"
    builder.printLn(`export const makeServiceMapFromEffect:\n\t${t} =\n\tServiceMap.makeServiceMapFactory<ServiceURLs>(ServiceNames);`)

    const file = yield* fileService.makeFileHandle(yield* project.fromRoot("gen", "mod.ts"))
    yield* file.write(builder.build());
}).pipe(
    Effect.scoped,
    Effect.provide(FileService.layer),
    Effect.provide(ProjectService.layer),
    Effect.provide(NodeServices.layer),
)

NodeRuntime.runMain(program);