import { defineConfig } from "voke";
import { dynamodbTable, sqsQueue } from "voke/aws";

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
  stage: "local",
});
