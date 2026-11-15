import { aws } from "@voke/aws";
import { dynamodbTable } from "@voke/aws/cloudformation";
import { defineConfig } from "voke";

export default defineConfig({
  name: "hello-api",
  provider: aws(),
  resources: {
    usersTable: dynamodbTable({ partitionKey: "id" }),
  },
});
