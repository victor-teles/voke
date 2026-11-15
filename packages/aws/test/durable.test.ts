import { afterAll, beforeAll, expect, test } from "bun:test";

import { createFunctions, InvokeError, voke, VokeConfigError } from "voke";
import type { StandardSchemaV1 } from "voke";

import { awsLambda, durable } from "../src/index";
import {
  runDurable,
  setupDurableTests,
  teardownDurableTests,
} from "../src/testing";

interface Order {
  id: string;
  quantity: number;
}

const orderSchema: StandardSchemaV1<unknown, Order> = {
  "~standard": {
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string" &&
      "quantity" in value &&
      typeof value.quantity === "number"
        ? { value: { id: value.id, quantity: value.quantity } }
        : { issues: [{ message: "expected an order" }] },
    vendor: "voke-test",
    version: 1,
  },
};

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

interface Receipt {
  functionName: string;
  orderId: string;
  reservationId: string;
}

const createOrderFunctions = (calls: string[]) =>
  createFunctions({
    fulfilOrder: durable({
      executionTimeout: { hours: 24 },
      handler: async (order, context) => {
        const reservation = await context.durable.step(
          "reserve-stock",
          async () => {
            calls.push(`reserve:${order.id}`);

            return await Promise.resolve({ id: `r-${order.id}` });
          }
        );
        await context.durable.wait("cooling-off", { minutes: 10 });

        return {
          functionName: context.functionName,
          orderId: order.id,
          reservationId: reservation.id,
        };
      },
      input: orderSchema,
      output: schema<Receipt>(),
    }),
  });

beforeAll(async () => {
  await setupDurableTests();
});

afterAll(async () => {
  await teardownDurableTests();
});

test("functions.invoke runs a durable Function locally and returns its validated output", async () => {
  const calls: string[] = [];
  const functions = createOrderFunctions(calls);

  voke(functions, { config: { name: "shop" } });

  await expect(
    functions.invoke("fulfilOrder", { id: "o-1", quantity: 2 })
  ).resolves.toEqual({
    functionName: "fulfilOrder",
    orderId: "o-1",
    reservationId: "r-o-1",
  });
  // The ten-minute wait replays the handler, but the checkpointed step runs once.
  expect(calls).toEqual(["reserve:o-1"]);
});

test("an invalid payload rejects with INVALID_PAYLOAD before any step runs", async () => {
  const calls: string[] = [];
  const functions = createOrderFunctions(calls);

  voke(functions, { config: { name: "shop" } });

  const failure = await functions
    .invoke("fulfilOrder", { id: "o-2" } as never)
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(InvokeError);
  expect((failure as InvokeError).code).toBe("INVALID_PAYLOAD");
  expect(calls).toEqual([]);
});

test("a failing step is retried by its retry strategy", async () => {
  let attempts = 0;
  const functions = createFunctions({
    charge: durable({
      executionTimeout: { minutes: 5 },
      handler: async (_payload, context) =>
        await context.durable.step(
          "charge-card",
          async () => {
            attempts += 1;

            if (attempts < 3) {
              throw new Error(`card declined ${attempts}`);
            }

            return await Promise.resolve("charged");
          },
          {
            retryStrategy: (_error, attemptCount) =>
              attemptCount < 5
                ? { delay: { seconds: 30 }, shouldRetry: true }
                : { shouldRetry: false },
          }
        ),
      output: schema<string>(),
    }),
  });

  voke(functions, { config: { name: "shop" } });

  await expect(functions.invoke("charge")).resolves.toBe("charged");
  expect(attempts).toBe(3);
});

test("a failing execution rejects with the error its handler threw", async () => {
  const functions = createFunctions({
    refund: durable({
      executionTimeout: { minutes: 5 },
      handler: async (_payload, context) =>
        await context.durable.step(
          "refund-card",
          () => {
            throw new TypeError("refund rejected");
          },
          { retryStrategy: () => ({ shouldRetry: false }) }
        ),
      output: schema<string>(),
    }),
  });

  voke(functions, { config: { name: "shop" } });

  const failure = await functions
    .invoke("refund")
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(InvokeError);
  expect((failure as Error).message).toContain("refund rejected");
});

test("runDurable returns the result and the recorded operations", async () => {
  const calls: string[] = [];
  const functions = createOrderFunctions(calls);

  voke(functions, { config: { name: "shop" } });

  const run = await runDurable(functions, "fulfilOrder", {
    id: "o-3",
    quantity: 1,
  });

  expect(run.result).toEqual({
    functionName: "fulfilOrder",
    orderId: "o-3",
    reservationId: "r-o-3",
  });
  expect(
    run.operations.map((operation) => [
      operation.getName(),
      operation.getType(),
    ])
  ).toEqual([
    ["reserve-stock", "STEP"],
    ["cooling-off", "WAIT"],
  ]);
  expect(run.operations[1]?.getWaitDetails()?.waitSeconds).toBe(600);
  expect(calls).toEqual(["reserve:o-3"]);
});

test("durable(...) returns an invokable Function whose Lambda record carries the durable settings", () => {
  const definition = durable({
    executionTimeout: { days: 1, minutes: 30 },
    handler: () => "done",
    output: schema<string>(),
    retentionDays: 30,
    synthesis: { provider: awsLambda({ architecture: "x86_64" }), timeout: 60 },
  });

  expect(definition.kind).toBe("invokable");
  expect(definition.synthesis).toEqual({
    provider: {
      aws: {
        properties: {
          architecture: "x86_64",
          durable: { executionTimeoutSeconds: 88_200, retentionDays: 30 },
        },
        type: "lambda.function",
      },
    },
    timeout: 60,
  });
});

test("durable(...) rejects a missing or non-positive execution timeout", () => {
  expect(() =>
    durable({
      executionTimeout: undefined as never,
      handler: () => "done",
      output: schema<string>(),
    })
  ).toThrow(VokeConfigError);
  expect(() =>
    durable({
      executionTimeout: { seconds: 0 } as never,
      handler: () => "done",
      output: schema<string>(),
    })
  ).toThrow(/executionTimeout/u);
  expect(() =>
    durable({
      executionTimeout: { seconds: 1.5 } as never,
      handler: () => "done",
      output: schema<string>(),
    })
  ).toThrow(/whole number of seconds/u);
});
