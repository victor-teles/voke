# Plan 014: A Provider package can add an Event Source without changing core

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 4015c46 -- packages/core/src packages/core/test packages/aws/src packages/aws/test examples/sqs-events CONTEXT.md docs apps/docs/content`
> and `git status --short` with the recorded current state. Reconcile routine drift; pause only
> if drift invalidates a protected contract or a decision listed below.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none. It is the prerequisite for plans 015, 016 and 017.
- **Category**: tech-debt
- **Planned at**: commit `4015c46`, 2026-11-14

## Why this matters

Voke models a trigger as an **Event Source** attached to a **Function**, but the only Event Source
the code can express is SQS. The provider-neutral core package names SQS in its types, its model,
its error messages and its dev log, and the AWS package assumes that every Event Source Function
is an SQS Function. Adding SNS, EventBridge, schedules, streams or S3 would mean editing core for
each one, which breaks the package rule that core knows no AWS concept. This plan makes the Event
Source contract open: core carries a source name, an optional resource key and a property record,
and `@voke/aws` owns one adapter per source. SQS keeps its behaviour and its CloudFormation
output; plans 015–017 then add sources by adding adapters.

## Current state

### Vocabulary (from `CONTEXT.md`; use these terms in names, comments and tests)

- **Function**: "A named serverless compute unit in a Voke Project". Not "worker" or "handler".
- **Event Source**: "A trigger relationship where an external event provider invokes a
  **Function**." Avoid "worker", "background route", "queue handler as a separate concept".
- **Event Invocation**: "The local test/runtime path that delivers an event-shaped payload to an
  Event Source Function." It is `functions.sendEvent(key, event)`.
- **Function Registry**: the typed catalog from `createFunctions({ ... })`.
- **Provider**: "A platform adapter that gives a Gateway runtime, deployment, synthesis, and local
  workflow behavior while keeping Function authoring provider-neutral." The AWS Provider is
  `aws()` from `@voke/aws`.
- Rules that stay true: "A Function with Event Sources does not mix HTTP routes or invokable
  handlers in v1." "An SQS Function can have one or more SQS Event Sources." "The root project
  model validates provider-neutral structure, while each Provider validates its own Provider
  Extension Records."

### Architecture rules (binding)

- `docs/adr/0007-specialized-provider-and-helper-packages.md`: "The core package owns
  provider-neutral Function, Gateway, config, contract, route, and Provider capability contracts;
  `@voke/aws` depends on public `voke` and owns the full AWS workflow, including AWS runtime
  adapters, resource helpers, SQS and authorizer entrypoints [...] This keeps future providers
  possible without making root `voke` depend on AWS, CloudFormation, SQS, or API Gateway concepts."
- `docs/adr/0007-opinionated-framework.md`: one spelling per setting, one name per API, and
  "Because the package is unreleased, removals happen without deprecation aliases".
- Core `src` must not import `@voke/*` (turbo rejects the workspace cycle). Core tests reach
  `@voke/*` through `paths` in `packages/core/tsconfig.json`.
- `docs/adr/0003-sqs-event-sources.md` defines SQS behaviour: normalized SQS Message Batch,
  invalid bodies are per-message failures by default, partial batch failure reporting is always on,
  tests use `functions.sendEvent`. None of that changes.

### Where SQS is hardcoded today (verified at `4015c46`)

Core, `packages/core/src/invoke.ts`:

- `:101-113` — the Event Source type is SQS:
  ```ts
  export interface SqsEventSourceDefinition {
    readonly options: SqsEventSourceOptions;
    readonly queue: string;
    readonly source: "sqs";
  }
  export type EventSourceDefinition = SqsEventSourceDefinition;
  ```
- `:132-241` — a second copy of the SQS message, batch, batch-result and batch-schema types
  (`SqsRecord`, `SqsBatchResult`, `SqsMessageBatch`, `SqsMessageBatchSchema`, ...). The live copy
  is `packages/aws/src/sqs.ts:20-135`. Core's `src/index.ts` exports none of the core copies.
- `:485-491` — every Event Source handler must return an SQS result:
  ```ts
  export type EventFunctionHandler<TPayload, TVariables ...> = (
    payload: TPayload, context: InvokeContext<TVariables>
  ) => SqsBatchResult | Promise<SqsBatchResult>;
  ```
- `:536-547` `EventFunctionDefinition<TKey, TInputSchema, TVariables>`; `:632-668`
  `EventFunctionDefinitionInput` and an unused `SqsFunctionDefinitionInput`.
- `:873-921` — `functions.sendEvent` is typed through `SqsLikeMessageBatchSchema`, takes
  `SqsEventInvocationInput<...>` and returns `Promise<SqsBatchResult>`; `SqsEventHandlerOptions`
  (`:916-921`) is unused in core.
- `:1815-1842` `sendEventToFunction` returns `Promise<SqsBatchResult>` and builds the error
  `Invalid SQS event for ${functionName}: ...`.
- `:1864-1872` and `:1888-1893` — an overload of `fn` that accepts `events` with an
  `SqsMessageBatchSchema`; `:1900-1919` is its runtime branch, which also holds the two guards
  "Event Source Functions cannot define HTTP routes in v1." and "Event Source Functions cannot
  define an output schema because Voke owns the event response contract." No source file calls
  `fn` with `events`. One test does: `packages/core/test/invoke.test.ts:555-587`.
- `:2083-2091` `formatEventSourceSummary` prints `eventSource.queue` and
  `eventSource.options.batchSize / maxBatchingWindowSeconds / enabled` for the Dev Function Summary.

Core, `packages/core/src/model.ts`:

- `:106-114` `VokeModelEventSource = VokeModelSqsEventSource` with fields
  `type: "sqs"`, `queue`, `batchSize?`, `maxBatchingWindowSeconds?`, `enabled?`.
- `:402-416` `validateModel` skips every event source whose `type` is not `"sqs"`.
- `:538-562` the model builder skips every definition whose `source` is not `"sqs"`, checks that
  `resources[eventSource.queue]` exists, and reports
  `SQS event source references resource "<key>", but no matching resource is defined.` at path
  `functions.<name>.events.<i>.queue`.

AWS package:

- `packages/aws/src/sqs.ts:376-429` `sqs()` builds the definition object directly (it does not call
  `fn`): `events: [{ options, queue, source: "sqs" }]`, `input: sqsMessageBatch(...)`,
  `kind: "event"`, `key: ""`, `routes: []`. `:446-452` `createSqsEventHandler` (a public export)
  converts an AWS SQS event to an Event Invocation and calls `functions.sendEvent`.
- `packages/aws/src/lambda-handlers.ts:193-200` — every `kind: "event"` Function gets the SQS
  handler:
  ```ts
  case "event": {
    const handle = createSqsEventHandler({ function: key, functions: functions as never });
    return async (event) => await handle(event as SqsAwsEvent);
  }
  ```
- `packages/aws/src/index.ts:93-113` `validateAwsModel` (the Provider's `validate`) checks that an
  SQS event source points at an `AWS::SQS::Queue` and skips other types.
- `packages/aws/src/cloudformation-synthesis.ts:93-96` (`VokeModelSqsEventSource` extract),
  `:515-573` (`toSqsEventSourceMappingResource`), `:1081-1099` (the loop that skips
  `eventSource.type !== "sqs"`).
- `packages/aws/src/lambda-settings.ts:186-200` and `:239-254` read `eventSource.queue` and
  `eventSource.maxBatchingWindowSeconds` for every event source, with no check of its type. This
  is only correct while every event source is SQS.

Tests and files that pin the current shape (update them; do not delete coverage):

| File                                                                                                                  | What it pins                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/core/test/model.test.ts:667-745`                                                                            | model `eventSources` shape; issue path `functions.processOrders.events.0.queue`                      |
| `packages/core/test/model-typecheck.ts:5,73-74`                                                                       | imports `SqsMessageBatch` and `VokeModelSqsEventSource` from core `src`                              |
| `packages/core/test/cloudformation.test.ts:28,163-194,672-755`                                                        | imports `SqsMessageBatch` from core; SQS fixture; a hand-built `{ queue, type: "sqs" }` event source |
| `packages/core/test/invoke.test.ts:516-587,705-805`                                                                   | `sendEvent` behaviour; the `fn({ events, ... } as never)` guard test                                 |
| `packages/core/test/invoke-typecheck.ts:156-171`                                                                      | `sendEvent` returns `Promise<SqsBatchResult>`; body type inferred; invokable keys rejected           |
| `packages/core/test/route-builder.test.ts:347-364`                                                                    | the Dev Function Summary line `SQS ordersQueue batchSize=10 maxBatchingWindowSeconds=5 enabled=true` |
| `packages/core/test/package-boundaries-typecheck.ts`                                                                  | root `voke` must not export SQS types                                                                |
| `packages/aws/test/sqs-event-source-validation.test.ts:35,58`                                                         | both error messages, verbatim                                                                        |
| `packages/aws/test/resources-only-synthesis.test.ts:81`                                                               | `SQS event source references resource "missingQueue"`                                                |
| `packages/aws/test/lambda-handlers.test.ts:175-184`                                                                   | deployed SQS handler returns only failed messages                                                    |
| `examples/sqs-events/test/synthesis.test.ts:11`                                                                       | the missing-resource message with its path prefix                                                    |
| `packages/core/test/fixtures/sqs-event-source-cloudformation.json` and the two other `*-cloudformation.json` fixtures | the synthesized templates                                                                            |

The model is not persisted anywhere (`schemaVersion: "1"` is only set at `model.ts:36,666`), so the
shape change needs no migration.

## Decisions taken in this plan

1. **Open Event Source record in core.** Target types:
   ```ts
   // packages/core/src/invoke.ts
   export interface EventSourceDefinition {
     /** The Event Source type, named by the Provider package that authored it, e.g. "sqs". */
     readonly source: string;
     /** The Voke resource key the source reads from, when it has one. */
     readonly resource?: string;
     /** Source settings. Voke copies them to the model untouched; the Provider validates them. */
     readonly properties: VokeModelRecord;
   }
   // packages/core/src/model.ts
   export interface VokeModelEventSource {
     type: string;
     resource?: string;
     properties: VokeModelRecord;
   }
   ```
   `VokeModelRecord` holds only JSON values, so a source applies its defaults when it builds the
   definition and never stores `undefined`.
2. **Core validates structure only.** Core checks that `resource`, when present, is a key in
   `resources`. The Provider's `validate` checks the resource kind and the properties. New core
   message: `"<source>" Event Source references resource "<key>", but no matching resource is
