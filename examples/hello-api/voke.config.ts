import { aws } from "@voke/aws";
import { dynamodbTable, sqsQueue } from "@voke/aws/cloudformation";
import { openapi } from "@voke/openapi";
import { defineConfig } from "voke";

import { requestTiming } from "./src/plugins/request-timing";

export default defineConfig({
  api: {
    cors: true,
  },
  entrypoint: "./src/index.ts",
  name: "hello-api",
  // `expose: true` also deploys the public /openapi.json and /docs routes; without it they are
  // served under `voke dev` only.
  plugins: [requestTiming(), openapi({ expose: true, title: "Hello API" })],
  provider: aws({ lambda: { runtime: "nodejs24.x" } }),
  region: "us-east-1",
  resources: {
    eventsQueue: sqsQueue(),
    usersTable: dynamodbTable({ partitionKey: "id" }),
  },
  stage: "local",
});
