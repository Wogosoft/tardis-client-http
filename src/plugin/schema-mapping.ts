import { Data } from "effect"
import type { ImportSymbol } from "@bufbuild/protoplugin";

export type SchemaMapping = Data.TaggedEnum<{
    Ref: { 
        schema: string
    },
    Composite: { 
        outer: string, 
        params: 
        | [inner: string | Exclude<SchemaMapping, { _tag: "Composite" }> ] 
        | [left: string, right: string | Exclude<SchemaMapping, { _tag: "Composite" }> ]
    },
    Imported: {
        schema: ImportSymbol
    }
}>

export const SchemaMapping = Data.taggedEnum<SchemaMapping>()