# Plan 016: A Function can consume a Kinesis stream or a DynamoDB table stream in typed batches

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 4015c46 -- packages/aws/src packages/aws/test packages/core/test examples apps/docs/content CONTEXT.md docs`
> and `git status --short` with the recorded current state. Plan 014 lands first and changes the
> Event Source types, `sqs.ts`, `lambda-handlers.ts`, `index.ts` and `cloudformation-synthesis.ts`
> on purpose; plan 015 may have landed and added `sns.ts`, `eventbridge.ts`, `schedule.ts`.
> Reconcile that drift; pause only if it invalidates a protected contract or a decision below.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `.factory/plans/014-open-event-source-contract.md` (hard). Ordering only:
  `.factory/plans/015-sns-eventbridge-schedule-event-sources.md` edits the same adapter table,
  `packages/aws/src/index.ts`, the public-surface test and the docs `meta.json`; run this plan
  after it, not in parallel.
- **Category**: direction
- **Planned at**: commit `4015c46`, 2026-11-14

## Why this matters

Stream processing is the second most common event pattern on Lambda after queues: change data
capture from a DynamoDB table, and ordered ingestion from Kinesis. It is also the pattern with the
most glue to get wrong: base64 payloads, DynamoDB's attribute-value JSON, starting positions,
checkpoints, and a failure report that Lambda ignores unless the mapping opts in. Voke already
solves the same class of problem for SQS. This plan gives streams the same treatment: a schema
for one record, a normalized batch, partial failure reporting on by default, local testing through
`functions.sendEvent`, and the mapping and IAM synthesized from the Function definition.

## Current state

### Vocabulary (from `CONTEXT.md`; use these terms)

- **Function**, **Function Registry**, **Provider**, **Event Source**, **Event Invocation** as
  defined there. An Event Source is "a trigger relationship where an external event provider
  invokes a Function"; Event Invocation is `functions.sendEvent(key, event)`.
- The SQS terms this plan mirrors: **SQS Message Batch** ("the normalized input delivered to a
  Function by an SQS Event Source, where each message exposes a parsed body plus raw provider
  metadata"), **SQS Message Schema** ("the schema for one application message body"), **SQS Batch
  Result** ("the handler result that tells an SQS Event Source which messages failed").
- Binding rules: Event Source Functions do not mix with routes or invokable handlers; an Event
  Source references its resource "by Voke resource key"; "An SQS Event Source configures Lambda
  trigger behavior; queue redrive belongs to the queue resource" (the same split applies to
  stream settings versus mapping settings); DLQ and redrive are deferred.

### Architecture rules (binding)

- `docs/adr/0007-specialized-provider-and-helper-packages.md`: all AWS code lives in `@voke/aws`;
  resource builders live under `@voke/aws/cloudformation`.
- `docs/adr/0007-opinionated-framework.md`: one way per thing; new options only when the default
  or the layer's escape hatch cannot meet the use case; no aliases.
- `docs/adr/0003-sqs-event-sources.md`: "Invalid JSON or schema failures are automatic per-message
  failures by default, and handlers receive only valid parsed messages. Projects that need to
  inspect invalid messages can opt out with `invalidMessageBody: "include"`." and "Partial batch
  failure reporting is the default for every SQS Event Source."

### Code at `4015c46`

- SQS batch machinery to reuse, `packages/aws/src/sqs.ts`: `createSqsBatchResult` (`:170-192`,
  a result object with a non-enumerable `fail(message)`), `parseMessageBody` (`:234-264`),
  `parseSqsMessageBatch` (`:266-319`, returns `{ batchResult(), messages, ok(), source }`),
  `sqsMessageBatch` (`:330-355`, the Standard Schema that normalizes the Event Invocation input).
  Public types: `SqsBatchResult { batchItemFailures: { itemIdentifier: string }[] }`.
- The SQS mapping, `packages/aws/src/cloudformation-synthesis.ts:558-572`:
  ```ts
  Properties: {
    BatchSize: eventSource.batchSize ?? 10,
    Enabled: eventSource.enabled ?? true,
    EventSourceArn: { "Fn::GetAtt": [queueLogicalId, "Arn"] },
    FunctionName: { Ref: lambdaLogicalId },
    FunctionResponseTypes: ["ReportBatchItemFailures"],
    MaximumBatchingWindowInSeconds: eventSource.maxBatchingWindowSeconds ?? 0,
  },
  Type: "AWS::Lambda::EventSourceMapping",
  ```
- `dynamodbTable(options)` (`cloudformation-synthesis.ts:126-164`) accepts `partitionKey`,
  `sortKey`, `billingMode` and emits `AttributeDefinitions`, `BillingMode`, `KeySchema`. It has no
  stream option. Its actions are item operations on the table ARN (`policyResource: "getAttArn"`).
  There is no Kinesis builder. Builders are re-exported from `packages/aws/src/cloudformation.ts`
  and pinned by `packages/core/test/public-surface.test.ts:136-149`.
- IAM: each Function has its own role, built by `functionRoleResource(statements)`
  (`cloudformation-synthesis.ts:473-508`) from every declared resource's statements plus that
  Function's Runtime Variable statements (`:1012-1018`). The Runtime Variable statements are the
  existing example of a per-Function contribution to one role.
- Local Floci bindings are derived by CloudFormation type in `resourceBindingFor`
  (`packages/aws/src/local.ts:116-169`); an unknown type returns `undefined`, so a new resource
  type gets no binding there until a branch is added. The AWS Emulator path reads stack outputs
  and needs no change.
- Build: the AWS SDK is external by default (`packages/core/src/config.ts:283`,
  `defaultBuildExternal`) because the Lambda Node.js runtime provides it. `@voke/aws` depends on
  five `@aws-sdk/client-*` packages and no `@aws-sdk/util-dynamodb`.
- The migrator reports stream events as manual work
  (`packages/core/src/serverless-migration.ts:1300-1301`): "Stream event source mappings need
  batching, starting position, and source permissions reviewed manually." Asserted at
  `packages/core/test/serverless-migration.test.ts:734,736`.
- Docs rule: every `ts`/`tsx` fence under `apps/docs/content/docs` must be `twoslash` and compile
  (`apps/docs/test/samples.test.ts`; `legacyUncheckedPages` is empty and stays empty). Pages are
  listed in `apps/docs/content/docs/meta.json`.

### State after plan 014 (expected; verify)

Core Event Sources are `{ source, resource?, properties }`; the model carries
`{ type, resource?, properties }`; `@voke/aws` has an internal adapter per source with
`toInvocation`, `toResponse`, `validate`, `synthesize`; `functions.sendEvent` resolves to the
handler's own result. Plan 014's maintenance notes say this plan extends the `synthesize` result
with IAM statements for the Function's role.

## Decisions taken in this plan

1. **Two entrypoints from `@voke/aws`: `kinesis` and `dynamodbStream`.**
   ```ts
   kinesis({
     stream: "clicksStream", // key of a kinesisStream() resource
     record: clickSchema, // Standard Schema for one JSON record payload
     handler: async (batch, context) => {
       for (const record of batch.records) {
         record.data.userId;
       }
       return batch.ok();
     },
   });
   dynamodbStream({
     table: "ordersTable", // key of a dynamodbTable({ stream }) resource
     item: orderSchema, // optional Standard Schema for one item image
     handler: async (batch) => {
       for (const record of batch.records) {
         record.eventName;
         record.keys;
         record.newItem;
         record.oldItem;
       }
       return batch.ok();
     },
   });
   ```
   Shared mapping options on both: `startingPosition`, `batchSize`, `maxBatchingWindowSeconds`,
   `bisectOnError`, `maxRetryAttempts`, `enabled`, and `invalidRecord: "fail" | "include"`.
   One stream or table per Function in v1.
2. **Normalized records.** Kinesis: `{ data, id, sequenceNumber, partitionKey, arrivedAt, raw, valid }`,
   where `data` is the base64-decoded UTF-8 payload parsed as JSON and validated by `record`.
   DynamoDB: `{ eventName: "INSERT" | "MODIFY" | "REMOVE", keys, newItem?, oldItem?, id, sequenceNumber, raw, valid }`,
   where `keys` and the images are converted from attribute-value JSON to plain values and the
   images are validated by `item` when it is given. Conversion follows the defaults of
   `unmarshall` from `@aws-sdk/util-dynamodb` (numbers as JavaScript numbers, sets as `Set`, binary
   as `Uint8Array`), implemented in a small internal function so no dependency is added.
3. **Batch contract: same shape as SQS, separate result name.** Handlers get
   `batch.records`, `batch.ok()` and `batch.batchResult()` with `fail(record)`, and the wire result
   is `{ batchItemFailures: [{ itemIdentifier }] }` with the record's sequence number. The
   implementation is shared with SQS (one internal batch-result helper). The exported type is a
   new `StreamBatchResult`, not `SqsBatchResult`, because the contract differs: SQS failures are
   independent, while for a stream Lambda resumes from the lowest failed sequence number, so every
   record after it in the batch is delivered again. One name per concept (ADR 0007):
   `SqsBatchResult` keeps meaning "independent messages"; `StreamBatchResult` means "checkpoint".
4. **Invalid records follow ADR 0003.** `invalidRecord: "fail"` (default) reports the record as
   failed and does not pass it to the handler; `"include"` passes it with `valid: false`, `error`
   and the undecoded payload.
5. **Mapping defaults.**
   | Option | Default | Note |
   | --- | --- | --- |
   | `startingPosition` | `"trimHorizon"` | `"latest"` is the other value. Trim horizon never skips records written before or during the first deploy; consumers must be idempotent anyway. |
   | `batchSize` | `100` | AWS's own default for both sources. |
   | `maxBatchingWindowSeconds` | `0` | |
   | `bisectOnError` | `true` | Only matters when the handler throws instead of reporting failures. |
   | `maxRetryAttempts` | not set | Lambda then retries until the record expires. |
   | `enabled` | `true` | |
   `FunctionResponseTypes: ["ReportBatchItemFailures"]` is always set and is not an option.
   Why retries are not capped by default: without a failure destination, a capped mapping drops
   records after the last attempt, and a short downstream outage would exhaust a small cap within
   seconds. Retrying until expiry stalls the shard visibly instead of losing data silently.
   Failure destinations belong to the deferred DLQ design; the guide must state this trade-off.
6. **Resources.** A new `kinesisStream(options?)` in `@voke/aws/cloudformation`:
   `AWS::Kinesis::Stream`, on-demand by default (`StreamModeDetails: { StreamMode: "ON_DEMAND" }`),
   `shardCount` switches to provisioned mode, `retentionHours` optional; binding attribute `name`
   (`Ref`), output `Name`, policy resource the stream ARN, actions `kinesis:PutRecord` and
   `kinesis:PutRecords` (what producing Functions need). `dynamodbTable()` gains
   `stream?: "NEW_AND_OLD_IMAGES" | "NEW_IMAGE" | "OLD_IMAGE" | "KEYS_ONLY"`, which emits
   `StreamSpecification: { StreamViewType }`. Without `stream`, the table output is unchanged
   (existing fixtures stay byte-identical).
7. **IAM for the consuming Function only.** The adapter contributes statements to that
   Function's role: for Kinesis the stream-read actions on the stream ARN; for DynamoDB the
   stream-read actions on `{ "Fn::GetAtt": [<Table>, "StreamArn"] }`. Other Functions' roles do
   not get them. This extends the adapter's `synthesize` result with role statements, merged in
   `cloudformation-synthesis.ts` next to the Runtime Variable statements (`:1012-1018`).
8. **Validation in the adapters.** `kinesis.stream` must be an `AWS::Kinesis::Stream`;
   `dynamodbStream.table` must be an `AWS::DynamoDB::Table` whose properties have
   `StreamSpecification` (message: `... add stream: "NEW_AND_OLD_IMAGES" to dynamodbTable()`); an
   `item` schema with `KEYS_ONLY` is an error; numeric options must be in AWS's ranges.
9. **Local Event Invocation uses plain values.**
   `functions.sendEvent("ingest", { records: [{ data: { userId: "u1" } }] })` and
   `functions.sendEvent("project", { records: [{ eventName: "INSERT", keys: { id: "o1" }, newItem: { id: "o1", total: 10 } }] })`.
   Sequence numbers, ids and timestamps are synthesized when omitted. The deployed adapter
   converts the AWS event (base64, attribute values) to this same input.
10. **The migrator only changes wording** for `stream` events (point to `kinesis()` /
    `dynamodbStream()`); code generation is deferred.

Facts to verify against AWS documentation before coding (not confirmed during planning):

- The exact execution-role actions for each source. Expected for Kinesis:
  `kinesis:DescribeStream`, `DescribeStreamSummary`, `GetRecords`, `GetShardIterator`,
  `ListShards`, `SubscribeToShard` on the stream ARN, and `kinesis:ListStreams` on `*`. Expected
  for DynamoDB Streams: `dynamodb:DescribeStream`, `GetRecords`, `GetShardIterator` on the stream
  ARN and `dynamodb:ListStreams` on `*`. Compare with the managed policies
  `AWSLambdaKinesisExecutionRole` and `AWSLambdaDynamoDBExecutionRole`.
- Checkpoint behaviour with `ReportBatchItemFailures`: the Lambda guides
  (`services-kinesis-batchfailurereporting.html`, `services-ddb-batchfailurereporting.html`) say
  the function returns the failed record's sequence number and Lambda retries from that record.
  Confirm the "lowest sequence number" rule and how `BisectBatchOnFunctionError` interacts.
- Allowed ranges: `BatchSize` (expected 1–10000), `MaximumBatchingWindowInSeconds` (0–300),
  `MaximumRetryAttempts` (-1–10000).
- Whether changing `StartingPosition` replaces the mapping, and whether the AWS Emulator and
  Floci support `AWS::Kinesis::Stream` and table streams in a resources-only template.
- `AWS::Kinesis::Stream` return values (`Ref` = name, `Fn::GetAtt Arn`).

## Commands you will need

| Purpose                                      | Command                                            | Expected on success        |
| -------------------------------------------- | -------------------------------------------------- | -------------------------- |
| Install (after adding the example workspace) | `bun install`                                      | exit 0, `bun.lock` updated |
| One test file                                | `cd packages/aws && bun test test/kinesis.test.ts` | all pass                   |
| Package tests                                | `cd packages/aws && bun test`                      | all pass                   |
| Typecheck                                    | `bun run typecheck`                                | exit 0                     |
| All tests                                    | `bun run test`                                     | all pass                   |
| Lint and format                              | `bun run check` (fix with `bun run fix`)           | exit 0                     |
| Docs                                         | `cd apps/docs && bun run test && bun run build`    | all pass, exit 0           |

All scripts exist in the repository; none was run during planning.

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`).
- No change in `packages/core/src` except the migrator reason string. A needed core change means
  plan 014 is incomplete: stop.
