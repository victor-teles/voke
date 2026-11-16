import { aws } from "@vokejs/aws";
import { eventBus, s3Bucket, snsTopic } from "@vokejs/aws/cloudformation";
import { defineConfig } from "voke";

export default defineConfig({
  entrypoint: "./src/functions.ts",
  name: "event-sources",
  provider: aws(),
  resources: {
    ordersBus: eventBus(),
    ordersTopic: snsTopic(),
    uploadsBucket: s3Bucket(),
  },
});
