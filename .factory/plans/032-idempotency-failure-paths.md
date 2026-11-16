# Plan 032: `@voke/idempotency` runs a retried handler once when the handler outlives its expiry or a store write fails, and reports the real error

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/idempotency apps/docs/content/docs/guides/idempotency.mdx apps/docs/content/docs/reference/errors.mdx apps/docs/content/docs/reference/packages.mdx CONTEXT.md docs/adr`
> and `git status --short` with the recorded current state. Expected drift from earlier plans of
> this round: plan 022 rewrites the `process.env` save/restore in
> `packages/idempotency/test/dynamodb-store.test.ts` (lines 68-76 today); plan 029 may change how
> the Plugin's table reaches Functions (`packages/idempotency/src/plugin.ts`); plans 027-029 may
> add ADRs, so the next free ADR number moves. Reconcile that. Pause only if
> `packages/idempotency/src/idempotent.ts`, `batch.ts`, `store.ts` or `dynamodb-store.ts` no
> longer match the excerpts below in a way that changes a decision.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (a new record status and a new store method; the batch handler starts throwing
  for store failures)
- **Depends on**: none. Ordering only: (022, same test file), (028, dead-letter queues receive
  the messages this plan keeps failing), (029, per-Function IAM for the Plugin's table).
- **Category**: bug
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

`@voke/idempotency` promises that a retried handler runs once. The promise holds on the happy
path and breaks on four failure paths: a handler that runs longer than `expiresAfterSeconds` is
run a second time while the first is still running; a result that cannot be stored makes every
retry run the handler again; a failing `release` hides the handler's own error; and
`idempotentBatch` swallows every error, so a missing Plugin or an `AccessDenied` on the table
fails every message with no trace. After this plan each path either prevents the second run or
tells the caller exactly what happened, and nothing fails without an error or a log line.

## Current state

### Architecture rules (binding)

- `AGENTS.md`: test first; small changes; no `console.log`; handle errors deliberately ("Avoid
  swallowing failures"); "Make invalid states hard to represent with TypeScript types".
- ADR `docs/adr/0007-opinionated-framework.md`: one supported way per layer, no deprecation
  aliases (the package is unreleased, version `0.0.0`).
- ADR `docs/adr/0017-idempotency-plugin.md` (the design this plan amends). Relevant lines:
  - "**Record lifecycle** (the layout and conditions of Powertools for AWS Lambda) ... One
    conditional `PutItem` writes `INPROGRESS` with `expiration` (epoch seconds) and
    `in_progress_expiration` (epoch milliseconds); it succeeds when no record exists, the record
    has expired, or it is `INPROGRESS` past its in-progress expiry."
  - "**The in-progress window is the Function's timeout** (`synthesis.timeout`, else
    `runtime.timeout`)".
  - "**Errors** are one `IdempotencyError extends Error` with four codes ... Messages never
    contain the key, the payload or the result."
- Plan 021's implementation rule, still binding for this package's own messages: "Never log the
  key, the payload or the stored result. Error messages name the Function and the record status,
  not the data."
- Vocabulary (`CONTEXT.md:251-261`): **Idempotency Key**, **Idempotency Record** ("the status
  (`INPROGRESS` or `COMPLETED`), the expiry, a hash of the validated input and the stored
  result"; avoid "lock", "cache entry"), **Idempotency Store** (avoid "idempotency cache",
  "persistence layer"). Also **Function**, **Plugin**, **Function Wrap**, **SQS Message Batch**,
  **SQS Batch Result**, **Event Invocation**.

### Code at `1c59d39`

Files (all under `packages/idempotency/`):

- `src/idempotent.ts` — the lifecycle (`runIdempotent`), option handling (`runWithOptions`),
  `idempotent`.
- `src/batch.ts` — `idempotentBatch`, the per-message SQS form.
- `src/store.ts` — `IdempotencyRecord`, `IdempotencyStore`, `blocksExecution`.
- `src/memory-store.ts`, `src/dynamodb-store.ts` — the two stores.
- `src/errors.ts` — `IdempotencyError` and its four codes.
- `src/plugin.ts` — the Plugin; puts `{ store, functionKey, timeoutSeconds, expiresAfterSeconds }`
  in an `AsyncLocalStorage` scope around each handler. Not changed by this plan.
- `test/lifecycle.test.ts` (lifecycle against `memoryStore()` with a fake clock),
  `test/batch.test.ts`, `test/dynamodb-store.test.ts` (a fake client that records commands),
  `test/plugin.test.ts`. `bun test` in the package: 34 pass, 0 fail.

The lifecycle, `src/idempotent.ts:163-203`:

```ts
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
// ...
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
```

The expiry check runs before the status check, `src/store.ts:42-60`:

```ts
if (existing.expiresAt < nowSeconds) {
  return false;
}

if (existing.status === "COMPLETED") {
  return true;
}

return (
  existing.inProgressExpiresAt === undefined ||
  existing.inProgressExpiresAt >= now
);
```

and the same in DynamoDB, `src/dynamodb-store.ts:66-67`:

```ts
export const acquireCondition =
  "attribute_not_exists(#id) OR #expiration < :now OR (#status = :inprogress AND attribute_exists(#in_progress_expiration) AND #in_progress_expiration < :now_in_millis)";
