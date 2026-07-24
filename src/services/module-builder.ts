import { ModuleMap, ModulePath, SymbolName } from "./module-map.ts";

export class ModuleBuilder {
    private imports: ModuleMap;
    private content: string;
    private prefix: string[];
    constructor(){
        this.imports = new ModuleMap();
        this.content = "";
        this.prefix = [];
    }

    addImport(name: string, from: string){
        this.imports.register(
            ModulePath(from),
            SymbolName(name) 
        );
    }

    addTypeOnlyImport(name: string, from: string){
        this.imports.register(
            ModulePath(from),
            SymbolName(name),
            true
        );
    }

    printLn(content: string){
        this.content += this.prefix.join("") + content + "\n";
    }

    print(content: string){
        this.content += this.prefix.join("") + content;
    }

    indent(fn: (builder: ModuleBuilder) => void){
        this.prefix.push("\t")
        fn(this)
        this.prefix.pop();
    }

    scope(prefix: string, fn: (builder: ModuleBuilder) => void, postfix = ""){
        this.printLn(prefix + "{")
        this.indent(fn)
        this.printLn("}" + postfix + ";\n")
    }

    build(){
        return [
            this.imports.toString(),
            this.content
        ].join("\n")
    }
}