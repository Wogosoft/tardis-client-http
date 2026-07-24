import { Context, Effect, Layer, FileSystem } from "effect";

export class FileService extends Context.Service<FileService>()("FileService", {
    make: Effect.gen(function*() { 
        const fs = yield* FileSystem.FileSystem;
        return {
            makeFileHandle: Effect.fn(function*(filePath: string){
                return {
                    write: Effect.fn(function*(data: string){
                        return yield* fs.writeFileString(filePath, data, { flag: "a+" })
                    })
                }
            })
        }
    })
}) {
    static readonly layer = Layer.effect(this, this.make)
}