```

`expiresAfterSeconds` is only checked for shape, `src/idempotent.ts:28-37` (called from
`plugin.ts:36` and `idempotent.ts:281`): `if (!Number.isInteger(value) || value <= 0)` throws a
`VokeConfigError`.

`complete` is one unconditional `UpdateItemCommand` (`dynamodb-store.ts:240-262`) and `release`
one unconditional `DeleteItemCommand` (`:263-269`). Neither is wrapped or retried by the package.

The batch form, `src/batch.ts:35-44`:

```ts
for (const message of batch.messages) {
  try {
    await runWithOptions(message, options, messageBody, () =>
      processMessage(message, context)
    );
  } catch {
    // The message is retried by SQS; the error is not logged, as it may carry payload data.
    result.fail(message);
  }
}
```

Facts around it:

- `functions.sendEvent` and the Lambda event handler do not catch handler errors
  (`packages/core/src/invoke.ts:1885-1920`, `packages/aws/src/lambda-handlers.ts:249-255`). An
  error thrown by an SQS handler fails the invocation: Lambda logs it and SQS redelivers the
  whole batch.
- With no Plugin configured there is no Function Wrap, so `resolveScope` throws a
  `VokeConfigError` inside the loop above and the `catch` swallows it.
- Nothing enforces the Function timeout locally: `invoke.ts:1519-1540` races only the caller's
  `timeoutMs` option. On Lambda the runtime stops the execution at the timeout.
- `console.error` in run-time code has precedents that pass `bun run check`:
  `packages/aws/src/lambda-handlers.ts:138`
  (`console.error(`Request Authorizer Function "${key}" failed`, error);`) and
  `packages/core/src/app.ts:105`. Tests silence and assert it with
  `spyOn(console, "error").mockImplementation(() => {})` and `mockRestore()` in a `finally`
  (`packages/core/test/api.test.ts:805-836`).
- The table is `PAY_PER_REQUEST` by default
  (`packages/aws/src/cloudformation-synthesis.ts:151`), with time to live on `expiration`.

### The four defects, traced

Times use `t0` (epoch milliseconds) and `s0 = t0 / 1000`.

**A. A handler that outlives `expiresAfterSeconds` runs twice.** Plugin
`idempotency({ expiresAfterSeconds: 5 })`, Function timeout 30.

1. `t0`: call 1 acquires. Record: `INPROGRESS`, `expiration = s0 + 5`,
   `in_progress_expiration = t0 + 30000`. Handler 1 starts and runs for 10 seconds.
2. `t0 + 6000`: call 2 acquires. `memoryStore`: `expiresAt (s0+5) < nowSeconds (s0+6)`, so
   `blocksExecution` returns `false` before looking at the status. DynamoDB:
   `#expiration < :now` is true. Handler 2 runs while handler 1 is still running.
3. `t0 + 10000`: handler 1 returns and its unconditional `complete` overwrites call 2's record;
   or handler 1 throws and its unconditional `release` deletes call 2's record, so a third call
   can acquire.

DynamoDB time to live makes it worse: it may delete the in-progress item any time after
`s0 + 5`. The cause is the value written to `expiration`, not the Function timeout.

**B. A completion write that fails makes retries run the handler again.**

