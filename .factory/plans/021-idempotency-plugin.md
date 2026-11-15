# Plan 021: `@voke/idempotency` makes a retried handler run once, backed by a DynamoDB table the Plugin provisions

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 4015c46 -- packages/core/src packages/aws/src packages/aws/test examples/sqs-events apps/docs docs CONTEXT.md roadmap-v2.md README.md`
> and `git status --short` with the recorded current state. Plan 019 lands first and changes
> core and `@voke/aws` on purpose; plans 014 and 018 may also have landed (see "State after the
> prerequisite plans"). Reconcile that drift; pause only if it invalidates a protected contract
> or a decision listed below.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `.factory/plans/019-plugin-contract.md` (hard: `contributions.resources`,
  `runtime.setup`, the Function Wrap, Plugins in registry-only projects). Ordering only: after
  `.factory/plans/014-open-event-source-contract.md` (it changes the event handler types that
  `idempotentBatch` builds on) and `.factory/plans/018-durable-functions.md` (the guide's Durable
  Function section refers to it). Independent of plan 020.
- **Category**: dx
- **Planned at**: commit `4015c46`, 2026-11-14

## Why this matters

AWS delivers events at least once. SQS redelivers a message when the Function times out or a
batch partly fails, an HTTP client retries a POST after a network error, and an asynchronous
Lambda invocation is retried twice by default. A handler that charges a card or sends an email
must therefore be safe to run twice. Today every Voke project has to build that itself: a table,
a conditional write, a lock for the in-flight case, an expiry and the IAM for it.
`roadmap-v2.md` phase 10 asks for "helpers for idempotency keys".

After this plan, a project adds `idempotency()` to `voke.config.ts`, wraps a handler with
`idempotent(handler, { key })`, and gets the table, its permissions, its binding and the
semantics. It is also the first Plugin that contributes a resource, so it proves that part of
the Plugin contract.

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: specialized helpers live in
  their own `@voke/*` package; `voke` stays provider-neutral; "`@voke/aws` depends on public
  `voke` and owns the full AWS workflow". `@voke/idempotency` is AWS-backed, so it may depend on
  `@voke/aws`; core must not learn about DynamoDB.
- ADR `docs/adr/0007-opinionated-framework.md`: one supported way per layer, one spelling per
  setting, no deprecation aliases.
- ADR `docs/adr/0003-sqs-event-sources.md`: "Partial batch failure reporting is the default for
  every SQS Event Source"; handlers "report failed message ids without handcrafting AWS response
  shapes".
- ADR `docs/adr/0009-aws-emulator-local-provider.md`: locally, "Resources run in the emulator and
  Function code runs in the local Gateway"; "Resource bindings come from stack outputs" written
  by `voke local bootstrap`; `createAwsClientConfig()` "returns an explicit `endpoint` whenever a
  Local AWS Provider is configured".
- Vocabulary from `CONTEXT.md`: **Function**, **Function Registry**, **Gateway**, **Event
  Source**, **SQS Message Batch**, **SQS Batch Result**, **Event Invocation**, **Provider**,
  **Local AWS Provider**; and from plan 019: **Plugin**, **Function Wrap**, **Plugin
  Contribution**.

### Code at `4015c46`

- **Table builder**, `packages/aws/src/cloudformation-synthesis.ts:126-164`:
  ```ts
  export const dynamodbTable = (
    options: {
      partitionKey?: string;
      sortKey?: string;
      billingMode?: "PAY_PER_REQUEST" | "PROVISIONED";
    } = {}
  ): StackResourceDefinition => {
  ```
  It grants `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query` and `Scan` on the
  table ARN, binds the attribute `name` (`bindingValue: "ref"`), and has **no time-to-live
  option**. `grep -ri "TimeToLive" packages/aws/src` finds nothing.
- **Who gets access**: every Function role receives the statements of every declared resource
  (`cloudformation-synthesis.ts:1012-1018`), and every Function receives every resource binding
  as an environment variable (`packages/core/src/model.ts`, `bindings`). A contributed table is
  therefore readable and writable from every Function with no extra IAM record.
- **Bindings and clients**, `packages/aws/src/resources.ts:22-49` and `:57-75`:
  `bindResource("idempotencyTable", "name").value()` reads
  `VOKE_RESOURCE_IDEMPOTENCY_TABLE_NAME` and throws `VokeResourceBindingError` when it is
  missing; `createAwsClientConfig()` returns `{ region, endpoint? }` for
  `new DynamoDBClient(createAwsClientConfig())`.
- **SDK in the bundle**: `packages/core/src/config.ts:187` sets
  `defaultBuildExternal = ["@aws-sdk/*"]`, documented at `config.ts:59` as "the AWS SDK, which the
  Lambda Node.js runtime provides". `@aws-sdk/client-dynamodb` is therefore left out of the
  Lambda bundle by default. `@voke/aws` does not depend on it today
  (`packages/aws/package.json`); `apps/docs/package.json` has it as a `devDependency`
  (`^3.1053.0`).
- **SQS handler shape**, `packages/aws/src/sqs.ts:64-99` and `:143-161`: the handler receives a
  batch with `messages` (each `{ id, body, attributes, messageAttributes, raw, valid: true }`),
  `batchResult()` (a builder with `fail(message)`) and `ok()`, plus an `InvokeContext`, and
  returns an `SqsBatchResult`. `message.id` is the SQS `messageId` (`sqs.ts:303-310`).
- **Invoke context**, `packages/core/src/invoke.ts:88-94`: `{ functionName, trace, variables }`.
  It carries no remaining-time value and no Plugin slot.
- **Function timeout**: `definition.synthesis?.timeout ?? config.runtime.timeout`, default 15
  seconds (`packages/core/src/model.ts:587`, `config.ts:299-300`).
- **Errors**: `VokeError` takes a `code` from a closed union (`packages/core/src/errors/shared.ts:1-8`).
  A package-specific error class that extends `Error` has a precedent: `LocalProviderError`
  (`packages/aws/src/local-provider.ts:120`).
- **Registry-only example**: `examples/sqs-events` (entrypoint `./src/functions.ts`, no Gateway).
  Its tests call `functions.sendEvent(...)` and `createLambdaHandlers({ functions })`
  (`examples/sqs-events/test/sqs-events.test.ts`).
- **New-package checklist** (how `@voke/schema` is registered): `package.json` (name,
  `exports: { ".": "./src/index.ts" }`, scripts `build`/`test`/`typecheck`/`clean`/`prepack`/
  `postpack`, `files`, `engines.bun >=1.4.4`, version `0.0.0`), `tsconfig.json`, `README.md`; the
  workspace glob and `turbo.json` need no edit; `packages/core/tsconfig.json` `paths`; a pinned
  export list in `packages/core/test/public-surface.test.ts`; `docs/stable-public-surface.md`;
  `apps/docs/content/docs/reference/packages.mdx`; `apps/docs/package.json` `devDependencies`
  (Twoslash resolves sample types there); `README.md:81`; `bun.lock` through `bun install`.
- **Docs samples**: `apps/docs/test/samples.test.ts` fails for any `ts`/`tsx` fence that is not
  marked `twoslash`. Every TypeScript sample on a docs page must be ` ```ts twoslash ` and
  compile.

### State after the prerequisite plans (expected; verify)

- Plan 019: `defineConfig({ plugins })`; `contributions.resources` merged into
  `config.resources`; `runtime.setup({ config, dev, functions })` returns `{ wrap? }`; a
  `FunctionWrap` receives `{ kind, functionKey, input, context, route? }` and `next`, and runs
  around invokable, route, event and Request Authorizer handlers of an activated Function
  Registry; `createLambdaHandlers(project, { config })` composes a Gateway for a registry-only
  project, so Plugins apply there.
- Plan 018: `functions.invoke(key, payload, { mode: "async", executionName })` starts a Durable
  Function idempotently: AWS rejects a second start with the same `executionName`. A Durable
  Function's steps are checkpointed, and its handler is replayed.
- Plan 014: `sendEvent` and event handlers return the source's own result type; the SQS batch
  API (`messages`, `batchResult()`, `ok()`) keeps its shape.

### Reference semantics (Powertools for AWS Lambda, TypeScript)

Read on 2026-11-14 from `https://docs.aws.amazon.com/powertools/typescript/latest/features/idempotency/`:

- `makeIdempotent(fn, { persistenceStore, config })` wraps a function; for batches it wraps the
  per-record function and each record gets its own idempotency record.
- The DynamoDB layer stores, by default attribute name: `id` (partition key, a hash of the
  payload or of the chosen key), `expiration` (Unix timestamp when the record expires), `status`
  ("status of the lambda execution during and after invocation"), `data` (the stored result),
  `validation` (hash of the payload parts used for validation) and `in_progress_expiration`
  ("when record expires while in progress (in case of the invocation times out)").

This plan follows that record layout and lifecycle. Details not quoted above (the exact
condition expression, the default expiry of one hour, deleting the record when the handler
throws) come from the planner's knowledge of Powertools; treat them as this plan's own
decisions, not as verified Powertools behaviour.

## Decisions taken in this plan

1. **Opt-in at the handler.** Nothing becomes idempotent because the Plugin is configured.

   ```ts
   import { idempotent } from "@voke/idempotency";

   export const charge = fn({
     input: chargeInput,
     output: chargeOutput,
     handler: idempotent(async (payload) => chargeCard(payload), {
       key: (payload) => payload.orderId,
     }),
   });
   ```

   `key` is required and returns a string, or `undefined` for "no key in this input". There is
   no JMESPath and no "hash the whole payload" default: the key is a business decision.

2. **How `idempotent` finds its store.** The Plugin's Function Wrap runs every handler inside a
   `node:async_hooks` `AsyncLocalStorage` scope holding `{ store, functionKey, timeoutSeconds, defaults }`.
   `idempotent` reads that scope when the handler runs. No module-level singleton, so two
   Gateways in one test process do not share state. Outside a scope (the Plugin is not in the
   config, or the handler is called directly) it throws a `VokeConfigError`:
   `idempotent() needs the idempotency() Plugin in voke.config.ts`. `idempotent(handler, { store })`
   skips the lookup, for unit tests.
3. **Record lifecycle.**
   1. `id` = `<functionKey>#<name?>#<sha256 of the key>`. `name` is an option for a Function
      that wraps more than one operation.
   2. Acquire: one conditional `PutItem` writes `status: "INPROGRESS"`, `expiration` (now +
      `expiresAfterSeconds`, epoch seconds), `in_progress_expiration` (now + the Function's
      timeout, epoch milliseconds) and `validation`. The condition lets the write through when
      the item does not exist, or its `expiration` has passed, or it is `INPROGRESS` with a
      passed `in_progress_expiration`.
   3. Blocked by a `COMPLETED` record: compare `validation`. Equal → return the stored `data`
      without running the handler. Different → `IdempotencyError`, code
      `IDEMPOTENCY_PAYLOAD_MISMATCH`.
   4. Blocked by a live `INPROGRESS` record → `IdempotencyError`, code
      `IDEMPOTENCY_IN_PROGRESS`. The caller's normal retry handles it.
   5. Handler returned → update to `COMPLETED` with `data` (the result as a JSON string).
   6. Handler threw → delete the record and rethrow, so a retry runs the handler again.
4. **Options.** `idempotent(handler, { key, name?, expiresAfterSeconds?, validate?, onMissingKey?, store? })`:
   `expiresAfterSeconds` defaults to the Plugin's value (default 3600); `validate(input)` selects
   what is hashed into `validation` (default: the whole input); `onMissingKey` is `"run"`
   (default: run without idempotency) or `"throw"` (code `IDEMPOTENCY_KEY_MISSING`).
5. **Results must be JSON.** A handler that returns a `Response` cannot be stored;
   `idempotent` throws `IDEMPOTENCY_RESULT_NOT_SERIALIZABLE` and releases the record. Route
   handlers return plain values, which the Gateway wraps in the `{ data }` envelope. `undefined`
   is stored as "no data" and replayed as `undefined`.
6. **In-progress timeout comes from the Function's timeout.** `setup` reads
   `definition.synthesis?.timeout ?? config.runtime.timeout` for each Function and the wrap puts
   it in the scope. Voke's `InvokeContext` has no remaining-time value, so this replaces
   Powertools' use of the Lambda context.
7. **SQS per-message form.**
   ```ts
   export const settle = sqs({
     queue: "paymentsQueue",
     message: paymentMessage,
     handler: idempotentBatch(async (message) => settlePayment(message.body), {
       key: (message) => message.body.paymentId,
     }),
   });
   ```
   `idempotentBatch` returns a full SQS handler. Each valid message runs through decision 3 on
   its own. A message whose function throws, or that is blocked `INPROGRESS`, is reported with
   `batchResult().fail(message)`; a replayed message counts as success. Messages run one after
   another in v1. `key` is required here too: the SQS `messageId` differs when a producer sends
   the same business event twice, so it is a poor default.
8. **Durable Functions use `executionName`, not this package.** The guide says: start a Durable
   Function with `functions.invoke(key, payload, { mode: "async", executionName })`; inside it,
   steps are already checkpointed. If plan 018 marks durable definitions in a way a Plugin can
   read from `setup`'s `functions`, `idempotent` throws a `VokeConfigError` that points at
   `executionName` when it runs inside one; if there is no such marker, this stays documentation
   only. No record is ever written for a Durable Function start.
9. **Plugin.** `idempotency({ table?, expiresAfterSeconds?, store? })`:
   - `name: "idempotency"`;
   - `contributions.resources`: `{ [table ?? "idempotencyTable"]: dynamodbTable({ partitionKey: "id", ttlAttribute: "expiration" }) }`,
     unless `store` is given;
   - `runtime.setup`: builds the timeout map and returns the wrap of decision 2. The DynamoDB
     store reads its table name with `bindResource(table, "name").value()` and creates its client
     on first use, so synthesis, builds and tests that never call a wrapped handler need neither
     the variable nor AWS.
   - No `contributions.provider` record: the table's own actions cover Get, Put, Update and
     Delete.
10. **`dynamodbTable({ ttlAttribute })`** is added to `@voke/aws`. It emits
    `TimeToLiveSpecification: { AttributeName, Enabled: true }`. DynamoDB removes expired items
    in the background, so the acquire condition, not the TTL, is what makes an expired record
    reusable.
11. **Store interface** (small, so tests need no AWS):

    ```ts
    export interface IdempotencyRecord {
      readonly id: string;
      readonly status: "COMPLETED" | "INPROGRESS";
      /** Epoch seconds. */
      readonly expiresAt: number;
      /** Epoch milliseconds; only while in progress. */
      readonly inProgressExpiresAt?: number;
      readonly validation: string;
      readonly data?: string;
    }

    export interface IdempotencyStore {
      acquire(
        record: IdempotencyRecord,
        now: number
      ): Promise<
        { acquired: true } | { acquired: false; existing: IdempotencyRecord }
      >;
      complete(
        id: string,
        data: string | undefined,
        expiresAt: number
      ): Promise<void>;
      release(id: string): Promise<void>;
    }
    ```

    `memoryStore()` and `dynamoDbStore({ tableName, client? })` implement it. Time comes from an
    injectable `now: () => number`, never from `Date.now()` inside the logic.

12. **Errors.** One class, `IdempotencyError extends Error`, with a `code` of
    `IDEMPOTENCY_IN_PROGRESS`, `IDEMPOTENCY_PAYLOAD_MISMATCH`, `IDEMPOTENCY_KEY_MISSING` or
    `IDEMPOTENCY_RESULT_NOT_SERIALIZABLE`. It is not a `VokeError`: that class has a closed code
    union in core. In a route, an uncaught `IdempotencyError` becomes the Gateway's generic 500;
    the guide shows catching `IDEMPOTENCY_IN_PROGRESS` and returning `error(..., { status: 409 })`.
13. **Package surface**: `idempotency`, `idempotent`, `idempotentBatch`, `memoryStore`,
    `dynamoDbStore`, `IdempotencyError`, and the types `IdempotencyStore`, `IdempotencyRecord`,
    `IdempotencyOptions`.

## Commands you will need

| Purpose           | Command                                                                                 | Expected on success                  |
| ----------------- | --------------------------------------------------------------------------------------- | ------------------------------------ |
| Install           | `bun install` (updates `bun.lock` for the new package and `@aws-sdk/client-dynamodb`)   | exit 0                               |
| Package tests     | `cd packages/idempotency && bun test`                                                   | 0 fail                               |
| AWS tests         | `cd packages/aws && bun test`                                                           | 0 fail                               |
| Core tests        | `cd packages/core && bun test test/public-surface.test.ts`                              | 0 fail                               |
| Package typecheck | `bun run typecheck` in `packages/idempotency`, `packages/aws`, `packages/core`          | exit 0                               |
| Example           | `cd examples/sqs-events && bun test && bun run typecheck`                               | 0 fail, exit 0                       |
| Synth example     | `cd examples/sqs-events && bun ../../packages/core/src/cli.ts synth --out <tmp>/t.json` | exit 0, the table is in the template |
| Docs samples      | `cd apps/docs && bun run check:samples guides/idempotency.mdx`                          | exit 0                               |
| Docs tests/links  | `cd apps/docs && bun run test && bun run lint:links`                                    | exit 0                               |
| Repo gates        | `bun run check && bun run typecheck && bun run test`                                    | exit 0                               |

None of these ran during planning. `packages/idempotency` does not exist yet; its scripts are the
ones every `@voke/*` package has.

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`). The lifecycle is tested against `memoryStore()` with a fake clock;
  no test sleeps, uses real time or calls AWS. The DynamoDB store is tested with a fake client
  object that records the commands it receives (`dynamoDbStore({ tableName, client })`).
- Dependencies of `@voke/idempotency`: `voke`, `@voke/aws` (both `workspace:*`) and
  `@aws-sdk/client-dynamodb` at the version range `apps/docs` already uses. Nothing else. Store
  `data` as a JSON string attribute so no document-client or marshalling package is needed.
- Hash with `node:crypto` SHA-256 over a JSON string with sorted object keys, so key order in
  the input does not change the hash.
- Run-time code must not use the `Bun` global. `node:async_hooks` is available on Bun and on the
  Lambda Node.js runtimes.
- Never log the key, the payload or the stored result. Error messages name the Function and the
  record status, not the data.
- The acquire step must be one conditional write. Do not read first and write second.
- Keep the no-Plugin path untouched: a project that does not configure `idempotency()` loads no
  DynamoDB code.
- Ultracite style; no `console.log`; early returns.

## Scope

**In scope**:

- `packages/idempotency/` (create): `package.json`, `tsconfig.json`, `README.md`, `src/index.ts`,
  `src/plugin.ts`, `src/idempotent.ts`, `src/batch.ts`, `src/store.ts`, `src/memory-store.ts`,
  `src/dynamodb-store.ts`, `src/errors.ts`, `test/*.test.ts`, `test/idempotent-typecheck.ts`.
- `packages/aws/src/cloudformation-synthesis.ts`: the `ttlAttribute` option of `dynamodbTable`
  only; `packages/aws/test/` one test for it.
- `packages/core/tsconfig.json` (`paths`), `packages/core/test/public-surface.test.ts`.
- `examples/sqs-events`: the Plugin in `voke.config.ts`, one Function using `idempotentBatch`,
  the dependency in `package.json`, tests.
- Docs: `apps/docs/content/docs/guides/idempotency.mdx` (create), `meta.json`,
  `guides/sqs-events.mdx` (a short "Run each message once" section with a link),
  `guides/resources.mdx` (`ttlAttribute` in the `dynamodbTable` row), `reference/packages.mdx`,
  `reference/errors.mdx` (the four codes), `apps/docs/package.json` (dev dependency),
  `docs/stable-public-surface.md`, `README.md` (package list).
- `CONTEXT.md`, a new ADR, `roadmap-v2.md` (point phase 10's idempotency item at this plan).
- `bun.lock`, `.factory/plans/README.md` (status only, unless the coordinator owns it).

**Out of scope**:

- Core changes. If one seems necessary, apply the STOP condition.
- A Redis, Valkey or other store; an in-memory cache in front of DynamoDB.
- Mapping `IdempotencyError` to HTTP status codes in the Gateway.
- An `Idempotency-Key` header convention for routes. `key` can read
  `request.headers.get("idempotency-key")` already; the guide shows it.
- Concurrent processing of the messages of one batch.
- SNS, EventBridge, Kinesis or DynamoDB Streams forms (plans 015–017 add those sources; add
  per-record forms when they exist).
- Dead-letter queues and redrive (ADR 0003 defers them).
- Durable Function starts (decision 8).
- Per-Function IAM scoping (roadmap v2 phase 5).

## Git workflow

- `origin/main` lacks PRs #53–#62: they were merged into each other's branches. The base is the
  stack tip `origin/feature/docs-site-platform` (`4015c46`) plus plan 019's branch (and plan
  020's, if the stack is linear).
- Branch: `feature/idempotency-plugin`, stacked on the previous plan's branch.
- Commit subjects are imperative sentences ("Run a retried handler once with @voke/idempotency").
  Commit only if the task authorizes it. Do not push or open a PR unless told.

## Steps

### Step 1: `dynamodbTable({ ttlAttribute })` (`@voke/aws`)

Test first in `packages/aws/test/`: the synthesized table has
`TimeToLiveSpecification: { AttributeName: "expiration", Enabled: true }` when the option is
set and no such property otherwise. The attribute is not added to `AttributeDefinitions` (only
key attributes belong there).

**Verify before coding**: that the AWS Emulator's CloudFormation accepts
`TimeToLiveSpecification` in `voke local bootstrap` (`voke local start && voke local bootstrap`
in `examples/sqs-events`, Docker required). If it rejects the property, see the STOP conditions.

### Step 2: Store interface, memory store and the lifecycle

Create the package from the checklist. Implement `store.ts`, `memory-store.ts`, `errors.ts` and
the core routine `runIdempotent({ store, id, validation, expiresAfterSeconds, timeoutSeconds, now }, run)`
in `idempotent.ts`.

**Evidence**: `test/lifecycle.test.ts` against `memoryStore()` with a fake clock, one case each:
first call runs and stores; second call with the same key replays without running; a different
payload with the same key fails with `IDEMPOTENCY_PAYLOAD_MISMATCH`; a second call while the
first is running fails with `IDEMPOTENCY_IN_PROGRESS`; a thrown handler releases the record and
the next call runs; an expired record runs again; a stale `INPROGRESS` record (past
`inProgressExpiresAt`) is taken over; `undefined` results replay as `undefined`; a `Response`
result fails with `IDEMPOTENCY_RESULT_NOT_SERIALIZABLE` and releases; key order in the payload
does not change the hash.

### Step 3: The Plugin, `idempotent` and `idempotentBatch`

Implement decisions 1, 2, 4, 6, 7 and 9. `idempotent` must preserve the handler's type:
`idempotent<TInput, TContext, TResult>(handler: (input: TInput, context: TContext) => TResult | Promise<TResult>, options)`
returns the same signature with a `Promise` result, so `fn`, `http` routes and `sqs` infer as
before.

**Evidence**: `test/plugin.test.ts`, composing
`voke(functions, { config: { name: "test", plugins: [idempotency({ store: memoryStore() })] } })`:
an invokable Function called twice through `functions.invoke` runs once and returns the same
result; a route called twice through `gateway.request` runs once; two Functions with the same key
value do not share a record; `onMissingKey: "throw"`; calling a wrapped handler with no Plugin
configured throws the `VokeConfigError` of decision 2; `idempotency()` without `store`
contributes `idempotencyTable` to `defineConfig(...).resources`, and `idempotency({ table: "dedupe" })`
contributes `dedupe`. `test/batch.test.ts`, through `functions.sendEvent`: a redelivered message
is not processed again and is not reported as failed; a throwing message is reported in
`batchItemFailures` and runs again on redelivery; an in-progress message is reported as failed.
`test/idempotent-typecheck.ts`: payload and result types flow through `idempotent`, and
`key` receives the typed input.

### Step 4: The DynamoDB store

Implement `dynamoDbStore` with `PutItemCommand` (condition from decision 3.2,
`ReturnValuesOnConditionCheckFailure: "ALL_OLD"` so a blocked acquire needs no second read),
`UpdateItemCommand` for `complete` and `DeleteItemCommand` for `release`. Attribute names: `id`,
`status`, `expiration`, `in_progress_expiration`, `validation`, `data`. `status` and `data` are
DynamoDB reserved words: use expression attribute names. When the condition fails and no old item
is returned, fall back to one `GetItemCommand` with `ConsistentRead: true`; if the item is gone,
retry the acquire once.

**Verify before coding**: that the AWS Emulator returns the old item for
`ReturnValuesOnConditionCheckFailure`; the fallback above covers it if not.

**Evidence**: `test/dynamodb-store.test.ts` with a fake client: the exact command inputs for
acquire, complete and release; a `ConditionalCheckFailedException` with an `Item` maps to
`{ acquired: false, existing }`; without an `Item` the fallback read runs; the client is created
only on first use and with `createAwsClientConfig()`; a missing binding variable surfaces
`VokeResourceBindingError` on first use, not at import or at `setup`.

### Step 5: Example and a local end-to-end check

- `examples/sqs-events`: add `idempotency()` to `voke.config.ts` and a second Function that uses
  `idempotentBatch`. In the test, build the handlers with plan 019's
  `createLambdaHandlers({ functions }, { config })`, using a config whose Plugin has
  `store: memoryStore()`, deliver the same SQS event twice and assert one side effect. Keep the
  existing tests passing; `test/synthesis.test.ts` asserts an error message for a missing queue,
  so check it still holds.
- Manual check, reported as such: with Docker, `voke local start && voke local bootstrap` in the
  example, then run a small script that calls the wrapped handler twice against the emulator's
  table and observe one execution and one `COMPLETED` item. If Docker is unavailable, say so in
  the report; it is not a blocker.

### Step 6: Registration, vocabulary, ADR and docs

- Registration: `packages/core/tsconfig.json` `paths`; a `public-surface.test.ts` case "keeps
  idempotency helpers in @voke/idempotency" pinning the run-time exports of decision 13;
  `docs/stable-public-surface.md`; `README.md`; `apps/docs/package.json`.
- `guides/idempotency.mdx`: why (at-least-once delivery); add the Plugin; wrap a Function, a
  route (with the `idempotency-key` header and the 409 pattern) and an SQS handler; choosing a
  key; what happens on a retry, on a concurrent call and on an error; expiry; testing with
  `memoryStore()`; local use (`voke local bootstrap` creates the table); Durable Functions use
  `executionName` (only if plan 018 has landed; otherwise leave the section out); cost (one
  write and one update per first execution); limits (JSON results, 400 KB DynamoDB item size,
  every Function can reach the table). Add the page to `meta.json` after `guides/sqs-events` and
  to `teachingSurfaceFiles`. Every TypeScript fence is ` ```ts twoslash `.
- `CONTEXT.md`: add **Idempotency Key** ("The application value that identifies one logical
  operation, chosen by the handler author." _Avoid_: request id, message id as a default),
  **Idempotency Record** and **Idempotency Store**; relationships: opt-in per handler; one record
  per Function and key; an SQS batch has one record per message; Durable Function starts use
  `executionName` instead.
- ADR with the next free number at execution time: opt-in at the handler, the record lifecycle,
  the Function timeout as the in-progress window, the Plugin-provisioned table, and why Durable
  Functions are excluded.

## Test plan

- New in `packages/idempotency/test/`: `lifecycle.test.ts`, `plugin.test.ts`, `batch.test.ts`,
  `dynamodb-store.test.ts`, `idempotent-typecheck.ts`. Model Gateway composition on
  `packages/core/test/api.test.ts`, SQS events on `examples/sqs-events/test/sqs-events.test.ts`,
  and fake AWS clients on `packages/aws/test/runtime-variables.test.ts`.
- Extended: one `dynamodbTable` case in `packages/aws/test/`; the export pin in
  `packages/core/test/public-surface.test.ts`; `examples/sqs-events/test/`.
- All tests are deterministic: fake clock, memory store or fake client, no network.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] A Function wrapped with `idempotent` runs once for two calls with the same key, for an
      invokable Function, a route and an SQS message (tests named in the steps)
- [ ] `voke synth` for `examples/sqs-events` contains an `AWS::DynamoDB::Table` with
      `TimeToLiveSpecification`, and every Function has `VOKE_RESOURCE_IDEMPOTENCY_TABLE_NAME`
- [ ] `git diff --stat <base> -- packages/core/src` is empty
- [ ] `packages/idempotency/package.json` depends only on `voke`, `@voke/aws` and
      `@aws-sdk/client-dynamodb`
- [ ] No test in `packages/idempotency` uses real time or a real AWS client
      (`grep -rn "Date.now\|setTimeout" packages/idempotency/test` returns no matches)
- [ ] `cd apps/docs && bun run check:samples guides/idempotency.mdx` exits 0
- [ ] The ADR exists; `CONTEXT.md` defines **Idempotency Key**
- [ ] The manual emulator check is reported as run or as skipped with the reason
- [ ] `.factory/plans/README.md` row updated by its owner

## STOP conditions

- Plan 019 has not landed, or its wrap does not run around event handlers or in registry-only
  projects. Do not add a module-level store singleton as a workaround; report it.
- The work needs a change in `packages/core/src` (for example a Plugin slot on `InvokeContext`
  or the remaining time). That is a contract change for plan 019's owner.
- The AWS Emulator rejects `TimeToLiveSpecification`, so `voke local bootstrap` fails for every
  project that uses the Plugin. Report it with the emulator's error; the likely fix (omit the
  property from the resources-only local template) belongs to `@voke/aws` local code and needs a
  decision.
- `AsyncLocalStorage` does not propagate through Voke's handler path under Bun or Node (a test in
  Step 3 would show it). Report it before choosing another mechanism.

## Maintenance notes

- Every Function role can read and write the idempotency table, because resource access is
  stack-wide today. Resource linking (roadmap v2 phase 5) should narrow it to Functions that use
  `idempotent`.
- The in-progress window equals the Function timeout. If Voke later exposes the remaining
  execution time on `InvokeContext`, use it and drop the timeout map.
- When SNS, EventBridge, Kinesis or DynamoDB Streams sources land (plans 015–017), add a
  per-record form for each instead of generalizing `idempotentBatch` early.
- A Durable Function replays its handler; `idempotent` inside one would hit its own record on
  replay. Decision 8 keeps the two apart; revisit only together with plan 018's owner.
- Reviewers should check: the acquire is a single conditional write, no key or payload is logged,
  and `packages/core/src` is untouched.
- Deferred: other stores, a local cache, HTTP status mapping for `IdempotencyError`, concurrent
  batch processing.