- Files: `packages/aws/src/kinesis.ts`, `dynamodb-stream.ts`, a shared `stream-batch.ts`
  (batch-result helper and stream batch types) and `dynamodb-attribute-values.ts` (the converter).
  Refactor `sqs.ts` to use the shared batch-result helper without changing its exported types or
  behaviour; the existing SQS tests are the proof.
- The attribute-value converter is a hot path and a parsing boundary: write table-driven tests
  for every type tag (`S`, `N`, `BOOL`, `NULL`, `M`, `L`, `SS`, `NS`, `BS`, `B`), nested values,
  an unknown tag (throw) and a number beyond `Number.MAX_SAFE_INTEGER` (document the precision
  loss; do not silently change the type).
- A record that fails to decode or validate must never throw out of the adapter in `"fail"` mode:
  it becomes a batch item failure, exactly like `sqs.ts:283-300`.
- Do not add `@aws-sdk/util-dynamodb` or any other dependency.
- Errors: `VokeConfigError` for authoring mistakes, `VokeModelError.validation` for model
  problems, `InvokeError` (`INVALID_PAYLOAD`) attached to invalid records.
- Ultracite: no `any`, `for...of`, no barrel files, no nested ternaries, top-level regex literals,
  no spread in accumulators inside loops.

## Scope