defined.` at path `functions.<name>.events.<i>.resource` (model builder) and
   `functions.<name>.eventSources.<i>.resource` (`validateModel`).
3. **The handler result is the Function's own.** `EventFunctionHandler` and
   `EventFunctionDefinition` get a result type parameter (add it last, default `unknown`, so the
   three-argument uses in `@voke/aws` keep compiling). `functions.sendEvent(key, event)` takes
   `StandardSchemaInput` of that Function's `input` schema and resolves to what its handler
   returns. Core has no `SqsBatchResult`.
4. **Core's SQS copies and the SQS overload of `fn` are removed**, with no alias. The two guards
   move to `createFunctions` (`invoke.ts:2187-2202`), which is where every Provider-built
   definition passes: an `event` Function must have at least one Event Source, all with the same
   `source`, no routes, and no `output`. Keep both existing guard messages verbatim and add
   `Function "<key>" mixes Event Sources "<a>" and "<b>"; a Function's Event Sources must share one source.`
5. **One internal adapter per source in `@voke/aws`.** Suggested shape (names may change; the five
   responsibilities may not):
   ```ts
   // packages/aws/src/event-sources.ts (internal: not exported from the package index)
   export interface AwsEventSourceAdapter {
     readonly source: string;
     /** AWS Lambda event → the Function's Event Invocation input. */
     toInvocation(event: unknown): unknown;
     /** The handler's result → the value the Lambda handler returns. */
     toResponse(result: unknown): unknown;
     /** Resource kind and property checks for one Event Source in the model. */
     validate(context: AwsEventSourceContext): VokeIssue[];
     /** CloudFormation resources for one Event Source, keyed by logical id. */
     synthesize(context: AwsEventSourceSynthesisContext): {
       resources: Record<string, CloudFormationResource>;
     };
   }
   ```
   The adapter is selected by `definition.events[0].source` at runtime and by
   `eventSource.type` in validation and synthesis. An unknown source is an error, never a skip:
   `Function "<key>" uses Event Source "<source>", which the AWS Provider does not support.`
   The table stays internal for now; a public registration API is a later decision.
