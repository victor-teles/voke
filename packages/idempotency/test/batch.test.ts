import { expect, spyOn, test } from "bun:test";

import { sqs } from "@voke/aws";
import { schema } from "@voke/schema";
import {
  createFunctions,
  voke,
  VokeConfigError,
  VokeResourceBindingError,
} from "voke";

import { idempotentBatch } from "../src/batch";
import { IdempotencyError } from "../src/errors";
import { memoryStore } from "../src/memory-store";
import { idempotency } from "../src/plugin";
import type { IdempotencyStore } from "../src/store";
import { failingStore } from "./failing-store";

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

const delivery = (id: string, paymentId: string, amount = 10) => ({
  body: { amount, paymentId },
  id,
});

// Silences console.error for `run` and returns the arguments of each call.
const capturingErrors = async (
  run: () => Promise<void>
): Promise<unknown[][]> => {
  const errorLog = spyOn(console, "error").mockImplementation(() => {});

  try {
    await run();

    return errorLog.mock.calls.map((call) => [...call]);
  } finally {
    errorLog.mockRestore();
  }
};

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

  const results: unknown[] = [];

  await capturingErrors(async () => {
    results.push(
      await functions.sendEvent("settle", {
        messages: [delivery("m1", "pay_ok"), delivery("m2", "pay_bad")],
      }),
      await functions.sendEvent("settle", {
        messages: [delivery("m2", "pay_bad")],
      })
    );
  });
  const [first, retry] = results;

  expect(first).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
  expect(retry).toEqual({ batchItemFailures: [] });
  expect(attempts).toEqual(["pay_ok", "pay_bad", "pay_bad"]);
});

test("a message that is in progress elsewhere is reported as failed without a log line", async () => {
  const store = memoryStore();
  const { promise: release, resolve } = Promise.withResolvers<undefined>();
  const blocked = settleFunctions(async () => await release, store);
  const other = settleFunctions(() => "settled", store);

  // Both registries key their records "settle", so they share records through the store.
  const running = blocked.sendEvent("settle", {
    messages: [delivery("m1", "pay_1")],
  });
  const results: unknown[] = [];
  const logged = await capturingErrors(async () => {
    results.push(
      await other.sendEvent("settle", {
        messages: [delivery("m9", "pay_1")],
      })
    );
  });

  expect(results).toEqual([{ batchItemFailures: [{ itemIdentifier: "m9" }] }]);
  expect(logged).toEqual([]);
  resolve();
  await expect(running).resolves.toEqual({ batchItemFailures: [] });
});

test("idempotentBatch in a Function that does not link the table rejects the whole invocation", async () => {
  const settled: string[] = [];
  const functions = createFunctions({
    settle: sqs({
      handler: idempotentBatch(
        (message) => settled.push(message.body.paymentId),
        { key: (message) => message.body.paymentId }
      ),
      message: paymentMessage,
      queue: "paymentsQueue",
    }),
  });

  voke(functions, { config: { name: "test", plugins: [idempotency()] } });

  await expect(
    functions.sendEvent("settle", { messages: [delivery("m1", "pay_1")] })
  ).rejects.toThrow(
    new VokeResourceBindingError(
      'Function "settle" does not link resource "idempotencyTable". Add it to the Function: resources: ["idempotencyTable"]'
    )
  );
  expect(settled).toEqual([]);
});

test("a store failure fails the Event Invocation with the store's error", async () => {
  const settled: string[] = [];
  const denied = Object.assign(new Error("not authorized"), {
    name: "AccessDeniedException",
  });
  const functions = settleFunctions(
    (paymentId) => settled.push(paymentId),
    failingStore(memoryStore(), { acquire: denied })
  );

  await expect(
    functions.sendEvent("settle", {
      messages: [delivery("m1", "pay_1"), delivery("m2", "pay_2")],
    })
  ).rejects.toBe(denied);
  expect(settled).toEqual([]);
});