1. Call 1 acquires; the handler charges the card and returns.
2. `store.complete` rejects (a throttle that outlasts the SDK's retries, a network error, or a
   `ValidationException` because the item would exceed DynamoDB's 400 KB item limit).
3. The raw store error reaches the caller. Nothing says the handler ran. The record stays
   `INPROGRESS`.
4. After the Function timeout a retry takes the record over and runs the handler again. For an
   oversized result step 2 repeats on every retry: one side effect per retry, for ever.

For a transient failure, step 4 cannot be prevented: the store could not be written. For an
oversized result it can, because the store is available.

**C. A failing `release` hides the handler's error.** The handler throws `E1`;
`await input.store.release(input.id)` rejects with `E2`; `throw error` is never reached. The
caller sees `E2` (for example a DynamoDB error) and `E1` is lost.

**D. `idempotentBatch` swallows every error.** A store whose `acquire` rejects with
`AccessDeniedException`, or a project without the Plugin: every message is reported in
`batchItemFailures`, the Event Invocation succeeds, nothing is logged, and SQS redelivers until
retention ends. A second defect in the same loop: the value `processMessage` returns is stored
as the result, although nothing reads it. If it is not JSON (a `Response`, a `BigInt`) the
message fails with `IDEMPOTENCY_RESULT_NOT_SERIALIZABLE` after its side effect, the record is
released, and every redelivery runs the side effect again.

### Reference behaviour (Powertools for AWS Lambda, TypeScript)

Read on 2026-11-15 from the source on `main`
(`packages/idempotency/src/IdempotencyHandler.ts` and
`persistence/DynamoDBPersistenceLayer.ts` in `aws-powertools/powertools-lambda-typescript`):

- The acquire condition is the same three clauses joined with `OR`:
  `attribute_not_exists(#id)`, `#expiry < :now`, and
  `(#status = :inprogress AND attribute_exists(#in_progress_expiry) AND #in_progress_expiry < :now_in_millis)`.
- The update and the delete have no condition expression. There is no size check.
- A failed save of the result throws `IdempotencyPersistenceLayerError` ("Failed to update
  success record to idempotency store") with the store error as `cause`, and is not retried.
- When the function throws and the delete also throws, the caller gets
  `IdempotencyPersistenceLayerError` ("Failed to delete record from idempotency store"); the
  function's own error is discarded.

So Voke today matches Powertools on A, B and C. This plan departs from it on purpose in
decisions 1, 4 and 5. Not compared: what value Powertools writes to the expiry attribute while
in progress, and its batch utility's handling of store errors ("verify before coding" if a
comparison is wanted in the ADR; do not state either as fact).

### Added after plan 023 landed (2026-11-15)

Plan 023 made a route's `request.headers` and `request.query` plain objects. Before it,
`headers` was a `Headers` instance, which hashes as `{}`. So when `idempotent()` wraps a route
handler without a `validate` option, the payload hash now includes every header. A client retry
that differs only in a per-request header (a tracing id, `x-amzn-trace-id`, a date) now fails
with `IDEMPOTENCY_PAYLOAD_MISMATCH` instead of replaying. The guide and the tests pass
`validate: (r) => r.body`, so they are unaffected. Decide in this plan what the default hash
covers for a route (recommended: the body only, or require `validate` for route handlers), add
a regression test with two requests that differ only in a tracing header, and update
`apps/docs/content/docs/guides/idempotency.mdx`.

## Decisions taken in this plan

1. **An in-progress record expires no earlier than its in-progress window.** At acquire,
   `runIdempotent` writes
   `expiresAt = max(startedAtSeconds + expiresAfterSeconds, ceil(inProgressExpiresAt / 1000))`.
   `complete` keeps setting `completedAtSeconds + expiresAfterSeconds`, so a completed record
   replays for exactly `expiresAfterSeconds` as documented.
   _Why_: `expiration` is also the time-to-live attribute, so the stored value itself must be
   right; a status-aware condition alone would still let DynamoDB delete a running record.
   _Reverse_: restore the old `expiresAt` expression in `runIdempotent`.
2. **The acquire condition expression does not change.** It stays the three clauses quoted
   above, identical to Powertools. With decision 1 the clause `#expiration < :now` can be true
   for an `INPROGRESS` record only after its in-progress window, when the third clause would
   allow the takeover anyway. `blocksExecution` changes only for the new status of decision 4.
   _Reverse_: n/a (no change).
3. **`expiresAfterSeconds` is not validated against the Function timeout.** A value shorter
   than the timeout is a legitimate short replay window, and decision 1 makes it safe. The
   per-handler option is checked when the handler is wrapped, where the Function is not known,
   and a run-time check would fail every call of a valid configuration. The check stays "a
   positive integer". _Reverse_: compare in `runWithOptions`, where both values are in scope.
4. **A result too large to store is recorded, not retried.** The limit is
   `maxResultBytes = 350 * 1024` UTF-8 bytes of the result's JSON, checked in `runIdempotent`
   for every store. It leaves room under DynamoDB's 400 KB item limit for the other attributes
   and their names. Over the limit:
   - the record is marked with a new status, `RESULT_TOO_LARGE`, through a new store method
     `markResultTooLarge(id, expiresAt)` (same expiry as `complete`);
   - the first call rejects with `IdempotencyError` `IDEMPOTENCY_RESULT_TOO_LARGE`;
   - every retry until the record expires rejects with the same code, without running the
     handler.

   _Why_: the first call and every replay must have the same outcome, and the handler's side
   effect must not repeat. Failing the first call makes the problem visible in the first test
   that hits it; `memoryStore()` enforces the same limit so tests see it without AWS.
   _Reverse_: delete the size check, the status and the method; an oversized result then fails
   in the store and falls under decision 5.
   `IDEMPOTENCY_RESULT_NOT_SERIALIZABLE` keeps plan 021's behaviour (release and throw).

5. **`complete` is not retried by the package; its failure has its own error.** The DynamoDB
   client already retries throttles and transient errors (SDK default; planner's knowledge, 3
   attempts — verify before quoting a number in docs). A second loop without backoff adds
   little, and one with backoff needs timers and the remaining execution time, which
   `InvokeContext` does not have. When `complete` or `markResultTooLarge` rejects,
   `runIdempotent` throws `IdempotencyError` `IDEMPOTENCY_COMPLETE_FAILED` with the store error
   as `cause`. The record is left `INPROGRESS` (not released), so retries are rejected with
   `IDEMPOTENCY_IN_PROGRESS` until the Function timeout passes; after that a retry runs the
   handler again. That residue is inherent (the store could not be written) and is documented.
   The handler's result is not returned: returning it would hide a store failure, and Voke has
   no logger to report it through.
   _Reverse_: drop the wrapping `try`/`catch`; the raw store error propagates again.
6. **The handler's error wins over a `release` failure.** `runIdempotent` rethrows the
   handler's error object unchanged (same identity, so `VokeError` status mapping in the Gateway
   still works). The `release` failure is logged once with `console.error`: a fixed message
   naming the Function, then the store's error object. The record then stays `INPROGRESS` until
   the Function timeout passes, which only delays the retry. No `AggregateError`: it would
   change the type callers catch. _Reverse_: `await input.store.release(...)` without the `try`.
7. **`idempotentBatch` fails a message only for message-scoped errors; anything else fails the
   Event Invocation.** Message-scoped means: `processMessage` threw, or `runWithOptions` threw
   an `IdempotencyError` with code `IDEMPOTENCY_IN_PROGRESS`, `IDEMPOTENCY_PAYLOAD_MISMATCH` or
   `IDEMPOTENCY_KEY_MISSING`. Every other error (a store error, a missing table binding, a
   missing Plugin, `IDEMPOTENCY_COMPLETE_FAILED`, a `key` or `validate` function that throws)
   is rethrown unchanged. Lambda then reports and logs the invocation error and SQS redelivers
   the whole batch; messages that already completed replay as successes, so the redelivery is
   safe. The package does not log the rethrown error (Lambda does).
   _Why_: a store failure hits every message, and an invocation error is the signal operators
   watch; a payload mismatch belongs to one message and must not block or dead-letter its
   batch-mates. _Reverse_: turn the `throw` back into `result.fail(message)`.
8. **A failed message is logged, except an in-progress duplicate.** For a message-scoped
   failure other than `IDEMPOTENCY_IN_PROGRESS`, `idempotentBatch` calls `console.error` with a
   fixed message naming the SQS message id, then the error. This replaces the code comment "the
   error is not logged, as it may carry payload data". The package's own messages still never
   contain the key, the payload or the result; the logged error is the project's own, and in
   every other path (a Function, a route, a plain `sqs` handler that throws) it already reaches
   the log in full. `IDEMPOTENCY_IN_PROGRESS` is the expected outcome for a duplicate and is
   not logged. _Reverse_: delete the `console.error` call.
