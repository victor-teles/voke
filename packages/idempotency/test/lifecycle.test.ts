import { expect, spyOn, test } from "bun:test";

import { IdempotencyError } from "../src/errors";
import { hashValue, maxResultBytes, runIdempotent } from "../src/idempotent";
import type { RunIdempotentInput } from "../src/idempotent";
import { memoryStore } from "../src/memory-store";
import type { IdempotencyRecord, IdempotencyStore } from "../src/store";
import { failingStore } from "./failing-store";

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

const pending = <TResult>() => Promise.withResolvers<TResult>();

test("a call while a handler outlives expiresAfterSeconds fails with IDEMPOTENCY_IN_PROGRESS", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now, {
    expiresAfterSeconds: 5,
    timeoutSeconds: 30,
  });
  const { promise, resolve } = pending<string>();
  const first = runIdempotent(input, () => promise);
  const { calls, run } = counter("second");

  clock.advance(6000);
  expect(await rejectionCode(runIdempotent(input, run))).toBe(
    "IDEMPOTENCY_IN_PROGRESS"
  );
  expect(calls.count).toBe(0);

  clock.advance(24_000);
  expect(await rejectionCode(runIdempotent(input, run))).toBe(
    "IDEMPOTENCY_IN_PROGRESS"
  );
  expect(calls.count).toBe(0);

  clock.advance(1);
  await expect(runIdempotent(input, run)).resolves.toBe("second");
  expect(calls.count).toBe(1);

  resolve("first");
  await first;
});

test("an in-progress record expires no earlier than its in-progress window", async () => {
  const acquired: IdempotencyRecord[] = [];
  const recording = (): IdempotencyStore => {
    const store = memoryStore();

    return {
      ...store,
      acquire: (record, now) => {
        acquired.push(record);

        return store.acquire(record, now);
      },
    };
  };
  const clock = fakeClock();

  await runIdempotent(
    lifecycle(recording(), clock.now, {
      expiresAfterSeconds: 5,
      timeoutSeconds: 30,
    }),
    () => "short"
  );
  await runIdempotent(lifecycle(recording(), clock.now), () => "default");

  const [short, defaults] = acquired;

  expect(short?.inProgressExpiresAt).toBe(startOfDay + 30_000);
  expect(short?.expiresAt).toBe(
    Math.ceil((short?.inProgressExpiresAt ?? 0) / 1000)
  );
  expect(defaults?.expiresAt).toBe(startOfDay / 1000 + 3600);
});

test("a completed record replays for expiresAfterSeconds even when the timeout is longer", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now, {
    expiresAfterSeconds: 5,
    timeoutSeconds: 30,
  });
  const { calls, run } = counter("done");

  await runIdempotent(input, run);
  clock.advance(5000);
  await expect(runIdempotent(input, run)).resolves.toBe("done");
  expect(calls.count).toBe(1);

  clock.advance(1000);
  await runIdempotent(input, run);
  expect(calls.count).toBe(2);
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

