import { Effect, HashMap } from "effect";
import { DescFile } from "@bufbuild/protobuf";
import { Schema } from "effect";
import * as fs from "@std/fs";
import * as path from "@std/path";

export class ServiceMeta extends Schema.Opaque<ServiceMeta>()(
   Schema.Struct({
        path: Schema.String,
        typeName: Schema.String,
        name: Schema.String
   }) 
){}

const ServiceRegistryCodec = Schema.HashMap(Schema.String, ServiceMeta)
    .pipe(
        Schema.toCodecJson,
        Schema.fromJsonString,
    )

export class ServiceRegistry {
    private internal: HashMap.HashMap<string, ServiceMeta>;
    private constructor(initial = HashMap.empty<string, ServiceMeta>()){
        this.internal = initial;
    }

    static fromFiles(files: readonly DescFile[]){
        const registry = new ServiceRegistry();
        for (const file of files){
            file.services.forEach(s => {
                registry.register(s.typeName, {
                    path: "@gen/" + file.name + "_wogo.ts",
                    name: s.name,
                    typeName: s.typeName
                })
            })
        }
        return registry
    }

    static fromPersistance(){
        const data = ServiceRegistry.readDataFromPersistance();
        return new ServiceRegistry(data)
    }

    static acquire(){
        return Effect.acquireRelease(
            Effect.gen(function*(){
                return ServiceRegistry.fromPersistance()
            }),
            Effect.fn(function*(){
                return ServiceRegistry.clearPersistance()
            })
        )
    }

    register(typeName: string, meta: ServiceMeta){
        this.internal = this.internal.pipe(HashMap.set(typeName, meta));
    }

    get services(){
        return this.internal.pipe(HashMap.values)
    }

    getServiceMeta(typeName: string){
        return this.internal.pipe(HashMap.get(typeName))
    }
    
    static getProjectPaths(){
        const projectHome = Deno.env.get("WOGO_GEN_DATA_HOME")
        if( !projectHome ){
            throw Error("Missing variable WOGO_GEN_DATA_HOME");
        }
        const dataFile = path.join(projectHome, "services.json")
        return [dataFile, projectHome] as const;
    }

    save(){
        const decoded = ServiceRegistry.readDataFromPersistance();
        const updated = HashMap.union(this.internal, decoded);
        ServiceRegistry.writeDataToPersistance(updated);
    }

    static createPersistance(){
        const [dataFile, dataHome] = ServiceRegistry.getProjectPaths();
        fs.ensureDirSync(dataHome);
        if(fs.existsSync(dataFile)){
            Deno.removeSync(dataFile)
        }
        fs.ensureFileSync(dataFile)
        Deno.writeTextFileSync(dataFile, Schema.encodeSync(ServiceRegistryCodec)(HashMap.empty()))
        return [dataFile, dataHome]
    }

    static clearPersistance(){
        const [dataFile, dataHome] = ServiceRegistry.getProjectPaths();
        if(fs.existsSync(dataFile)){
            Deno.removeSync(dataFile)
        }
        if(fs.existsSync(dataHome)){
            Deno.removeSync(dataHome)
        }
    }

    private static readDataFromPersistance(){
        const [dataFile] = ServiceRegistry.getProjectPaths();
        const raw = Deno.readFileSync(dataFile)
        const str = new TextDecoder("utf-8").decode(raw);
        return Schema.decodeSync(ServiceRegistryCodec)(str);
    }

    private static writeDataToPersistance(data: HashMap.HashMap<string, ServiceMeta>){
        const [dataFile] = ServiceRegistry.getProjectPaths();
        const encoded = Schema.encodeSync(ServiceRegistryCodec)(data);
        return Deno.writeTextFileSync(dataFile, encoded);
    }

    static usingPersistance(){
        const resources = this.createPersistance()
        return {
            resources,
            getRegistry(){
                return ServiceRegistry.fromPersistance();
            },
            [Symbol.dispose](){
                ServiceRegistry.clearPersistance();
            }
        }
    }
}