9. **`idempotentBatch` stores no result.** Its `run` callback awaits `processMessage` and
   returns `undefined`; the SQS handler never reads a stored result. This removes the
   not-serializable and too-large failures from the batch form. _Reverse_: return the value.
10. **`complete` and `release` stay unconditional** (no owner check). With decision 1 a
    takeover needs the Function timeout to have passed, and on Lambda the first execution has
    been stopped by then. See "Findings checked and dropped".

## Commands you will need

| Purpose           | Command                                                        | Expected on success    |
| ----------------- | -------------------------------------------------------------- | ---------------------- |
| Package tests     | `cd packages/idempotency && bun test`                          | 0 fail (34 pass today) |
| One test file     | `cd packages/idempotency && bun test test/lifecycle.test.ts`   | 0 fail                 |
| Package typecheck | `cd packages/idempotency && bun run typecheck`                 | exit 0                 |
| Example           | `cd examples/sqs-events && bun test && bun run typecheck`      | 0 fail, exit 0         |
| Surface pin       | `cd packages/core && bun test test/public-surface.test.ts`     | 0 fail                 |
| Docs samples      | `cd apps/docs && bun run check:samples guides/idempotency.mdx` | exit 0                 |
| Docs tests/links  | `cd apps/docs && bun run test && bun run lint:links`           | exit 0                 |
| Format            | `bun x ultracite fix`                                          | exit 0                 |
| Repo gates        | `bun run check && bun run typecheck && bun run test`           | exit 0                 |

Only `cd packages/idempotency && bun test` ran during planning (34 pass). The others are the
repository's verified commands at `1c59d39`.

## Implementation rules relevant to this plan

- Test first: write each test of a step, see it fail for the reason stated, then change the
  code.
- No test uses real time, timers, the network or a real AWS client. Use the existing
  `fakeClock()` in `lifecycle.test.ts` and the `fakeClient()` in `dynamodb-store.test.ts`.
- Run-time code must not use the `Bun` global (the Lambda runtime is Node.js). Use
  `import { Buffer } from "node:buffer"` for `Buffer.byteLength(data, "utf8")`.
- Error and log messages written by this package name the Function, the record status and the
  SQS message id. Never the Idempotency Key, the payload or the result.
- No `console.log`. `console.error` is the only log call, used exactly twice (decisions 6
  and 8). If `bun run check` rejects it, see how `packages/aws/src/lambda-handlers.ts:138`
  passes and do the same.
- Tests that expect a log line spy on it and restore it:
  `const errorLog = spyOn(console, "error").mockImplementation(() => {});` then
  `errorLog.mockRestore()` in a `finally`, as in `packages/core/test/api.test.ts:805-836`.
- Acquire stays one conditional write. Do not add a read before it.
- Do not edit lines 68-76 of `test/dynamodb-store.test.ts` (the `process.env` handling); plan
  022 owns them.
- Ultracite style: early returns, `for...of`, no nested ternaries, no `.only`/`.skip`.

## Scope

**In scope**:

- `packages/idempotency/src/idempotent.ts`, `batch.ts`, `store.ts`, `memory-store.ts`,
  `dynamodb-store.ts`, `errors.ts`
- `packages/idempotency/test/lifecycle.test.ts`, `batch.test.ts`, `dynamodb-store.test.ts`;
  `packages/idempotency/test/failing-store.ts` (create: the test helper of Step 1)
- `apps/docs/content/docs/guides/idempotency.mdx`, `apps/docs/content/docs/reference/errors.mdx`,
  `apps/docs/content/docs/reference/packages.mdx` (the `IdempotencyError` row)
- `CONTEXT.md` (the **Idempotency Record** entry)
- `docs/adr/<next free number>-idempotency-failure-paths.md` (create)

**Out of scope**:

- `packages/idempotency/test/dynamodb-store.test.ts:68-76` — plan 022.
- `packages/idempotency/src/plugin.ts` and `index.ts` — no change needed; the run-time export
  list pinned in `packages/core/test/public-surface.test.ts:259-271` stays the same (only types
  change: two error codes, one status, one store method).
- `packages/core/src`, `packages/aws/src` — no core or `@voke/aws` change.
- Dead-letter queues for messages that keep failing — plan 028.
- Scoping the idempotency table to the Functions that use it — plan 029.
- Owner checks on `complete`/`release`, a retry loop for `complete`, HTTP status mapping for
  `IdempotencyError`, other stores, concurrent batch processing.
- `docs/adr/0017-idempotency-plugin.md` — ADRs are records; the new ADR amends it.

## Git workflow

- Branch: `feature/idempotency-failure-paths`, stacked on the previous plan's branch of this
  round (base `feature/docs-revamp` at `1c59d39` if none).
- Commit subjects are imperative sentences that state the outcome, for example "Keep a retried
  handler to one run when a store write fails". Commit only if the task authorizes it. Do not
  push or open a PR unless told.

## Steps

### Step 1: A store that fails on demand (test helper)

Create `packages/idempotency/test/failing-store.ts`: a function that wraps an
`IdempotencyStore` and rejects chosen methods.

```ts
export const failingStore = (
  store: IdempotencyStore,
  failures: Partial<Record<keyof IdempotencyStore, Error>>
): IdempotencyStore
```

Each method rejects with its entry in `failures` when one is set (without calling the wrapped
store) and delegates otherwise. Tests mutate nothing global; to "heal" the store, a test builds
a second wrapper around the same `memoryStore()`.