**In scope**:

- `packages/aws/src/kinesis.ts`, `dynamodb-stream.ts`, `stream-batch.ts`,
  `dynamodb-attribute-values.ts` (create); `sqs.ts` (shared helper only), `event-sources.ts`,
  `index.ts`, `cloudformation.ts`, `cloudformation-synthesis.ts`, `local.ts`
  (`resourceBindingFor` branch for `AWS::Kinesis::Stream`)
- `packages/aws/test/kinesis.test.ts`, `dynamodb-stream.test.ts`,
  `dynamodb-attribute-values.test.ts`, `stream-synthesis.test.ts`, `stream-typecheck.ts` (create),
  fixtures under `packages/aws/test/fixtures/`, `local.test.ts`
- `packages/core/test/public-surface.test.ts` (export lists, docs and example file lists),
  `packages/core/src/serverless-migration.ts` (one reason string) and
  `packages/core/test/serverless-migration.test.ts` (the lines that quote it)
- `examples/stream-events/` (create), `bun.lock`
- `apps/docs/content/docs/guides/kinesis-events.mdx`, `dynamodb-stream-events.mdx` (create),
  `meta.json`, `guides/resources.mdx` (builder table and permissions table),
  `reference/packages.mdx`
- `CONTEXT.md`, `docs/stable-public-surface.md`, a new ADR in `docs/adr/`
- `.factory/plans/README.md` (status only, unless coordinator-owned)

