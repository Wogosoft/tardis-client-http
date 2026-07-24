import { Config, Context, Effect, Layer, Path } from "effect";

export class ProjectService extends Context.Service<ProjectService>()("ProjectService", {
    make: Effect.gen(function*() {
        const path = yield* Path.Path; 
        const root = yield* Config.string("WOGO_GEN_PROJECT_ROOT");
        return {
            fromRoot: Effect.fn(function*(...paths: string[]){
                return path.join(root, ...paths);
            })
        }
     })
}) {
    static readonly layer = Layer.effect(this, this.make)
}