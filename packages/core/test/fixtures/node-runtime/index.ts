import { aws, bindResource, sqs } from "@voke/aws";

import { createFunctions, fn, http, route, voke } from "../../../src/index";
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

const usersTable = bindResource("usersTable", "name");

export const processedOrders: string[] = [];

export const functions = createFunctions({
  greet: fn({
    handler: (payload) => ({ message: `Hello, ${payload.name}` }),
    input: greetingSchema,
    output: messageSchema,
  }),
  http: http({
    routes: [
      route.get("/health", {
        handler: () => ({ ok: true, runtime: "node" }),
      }),
      route.get("/greeting", {
        handler: async (): Promise<{ message: string }> =>
          await functions.invoke("greet", { name: "Node" }),
      }),
      route.get("/table", {
        handler: () => ({ table: usersTable.value() }),
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
  config: { name: "node-runtime", provider: aws() },
});

export default gateway;