### Step 2: An in-progress record outlives the handler (decisions 1-3)

Tests first, in `test/lifecycle.test.ts`:

1. "a call while a handler outlives expiresAfterSeconds fails with IDEMPOTENCY_IN_PROGRESS":
   `lifecycle(store, clock.now, { expiresAfterSeconds: 5, timeoutSeconds: 30 })`; start a first
   `runIdempotent` whose `run` returns a pending promise (`Promise.withResolvers`);
   `clock.advance(6000)`; a second `runIdempotent` must reject with `IDEMPOTENCY_IN_PROGRESS`
   and its `run` must not be called. **Fails today**: the second call acquires and runs.
   Then `clock.advance(24_000)` (now `t0 + 30000`): still `IDEMPOTENCY_IN_PROGRESS`;
   `clock.advance(1)`: the next call runs (takeover). Resolve the first promise at the end.
2. "an in-progress record expires no earlier than its in-progress window": wrap `memoryStore()`
   so `acquire` records the record it receives. With `expiresAfterSeconds: 5, timeoutSeconds: 30`
   expect `expiresAt === Math.ceil(inProgressExpiresAt / 1000)`; with the defaults
   (`3600`, `15`) expect `expiresAt === startOfDay / 1000 + 3600`. **First half fails today.**
3. "a completed record replays for expiresAfterSeconds even when the timeout is longer":
   `expiresAfterSeconds: 5, timeoutSeconds: 30`; run to completion; `advance(5000)`: replay
   (handler count 1); `advance(1000)`: runs again (count 2). Passes today and must keep passing.

Change, in `runIdempotent` only:

```ts
const inProgressExpiresAt =
  startedAt + input.timeoutSeconds * millisecondsPerSecond;
// `expiresAfterSeconds` may be shorter than the Function timeout, and DynamoDB time to live
// deletes on `expiration`: a running record must not expire before its in-progress window.
const expiresAt = Math.max(
  startedAtSeconds + input.expiresAfterSeconds,
  Math.ceil(inProgressExpiresAt / millisecondsPerSecond)
);
```

Leave `acquireCondition`, `assertExpiresAfterSeconds` and the existing assertion of the
condition string in `test/dynamodb-store.test.ts:113-115` untouched.

**Evidence**: `bun test test/lifecycle.test.ts` → all pass, including the existing "an
in-progress record past the Function timeout is taken over".

### Step 3: The handler's error wins over a failed release (decision 6)

Tests first, in `test/lifecycle.test.ts`, with
`failingStore(memoryStore(), { release: releaseError })` and a `console.error` spy:

1. "when release fails too, the handler's error is the one thrown":
   `await expect(runIdempotent(input, () => { throw failure; })).rejects.toBe(failure)`.
   **Fails today** (rejects with `releaseError`).
2. Same test or a second one: the spy was called once; its first argument contains
   `Function "charge"` and does not contain the record id's key part; its second argument is
   `releaseError`.
3. "after a failed release, a call inside the Function timeout is rejected, and one after it
   runs": with a healthy wrapper around the same memory store, the next call rejects with
   `IDEMPOTENCY_IN_PROGRESS`; after `clock.advance(15_001)` it runs.

Change: replace `await input.store.release(input.id);` with a small function in
`idempotent.ts`:

```ts
const releaseAfterFailure = async (
  input: RunIdempotentInput
): Promise<void> => {
  try {
    await input.store.release(input.id);
  } catch (releaseError) {
    // The handler's error is the one the caller needs; this one only delays the retry.
    console.error(
      `idempotent() could not release the Idempotency Record of Function "${input.functionKey}". Calls with the same key are rejected with IDEMPOTENCY_IN_PROGRESS until the Function timeout passes`,
      releaseError
    );
  }
};
```

The existing test "a Response result fails with IDEMPOTENCY_RESULT_NOT_SERIALIZABLE and
releases the record" goes through the same path and must stay green.

### Step 4: A result that cannot be stored (decisions 4 and 5)

Tests first.

`test/lifecycle.test.ts`:

1. "a failed completion write rejects with IDEMPOTENCY_COMPLETE_FAILED and keeps the store's
   error as cause": `failingStore(memoryStore(), { complete: throttled })`; the call rejects
   with an `IdempotencyError` whose `code` is `IDEMPOTENCY_COMPLETE_FAILED` and whose `cause`
   is `throttled`; `run` was called once. **Fails today** (rejects with the raw error).
2. "after a failed completion write the record still blocks until the Function timeout": with a
   healthy wrapper around the same memory store, a retry rejects with
   `IDEMPOTENCY_IN_PROGRESS` and does not run; after `clock.advance(15_001)` it runs. This is
   the documented residue; the test pins that the record is not released.
3. "a result over maxResultBytes is recorded and fails with IDEMPOTENCY_RESULT_TOO_LARGE": `run`
   returns `"x".repeat(maxResultBytes)` (its JSON is two bytes longer). The first call rejects
   with `IDEMPOTENCY_RESULT_TOO_LARGE`; a second call rejects with the same code; `run` was
   called once. **Fails today** (`memoryStore` stores it and both calls resolve).
4. "the limit counts UTF-8 bytes": `"é".repeat(maxResultBytes / 2)` (two bytes per character,
   plus the quotes) is too large; `"x".repeat(maxResultBytes - 2)` is stored and replayed.
5. "an oversized-result record expires like a completed one": after
   `clock.advance((expiresAfterSeconds + 1) * 1000)` the handler runs again.
6. "a payload mismatch is reported before the stored status": same id, other `validation`,
   against a `RESULT_TOO_LARGE` record → `IDEMPOTENCY_PAYLOAD_MISMATCH`.
