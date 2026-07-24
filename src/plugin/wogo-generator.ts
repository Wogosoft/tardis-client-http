import { type GeneratedFile, getComments, type ImportSymbol, safeIdentifier, type Schema } from "@bufbuild/protoplugin";
import { type DescEnum, type DescFile,type  DescMessage, type DescService, ScalarType } from "@bufbuild/protobuf";
import { ImportRegistry } from "./import-registry.ts";
import { EffectPrelude } from "./effect-prelude.ts";
import { WellKnownTypes } from "./wkt.ts";
import { ServiceRegistry } from "./service-registry.ts";
import { SchemaMapping } from "./schema-mapping.ts";

const mapScalarField = (scalar: ScalarType) => {
  switch(scalar){
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
    case ScalarType.INT32:
    case ScalarType.FIXED32:
    case ScalarType.UINT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
      return "Number";
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      return "BigInt";
    case ScalarType.BOOL:
      return "Boolean";
    case ScalarType.STRING:
      return "String";
    case ScalarType.BYTES:
      return "Uint8Array";
  }
}

const fieldPrinterFactory = (
    f: GeneratedFile,
    Schema: ImportSymbol,
    defaultIndent = ""
) => (name: string, optional: boolean) => (
    fieldData: {
        schema: string | SchemaMapping,
        suspend?: boolean,
        indent?: string
    }
) => {
    const { schema, suspend, indent=defaultIndent } = fieldData;
    if( typeof schema === "string" ){
        if( optional && suspend){
            f.print`${indent}${name}: ${Schema}.optional(${Schema}.suspend(() => ${Schema}.${schema})),`
        } else if( optional && !suspend ){
            f.print`${indent}${name}: ${Schema}.optional(${Schema}.${schema}),`
        } else if( !optional && suspend ){
            f.print`${indent}${name}: ${Schema}.suspend(() => ${Schema}.${schema}),`
        } else {
            f.print`${indent}${name}: ${Schema}.${schema},`
        }
    } else if( schema._tag === "Imported" ) {
        if( optional ){
            f.print`${indent}${name}: ${Schema}.optional(${schema.schema}),`;
        } else {
            f.print`${indent}${name}: ${schema.schema},`;
        }
    } else if( schema._tag === "Composite"){
        const outer = schema.outer;
        if( schema.params.length === 1 ){
            const [inner] = schema.params;
            if( typeof inner === "string" ){
                if( optional && suspend){
                    f.print`${indent}${name}: ${Schema}.optional(${Schema}.${outer}(${Schema}.suspend(() => ${Schema}.${inner}))),`
                } else if( optional && !suspend ){
                    f.print`${indent}${name}: ${Schema}.optional(${Schema}.${outer}(${Schema}.${inner})),`
                } else if( !optional && suspend ){
                    f.print`${indent}${name}: ${Schema}.${outer}(${Schema}.suspend(() => ${Schema}.${inner})),`
                } else {
                    f.print`${indent}${name}: ${Schema}.${outer}(${Schema}.${inner}),`
                }
            } else {
                if( optional && suspend){
                    f.print`${indent}${name}: ${Schema}.optional(${Schema}.${outer}(${Schema}.suspend(() => ${inner.schema}))),`
                } else if( optional && !suspend ){
                    f.print`${indent}${name}: ${Schema}.optional(${Schema}.${outer}(${inner.schema})),`
                } else if( !optional && suspend ){
                    f.print`${indent}${name}: ${Schema}.${outer}(${Schema}.suspend(() => ${inner.schema})),`
                } else {
                    f.print`${indent}${name}: ${Schema}.${outer}(${inner.schema}),`
                }
            }
        } else {
            const [left, right] = schema.params;
            if( typeof right === "string" ){
                if( optional && suspend){
                    f.print`${indent}${name}: ${Schema}.optional(${Schema}.${outer}(${Schema}.${left},${Schema}.suspend(() => ${Schema}.${right}))),`
                } else if( optional && !suspend ){
                    f.print`${indent}${name}: ${Schema}.optional(${Schema}.${outer}(${Schema}.${left},${Schema}.${right})),`
                } else if( !optional && suspend ){
                    f.print`${indent}${name}: ${Schema}.${outer}(${Schema}.${left},${Schema}.suspend(() => ${Schema}.${right})),`
                } else {
                    f.print`${indent}${name}: ${Schema}.${outer}(${Schema}.${left},${Schema}.${right}),`
                }
            } else {
                if( optional && suspend){
                    f.print`${indent}${name}: ${Schema}.optional(${Schema}.${outer}(${Schema}.${left},${Schema}.suspend(() => ${right.schema}))),`
                } else if( optional && !suspend ){
                    f.print`${indent}${name}: ${Schema}.optional(${Schema}.${outer}(${Schema}.${left}, ${right.schema})),`
                } else if( !optional && suspend ){
                    f.print`${indent}${name}: ${Schema}.${outer}(${Schema}.${left},${Schema}.suspend(() => ${right.schema})),`
                } else {
                    f.print`${indent}${name}: ${Schema}.${outer}(${Schema}.${left}, ${right.schema}),`
                }
            }
        }
    } else {
        if( optional && suspend){
            f.print`${indent}${name}: ${Schema}.optional(${Schema}.suspend(() => ${schema.schema})),`
        } else if( optional && !suspend ){
            f.print`${indent}${name}: ${Schema}.optional(${schema.schema}),`
        } else if( !optional && suspend ){
            f.print`${indent}${name}: ${Schema}.suspend(() => ${schema.schema}),`
        } else {
            f.print`${indent}${name}: ${schema.schema},`
        }
    }
}

