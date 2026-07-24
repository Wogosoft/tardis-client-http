import { Brand, Data, HashMap, HashSet, pipe } from "effect";

export type ModulePath = string & Brand.Brand<"ModulePath">
export const ModulePath = Brand.nominal<ModulePath>();

export type SymbolName = string & Brand.Brand<"SymbolName">
export const SymbolName = Brand.nominal<SymbolName>();

export class ModuleSymbol
extends Data.TaggedClass("ModuleSymbol")<{
    identifier: SymbolName,
    typeOnly: boolean
}> {}

export class ModuleMap {
    constructor(
        private internal = HashMap.empty<ModulePath, HashSet.HashSet<ModuleSymbol>>()
    ){}

    static ModulePath = ModulePath;
    static SymbolName = SymbolName;
    static ModuleSymbol = ModuleSymbol;

    register(modulePath: ModulePath, symbolName: SymbolName, typeOnly: boolean = false){
        const sym = new ModuleSymbol({
            identifier: symbolName,
            typeOnly
        })
        if( !HashMap.has(modulePath)(this.internal) ){
            this.internal = this.internal.pipe(
                HashMap.set(modulePath, HashSet.empty())
            )
        }
        this.internal = this.internal.pipe(
            HashMap.modify(modulePath, HashSet.add(sym))
        )
    }

    toString(){
        function toImportStatement(symbols: HashSet.HashSet<ModuleSymbol>, modulePath: ModulePath): string {
            const allTypeOnly = pipe(
                symbols,
                HashSet.every(s => s.typeOnly),
            )

            const mapped = pipe(
                symbols,
                HashSet.map(s => (allTypeOnly || !s.typeOnly) 
                    ? s.identifier
                    : `type ${s.identifier}` ),
            )

            const imports = [...mapped].toSorted().join(" , ")

            if( allTypeOnly ){
                return `import type { ${imports} } from "${modulePath}";\n`
            } else {
                return `import { ${imports} } from "${modulePath}";\n`
            }
        }

        return this.internal
            .pipe(HashMap.toEntries)
            .toSorted(([aModulePath], [bModulePath]) => aModulePath.localeCompare(bModulePath))
            .reduce((acc, [modulePath, symbols]) => acc + toImportStatement(symbols, modulePath), "")
    }
}