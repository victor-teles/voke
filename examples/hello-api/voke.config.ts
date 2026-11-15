import { aws } from "@voke/aws";
import { dynamodbTable, sqsQueue } from "@voke/aws/cloudformation";
import { defineConfig } from "voke";

import { requestTiming } from "./src/plugins/request-timing";

export default defineConfig({
  api: {
    cors: true,
  },
  entrypoint: "./src/index.ts",
  name: "hello-api",
  plugins: [requestTiming()],
  provider: aws({ lambda: { runtime: "nodejs24.x" } }),
  region: "us-east-1",
  resources: {
    eventsQueue: sqsQueue(),
    usersTable: dynamodbTable({ partitionKey: "id" }),
  },
  stage: "local",
});
