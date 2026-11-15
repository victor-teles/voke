import { expect, test } from "bun:test";

import { sqs } from "@voke/aws";
import { schema } from "@voke/schema";
import { createFunctions, voke } from "voke";

import { idempotentBatch } from "../src/batch";
import { memoryStore } from "../src/memory-store";
import { idempotency } from "../src/plugin";
import type { IdempotencyStore } from "../src/store";

const paymentMessage = schema.object({
  amount: schema.number(),
  paymentId: schema.string(),
});

const settleFunctions = (
  settle: (paymentId: string) => unknown,
  store: IdempotencyStore = memoryStore()
) => {
  const functions = createFunctions({
    settle: sqs({
      handler: idempotentBatch((message) => settle(message.body.paymentId), {
        key: (message) => message.body.paymentId,
      }),
      message: paymentMessage,
      queue: "paymentsQueue",
    }),
  });

  voke(functions, {
    config: { name: "test", plugins: [idempotency({ store })] },
  });

  return functions;
};

const delivery = (id: string, paymentId: string) => ({
  body: { amount: 10, paymentId },
  id,
});

test("a redelivered message is not processed again and is not reported as failed", async () => {
  const settled: string[] = [];
  const functions = settleFunctions((paymentId) => settled.push(paymentId));

  const first = await functions.sendEvent("settle", {
    messages: [delivery("m1", "pay_1"), delivery("m2", "pay_2")],
  });
  // SQS gives a redelivered message a new receive count; a duplicate producer send a new id.
  const second = await functions.sendEvent("settle", {
    messages: [delivery("m3", "pay_1")],
  });

  expect(first).toEqual({ batchItemFailures: [] });
  expect(second).toEqual({ batchItemFailures: [] });
  expect(settled).toEqual(["pay_1", "pay_2"]);
});

test("a throwing message is reported as failed and runs again on redelivery", async () => {
  const attempts: string[] = [];
  const functions = settleFunctions((paymentId) => {
    attempts.push(paymentId);

    if (paymentId === "pay_bad" && attempts.length === 2) {
      throw new Error("ledger unavailable");
    }
  });

  const first = await functions.sendEvent("settle", {
    messages: [delivery("m1", "pay_ok"), delivery("m2", "pay_bad")],
  });
  const retry = await functions.sendEvent("settle", {
    messages: [delivery("m2", "pay_bad")],
  });

  expect(first).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
  expect(retry).toEqual({ batchItemFailures: [] });
  expect(attempts).toEqual(["pay_ok", "pay_bad", "pay_bad"]);
});

test("a message that is in progress elsewhere is reported as failed", async () => {
  const store = memoryStore();
  const { promise: release, resolve } = Promise.withResolvers<undefined>();
  const blocked = settleFunctions(async () => await release, store);
  const other = settleFunctions(() => "settled", store);

  // Both registries key their records "settle", so they share records through the store.
  const running = blocked.sendEvent("settle", {
    messages: [delivery("m1", "pay_1")],
  });
  const concurrent = await other.sendEvent("settle", {
    messages: [delivery("m9", "pay_1")],
  });

  expect(concurrent).toEqual({ batchItemFailures: [{ itemIdentifier: "m9" }] });
  resolve();
  await expect(running).resolves.toEqual({ batchItemFailures: [] });
});
