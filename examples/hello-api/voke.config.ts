import { aws } from "@voke/aws";
import { dynamodbTable, sqsQueue } from "@voke/aws/cloudformation";
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
  provider: aws(),
  region: "us-east-1",
  runtime: {
    lambda: "nodejs24.x",
  },
  stage: "local",
});
