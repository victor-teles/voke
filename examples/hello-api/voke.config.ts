import { dynamodbTable, sqsQueue } from "@voke/aws";
import { defineConfig } from "voke";

export default defineConfig({
  cloudFormation: {
    resources: {
      eventsQueue: sqsQueue(),
      usersTable: dynamodbTable({ partitionKey: "id" }),
    },
  },
  entrypoint: "./src/index.ts",
  name: "hello-api",
  region: "us-east-1",
  runtime: {
    lambda: "nodejs24.x",
  },
  stage: "local",
});
