import { HashMap, Option } from "effect";
import { GeneratedFile } from "@bufbuild/protoplugin";
import { DescFile } from "@bufbuild/protobuf";
import { dirname } from "@std/path"
import { WellKnownTypes } from "./wkt.ts";

export class ImportRegistry {
    private internal: HashMap.HashMap<string, string>;
    private constructor(){
        this.internal = HashMap.empty();
    }

    static fromFiles(files: readonly DescFile[]){
        const registry = new ImportRegistry();
        for (const file of files){
            [
                ...file.enums,
                ...file.messages,
                ...file.services
            ].forEach(e => {
                if( !WellKnownTypes.isWellKnownType(e.typeName) ){
                    registry.register(e.typeName, file.name + "_wogo.ts")
                }
            })
        }
        return registry
    }

    private register(typeName: string, path: string){
        if( !typeName.startsWith("wogo") ){
            console.error("Almost registered external type: " + typeName)
            return
        }
        this.internal = this.internal.pipe(HashMap.set(typeName, path));
    }

    import(file: GeneratedFile, data: { typeName: string, name: string }){
        const path = this.internal.pipe(
            HashMap.get(data.typeName)
        )

        if ( Option.isNone(path) ){
            console.error("Error importing "+ data.typeName)
            return file.import(data.name, "@gen/" + dirname(data.typeName.replaceAll(".", "/")))
        }

        return file.import(data.name, "@gen/" + path.value)
    }
}