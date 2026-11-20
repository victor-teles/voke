import { expect, spyOn, test } from "bun:test";

import { response } from "@vokejs/http";
import { schema } from "@vokejs/schema";
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
              key: (request) => request.headers["idempotency-key"],
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

test("a route retry that differs only in a tracing header replays without validate", async () => {
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
            { key: (request) => request.headers["idempotency-key"] }
          ),
        }),
      ],
    }),
  });
  const gateway = voke(functions, {
    config: config([idempotency({ store: memoryStore() })]),
  });
  const post = (traceId: string, item = "book") =>
    gateway.request("/orders", {
      body: JSON.stringify({ item }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "req_1",
        "x-amzn-trace-id": traceId,
      },
      method: "POST",
    });

  const first = await post("Root=1-a");
  const retry = await post("Root=1-b");
  // The Gateway logs the unexpected IdempotencyError of the mismatch below.
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  let otherBody: Response;

  try {
    otherBody = await post("Root=1-c", "pen");
  } finally {
    errorLog.mockRestore();
  }

  expect(await first.json()).toEqual({ data: { orderId: "ord_1" } });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ data: { orderId: "ord_1" } });
  // A different body with the same key is still a mismatch: the Gateway's generic 500.
  expect(otherBody.status).toBe(500);
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
      key: (request: { headers: Record<string, string | undefined> }) =>
        request.headers["idempotency-key"],
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

const tableBinding = "VOKE_RESOURCE_IDEMPOTENCY_TABLE_NAME";

// Runs `run` with the table binding unset, restoring it afterwards.
const withoutTableBinding = async (run: () => Promise<void>): Promise<void> => {
  const previous = process.env[tableBinding];

  Reflect.deleteProperty(process.env, tableBinding);

  try {
    await run();
  } finally {
    if (previous !== undefined) {
      process.env[tableBinding] = previous;
    }
  }
};

const linkedChargeFunctions = (resources: readonly string[]) => {
  const charges: string[] = [];
  const functions = createFunctions({
    charge: fn({
      handler: idempotent(
        (payload) => {
          charges.push(payload.orderId);

          return { chargeId: `ch_${charges.length}` };
        },
        { key: (payload) => payload.orderId }
      ),
      input: chargeInput,
      output: chargeOutput,
      resources,
    }),
  });

  voke(functions, { config: config([idempotency()]) });

  return { charges, functions };
};

test("a Function that links the idempotency table reads its name through the binding", async () => {
  const { charges, functions } = linkedChargeFunctions(["idempotencyTable"]);

  // The link passes, so the next check is the binding itself; the handler never runs.
  await withoutTableBinding(async () => {
    const rejection = await functions
      .invoke("charge", { amount: 10, orderId: "ord_1" })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(VokeResourceBindingError);
    expect((rejection as Error).message).toBe(
      `Missing resource binding: ${tableBinding}`
    );
  });
  expect(charges).toEqual([]);
});

test("a Function that does not link the idempotency table fails before its handler runs", async () => {
  const { charges, functions } = linkedChargeFunctions([]);
  const previous = process.env[tableBinding];

  process.env[tableBinding] = "orders-dev-idempotency";

  try {
    const rejection = await functions
      .invoke("charge", { amount: 10, orderId: "ord_1" })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(VokeResourceBindingError);
    expect((rejection as Error).message).toBe(
      'Function "charge" does not link resource "idempotencyTable". Add it to the Function: resources: ["idempotencyTable"]'
    );
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, tableBinding);
    } else {
      process.env[tableBinding] = previous;
    }
  }

  expect(charges).toEqual([]);
});

test("idempotency({ store }) needs no Resource Link", async () => {
  const { charges, functions } = chargeFunctions();

  voke(functions, { config: config([idempotency({ store: memoryStore() })]) });

  await expect(
    functions.invoke("charge", { amount: 10, orderId: "ord_1" })
  ).resolves.toEqual({ chargeId: "ch_1" });
  expect(charges).toEqual(["ord_1"]);
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
