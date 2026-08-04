import type { GeneratedFile } from "@bufbuild/protoplugin";

export class EffectPrelude {
    constructor(readonly file: GeneratedFile){}

    private fromEffect(name: string, typeOnly = false){
        return this.file.import(name, "effect", typeOnly);
    }

    private fromPrelude(name: string, typeOnly = false){
        return this.file.import(name, "@wogo/tardis-integration-prelude", typeOnly);
    }

    get Effect(){ 
        return this.fromEffect("Effect")
    }

    get Context(){
        return this.fromEffect("Context")
    }

    get HttpClient(){
        return this.file.import("HttpClient", "effect/unstable/http", true);
    }

    get Layer(){
        return this.fromEffect("Layer")
    }

    get Schema(){
        return this.fromEffect("Schema")
    }

    get ServiceMap(){
        return this.fromPrelude("ServiceMap")
    }

    get ServiceBuilder(){
        return this.fromPrelude("ServiceBuilder")
    }
}