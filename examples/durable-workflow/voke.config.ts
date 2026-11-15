import { aws } from "@voke/aws";
import { defineConfig } from "voke";

export default defineConfig({
  entrypoint: "./src/index.ts",
  name: "durable-workflow",
  provider: aws(),
});
