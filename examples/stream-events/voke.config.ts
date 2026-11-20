import { aws } from "@vokejs/aws";
import { dynamodbTable, kinesisStream } from "@vokejs/aws/cloudformation";
import { defineConfig } from "voke";

export default defineConfig({
  entrypoint: "./src/functions.ts",
  name: "stream-events",
  provider: aws(),
  resources: {
    clicksStream: kinesisStream(),
    ordersTable: dynamodbTable({ stream: "NEW_AND_OLD_IMAGES" }),
  },
});
