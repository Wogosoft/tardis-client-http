import { GeneratedFile } from "@bufbuild/protoplugin";

export class EffectPrelude {
    constructor(readonly file: GeneratedFile){}

    private fromEffect(name: string){
        return this.file.import(name, "effect");
    }

    private fromPrelude(name: string){
        return this.file.import(name, "@wogo/tardis-integration-prelude");
    }

    get Effect(){ 
        return this.fromEffect("Effect")
    }

    get Context(){
        return this.fromEffect("Context")
    }

    get Layer(){
        return this.fromEffect("Layer")
    }

    get Schema(){
        return this.fromPrelude("Schema")
    }

    get ServiceMap(){
        return this.fromPrelude("ServiceMap")
    }

    get ServiceBuilder(){
        return this.fromPrelude("ServiceBuilder")
    }
}