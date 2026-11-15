// Run-time module: imported by deployed Functions through voke.config.ts.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { VokeConfigError } from "voke";

import { IdempotencyError } from "./errors";
import type { IdempotencyRecord, IdempotencyStore } from "./store";

/** What the Plugin's Function Wrap puts around one handler call. */
export interface IdempotencyScope {
  readonly store: IdempotencyStore;
  readonly functionKey: string;
  /** The Function's timeout: how long an `INPROGRESS` record blocks other calls. */
  readonly timeoutSeconds: number;
  /** The Plugin's default for `expiresAfterSeconds`. */
  readonly expiresAfterSeconds: number;
}

export const idempotencyScope = new AsyncLocalStorage<IdempotencyScope>();

export const defaultExpiresAfterSeconds = 3600;
// Voke's default Function timeout; used only when `idempotent` runs outside the Plugin with its
// own `store`, where no Function timeout is known.
const unscopedTimeoutSeconds = 15;
const millisecondsPerSecond = 1000;

export const assertExpiresAfterSeconds = (
  value: number,
  where: string
): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new VokeConfigError(
      `${where} expected expiresAfterSeconds to be a positive integer of seconds; received ${String(value)}`
    );
  }
};

export interface IdempotencyOptions<TInput> {
  /**
   * The Idempotency Key: the application value that identifies one logical operation, such as
   * an order id. `undefined` or `""` means the input has no key; see `onMissingKey`.
   */
  readonly key: (input: TInput) => string | undefined;
  /** Separates the records of several operations wrapped in one Function. */
  readonly name?: string;
  /** How long a completed record replays its result. Defaults to the Plugin's value (3600). */
  readonly expiresAfterSeconds?: number;
  /**
   * The part of the input that must be equal on a replay. Defaults to the whole input. A replay
   * with the same key and a different value fails with `IDEMPOTENCY_PAYLOAD_MISMATCH`.
   */
  readonly validate?: (input: TInput) => unknown;
  /** `"run"` (default) runs the handler without idempotency; `"throw"` rejects with `IDEMPOTENCY_KEY_MISSING`. */
  readonly onMissingKey?: "run" | "throw";
  /** A store used instead of the Plugin's, for unit tests that call the handler directly. */
  readonly store?: IdempotencyStore;
}

export interface RunIdempotentInput {
  readonly store: IdempotencyStore;
  readonly id: string;
  readonly validation: string;
  readonly expiresAfterSeconds: number;
  readonly timeoutSeconds: number;
  readonly functionKey: string;
  /** Epoch milliseconds. */
  readonly now: () => number;
}

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Sorts object keys, so `{ a, b }` and `{ b, a }` hash the same.
const sortKeys = (_key: string, value: unknown): unknown =>
  isRecordObject(value)
    ? Object.fromEntries(
        Object.entries(value).toSorted(([left], [right]) =>
          left < right ? -1 : 1
        )
      )
    : value;

/** SHA-256 (hex) of a JSON string with sorted object keys. */
export const hashValue = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(value, sortKeys) ?? "undefined")
    .digest("hex");

export const recordId = (
  functionKey: string,
  name: string | undefined,
  key: string
): string => `${functionKey}#${name ?? ""}#${hashValue(key)}`;

const notSerializable = (
  functionKey: string,
  cause?: unknown
): IdempotencyError =>
  new IdempotencyError(
    "IDEMPOTENCY_RESULT_NOT_SERIALIZABLE",
    `Function "${functionKey}" returned a value idempotent() cannot store as JSON. Return a plain value; the Gateway wraps it in { data }`,
    { cause }
  );

// The stored form of a result: a JSON string, or undefined for `undefined`.
const serializeResult = (
  result: unknown,
  functionKey: string
): string | undefined => {
  if (result === undefined) {
    return undefined;
  }

  if (result instanceof Response) {
    throw notSerializable(functionKey);
  }

  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(result);
  } catch (error) {
    throw notSerializable(functionKey, error);
  }

  if (serialized === undefined) {
    throw notSerializable(functionKey);
  }

  return serialized;
};

const readStoredResult = (data: string | undefined): unknown =>
  data === undefined ? undefined : JSON.parse(data);

const replayExisting = (
  existing: IdempotencyRecord,
  input: RunIdempotentInput
): unknown => {
  if (existing.status === "INPROGRESS") {
    throw new IdempotencyError(
      "IDEMPOTENCY_IN_PROGRESS",
      `Function "${input.functionKey}" is already running this operation (record status INPROGRESS). Retry later`
    );
  }

  if (existing.validation !== input.validation) {
    throw new IdempotencyError(
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      `Function "${input.functionKey}" already completed this operation with a different payload (record status COMPLETED)`
    );
  }

  return readStoredResult(existing.data);
};

