import { aws, sqs } from "@vokejs/aws";
import { dynamodbTable } from "@vokejs/aws/cloudformation";

import { createFunctions, fn, http, voke } from "../../../src/index";
import type { StandardSchemaV1 } from "../../../src/index";

const greetingSchema: StandardSchemaV1<{ name: string }, { name: string }> = {
  "~standard": {
    validate: (value) => ({ value: value as { name: string } }),
    vendor: "voke-node-runtime-fixture",
    version: 1,
  },
};

const messageSchema: StandardSchemaV1<
  { message: string },
  { message: string }
> = {
  "~standard": {
    validate: (value) => ({
      value: value as { message: string },
    }),
    vendor: "voke-node-runtime-fixture",
    version: 1,
  },
};

export const processedOrders: string[] = [];

export const functions = createFunctions({
  greet: fn({
    handler: (payload) => ({ message: `Hello, ${payload.name}` }),
    input: greetingSchema,
    output: messageSchema,
  }),
  http: http({
    resources: ["usersTable"],
    routes: (route) => [
      route.get("/health", {
        handler: () => ({ ok: true, runtime: "node" }),
      }),
      route.get("/greeting", {
        handler: async (): Promise<{ message: string }> =>
          await functions.invoke("greet", { name: "Node" }),
      }),
      route.get("/table", {
        handler: (_request, context) => ({
          table: context.resource("usersTable"),
        }),
      }),
    ],
  }),
  processOrder: sqs({
    handler: (batch) => {
      for (const message of batch.messages) {
        processedOrders.push(message.body.name);
      }

      return batch.ok();
    },
    message: greetingSchema,
    queue: "ordersQueue",
  }),
});

const gateway = voke(functions, {
  config: {
    name: "node-runtime",
    provider: aws(),
    resources: { usersTable: dynamodbTable() },
  },
});

export default gateway;
