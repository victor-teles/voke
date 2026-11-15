import { expect, test } from "bun:test";

import { response } from "@voke/http";
import { schema } from "@voke/schema";
import {
  createFunctions,
  defineConfig,
  fn,
  http,
  route,
  voke,
  VokeConfigError,
  VokeResourceBindingError,
} from "voke";
import type { VokePlugin } from "voke";

import { IdempotencyError } from "../src/errors";
import { idempotent } from "../src/idempotent";
import { memoryStore } from "../src/memory-store";
import { idempotency } from "../src/plugin";

const chargeInput = schema.object({
  amount: schema.number(),
  orderId: schema.string(),
});
const chargeOutput = schema.object({ chargeId: schema.string() });

const config = (plugins: VokePlugin[]) => ({ name: "test", plugins });

const chargeFunctions = () => {
  const charges: string[] = [];
  const charge = () =>
    fn({
      handler: idempotent(
        (payload) => {
          charges.push(payload.orderId);

          return { chargeId: `ch_${charges.length}` };
        },
        { key: (payload) => payload.orderId }
      ),
      input: chargeInput,
      output: chargeOutput,
    });
  const functions = createFunctions({ charge: charge(), refund: charge() });

  return { charges, functions };
};

test("an invokable Function called twice with the same key runs once", async () => {
  const { charges, functions } = chargeFunctions();

  voke(functions, { config: config([idempotency({ store: memoryStore() })]) });

  const first = await functions.invoke("charge", {
    amount: 10,
    orderId: "ord_1",
  });
  const second = await functions.invoke("charge", {
    amount: 10,
    orderId: "ord_1",
  });

  expect(first).toEqual({ chargeId: "ch_1" });
  expect(second).toEqual(first);
  expect(charges).toEqual(["ord_1"]);
});

test("two Functions with the same key value do not share a record", async () => {
  const { charges, functions } = chargeFunctions();

  voke(functions, { config: config([idempotency({ store: memoryStore() })]) });

  await functions.invoke("charge", { amount: 10, orderId: "ord_1" });
  await functions.invoke("refund", { amount: 10, orderId: "ord_1" });

  expect(charges).toEqual(["ord_1", "ord_1"]);
});

test("a route called twice with the same idempotency-key header runs once", async () => {
  const created: string[] = [];
  const functions = createFunctions({
    orders: http({
      routes: [
        route.post("/orders", {
          body: schema.object({ item: schema.string() }),
          handler: idempotent(
            (request) => {
              created.push(request.body.item);

              return { orderId: `ord_${created.length}` };
            },
            {
              key: (request) =>
                request.headers.get("idempotency-key") ?? undefined,
              validate: (request) => request.body,
            }
          ),
        }),
      ],
    }),
  });
  const gateway = voke(functions, {
    config: config([idempotency({ store: memoryStore() })]),
  });
  const post = () =>
    gateway.request("/orders", {
      body: JSON.stringify({ item: "book" }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "req_1",
      },
      method: "POST",
    });

  const first = await post();
  const second = await post();

  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ data: { orderId: "ord_1" } });
  expect(await second.json()).toEqual({ data: { orderId: "ord_1" } });
  expect(created).toEqual(["book"]);
});

test("a route can answer 409 while the same request is still running", async () => {
  const { promise: release, resolve } = Promise.withResolvers<undefined>();
  const createOrder = idempotent(
    async () => {
      await release;

      return { ok: true };
    },
    {
      key: (request: { headers: Headers }) =>
        request.headers.get("idempotency-key") ?? undefined,
    }
  );
  const functions = createFunctions({
    orders: http({
      routes: [
        route.post("/orders", {
          handler: async (request, context) => {
            try {
              return await createOrder(request, context);
            } catch (error) {
              if (
                error instanceof IdempotencyError &&
                error.code === "IDEMPOTENCY_IN_PROGRESS"
              ) {
                return response.error("Request in progress", { status: 409 });
              }

              throw error;
            }
          },
        }),
      ],
    }),
  });
  const gateway = voke(functions, {
    config: config([idempotency({ store: memoryStore() })]),
  });
  const post = () =>
    gateway.request("/orders", {
      headers: { "idempotency-key": "req_1" },
      method: "POST",
    });

  const first = post();
  const second = await post();

  expect(second.status).toBe(409);
  resolve();
  const completed = await first;

  expect(completed.status).toBe(200);
});