**Out of scope**:

- `ParallelizationFactor`, `MaximumRecordAgeInSeconds`, tumbling windows, `AT_TIMESTAMP`,
  Kinesis enhanced fan-out consumers, event filtering (`FilterCriteria`).
- Failure destinations for discarded records (part of the deferred DLQ and redrive design).
- Non-JSON Kinesis payloads (aggregated KPL records, binary): `"include"` mode is the way to read
  them in v1.
- Deferred for the whole event track: a `voke dev` poller that delivers emulator events to local
  Functions, WebSocket APIs, MSK/Kafka/MQ, DLQ and redrive design, least-privilege per-Function
  resource linking, typed publishers.

## Git workflow

- `origin/main` lacks PRs #53–#62; the base is the stack tip `origin/feature/docs-site-platform`
  plus the branches of the plans this one follows.
- Branch: `feature/kinesis-dynamodb-stream-event-sources`, stacked on the previous plan's branch
  (`feature/sns-eventbridge-schedule-event-sources` if 015 landed, else
  `feature/open-event-source-contract`).
- Commit subjects are imperative sentences ("Add the Kinesis Event Source"). Commit only if
  authorized. Do not push or open a PR unless told.

## Steps

### Step 1: Shared batch helper

Extract the batch-result builder from `sqs.ts:170-192` into `stream-batch.ts` (or a neutral
`batch-result.ts`) and make `sqs.ts` use it. No exported SQS name or behaviour changes.

