import { expect, test } from "bun:test";

import { IdempotencyError } from "../src/errors";
import { hashValue, runIdempotent } from "../src/idempotent";
import type { RunIdempotentInput } from "../src/idempotent";
import { memoryStore } from "../src/memory-store";
import type { IdempotencyStore } from "../src/store";

const startOfDay = Date.UTC(2026, 10, 15);

const fakeClock = () => {
  let current = startOfDay;

  return {
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    now: () => current,
  };
};

const lifecycle = (
  store: IdempotencyStore,
  now: () => number,
  overrides: Partial<RunIdempotentInput> = {}
): RunIdempotentInput => ({
  expiresAfterSeconds: 3600,
  functionKey: "charge",
  id: "charge##key",
  now,
  store,
  timeoutSeconds: 15,
  validation: hashValue({ amount: 10 }),
  ...overrides,
});

const counter = <TResult>(result?: TResult) => {
  const calls = { count: 0 };
  const run = () => {
    calls.count += 1;

    return result;
  };

  return { calls, run };
};

const rejectionCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IdempotencyError) {
      return error.code;
    }

    throw error;
  }

  throw new Error("expected the call to reject");
};

test("the first call runs the handler and a second call replays its stored result", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now);
  const { calls, run } = counter({ chargeId: "ch_1" });

  await expect(runIdempotent(input, run)).resolves.toEqual({
    chargeId: "ch_1",
  });
  clock.advance(1000);
  await expect(runIdempotent(input, run)).resolves.toEqual({
    chargeId: "ch_1",
  });
  expect(calls.count).toBe(1);
});

test("the same key with a different payload fails with IDEMPOTENCY_PAYLOAD_MISMATCH", async () => {
  const clock = fakeClock();
  const store = memoryStore();
  const { calls, run } = counter("done");

  await runIdempotent(lifecycle(store, clock.now), run);

  expect(
    await rejectionCode(
      runIdempotent(
        lifecycle(store, clock.now, { validation: hashValue({ amount: 20 }) }),
        run
      )
    )
  ).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH");
  expect(calls.count).toBe(1);
});

test("a call while the first is still running fails with IDEMPOTENCY_IN_PROGRESS", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now);
  const { promise: release, resolve } = Promise.withResolvers<string>();
  const first = runIdempotent(input, () => release);

  expect(await rejectionCode(runIdempotent(input, () => "second"))).toBe(
    "IDEMPOTENCY_IN_PROGRESS"
  );

  resolve("first");
  await expect(first).resolves.toBe("first");
});

test("a handler that throws releases the record, so the next call runs again", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now);
  const failure = new Error("card declined");

  await expect(
    runIdempotent(input, () => {
      throw failure;
    })
  ).rejects.toBe(failure);

  const { calls, run } = counter("charged");

  await expect(runIdempotent(input, run)).resolves.toBe("charged");
  expect(calls.count).toBe(1);
});

test("a completed record that has expired runs the handler again", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now, {
    expiresAfterSeconds: 60,
  });
  const { calls, run } = counter("ok");

  await runIdempotent(input, run);
  clock.advance(60_000);
  await runIdempotent(input, run);
  expect(calls.count).toBe(1);

  clock.advance(1000);
  await runIdempotent(input, run);
  expect(calls.count).toBe(2);
});

test("an in-progress record past the Function timeout is taken over", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now, { timeoutSeconds: 15 });
  // The first execution never finishes: the Function timed out.
  const stuck = runIdempotent(
    input,
    () => Promise.withResolvers<never>().promise
  );

  clock.advance(15_000);
  expect(await rejectionCode(runIdempotent(input, () => "early"))).toBe(
    "IDEMPOTENCY_IN_PROGRESS"
  );

  clock.advance(1);
  await expect(runIdempotent(input, () => "retried")).resolves.toBe("retried");
  expect(stuck).toBeInstanceOf(Promise);
});

test("an undefined result is stored as no data and replays as undefined", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now);
  const { calls, run } = counter();

  await expect(runIdempotent(input, run)).resolves.toBeUndefined();
  await expect(runIdempotent(input, run)).resolves.toBeUndefined();
  expect(calls.count).toBe(1);
});

test("a Response result fails with IDEMPOTENCY_RESULT_NOT_SERIALIZABLE and releases the record", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now);

  expect(
    await rejectionCode(runIdempotent(input, () => Response.json({ ok: true })))
  ).toBe("IDEMPOTENCY_RESULT_NOT_SERIALIZABLE");

  const { calls, run } = counter({ ok: true });

  await expect(runIdempotent(input, run)).resolves.toEqual({ ok: true });
  expect(calls.count).toBe(1);
});

test("the first call resolves to the stored JSON value, like a replay", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now);
  const createdAt = new Date(startOfDay);

  await expect(runIdempotent(input, () => ({ createdAt }))).resolves.toEqual({
    createdAt: createdAt.toISOString(),
  });
});

test("key order in a payload does not change its hash", () => {
  expect(hashValue({ amount: 10, nested: { a: 1, b: 2 }, orderId: "o" })).toBe(
    hashValue({ amount: 10, nested: { a: 1, b: 2 }, orderId: "o" })
  );
  expect(hashValue({ amount: 10 })).not.toBe(hashValue({ amount: 11 }));
});
