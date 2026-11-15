import { aws } from "@voke/aws";
import { eventBus, s3Bucket, snsTopic } from "@voke/aws/cloudformation";
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
