import { aws } from "@vokejs/aws";
import { defineConfig } from "voke";

export default defineConfig({
  entrypoint: "./src/index.ts",
  name: "e2e-api",
  provider: aws(),
});