export class WogoGenerator {
    private importRegistry: ImportRegistry;
    private serviceRegistry: ServiceRegistry;
    constructor(private schema: Schema){
        this.importRegistry = ImportRegistry.fromFiles(schema.allFiles);
        this.serviceRegistry = ServiceRegistry.fromFiles(schema.allFiles);
    }

    private generateFile(file: DescFile){
        const gf = this.schema.generateFile(file.name + "_wogo.ts");
        gf.preamble(file);
        return gf
    }

    private generateEnum(f: GeneratedFile, enumeration: DescEnum){
        const prelude = new EffectPrelude(f);
        f.print(f.jsDoc(enumeration))
        f.print(f.export("const", enumeration.name), " = ", prelude.Schema, ".String;\n")
        f.print(f.jsDoc(enumeration))
        f.print(f.export("const", enumeration.name + "Values"), " = {")
        for (const enumValue of enumeration.values){
          f.print(`\t${enumValue.localName}: "${enumValue.name}",`)
        }
        f.print("};\n")
    }

    private generateMessage(f: GeneratedFile, file: DescFile, message: DescMessage){
        const { Schema } = new EffectPrelude(f);
        f.print(f.jsDoc(message));
        f.print(f.export("const", message.name), " = ", Schema, ".Struct({")
        const makeFieldPrinter = fieldPrinterFactory(f, Schema, "\t");
        for (const field of message.fields){
            f.print(f.jsDoc(field, "\t"));
            const comments = getComments(field);
            const isOptional = ((comments.leading ?? "") + (comments.trailing ?? "")).includes("Optional:");
            const printField = makeFieldPrinter(field.localName, isOptional);
            switch(field.fieldKind){
                case "scalar":{
                    printField({
                        schema: mapScalarField(field.scalar),
                    })
                }
                break
                case "message":{
                    const isLocal = Boolean(file.messages.find(m => m.typeName === field.message.typeName));
                    if( isLocal ){
                        const currentPrecedance = file.messages.findIndex(m => m.typeName === message.typeName)
                        const nestedPrecedance = file.messages.findIndex(m => m.typeName === field.message.typeName)
                        printField({
                            schema: SchemaMapping.Ref({ schema: field.message.name }),
                            suspend: currentPrecedance < nestedPrecedance,
                        })
                    } else if(WellKnownTypes.isWellKnownType(field.message.typeName)) {
                        printField({
                            schema: WellKnownTypes.getSchemaMapping(field.message.typeName),
                        })
                    } else {
                        printField({
                            schema: SchemaMapping.Imported({ schema: this.importRegistry.import(f, field.message) }),
                        })
                    }
                    break;
                }
                case "enum":{
                    const isLocal = Boolean(file.enums.find(e => e.typeName === field.enum.typeName))
                    if( isLocal ){
                        const currentPrecedance = file.messages.findIndex(m => m.typeName === message.typeName)
                        const nestedPrecedance = file.messages.findIndex(m => m.typeName === field.enum.typeName)
                        printField({
                            schema: SchemaMapping.Ref({ schema :field.enum.name }),
                            suspend: currentPrecedance < nestedPrecedance,
                        })
                    } else {
                        printField({
                            schema: SchemaMapping.Imported({ schema: this.importRegistry.import(f, field.enum) }),
                        })
                    }
                    break;
                }
                case "list": {
                    switch(field.listKind){
                        case "scalar": {
                            printField({
                                schema: SchemaMapping.Composite({
                                    outer: "Array",
                                    params: [mapScalarField(field.scalar)]
                                }),
                            })
                            break;
                        }
                        case "message": {
                            const isLocal = Boolean(file.messages.find(m => m.typeName === field.message.typeName));
                            if( isLocal ){
                                const currentPrecedance = file.messages.findIndex(m => m.typeName === message.typeName)
                                const nestedPrecedance = file.messages.findIndex(m => m.typeName === field.message.typeName)
                                printField({
                                    schema: SchemaMapping.Composite({
                                        outer: "Array",
                                        params: [SchemaMapping.Ref({ schema: field.message.name})]
                                    }),
                                    suspend: currentPrecedance < nestedPrecedance,
                                })
                            } else if(WellKnownTypes.isWellKnownType(field.message.typeName)) {
                                printField({
                                    schema: SchemaMapping.Composite({
                                        outer: "Array",
                                        params: [WellKnownTypes.getSchemaMapping(field.message.typeName)],
                                    })
                                })
                            } else {
                                printField({
                                    schema: SchemaMapping.Composite({
                                        outer: "Array",
                                        params: [
                                            SchemaMapping.Imported({ 
                                                schema: this.importRegistry.import(f, field.message)
                                            })
                                        ]
                                    })
                                })
                            }
                            break;
                        }
                        case "enum": {
                            const isLocal = Boolean(file.enums.find(e => e.typeName === field.enum.typeName))
                            if( isLocal ){
                                const currentPrecedance = file.messages.findIndex(m => m.typeName === message.typeName)
                                const nestedPrecedance = file.messages.findIndex(m => m.typeName === field.enum.typeName)
                                printField({
                                    schema: SchemaMapping.Composite({
                                        outer: "Array",
                                        params: [
                                            SchemaMapping.Ref({ schema: field.enum.name})
                                        ]
                                    }),
                                    suspend: currentPrecedance < nestedPrecedance
                                })
                            } else {
                                printField({
                                    schema: SchemaMapping.Composite({ 
                                        outer: "Array",
                                        params: [SchemaMapping.Imported({ 
                                            schema: this.importRegistry.import(f, field.enum)
                                        })]
                                    })
                                })
                            }
                            break;
                        }
                    }
                    break;
                }
                case "map": {
                    switch(field.mapKind){
                        case "scalar": {
                            printField({
                                schema: SchemaMapping.Composite({
                                    outer: "Record",
                                    params: [mapScalarField(field.mapKey), mapScalarField(field.scalar)]
                                })
                            })
                            break;
                        }
                        case "message": {
                            const isLocal = Boolean(file.messages.find(m => m.typeName === field.message.typeName));
                            if( isLocal ){
                                const currentPrecedance = file.messages.findIndex(m => m.typeName === message.typeName)
                                const nestedPrecedance = file.messages.findIndex(m => m.typeName === field.message.typeName)
                                printField({
                                    suspend: currentPrecedance < nestedPrecedance,
                                    schema: SchemaMapping.Composite({
                                        outer: "Record",
                                        params: [
                                            mapScalarField(field.mapKey),
                                            SchemaMapping.Ref({ schema: field.message.name })
                                        ]
                                    })
                                })
                            } else if(WellKnownTypes.isWellKnownType(field.message.typeName)) {
                                printField({
                                    schema: SchemaMapping.Composite({
                                        outer: "Record",
                                        params: [
                                            mapScalarField(field.mapKey),
                                            WellKnownTypes.getSchemaMapping(field.message.typeName)
                                        ]
                                    })
                                })
                            }  else {
                                printField({
                                    schema: SchemaMapping.Composite({
                                        outer: "Record",
                                        params: [
                                            mapScalarField(field.mapKey),
                                            SchemaMapping.Imported({ schema: this.importRegistry.import(f, field.message)})
                                        ]
                                    })
                                })
                            }
                            break;
                        }
                        case "enum": {
                            const isLocal = Boolean(file.messages.find(m => m.typeName === field.enum.typeName));
                            if( isLocal ){
                                const currentPrecedance = file.messages.findIndex(m => m.typeName === message.typeName)
                                const nestedPrecedance = file.messages.findIndex(m => m.typeName === field.enum.typeName)
                                printField({
                                    suspend: currentPrecedance < nestedPrecedance,
                                    schema: SchemaMapping.Composite({
                                        outer: "Record",
                                        params: [
                                            mapScalarField(field.mapKey),
                                            SchemaMapping.Ref({ schema: field.enum.name })
                                        ]
                                    })
                                })
                            } else {
                                printField({
                                    schema: SchemaMapping.Composite({
                                        outer: "Record",
                                        params: [
                                            mapScalarField(field.mapKey),
                                            SchemaMapping.Imported({ schema: this.importRegistry.import(f, field.enum)})
                                        ]
                                    })
                                })
                            }
                            break;
                        }
                    }
                    break;
                }
            }
        }
        f.print("});\n")
    }

