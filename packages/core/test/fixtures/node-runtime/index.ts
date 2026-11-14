import { aws, bindResource } from "@voke/aws";

import { createFunctions, fn, http, route, voke } from "../../../src/index";
import type { StandardSchemaV1 } from "../../../src/schema";

const greetingSchema: StandardSchemaV1<{ name: string }, { name: string }> = {
  "~standard": {
    validate: (value) => ({ data: value as { name: string }, success: true }),
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
      data: value as { message: string },
      success: true,
    }),
    vendor: "voke-node-runtime-fixture",
    version: 1,
  },
};

const usersTable = bindResource("usersTable", "name");

const functions = createFunctions({
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
});

const gateway = voke(functions, {
  config: { name: "node-runtime" },
  provider: aws(),
});

export const { handler } = gateway;

export default gateway;