**Evidence**: `cd packages/aws && bun test test/sqs.test.ts test/lambda-handlers.test.ts` and
`cd packages/core && bun test test/invoke.test.ts` pass unchanged.

### Step 2: Resource builders

Tests first (`stream-synthesis.test.ts`): `kinesisStream()` emits on-demand mode;
`kinesisStream({ shardCount: 2 })` emits provisioned mode; `dynamodbTable({ stream })` emits
`StreamSpecification`; `dynamodbTable()` output is unchanged. Then add the builder and the option,
export `kinesisStream` from `packages/aws/src/cloudformation.ts`, update
`public-surface.test.ts:139-148`, and add the `AWS::Kinesis::Stream` branch to
`resourceBindingFor` (`local.ts:116-169`, binding attribute `name`, value the logical id) with a
case in `local.test.ts`.

### Step 3: Kinesis

Tests first (`kinesis.test.ts`): `sendEvent` with plain `data` reaches the handler parsed and
typed; an invalid record becomes a batch item failure keyed by its sequence number and is not
passed to the handler; `"include"` mode passes it with `valid: false`; the deployed handler
accepts a real Kinesis Lambda event (`Records[].kinesis.data` base64,
`eventSource: "aws:kinesis"`); payload that is not valid base64 or not JSON is a record failure,
not a thrown error; `batch.batchResult().fail(record)` is reflected in the response. Then
implement `kinesis.ts` and register the adapter.