7. "a failed markResultTooLarge rejects with IDEMPOTENCY_COMPLETE_FAILED":
   `failingStore(memoryStore(), { markResultTooLarge: denied })`.

`test/dynamodb-store.test.ts`:

8. "markResultTooLarge sets the status and the expiry and removes the in-progress expiry": one
   `UpdateItemCommand` with `Key: { id: { S } }`,
   `UpdateExpression: "SET #status = :status, #expiration = :expiration REMOVE #in_progress_expiration"`,
   `ExpressionAttributeValues: { ":expiration": { N }, ":status": { S: "RESULT_TOO_LARGE" } }`
   and the three name placeholders.
9. "a blocking item with status RESULT_TOO_LARGE maps to the existing record": a
   `conditionalCheckFailed(item)` whose item has `status: { S: "RESULT_TOO_LARGE" }` and no
   `data` → `{ acquired: false, existing: { status: "RESULT_TOO_LARGE", ... } }`.

Changes:

- `src/errors.ts`: add `"IDEMPOTENCY_COMPLETE_FAILED"` and `"IDEMPOTENCY_RESULT_TOO_LARGE"` to
  `IdempotencyErrorCode` (keep the union sorted).
- `src/store.ts`:
  - `status: "COMPLETED" | "INPROGRESS" | "RESULT_TOO_LARGE"`, with a doc line: the handler
    finished and its result was too large to store; the record blocks a new execution until
    `expiresAt`, like `COMPLETED`.
  - `IdempotencyStore.markResultTooLarge(id: string, expiresAt: number): Promise<void>` —
    "Marks the record `RESULT_TOO_LARGE` with a new `expiresAt` (epoch seconds)."
  - `blocksExecution`: `if (existing.status !== "INPROGRESS") { return true; }`.
- `src/memory-store.ts`: implement `markResultTooLarge` like `complete` (keep `validation`, no
  `data`, no `inProgressExpiresAt`; no-op when the record is gone).
- `src/dynamodb-store.ts`: implement `markResultTooLarge` with the command of test 8 (share the
  status/expiry update with `complete` only if it stays simpler than two commands; the existing
  `complete` assertions at `test/dynamodb-store.test.ts:174-221` must not change); `fromItem`
  accepts the third status. The acquire condition needs no change: a `RESULT_TOO_LARGE` item
  passes only the `#expiration < :now` clause.
- `src/idempotent.ts`:
  - `export const maxResultBytes = 350 * 1024;` with a comment giving the reason (DynamoDB's
    400 KB item limit, minus room for the other attributes).
  - `replayExisting`: after the `INPROGRESS` and the validation checks, throw
    `IDEMPOTENCY_RESULT_TOO_LARGE` for a `RESULT_TOO_LARGE` record.
  - After the handler returned:

    ```ts
    const expiresAt = completedAtSeconds + input.expiresAfterSeconds;
    const tooLarge =
      data !== undefined && Buffer.byteLength(data, "utf8") > maxResultBytes;

    try {
      await (tooLarge
        ? input.store.markResultTooLarge(input.id, expiresAt)
        : input.store.complete(input.id, data, expiresAt));
    } catch (error) {
      throw completeFailed(input.functionKey, error);
    }

    if (tooLarge) {
      throw resultTooLarge(input.functionKey);
    }
    ```

  - Messages (one helper each, used by the first call and by replays):
    - `IDEMPOTENCY_RESULT_TOO_LARGE`: `Function "<key>" returned a result larger than idempotent() can store (<maxResultBytes> bytes of JSON). The operation ran once and is recorded (record status RESULT_TOO_LARGE); return a smaller value, such as an id`
    - `IDEMPOTENCY_COMPLETE_FAILED` (with `{ cause }`): `Function "<key>" ran, but its Idempotency Record could not be updated (record status INPROGRESS). Calls with the same key are rejected until the Function timeout passes; after that a retry runs the handler again`

**Evidence**: `bun test` in the package → 0 fail; `bun run typecheck` → exit 0 (it fails until
both stores implement the new method, which is the type system doing its job).

### Step 5: `idempotentBatch` fails the invocation for store failures and logs failed messages (decisions 7-9)

Tests first, in `test/batch.test.ts`. `settleFunctions(settle, store)` already accepts a store.

1. "a store failure fails the Event Invocation with the store's error":
   `failingStore(memoryStore(), { acquire: denied })` where `denied` is an `Error` named
   `AccessDeniedException`; `functions.sendEvent("settle", { messages: [m1, m2] })` rejects, and
   the rejection `toBe(denied)`; `settle` was never called. **Fails today**: it resolves with
   both messages in `batchItemFailures`.
2. "a batch without the Plugin rejects with a VokeConfigError": build the registry as
   `settleFunctions` does but with `voke(functions, { config: { name: "test" } })`.
   **Fails today** for the same reason.
3. "a completion failure fails the invocation, and completed messages replay on redelivery":
   one shared `memoryStore()`. First registry uses a wrapper whose `complete` rejects only for
   the second message (make the helper accept a predicate, or build the wrapper inline in this
   test): the invocation rejects with `IDEMPOTENCY_COMPLETE_FAILED`. Second registry on the same
   memory store, healthy: redelivering both messages returns
   `{ batchItemFailures: [{ itemIdentifier: <second id> }] }` (its record is still
   `INPROGRESS`), and `settle` is not called again for either message.
4. "a message whose function throws is failed and logged with its message id": with a
   `console.error` spy: `batchItemFailures` holds the message; the spy was called once; the
   first argument contains the message id (`m2`) and not the payment id; the second argument is
   the thrown error. **The log assertion fails today.** The existing test "a throwing message is
   reported as failed and runs again on redelivery" needs the same spy so it stays quiet.