6. **SQS behaviour and templates do not change.** `sqs()` stores
   `{ source: "sqs", resource: <queue key>, properties: { batchSize, maxBatchingWindowSeconds, enabled } }`
   with defaults applied (`10`, `0`, `true`), which are the values synthesis already falls back to
   (`cloudformation-synthesis.ts:562-568`). The three CloudFormation fixtures must stay
   byte-identical. `createSqsEventHandler` stays exported and behaves the same.
7. **The Dev Function Summary is generic.** It prints the source in upper case, the resource key
   (or `-`), then each property as `key=value` in the order the source declared them. For the
   pinned SQS case the line stays identical because `sqs()` declares `batchSize`,
   `maxBatchingWindowSeconds`, `enabled` in that order.

## Commands you will need

| Purpose         | Command                                           | Expected on success |
| --------------- | ------------------------------------------------- | ------------------- |
| Install         | `bun install --frozen-lockfile`                   | exit 0              |
| One test file   | `cd packages/core && bun test test/model.test.ts` | all pass            |
| Package tests   | `cd packages/aws && bun test`                     | all pass            |
| Typecheck       | `bun run typecheck`                               | exit 0              |
| All tests       | `bun run test`                                    | all pass            |
| Lint and format | `bun run check` (fix with `bun run fix`)          | exit 0              |
| Docs samples    | `cd apps/docs && bun run test`                    | all pass            |

