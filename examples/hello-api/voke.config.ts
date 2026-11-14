import { aws } from "@voke/aws";
import { dynamodbTable, sqsQueue } from "@voke/aws/cloudformation";
import { defineConfig } from "voke";

export default defineConfig({
  api: {
    cors: true,
  },
  entrypoint: "./src/index.ts",
  name: "hello-api",
  provider: aws({ lambda: { runtime: "nodejs24.x" } }),
  region: "us-east-1",
  resources: {
    eventsQueue: sqsQueue(),
    usersTable: dynamodbTable({ partitionKey: "id" }),
  },
  stage: "local",
});