test("when release fails too, the handler's error is the one thrown and the release failure is logged once", async () => {
  const clock = fakeClock();
  const releaseError = new Error("table unavailable");
  const failure = new Error("card declined");
  const input = lifecycle(
    failingStore(memoryStore(), { release: releaseError }),
    clock.now,
    { id: "charge##secret-key-hash" }
  );

  const logged = await capturingErrors(async () => {
    await expect(
      runIdempotent(input, () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });

  expect(logged).toHaveLength(1);
  expect(String(logged[0]?.[0])).toContain('Function "charge"');
  expect(String(logged[0]?.[0])).not.toContain("secret-key-hash");
  expect(logged[0]?.[1]).toBe(releaseError);
});

test("after a failed release, a call inside the Function timeout is rejected, and one after it runs", async () => {
  const clock = fakeClock();
  const store = memoryStore();

  await capturingErrors(async () => {
    await runIdempotent(
      lifecycle(
        failingStore(store, { release: new Error("table unavailable") }),
        clock.now
      ),
      () => {
        throw new Error("card declined");
      }
    ).catch(() => {});
  });

  const healthy = lifecycle(store, clock.now);
  const { calls, run } = counter("charged");

  expect(await rejectionCode(runIdempotent(healthy, run))).toBe(
    "IDEMPOTENCY_IN_PROGRESS"
  );
  clock.advance(15_001);
  await expect(runIdempotent(healthy, run)).resolves.toBe("charged");
  expect(calls.count).toBe(1);
});

test("a failed completion write rejects with IDEMPOTENCY_COMPLETE_FAILED and keeps the store's error as cause", async () => {
  const clock = fakeClock();
  const throttled = new Error("slow down");
  const { calls, run } = counter("charged");
  const rejection = await runIdempotent(
    lifecycle(failingStore(memoryStore(), { complete: throttled }), clock.now),
    run
  ).catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(IdempotencyError);
  expect((rejection as IdempotencyError).code).toBe(
    "IDEMPOTENCY_COMPLETE_FAILED"
  );
  expect((rejection as IdempotencyError).cause).toBe(throttled);
  expect((rejection as IdempotencyError).message).toContain(
    'Function "charge"'
  );
  expect(calls.count).toBe(1);
});

test("after a failed completion write the record still blocks until the Function timeout", async () => {
  const clock = fakeClock();
  const store = memoryStore();

  await runIdempotent(
    lifecycle(
      failingStore(store, { complete: new Error("slow down") }),
      clock.now
    ),
    () => "charged"
  ).catch(() => {});

  const healthy = lifecycle(store, clock.now);
  const { calls, run } = counter("charged again");

  expect(await rejectionCode(runIdempotent(healthy, run))).toBe(
    "IDEMPOTENCY_IN_PROGRESS"
  );
  expect(calls.count).toBe(0);
  clock.advance(15_001);
  await expect(runIdempotent(healthy, run)).resolves.toBe("charged again");
  expect(calls.count).toBe(1);
});

test("a result over maxResultBytes is recorded and fails with IDEMPOTENCY_RESULT_TOO_LARGE", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now);
  const { calls, run } = counter("x".repeat(maxResultBytes));

  expect(await rejectionCode(runIdempotent(input, run))).toBe(
    "IDEMPOTENCY_RESULT_TOO_LARGE"
  );
  clock.advance(1000);
  expect(await rejectionCode(runIdempotent(input, run))).toBe(
    "IDEMPOTENCY_RESULT_TOO_LARGE"
  );
  expect(calls.count).toBe(1);
});

test("the result size limit counts UTF-8 bytes", async () => {
  const clock = fakeClock();
  const twoByteCharacters = "é".repeat(maxResultBytes / 2);
  const fits = "x".repeat(maxResultBytes - 2);

  expect(
    await rejectionCode(
      runIdempotent(
        lifecycle(memoryStore(), clock.now),
        () => twoByteCharacters
      )
    )
  ).toBe("IDEMPOTENCY_RESULT_TOO_LARGE");

  const input = lifecycle(memoryStore(), clock.now);
  const { calls, run } = counter(fits);

  await expect(runIdempotent(input, run)).resolves.toBe(fits);
  await expect(runIdempotent(input, run)).resolves.toBe(fits);
  expect(calls.count).toBe(1);
});

test("an oversized-result record expires like a completed one", async () => {
  const clock = fakeClock();
  const input = lifecycle(memoryStore(), clock.now, {
    expiresAfterSeconds: 60,
  });
  const { calls, run } = counter("x".repeat(maxResultBytes));

  await runIdempotent(input, run).catch(() => {});
  clock.advance(61_000);
  expect(await rejectionCode(runIdempotent(input, run))).toBe(
    "IDEMPOTENCY_RESULT_TOO_LARGE"
  );
  expect(calls.count).toBe(2);
});

test("a payload mismatch is reported before an oversized-result status", async () => {
  const clock = fakeClock();
  const store = memoryStore();
  const { run } = counter("x".repeat(maxResultBytes));

  await runIdempotent(lifecycle(store, clock.now), run).catch(() => {});

  expect(
    await rejectionCode(
      runIdempotent(
        lifecycle(store, clock.now, { validation: hashValue({ amount: 20 }) }),
        run
      )
    )
  ).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH");
});

test("a failed markResultTooLarge rejects with IDEMPOTENCY_COMPLETE_FAILED", async () => {
  const clock = fakeClock();
  const denied = new Error("access denied");
  const rejection = await runIdempotent(
    lifecycle(
      failingStore(memoryStore(), { markResultTooLarge: denied }),
      clock.now
    ),
    () => "x".repeat(maxResultBytes)
  ).catch((error: unknown) => error);

  expect((rejection as IdempotencyError).code).toBe(
    "IDEMPOTENCY_COMPLETE_FAILED"
  );
  expect((rejection as IdempotencyError).cause).toBe(denied);
});
