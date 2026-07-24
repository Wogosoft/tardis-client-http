import { 
  createEcmaScriptPlugin, 
  runNodeJs, 
  type Schema,
} from "@bufbuild/protoplugin";
import { WogoGenerator } from "./wogo-generator.ts";

const plugin = createEcmaScriptPlugin({
  name: "protoc-gen-wogo",
  version: "v1",
  generateTs(schema: Schema) {
    const generator = new WogoGenerator(schema);
    generator.generateFiles()
    generator.saveServiceDefinitions()
  },
});

runNodeJs(plugin);