test("a batch without the Plugin rejects with a VokeConfigError", async () => {
  const settled: string[] = [];
  const functions = createFunctions({
    settle: sqs({
      handler: idempotentBatch(
        (message) => settled.push(message.body.paymentId),
        { key: (message) => message.body.paymentId }
      ),
      message: paymentMessage,
      queue: "paymentsQueue",
    }),
  });

  voke(functions, { config: { name: "test" } });

  await expect(
    functions.sendEvent("settle", { messages: [delivery("m1", "pay_1")] })
  ).rejects.toBeInstanceOf(VokeConfigError);
  expect(settled).toEqual([]);
});

test("a completion failure fails the invocation, and completed messages replay on redelivery", async () => {
  const settled: string[] = [];
  const store = memoryStore();
  const completions = { count: 0 };
  // Completes the first message's record and fails the second one's completion write.
  const failsSecondCompletion: IdempotencyStore = {
    ...store,
    complete: (id, data, expiresAt) => {
      completions.count += 1;

      return completions.count === 2
        ? Promise.reject(new Error("slow down"))
        : store.complete(id, data, expiresAt);
    },
  };
  const messages = [delivery("m1", "pay_1"), delivery("m2", "pay_2")];

  const rejection = await settleFunctions(
    (paymentId) => settled.push(paymentId),
    failsSecondCompletion
  )
    .sendEvent("settle", { messages })
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(IdempotencyError);
  expect((rejection as IdempotencyError).code).toBe(
    "IDEMPOTENCY_COMPLETE_FAILED"
  );

  const results: unknown[] = [];
  const logged = await capturingErrors(async () => {
    results.push(
      await settleFunctions(
        (paymentId) => settled.push(paymentId),
        store
      ).sendEvent("settle", { messages })
    );
  });

  // The second record is still INPROGRESS until the Function timeout passes.
  expect(results).toEqual([{ batchItemFailures: [{ itemIdentifier: "m2" }] }]);
  expect(logged).toEqual([]);
  expect(settled).toEqual(["pay_1", "pay_2"]);
});

test("a message whose function throws is failed and logged with its message id", async () => {
  const failure = new Error("ledger unavailable");
  const functions = settleFunctions((paymentId) => {
    if (paymentId === "pay_secret") {
      throw failure;
    }
  });
  const results: unknown[] = [];

  const logged = await capturingErrors(async () => {
    results.push(
      await functions.sendEvent("settle", {
        messages: [delivery("m1", "pay_ok"), delivery("m2", "pay_secret")],
      })
    );
  });

  expect(results).toEqual([{ batchItemFailures: [{ itemIdentifier: "m2" }] }]);
  expect(logged).toHaveLength(1);
  expect(String(logged[0]?.[0])).toContain('"m2"');
  expect(String(logged[0]?.[0])).not.toContain("pay_secret");
  expect(logged[0]?.[1]).toBe(failure);
});

test("a payload mismatch fails only that message", async () => {
  const settled: string[] = [];
  const functions = settleFunctions((paymentId) => settled.push(paymentId));

  await functions.sendEvent("settle", {
    messages: [delivery("m1", "pay_1", 10)],
  });

  const results: unknown[] = [];
  const logged = await capturingErrors(async () => {
    results.push(
      await functions.sendEvent("settle", {
        messages: [delivery("m2", "pay_1", 20), delivery("m3", "pay_2")],
      })
    );
  });

  expect(results).toEqual([{ batchItemFailures: [{ itemIdentifier: "m2" }] }]);
  expect(settled).toEqual(["pay_1", "pay_2"]);
  expect(logged).toHaveLength(1);
  expect(logged[0]?.[1]).toMatchObject({
    code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
  });
});

test("the value processMessage returns is not stored", async () => {
  const settled: string[] = [];
  const functions = settleFunctions((paymentId) => {
    settled.push(paymentId);

    return Response.json({});
  });

  const first = await functions.sendEvent("settle", {
    messages: [delivery("m1", "pay_1")],
  });
  const second = await functions.sendEvent("settle", {
    messages: [delivery("m2", "pay_1")],
  });

  expect(first).toEqual({ batchItemFailures: [] });
  expect(second).toEqual({ batchItemFailures: [] });
  expect(settled).toEqual(["pay_1"]);
});