### Step 4: DynamoDB Streams

Tests first (`dynamodb-attribute-values.test.ts`, then `dynamodb-stream.test.ts`): the converter
cases from the rules above; `INSERT`, `MODIFY` and `REMOVE` records map to `newItem`/`oldItem`
correctly for each view type; `item` validates the images that are present; a `REMOVE` record
with `NEW_IMAGE` view has neither image and is valid; the deployed handler accepts a real
DynamoDB Streams Lambda event (`eventSource: "aws:dynamodb"`, `dynamodb.Keys`, `NewImage`,
`OldImage`, `SequenceNumber`). Then implement.

### Step 5: Mapping, IAM and validation

Tests first, in `stream-synthesis.test.ts` with fixtures: one project with a Kinesis consumer, a
DynamoDB stream consumer and an unrelated `fn`; assert the template against a fixture and,
separately, that (a) each mapping has `FunctionResponseTypes: ["ReportBatchItemFailures"]`,
`StartingPosition: "TRIM_HORIZON"`, `BatchSize: 100`, `BisectBatchOnFunctionError: true` and no
`MaximumRetryAttempts`; (b) `maxRetryAttempts: 5` emits `MaximumRetryAttempts: 5`; (c) the
stream-read statements are on the consumer's role and absent from the unrelated Function's role;
(d) the DynamoDB mapping's `EventSourceArn` is `{ "Fn::GetAtt": ["OrdersTable", "StreamArn"] }`;
(e) each decision 8 error is raised with its path; (f) `scope: "resources"` output contains the
stream and the table's `StreamSpecification` but no mapping.

Implement `validate` and `synthesize`; extend the adapter `synthesize` result with role
statements and merge them where the role is built.

**Evidence**: `cd packages/aws && bun test` passes;
`git diff --stat 4015c46 -- packages/core/test/fixtures` prints nothing.

### Step 6: Exports, example, docs, vocabulary, ADR, migrator wording

- Export `kinesis`, `dynamodbStream` and their public types (`StreamBatchResult`,
  `KinesisRecordBatch`, `KinesisEventInvocationInput`, `DynamodbStreamRecordBatch`,
  `DynamodbStreamEventInvocationInput`, the record types, the mapping option type) from
  `packages/aws/src/index.ts`; update `public-surface.test.ts:114-131`,
  `docs/stable-public-surface.md` and `reference/packages.mdx`. Add `stream-typecheck.ts`
  (record types inferred from the schema; `sendEvent` resolves to `StreamBatchResult`; wrong
  input shapes are type errors).