/**
 * Runs `run` once per record id: acquire with one conditional write, replay a completed record,
 * reject a live in-progress one, release the record when `run` throws. The first call and every
 * replay resolve to the same JSON value.
 */
export const runIdempotent = async (
  input: RunIdempotentInput,
  run: () => unknown
): Promise<unknown> => {
  const startedAt = input.now();
  const startedAtSeconds = Math.floor(startedAt / millisecondsPerSecond);
  const acquire = await input.store.acquire(
    {
      expiresAt: startedAtSeconds + input.expiresAfterSeconds,
      id: input.id,
      inProgressExpiresAt:
        startedAt + input.timeoutSeconds * millisecondsPerSecond,
      status: "INPROGRESS",
      validation: input.validation,
    },
    startedAt
  );

  if (!acquire.acquired) {
    return replayExisting(acquire.existing, input);
  }

  let data: string | undefined;

  try {
    data = serializeResult(await run(), input.functionKey);
  } catch (error) {
    await input.store.release(input.id);
    throw error;
  }

  const completedAtSeconds = Math.floor(input.now() / millisecondsPerSecond);

  await input.store.complete(
    input.id,
    data,
    completedAtSeconds + input.expiresAfterSeconds
  );

  return readStoredResult(data);
};

const missingPluginMessage =
  "idempotent() needs the idempotency() Plugin in voke.config.ts, or a store in its options";

const resolveScope = (
  store: IdempotencyStore | undefined
): IdempotencyScope => {
  const scope = idempotencyScope.getStore();

  if (store !== undefined) {
    return {
      expiresAfterSeconds:
        scope?.expiresAfterSeconds ?? defaultExpiresAfterSeconds,
      functionKey: scope?.functionKey ?? "",
      store,
      timeoutSeconds: scope?.timeoutSeconds ?? unscopedTimeoutSeconds,
    };
  }

  if (scope === undefined) {
    throw new VokeConfigError(missingPluginMessage);
  }

  return scope;
};

/**
 * Runs one input through the record lifecycle. Shared by `idempotent` and `idempotentBatch`;
 * `defaultValidate` is what `validate` falls back to.
 */
export const runWithOptions = async <TInput>(
  input: TInput,
  options: IdempotencyOptions<TInput>,
  defaultValidate: (input: TInput) => unknown,
  run: () => unknown
): Promise<unknown> => {
  const scope = resolveScope(options.store);
  const key = options.key(input);

  if (key === undefined || key === "") {
    if (options.onMissingKey === "throw") {
      throw new IdempotencyError(
        "IDEMPOTENCY_KEY_MISSING",
        `Function "${scope.functionKey}" received an input without an Idempotency Key`
      );
    }

    return await run();
  }

  return await runIdempotent(
    {
      expiresAfterSeconds:
        options.expiresAfterSeconds ?? scope.expiresAfterSeconds,
      functionKey: scope.functionKey,
      id: recordId(scope.functionKey, options.name, key),
      now: Date.now,
      store: scope.store,
      timeoutSeconds: scope.timeoutSeconds,
      validation: hashValue((options.validate ?? defaultValidate)(input)),
    },
    run
  );
};

/** Checks the options when a handler is wrapped, so a bad option fails at import, not per call. */
export const assertIdempotencyOptions = <TInput>(
  options: IdempotencyOptions<TInput>,
  where: string
): void => {
  if (typeof options.key !== "function") {
    throw new VokeConfigError(
      `${where} expected key to be a function that returns the Idempotency Key`
    );
  }

  if (options.expiresAfterSeconds !== undefined) {
    assertExpiresAfterSeconds(options.expiresAfterSeconds, where);
  }
};

const wholeInput = <TInput>(input: TInput): unknown => input;

/**
 * Makes a handler run once per Idempotency Key. A second call with the same key resolves to the
 * stored result without running the handler. Needs the `idempotency()` Plugin, or `store`.
 */
export const idempotent = <TInput, TContext, TResult>(
  handler: (input: TInput, context: TContext) => TResult | Promise<TResult>,
  options: IdempotencyOptions<TInput>
): ((input: TInput, context: TContext) => Promise<Awaited<TResult>>) => {
  assertIdempotencyOptions(options, "idempotent()");

  return async (
    input: TInput,
    context: TContext
  ): Promise<Awaited<TResult>> => {
    const result = await runWithOptions(input, options, wholeInput, () =>
      handler(input, context)
    );

    return result as Awaited<TResult>;
  };
};