These scripts exist in the root `package.json`, `packages/*/package.json` and
`apps/docs/package.json`. None of them was run during planning.

## Implementation rules relevant to this plan

- Work test-first (`AGENTS.md`): change or add the failing test, then the code, then run the
  nearest test command.
- Core must contain no AWS word after this plan: `grep -n "Sqs\|sqs" packages/core/src/invoke.ts packages/core/src/model.ts`
  returns nothing. `packages/core/src/serverless-migration.ts` is exempt (it generates `sqs(...)`
  source text).
- No aliases and no deprecated re-exports. The package is unreleased.
- Errors: configuration problems throw `VokeConfigError` (use `VokeConfigError.validation([{ message, path }])`
  when there is a path); model problems throw `VokeModelError.validation`. Never a plain `Error`
  for a user mistake. `validateAwsModel` throws a plain `Error` today for the queue-kind check;
  keep its message verbatim and keep the type the existing test expects.
- Ultracite rules that matter here: no `any` (use `unknown` and narrow), `for...of` instead of
  `.forEach`, no barrel files, no nested ternaries, explicit return types on exported functions.
- Keep the Lambda bundle lean: the runtime half of an adapter (`toInvocation`, `toResponse`) must
  not import anything the synthesis half does not already load at runtime. Avoid an import cycle
  between the adapter table and `cloudformation-synthesis.ts`; the simplest way is to move
  `toLogicalId`, `resourceProvider` and the `CloudFormation*` types to a small shared module that
  both import.

## Scope

**In scope**:

- `packages/core/src/invoke.ts`, `packages/core/src/model.ts`, `packages/core/src/index.ts`
- `packages/core/test/*.ts` listed in the table above, and new tests named below
- `packages/aws/src/sqs.ts`, `lambda-handlers.ts`, `index.ts`, `cloudformation-synthesis.ts`,
  `lambda-settings.ts`, a new `event-sources.ts` (and a small shared CloudFormation helper module
  if needed)
- `packages/aws/test/*.ts` listed above, and a new `event-sources.test.ts`
- `examples/sqs-events/test/synthesis.test.ts` (message text only)
- `CONTEXT.md`, `docs/stable-public-surface.md`, a new ADR in `docs/adr/`
- `apps/docs/content/docs/guides/sqs-events.mdx` and `reference/errors.mdx` only where they quote
  a message this plan changes
- `.factory/plans/README.md` (status only, unless coordinator-owned)

**Out of scope**:

- Any new Event Source (`sns`, `eventBridge`, `schedule`, `kinesis`, `dynamodbStream`, `s3`):
  plans 015–017.
- A public API for third parties to register Event Source adapters.
- `packages/core/src/serverless-migration.ts`: it only emits `sqs(...)` text and is unaffected.
- The `packages/core/test/fixtures/*.json` files: they are evidence, not edit targets.
- Deferred, for all four event plans: a `voke dev` poller that delivers emulator events to local
  Functions, WebSocket APIs, MSK/Kafka/MQ sources, DLQ and redrive design, least-privilege
  per-Function resource linking, typed publishers.

## Git workflow

- `origin/main` lacks PRs #53–#62: they were merged into each other's branches. The base is the
  stack tip `origin/feature/docs-site-platform` (`4015c46`).
- Branch: `feature/open-event-source-contract`, created from the stack tip. PRs are stacked on the
  previous plan's branch.
- Commit subjects are imperative sentences ("Open the Event Source contract in core"). Commit
  only if the task authorizes it. Do not push or open a PR unless told.

## Steps

### Step 1: Open the core types

