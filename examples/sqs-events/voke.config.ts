import { aws } from "@voke/aws";
import { sqsQueue } from "@voke/aws/cloudformation";
import { defineConfig } from "voke";

export default defineConfig({
  cloudFormation: {
    resources: {
      ordersQueue: sqsQueue(),
    },
  },
  entrypoint: "./src/functions.ts",
  name: "sqs-events",
  provider: aws(),
});