5. "an in-progress message is failed without a log line": the existing third test plus a spy
   that was not called.
6. "a payload mismatch fails only that message": deliver `pay_1` with `amount: 10`, then one
   batch with `pay_1` at `amount: 20` and a new `pay_2`: only the first is in
   `batchItemFailures`, `pay_2` is settled, and one line is logged.
7. "the value processMessage returns is not stored": `settle` returns `Response.json({})`.
   First delivery: `{ batchItemFailures: [] }`. Second delivery of the same payment id:
   `{ batchItemFailures: [] }`, and `settle` ran once. **Fails today**: the message is failed
   with `IDEMPOTENCY_RESULT_NOT_SERIALIZABLE`, released, and processed again.

Change `src/batch.ts` to this shape:

```ts
const messageScopedCodes: ReadonlySet<IdempotencyErrorCode> = new Set([
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_KEY_MISSING",
  "IDEMPOTENCY_PAYLOAD_MISMATCH",
]);

// inside the handler
for (const message of batch.messages) {
  const attempt = { handlerFailed: false };

  try {
    await runWithOptions(message, options, messageBody, async () => {
      try {
        // The SQS handler reads no result, so none is stored.
        await processMessage(message, context);
      } catch (error) {
        attempt.handlerFailed = true;
        throw error;
      }
    });
  } catch (error) {
    if (!isMessageScoped(error, attempt.handlerFailed)) {
      // A store or configuration failure: fail the Event Invocation, so Lambda reports it and
      // SQS redelivers the batch. Completed messages replay as successes.
      throw error;
    }

    if (attempt.handlerFailed || !isInProgress(error)) {
      console.error(
        `idempotentBatch() reports SQS message "${message.id}" as failed`,
        error
      );
    }

    result.fail(message);
  }
}
```

Use an object (`attempt`), not a `let` flag: TypeScript does not see an assignment made inside
the callback and would treat the flag as always `false`. Extract `isMessageScoped` and
`isInProgress` as small top-level functions. Update the JSDoc of `idempotentBatch` to state the
rule of decision 7 and delete the old comment about not logging.

**Evidence**: `bun test` in the package → 0 fail;
`cd examples/sqs-events && bun test` → 0 fail (its test delivers a payment twice through
`createLambdaHandlers` with `memoryStore()` and expects one settlement; that must not change).

### Step 6: Docs, vocabulary and the ADR

- `apps/docs/content/docs/guides/idempotency.mdx`:
  - "What happens on a retry" table: add rows for "The result is larger than 350 KB of JSON"
    (`IDEMPOTENCY_RESULT_TOO_LARGE` on the first call and on every retry until the record
    expires; the handler does not run again) and "The record could not be marked completed"
    (`IDEMPOTENCY_COMPLETE_FAILED` with the store's error as `cause`; retries get
    `IDEMPOTENCY_IN_PROGRESS` until the Function timeout passes, then the handler runs again).
    Change "The handler threw" to say the handler's own error is always the one rethrown.
  - "Expiry": add that `expiresAfterSeconds` may be shorter than the Function timeout; a
    running call still blocks duplicates for the whole timeout.
  - "Run each SQS message once" bullets: a message fails on its own when its function throws,
    its key is in progress elsewhere, its payload differs from the first delivery, or its key is
    missing with `onMissingKey: "throw"`; failed messages are logged with their message id
    (except in-progress duplicates); any other error, such as a table the Function cannot reach,
    fails the whole invocation; the value the function returns is not stored.
  - "Limits": replace "A DynamoDB item holds at most 400 KB, so a stored result must be smaller."
    with the 350 KB limit and what happens above it; add "run once" has one exception: if the
    completion write fails, a retry after the Function timeout runs the handler again; add that
    `voke dev` and tests do not enforce the Function timeout, so a handler paused longer than it
    can be run again by a duplicate.
  - Line 166 ("Voke never logs them") stays true; add that `idempotentBatch` logs the error a
    message's function throws.
  - Any new TypeScript fence must be ` ```ts twoslash ` and compile. Prose-only edits are
    enough; no new sample is required.
- `apps/docs/content/docs/reference/errors.mdx` ("Idempotency errors", lines 135-146): change
  "four" wording if present, add the two codes to the table, and add one sentence: in
  `idempotentBatch`, store and configuration errors fail the invocation.
- `apps/docs/content/docs/reference/packages.mdx:167`: extend the `IdempotencyError` row with
  "its result is too large, or its record could not be completed".
- `CONTEXT.md:255-256`, **Idempotency Record**: "the status (`INPROGRESS`, `COMPLETED` or
  `RESULT_TOO_LARGE`), ...". No new term.
- ADR `docs/adr/<next free number>-idempotency-failure-paths.md` (list `docs/adr/`; three ADRs
  share 0007, the highest today is 0017). One page, in the style of ADR 0017, recording
  decisions 1-10, that it amends ADR 0017's record lifecycle and error list, and the departures
  from Powertools listed under "Reference behaviour". Do not edit ADR 0017.

**Evidence**: `cd apps/docs && bun run check:samples guides/idempotency.mdx` → exit 0;
`bun run test && bun run lint:links` in `apps/docs` → exit 0.

### Step 7: Gates

Run `bun x ultracite fix`, then `bun run check && bun run typecheck && bun run test` from the
repository root.

## Test plan

- New, `test/lifecycle.test.ts`: Step 2 tests 1-3, Step 3 tests 1-3, Step 4 tests 1-7.
- New, `test/dynamodb-store.test.ts`: Step 4 tests 8-9.
- New, `test/batch.test.ts`: Step 5 tests 1-7; the existing throwing-message test gains a
  `console.error` spy.
- New helper: `test/failing-store.ts`.
- Unchanged and must stay green: all 34 existing tests, in particular
  `test/plugin.test.ts` ("idempotency() reads its table binding when a wrapped handler first
  runs" still rejects with a raw `VokeResourceBindingError`: acquire failures are not wrapped),
  the acquire-condition string assertion, and `examples/sqs-events/test/sqs-events.test.ts`.
- Pattern: the existing tests in each file (fake clock, `counter()`, `rejectionCode()`,
  `fakeClient()`).
- Verification: `cd packages/idempotency && bun test` → 0 fail, at least 50 tests.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] With `expiresAfterSeconds` shorter than the timeout, a second call during the first is
      rejected with `IDEMPOTENCY_IN_PROGRESS` (Step 2 test 1)
- [ ] A failing `release` no longer changes the error the caller gets, and is logged once
      (Step 3 tests 1-2)
- [ ] An oversized result is run once and reported with `IDEMPOTENCY_RESULT_TOO_LARGE` on every
      call; a failed completion write is reported with `IDEMPOTENCY_COMPLETE_FAILED` and its
      `cause` (Step 4)
- [ ] `idempotentBatch` rejects for a store failure and for a missing Plugin, and logs failed
      messages (Step 5 tests 1, 2 and 4)
- [ ] `grep -n "catch {" packages/idempotency/src/batch.ts` returns no matches
- [ ] `grep -rn "console\." packages/idempotency/src` shows exactly two `console.error` calls
- [ ] `grep -rn "Date.now\|setTimeout" packages/idempotency/test` returns no matches
- [ ] `git diff --stat 1c59d39 -- packages/core/src packages/aws/src packages/idempotency/src/plugin.ts packages/idempotency/src/index.ts`
      shows no change made by this plan
- [ ] The acquire condition string in `src/dynamodb-store.ts` is unchanged
- [ ] The guide, the error reference and `CONTEXT.md` name the two new codes and the new
      status; the ADR exists
- [ ] `cd apps/docs && bun run check:samples guides/idempotency.mdx` exits 0

## STOP conditions

- Step 2 test 1 passes before the change. Then the trace in "A" is wrong for the current code;
  report what `runIdempotent` writes to `expiresAt` instead of changing the stores.
- Rethrowing from `idempotentBatch` does not fail the invocation: `functions.sendEvent` or the
  Lambda event handler has started catching handler errors (plan 028 may change the SQS path).
  Decision 7 then needs the owner's choice between failing all messages and rethrowing.
- Plan 028 or 029 has changed `batch.ts`, `idempotent.ts` or the store contract in a way that
  conflicts with decisions 4, 7 or 9.
- The fix needs a change in `packages/core/src` or `packages/aws/src`.
- `bun run check` rejects `console.error` in this package and the two precedents no longer
  exist. Report it; do not swallow the errors instead.

## Findings checked and dropped

- "The acquire condition ignores status": partly wrong. The third clause checks
  `#status = :inprogress`; the second clause, `#expiration < :now`, is the status-blind one. It
  is the same expression Powertools uses (verified from source). The defect is the value written
  to `expiration`, fixed by decision 1; the expression stays.