    private generateService(f: GeneratedFile, service: DescService){
        const {
            Context,
            HttpClient,
            Effect,
            Layer,
            ServiceBuilder,
            ServiceMap
        } = new EffectPrelude(f)
        const serviceId = safeIdentifier(service.name);
        f.print(f.jsDoc(service));
        f.print`${f.export("class", serviceId)} extends ${Context}.Service<${serviceId}>()(`
        f.print(`\t"@wogo/tardis/${serviceId}",`)
        f.print("\t{")
        f.print`\t\tmake: ${Effect}.gen(function*(){`
        f.print`\t\t\tconst serviceName = "${service.typeName}";`
        f.print`\t\t\tconst baseUrl = yield* ${ServiceMap}.getURL(serviceName);`
        f.print`\t\t\tconst builder = yield* ${ServiceBuilder}.make(baseUrl, serviceName);`
        f.print`\t\t\treturn {`
        for(const method of service.methods){
            const inputImport = this.importRegistry.import(f, method.input);
            const outputImport = this.importRegistry.import(f, method.output);
            f.print(f.jsDoc(method, "\t\t\t\t"));
            f.print`\t\t\t\t${method.localName}: builder.makeOperation({`
            f.print`\t\t\t\t\toperationId: "${method.name}",`
            f.print`\t\t\t\t\tinputSchema: ${inputImport},`
            f.print`\t\t\t\t\toutputSchema: ${outputImport},`
            f.print`\t\t\t\t}),`
        }
        f.print`\t\t\t}`
        f.print("\t\t})")
        f.print("\t}")
        f.print("){")
        f.print`\tstatic readonly layer: ${Layer}.Layer<${serviceId}, ${ServiceMap}.ServiceError, ${HttpClient}.HttpClient| ${ServiceMap}.ServiceMap> = ${Layer}.effect(this, this.make)`
        f.print`\tstatic readonly serviceId = "${service.typeName}" as const;`
        f.print("}\n")
    }

    generateFiles(){
        for(const file of this.schema.files){

            const generatedFile = this.generateFile(file);
            
            for (const enumeration of file.enums){
                this.generateEnum(generatedFile, enumeration);
            }

            for (const message of file.messages){
                this.generateMessage(generatedFile, file, message);
            }

            for (const service of file.services){
                this.generateService(generatedFile, service);
            }
        }
    }

    saveServiceDefinitions(){
        this.serviceRegistry.save()
    }
}