test('onMissingKey: "throw" rejects an input without a key', async () => {
  const functions = createFunctions({
    charge: fn({
      handler: idempotent(() => ({ chargeId: "ch_1" }), {
        key: (payload: { orderId?: string }) => payload.orderId,
        onMissingKey: "throw",
      }),
      input: schema.object({ orderId: schema.optional(schema.string()) }),
      output: chargeOutput,
    }),
  });

  voke(functions, { config: config([idempotency({ store: memoryStore() })]) });

  const rejection = await functions
    .invoke("charge", {})
    .catch((error) => error);

  expect(rejection).toBeInstanceOf(IdempotencyError);
  expect((rejection as IdempotencyError).code).toBe("IDEMPOTENCY_KEY_MISSING");
});

test("an input without a key runs the handler without a record by default", async () => {
  const runs: number[] = [];
  const functions = createFunctions({
    charge: fn({
      handler: idempotent(
        () => {
          runs.push(runs.length);

          return { chargeId: "ch" };
        },
        { key: (payload: { orderId?: string }) => payload.orderId }
      ),
      input: schema.object({ orderId: schema.optional(schema.string()) }),
      output: chargeOutput,
    }),
  });

  voke(functions, { config: config([idempotency({ store: memoryStore() })]) });

  await functions.invoke("charge", {});
  await functions.invoke("charge", {});

  expect(runs).toEqual([0, 1]);
});

test("a wrapped handler without the Plugin throws a VokeConfigError", async () => {
  const { functions } = chargeFunctions();

  voke(functions, { config: { name: "test" } });

  const rejection = await functions
    .invoke("charge", { amount: 10, orderId: "ord_1" })
    .catch((error) => error);

  expect(rejection).toBeInstanceOf(VokeConfigError);
  expect((rejection as Error).message).toContain(
    "idempotent() needs the idempotency() Plugin in voke.config.ts"
  );
});

test("a store in the options lets a test call the handler directly", async () => {
  const handler = idempotent((payload: { orderId: string }) => payload, {
    key: (payload) => payload.orderId,
    store: memoryStore(),
  });

  await expect(handler({ orderId: "ord_1" }, {})).resolves.toEqual({
    orderId: "ord_1",
  });
});

test("idempotency() contributes the idempotencyTable resource with time to live", () => {
  const resolved = defineConfig({ name: "test", plugins: [idempotency()] });
  const table = resolved.resources.idempotencyTable as unknown as {
    properties: Record<string, unknown>;
  };

  expect(Object.keys(resolved.resources)).toEqual(["idempotencyTable"]);
  expect(table.properties.TimeToLiveSpecification).toEqual({
    AttributeName: "expiration",
    Enabled: true,
  });
});

test("idempotency() reads its table binding when a wrapped handler first runs, not at setup", async () => {
  const { charges, functions } = chargeFunctions();

  delete process.env.VOKE_RESOURCE_IDEMPOTENCY_TABLE_NAME;
  voke(functions, { config: config([idempotency()]) });

  const rejection = await functions
    .invoke("charge", { amount: 10, orderId: "ord_1" })
    .catch((error) => error);

  expect(rejection).toBeInstanceOf(VokeResourceBindingError);
  expect(charges).toEqual([]);
});

test("idempotency({ table }) contributes the table under that key", () => {
  const resolved = defineConfig({
    name: "test",
    plugins: [idempotency({ table: "dedupe" })],
  });

  expect(Object.keys(resolved.resources)).toEqual(["dedupe"]);
});

test("idempotency({ store }) contributes no table", () => {
  const resolved = defineConfig({
    name: "test",
    plugins: [idempotency({ store: memoryStore() })],
  });

  expect(resolved.resources).toEqual({});
});