- `examples/stream-events/` modeled on `examples/sqs-events`: a `clicks` Kinesis consumer and an
  `orders` table projection, with `sendEvent` tests and one deployed-handler test each. Add its
  source files to `firstPartyExampleFiles` in `public-surface.test.ts:49-59`.
- Two guide pages (declare, handle, report failures, test, "what gets deployed", and a section
  "When a record can never succeed" that explains decision 5), all fences `ts twoslash`;
  register in `meta.json` and in `teachingSurfaceFiles` (`public-surface.test.ts:21-47`). Update
  the builder and permissions tables in `guides/resources.mdx`.
- `CONTEXT.md`: add **Kinesis Event Source**, **DynamoDB Stream Event Source**, **Stream Record
  Batch**, **Stream Batch Result** ("the handler result that tells a stream Event Source the first
  record to deliver again"), and the relationship "A stream Event Source redelivers every record
  from the lowest failed sequence number."
- ADR with the next free number at execution time: "Stream Event Sources: checkpoint batch
  results, trim-horizon start, retries until expiry".
- Migrator: change the `stream` reason string and the two test lines that quote it.

## Test plan

- New test files and cases as listed in Steps 2–6.
- Patterns: `packages/aws/test/sqs.test.ts` (authoring and variables),
  `packages/aws/test/lambda-handlers.test.ts:175-184` (deployed handler),
  `packages/core/test/cloudformation.test.ts:163-194` (fixture test),
  `packages/aws/test/runtime-variable-iam.test.ts` (per-Function IAM assertions).
- Verification: `bun run test` → all pass; `bun run typecheck` → exit 0;
  `cd apps/docs && bun run test` → 0 fail.

## Done criteria

- [ ] `kinesis`, `dynamodbStream` are exported from `@voke/aws` and `kinesisStream` from
      `@voke/aws/cloudformation`; the surface tests pass
- [ ] For each source: local `sendEvent` tests and a deployed-handler test with a real-shaped AWS
      event exist and pass
- [ ] Stream-read IAM is on the consuming Function's role only (test exists)
- [ ] Existing CloudFormation fixtures are unchanged
- [ ] The SQS tests pass without edits after the helper extraction
- [ ] `package.json` of `@voke/aws` has no new dependency
- [ ] `cd examples/stream-events && bun test` passes
- [ ] Two guide pages exist, are in `meta.json`; `cd apps/docs && bun run test` passes with
      `legacyUncheckedPages` still empty
- [ ] `bun run check`, `bun run typecheck`, `bun run test` exit 0
- [ ] ADR written; `CONTEXT.md` has the new terms
- [ ] `.factory/plans/README.md` status row updated by its owner

## STOP conditions

- AWS documentation contradicts decision 3 (for example, Lambda does not resume from the lowest
  reported sequence number). The `StreamBatchResult` contract and the guide text depend on it.
- The role statements cannot be scoped to the stream ARN (for example an action requires `*`
  beyond `ListStreams`). Report the action list; widening IAM is an owner decision.
- `Fn::GetAtt StreamArn` on a table whose stream is declared in the same template creates a
  dependency CloudFormation rejects.
- The owner prefers `"latest"` or a capped `maxRetryAttempts` as the default: both are one-line
  changes, but they change what a first deploy does to data, so they need a recorded decision.
- Proving a deployed mapping needs real AWS credentials. Do not deploy without explicit approval.

## Maintenance notes

- When the DLQ design lands, add an on-failure destination option here and reconsider the
  default for `maxRetryAttempts` together with it.
- The converter mirrors `@aws-sdk/util-dynamodb`; if a typed-publisher or data-access integration
  later adds that package, replace the internal function with it.
- A reviewer should scrutinize the IAM statements, the base64 and JSON error paths, and that
  `"fail"` mode can never throw for one bad record.
- Deferred: plural streams per Function, event filtering, enhanced fan-out, parallelization,
  tumbling windows, migrator code generation, local delivery in `voke dev`.