Write the type tests first in `packages/core/test/invoke-typecheck.ts`: `sendEvent` on an SQS
Function still resolves to the SQS batch result type from `@voke/aws`; a Function built with a
hand-written `EventFunctionDefinition` whose handler returns `{ done: true }` makes `sendEvent`
resolve to `{ done: boolean }`; the wrong event shape and an invokable key stay errors
(`invoke-typecheck.ts:167-171`).

Then in `invoke.ts`: replace `:101-113` with the open `EventSourceDefinition`; delete `:132-241`
except `EventInvocationInput`, which becomes `unknown`-based or is removed if unused; add the
result parameter to `EventFunctionHandler` and `EventFunctionDefinition`; make
`FunctionDefinitionWithKey` (`:708-718`) carry the handler's awaited return type; replace
`EventFunctionKey`, `EventFunctionInput` and `FunctionRegistrySendEvent` (`:873-914`) with
definitions based on `kind: "event"`, `StandardSchemaInput<input>` and the result parameter;
delete `SqsFunctionDefinitionInput`, `SqsQueueInput`, `SqsQueueListInput`, `SqsEventHandlerOptions`.
Export `EventSourceDefinition` and `EventFunctionHandler` as types from `src/index.ts`, next to
`EventFunctionDefinition` (`index.ts:29`), and `VokeModelEventSource` next to `VokeModelFunction`.

In `packages/aws/src/sqs.ts`, the `"include"` mode currently relies on core widening the body to
`unknown` (`invoke.ts:203-204`). Move that into the AWS type: the `SqsMessageBatchSchema` input
type becomes `SqsEventInvocationInput<unknown>` when `TInvalidMessageBody` is `"include"`.

**Evidence**: `cd packages/core && bunx tsgo --project tsconfig.json --noEmit` exits 0.

### Step 2: Move the guards and make dispatch generic (core)

Rewrite `invoke.test.ts:555-587` to pass a real `sqs()` definition spread with `routes`, then
with `output`, to `createFunctions`, and add a case that mixes two sources. Then remove the SQS
overload and the `"events" in definition` branch from `fn` (`:1864-1872`, `:1888-1893`,
`:1900-1919`), add the guards to `createFunctions`, make `sendEventToFunction` return
`Promise<unknown>` with the message `Invalid "<source>" event for <functionName>: ...`, and make
`formatEventSourceSummary` generic (decision 7).

**Evidence**: `cd packages/core && bun test test/invoke.test.ts test/route-builder.test.ts` passes
with the summary expectation at `route-builder.test.ts:347-364` unchanged.

### Step 3: Open the model (core)

Update `model.test.ts:698-713` to the new shape first:

```ts
{ type: "sqs", resource: "ordersQueue", properties: { batchSize: 10, maxBatchingWindowSeconds: 0, enabled: true } },
{ type: "sqs", resource: "priorityQueue", properties: { batchSize: 5, maxBatchingWindowSeconds: 30, enabled: false } },
```

and the issue path at `:740` to `functions.processOrders.events.0.resource`. Add a test that an
Event Source with an unknown `source` and no `resource` is copied to the model untouched when no
Provider is configured. Then change `model.ts:106-114`, `:402-416` and `:538-562` (decisions 1
and 2). Update `model-typecheck.ts` and `package-boundaries-typecheck.ts` to the remaining type
names; keep the assertion that root `voke` exports no SQS type.

### Step 4: Adapters in `@voke/aws`

Write `packages/aws/test/event-sources.test.ts` first: the SQS adapter converts an AWS SQS event
to the invocation input `createSqsEventHandler` produces today; `validate` returns the
queue-kind message verbatim for a `dynamodbTable()` resource; `synthesize` returns the same
`AWS::Lambda::EventSourceMapping` as `cloudformation-synthesis.ts:558-572`; an unknown source
makes `createLambdaHandlers` and `createVokeModel({ provider: aws() })` throw the "does not
support" message.

Then:

- `sqs.ts`: `sqs()` emits the new definition shape with defaults applied; add the SQS adapter
  (runtime half here).
- `event-sources.ts`: the adapter interface, the table, and a lookup that throws for unknown
  sources.
- `lambda-handlers.ts:193-200`: select the adapter by `definition.events?.[0]?.source` and return
  `async (event) => adapter.toResponse(await functions.sendEvent(key, adapter.toInvocation(event)))`.
- `index.ts:93-113`: `validateAwsModel` calls `adapter.validate` for every event source.
- `cloudformation-synthesis.ts`: delete the `VokeModelSqsEventSource` extract; the loop at
  `:1081-1099` calls `adapter.synthesize` and merges `resources`; the SQS mapping builder moves
  behind the SQS adapter and reads `eventSource.resource` and `eventSource.properties`.