- "`complete` and `release` are unconditional": true, and the same as Powertools. Dropped as a
  defect: after decision 1 another execution can take a record over only once the Function
  timeout has passed, when Lambda has stopped the first one. It still matters where the timeout
  is not enforced (`voke dev`, tests) and for `idempotent(handler, { store })` without the
  Plugin, which assumes 15 seconds (`src/idempotent.ts:25`; plan 021 decision 2 scopes that
  option to unit tests). Recorded under maintenance notes.
- "`complete` is not retried": the package adds no retry, and the SDK client has its own.
  Decided in decision 5; no loop is added.
- "`IDEMPOTENCY_RESULT_NOT_SERIALIZABLE` releases the record after the handler ran": a recorded
  decision (plan 021 decision 5, `test/lifecycle.test.ts:172`). It fails on a handler's first
  call in any test, unlike a size limit that depends on data. Kept for `idempotent`; removed
  for `idempotentBatch` by decision 9.
- "`idempotentBatch` does not log": the silence was deliberate (the code comment), to keep
  payload data out of logs. Narrowed by decision 8, not dropped.
- `packages/idempotency/test/dynamodb-store.test.ts:75` (`process.env = { ...savedEnv }`):
  belongs to plan 022.

## Maintenance notes

- "Run once" has one residue: if the completion write is lost, the record stays `INPROGRESS`
  and a retry after the Function timeout runs the handler again. Closing it needs either an
  outbox written in the same transaction as the side effect or the remaining execution time for
  a backoff loop; both are out of scope.
- `complete`, `markResultTooLarge` and `release` have no owner check. If Voke ever runs
  handlers past their timeout on AWS (or exposes the remaining time on `InvokeContext`), add an
  owner token to the record and make the three writes conditional on it.
- `maxResultBytes` is one constant for every store. If a second production store appears, move
  the limit to the store.
- A new status is a change to stored data. A deployment that predates this plan would reject a
  `RESULT_TOO_LARGE` item as malformed; the package is unreleased, so there is no migration.
- Plan 028's dead-letter queue is where a message with a permanent payload mismatch ends up;
  until then it is redelivered until retention ends, now with one log line per delivery.
- Reviewers should check: the handler's error object is rethrown unchanged; no log line or
  error message contains the key, the payload or the result; the acquire is still one
  conditional write; `idempotentBatch` rethrows instead of logging for store failures.
- Deferred: validating `expiresAfterSeconds` against the timeout (decision 3), a retry loop for
  `complete`, returning the handler's result when the completion write fails, per-message
  results in the batch form.
