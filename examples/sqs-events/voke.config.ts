import { aws } from "@voke/aws";
import { sqsQueue } from "@voke/aws/cloudformation";
import { defineConfig } from "voke";

export default defineConfig({
  entrypoint: "./src/functions.ts",
  name: "sqs-events",
  provider: aws(),
  resources: {
    ordersQueue: sqsQueue(),
  },
});
