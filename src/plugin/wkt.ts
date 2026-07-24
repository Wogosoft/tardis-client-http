const KnownTypeNames = {
    Any: "google.protobuf.Any",
    Duration: "google.protobuf.Duration",
    FieldMask: "google.protobuf.FieldMask",
    ListValue: "google.protobuf.ListValue",
    NullValue: "google.protobuf.NullValue",
    Struct: "google.protobuf.Struct",
    Timestamp: "google.protobuf.Timestamp",
    Value: "google.protobuf.Value",
} as const

const KnownTypeNameValues = Object.values(KnownTypeNames);

type KnownTypeName = (typeof KnownTypeNames)[keyof typeof KnownTypeNames];

export class WellKnownTypes {
    static isWellKnownType(typename: string): typename is KnownTypeName {
        return KnownTypeNameValues.includes(typename as KnownTypeName);
    }

    static getSchemaMapping(typename: string){
        switch(typename){
            case "google.protobuf.ListValue":
                return "Array(Schema.Any)";
            case "google.protobuf.NullValue":
                return "Null";
            case "google.protobuf.Struct":
                return "Record(Schema.String, Schema.Any)";
            case "google.protobuf.Duration":
            case "google.protobuf.FieldMask":
            case "google.protobuf.Timestamp":
                return "String";
            case "google.protobuf.Value":
            case "google.protobuf.Any":
                return "Any";
            default:
                return "Unknown" ;
        }
    }
}