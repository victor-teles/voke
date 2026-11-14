import { aws } from "@voke/aws";
import { defineConfig } from "voke";

export default defineConfig({
  entrypoint: "./src/index.ts",
  name: "cross-function-api",
  provider: aws(),
});