- `lambda-settings.ts:186-200` and `:239-254`: consider only event sources whose `type` is `"sqs"`
  and read `resource` and `properties.maxBatchingWindowSeconds`.

Update the message expectations in `sqs-event-source-validation.test.ts:58`,
`resources-only-synthesis.test.ts:81`, `examples/sqs-events/test/synthesis.test.ts:11` and the
hand-built event source at `packages/core/test/cloudformation.test.ts:745-750`.

**Evidence**: `cd packages/aws && bun test` and
`cd packages/core && bun test test/cloudformation.test.ts` pass, and
`git diff --stat 4015c46 -- packages/core/test/fixtures` prints nothing.

### Step 5: Vocabulary, ADR and docs

- ADR with the next free number (0010 at planning time; three ADRs share 0007, do not renumber
  them): "Event Sources are open records in core and adapters in the Provider". Record decisions
  1–5 and that the adapter table is internal for now.
- `CONTEXT.md`: add "A **Function**'s **Event Sources** share one source type." and "**Event
  Source** types are authored through Provider packages; the root `voke` package names none."
  Replace the two statements that `functions.sendEvent(...)` "defaults to SQS in v1" (the example
  dialogue near line 437 and the flagged ambiguity near line 592) with: the event shape and the
  result of an **Event Invocation** are defined by the Function's Event Source.
- `docs/stable-public-surface.md`: add the three new type exports to "Provider building blocks".
- `apps/docs/content/docs`: update any quoted message that changed
  (`grep -rn "event source references" apps/docs/content`). Every `ts`/`tsx` fence on the docs
  site must be marked `twoslash` and compile (`apps/docs/test/samples.test.ts`); this plan adds no
  new page.

## Test plan

- New: `packages/aws/test/event-sources.test.ts` (Step 4); new cases in `invoke.test.ts`
  (guards in `createFunctions`, mixed sources), `model.test.ts` (unknown source copied untouched),
  `invoke-typecheck.ts` (result type per Function).
- Updated: every file in the "pins the current shape" table.
- Pattern: `packages/aws/test/sqs-event-source-validation.test.ts` for Provider validation tests;
  `packages/aws/test/lambda-handlers.test.ts:175-184` for deployed handler tests.
- Verification: `bun run test` → all pass; `bun run typecheck` → exit 0.

## Done criteria

- [ ] `grep -n "Sqs\|sqs" packages/core/src/invoke.ts packages/core/src/model.ts` returns nothing
- [ ] `git diff --stat 4015c46 -- packages/core/test/fixtures` prints nothing
- [ ] `route-builder.test.ts` Dev Function Summary expectation is unchanged and passes
- [ ] `createLambdaHandlers` and `createVokeModel({ provider: aws() })` reject an unknown Event
      Source with the "does not support" message (tests exist and pass)
- [ ] `functions.sendEvent` resolves to the handler's own result type (type test exists)
- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] The ADR exists; `CONTEXT.md` no longer says `sendEvent` defaults to SQS
- [ ] `git status --short` shows only in-scope files
- [ ] `.factory/plans/README.md` status row updated by its owner

## STOP conditions

- A CloudFormation fixture would have to change to make the tests pass. That means SQS output
  changed; find the cause instead of regenerating the fixture.
- The result type parameter cannot be threaded through `FunctionRegistry` without making
  `createFunctions` inference fall back to `unknown` for existing SQS Functions
  (`invoke-typecheck.ts:156-161` would fail). Report the smallest reproduction.
- Removing the `fn` overload breaks a caller this plan did not find
  (`grep -rn "events:" packages examples apps/docs/content` shows a `fn({ events` use).
- Typecheck time for `packages/core` grows noticeably (more than about 30%) because of the new
  conditional types; report before and after.

## Maintenance notes

- Plans 015–017 add adapters to the table. Plan 016 needs an adapter to contribute IAM statements
  to its Function's role, and plan 017 needs one to patch a resource's properties (as
  `withDerivedVisibilityTimeout` does for queues at `cloudformation-synthesis.ts:905-918`). Extend
  the `synthesize` result then; do not add unused fields now.
- A reviewer should check that no test lost coverage when its expectation changed, and that the
  bundle for `examples/sqs-events` did not grow (`voke build` output size before and after).
- Deferred: a public adapter registration API; moving `withDerivedVisibilityTimeout` behind the
  SQS adapter; Serverless migration changes (none are needed here).
