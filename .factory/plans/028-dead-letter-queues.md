# Plan 028: A failed event lands in a dead-letter queue instead of looping or disappearing

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/aws/src packages/aws/test packages/core/test/fixtures packages/core/test/cloudformation.test.ts examples apps/docs/content/docs docs/adr CONTEXT.md`
> and `git status --short` with the recorded current state. Plans 022 to 027 are meant to land
> first. Plan 027 edits the resource loop of `packages/aws/src/cloudformation-synthesis.ts` on
> purpose (retention policies; see "State after plan 027"). Reconcile that drift; pause only if it
> invalidates a decision listed below or a STOP condition applies.

## Status

- **Priority**: P1
- **Effort**: L (three slices; see "Where this plan can be split")
- **Risk**: MED
- **Depends on**: none hard. Ordering only: after `.factory/plans/027-*.md` (same synthesis
  file; this plan copies its retention rule for queues), before `.factory/plans/029-*.md`
  (per-Function IAM rewrites how role statements are assembled).
- **Category**: bug (reliability)
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

Today no Event Source has a failure path. An SQS message that can never succeed is delivered
again until the queue's retention ends (4 days by default), and every delivery is a paid
invocation. A stream record that can never succeed blocks its shard until the record expires.
An SNS, EventBridge, S3 or schedule event that fails is retried twice by Lambda and then
dropped, with nothing left to inspect. A user finds out from a missing side effect.

After this plan, every Event Source Voke supports sends an event the Function cannot process
to an SQS queue that Voke creates, by default, with one option to turn it off. No source
redelivers forever, blocks a shard for a day, or drops an event silently.

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0007-opinionated-framework.md`: "one supported way to do each thing", "Each
  setting has one spelling", removals without deprecation aliases, and "New options should be
  added only when a use case cannot be met through the default or the layer's escape hatch".
  The escape hatch for infrastructure is "raw CloudFormation resource definitions in config".
  It also says: "opinions that affect deployed behavior should be verified against AWS before
  they are adopted".
- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: `voke` (core) is
  provider-neutral; `@voke/aws` owns all AWS code. **This plan changes nothing in
  `packages/core/src`.**
- ADR `docs/adr/0010-open-event-source-contract.md`: core carries an Event Source as
  `{ source, resource?, properties }` and "copies [properties] to the model untouched"; the
  model record is `{ type, resource?, properties }` (`packages/core/src/model.ts:115-120`).
  `@voke/aws` "keeps one internal adapter per source".
- ADR `docs/adr/0003-sqs-event-sources.md`: "Queue redrive and DLQ configuration are deferred
  because they belong to queue resource lifecycle design rather than Lambda trigger wiring."
  `CONTEXT.md:528-529` repeats it: "an SQS Event Source configures Lambda trigger behavior;
  queue redrive belongs to the queue resource."
- ADR `docs/adr/0011-push-event-sources-and-eventbridge-scheduler.md`: an invalid SNS or
  EventBridge payload "throws an `InvokeError` with code `INVALID_PAYLOAD`, the invocation
  fails, and Lambda's asynchronous retry and failure handling apply". Deferred there:
  "per-schedule retry policies and dead-letter queues, Lambda `OnFailure` destinations". Also:
  "these triggers, permissions and the Scheduler role are absent from the resources-only
  template that `voke local bootstrap` deploys".
- ADR `docs/adr/0012-stream-event-sources.md`: "`MaximumRetryAttempts` is not set, so Lambda
  retries a failing record until it expires from the stream. Without a failure destination, a
  capped mapping discards records after the last attempt [...] Failure destinations belong to
  the deferred DLQ and redrive design; when it lands, this default is reconsidered together
  with it." **This plan is that reconsideration.** The same ADR already says
  "`BisectBatchOnFunctionError` is on".
- ADR `docs/adr/0013-s3-event-sources-use-eventbridge.md`: S3 events reach the Function
  through an EventBridge rule; the adapter's `resourceProperties` hook patches the referenced
  resource and "does not run for the resources-only template".
- Vocabulary (`CONTEXT.md`): **Function**, **Event Source**, **SQS Event Source**, **SQS
  Batch Result**, **Stream Batch Result**, **Event Invocation**, **Provider**. Avoid "worker",
  "queue handler", "trigger" as a noun for the concept.

### Code at `1c59d39`

- **Nothing configures a failure path.**
  `grep -rn "RedrivePolicy\|DestinationConfig\|DeadLetter\|EventInvokeConfig" packages/aws/src`
  returns no match.
- **SQS**, `packages/aws/src/sqs.ts:243-247`: a body that fails the schema becomes a batch
  item failure, so SQS delivers it again.
  ```ts
  try {
    body = await parseMessageBody(schema.body, raw);
  } catch (error) {
    failures.push({ itemIdentifier: raw.messageId });
  ```
  The adapter emits one mapping per queue (`sqs.ts:490-503`, logical id
  `${lambdaLogicalId}${queueLogicalId}EventSourceMapping`) and defines neither
  `resourceProperties` nor `roleStatements`.
- **The queue builder**, `packages/aws/src/cloudformation-synthesis.ts:223-251`:
  `sqsQueue(options: SqsQueueOptions = {})` takes only `visibilityTimeoutSeconds` and emits
  `properties: {}` or `{ VisibilityTimeout }`. Synthesis adds a derived `VisibilityTimeout`
  for a consumed queue (`withDerivedVisibilityTimeout`, `:894-907`; the value is six times the
  consumer's timeout plus its batching window, `packages/aws/src/lambda-settings.ts:331-352`).
  `sqsQueue()` has no FIFO option; `grep -rni fifo packages/aws/src` returns no match.
- **Resource metadata**: `awsCloudFormationResource` (`cloudformation-synthesis.ts:81-102`)
  writes `provider.aws = { type: "cloudformation.resource", properties: { bindingValue,
cloudFormationType, outputName, policyResource } }`; core copies a builder's `provider`
  record to the model (`packages/core/src/model.ts:296-327`); `resourceProvider(resource)`
  reads it back as `AwsCloudFormationResourceProvider`
  (`packages/aws/src/cloudformation-template.ts:42-47,61-75`).
- **Streams**, `packages/aws/src/stream-batch.ts`: an invalid record becomes a batch item
  failure (`:196`, `failures.push({ itemIdentifier: sequenceNumber })`). Defaults (`:57-68`):
  ```ts
  bisectOnError: options.bisectOnError ?? true,
  ...
  ...(options.maxRetryAttempts === undefined
    ? {}
    : { maxRetryAttempts: options.maxRetryAttempts }),
  ```
  and the mapping only sets `MaximumRetryAttempts` when the user passed it (`:145-147`). The
  option's doc comment (`:41-46`) says "Unset by default: Lambda retries until the record
  expires, because without a failure destination a capped mapping drops records silently."
  Range check: `maxRetryAttempts: { max: 10_000, min: -1 }` (`:73`). `kinesis()` and
  `dynamodbStream()` both spread `streamEventSourceProperties(definition)` into their Event
  Source properties (`kinesis.ts:310-314`, `dynamodb-stream.ts:364-371`) and build the mapping
  with `streamEventSourceMappingProperties` (`kinesis.ts:414-425`,
  `dynamodb-stream.ts:506-517`). Their `roleStatements` grant stream reads only
  (`kinesis.ts:391-403`, `dynamodb-stream.ts:480-495`).
- **Push sources**: `packages/aws/src/sns.ts:195` (`parseJsonEventPayload` throws on a bad
  body) and the adapters' `toResponse` return nothing (`sns.ts:355-357`,
  `eventbridge.ts:381-383`, `s3.ts:557-559`, `schedule.ts:343-345`). The deployed handler
  lets the error propagate (`packages/aws/src/lambda-handlers.ts:249-255`), so Lambda's
  asynchronous retry applies and then the event is dropped. Resources per source:
  `sns.ts:338-352` (permission + subscription), `eventbridge.ts:300-329`
  (`eventBridgeRuleResources`: rule + permission, also used by `s3.ts:536-546`),
  `schedule.ts:310-331` (one `AWS::Scheduler::Schedule` with
  `Target: { Arn, Input, RoleArn }`) and `schedule.ts:259-305,334-340` (one shared
  `VokeSchedulerRole` whose only statement is `lambda:InvokeFunction`).
- **Adapter interface**, `packages/aws/src/event-sources.ts:34-70`: `synthesize(context)`
  returns resources keyed by logical id; optional `synthesizeStack(contexts)`,
  `roleStatements(context: AwsEventSourceContext)` and
  `resourceProperties(context, properties)`. `AwsEventSourceSynthesisContext` adds
  `lambdaLogicalId` to `AwsEventSourceContext`.
- **Synthesis loop**, `packages/aws/src/cloudformation-synthesis.ts`: resources at `:993-1010`;
  each Function's role at `:1033-1042` (it includes
  `toEventSourcePolicyStatements(name, definition, model)`, `:496-512`, which has no
  `lambdaLogicalId`); adapter output is merged with
  `Object.assign(templateResources, adapter.synthesize(eventSourceContext).resources)`
  (`:1132-1135`), which silently overwrites any resource with the same logical id;
  `patchEventSourceResource` at `:910-931,1136`; `synthesizeStack` at `:1144-1151`. A
  Function's logical id is `Function` for the key `http`, else `${toLogicalId(key)}Function`
  (`:561-562`). `scope: "resources"` empties `functions` before the loop (`:952-961`), so no
  adapter runs for the template `voke local bootstrap` deploys.
- **Local runs**: `functions.sendEvent` runs the same parsing and handler and returns the
  handler's result or throws. `voke dev` does not read from queues
  (`apps/docs/content/docs/guides/sqs-events.mdx:296-300`), and no code delivers AWS Emulator
  events to Functions (`grep -n "ReceiveMessage\|poll" packages/aws/src/local*.ts` finds only
  a health poll).
- **Tests that pin the affected output** (they must change with the code):
  - fixtures compared with `toEqual`:
    `packages/core/test/fixtures/sqs-event-source-cloudformation.json`
    (`packages/core/test/cloudformation.test.ts:191-194`),
    `packages/aws/test/fixtures/event-sources-cloudformation.json`,
    `stream-event-sources-cloudformation.json`, `s3-event-sources-cloudformation.json`;
  - stored Event Source properties: `packages/aws/test/kinesis.test.ts:230-241`,
    `dynamodb-stream.test.ts:~257-270`, `sns.test.ts:104-107`, `eventbridge.test.ts:113-120`,
    and the `schedule`/`s3` equivalents;
  - `packages/aws/test/event-source-synthesis.test.ts:146-147` pins `VokeSchedulerRole`'s
    `Policies`;
  - resources-only lists that must stay exactly as they are:
    `event-source-synthesis.test.ts:203-206`, `stream-synthesis.test.ts:297-300`,
    `s3-synthesis.test.ts:238-241`.
  - `packages/aws/test/template-references.ts` exports `findReferenceCycle(template)`.
- **Docs that state the current behaviour**: `guides/sqs-events.mdx:161-166,306-309`,
  `guides/sns-events.mdx:80-81,166`, `guides/eventbridge-events.mdx:~93,150`,
  `guides/s3-events.mdx:~83`, `guides/scheduled-functions.mdx:124`,
  `guides/kinesis-events.mdx:186-204`, `guides/dynamodb-stream-events.mdx:159-170`,
  `reference/config.mdx:206-218` ("Defaults" table), `guides/resources.mdx:40`,
  `guides/deploy.mdx:120-128` (all under `apps/docs/content/docs/`).

### AWS facts checked on 2026-11-15 (CloudFormation Template Reference and Lambda Developer Guide)

- `AWS::SQS::Queue.RedrivePolicy` is `Json`:
  `{ "deadLetterTargetArn": String, "maxReceiveCount": Integer }` (lower camel case), update
  without interruption. "The dead-letter queue of a FIFO queue must also be a FIFO queue."
  `MessageRetentionPeriod`: 60 to 1,209,600 seconds, default 345,600. Without
  `SqsManagedSseEnabled`, "SSE-SQS encryption is enabled by default".
- Lambda, "Configuring a queue to use with Lambda": "We recommend setting the
  `maxReceiveCount` on your source queue's redrive policy to at least 5." And: "If you're using
  Amazon SQS as an event source, configure a dead-letter queue on the Amazon SQS queue itself
  and not on the Lambda function."
- `AWS::Lambda::EventSourceMapping`: `DestinationConfig: { OnFailure: { Destination: <arn> } }`
  ("Kinesis, DynamoDB Streams, Amazon MSK, and self-managed Apache Kafka"; an SQS queue is an
  allowed destination), `MaximumRetryAttempts` (-1 to 10000, default -1 "infinite"),
  `BisectBatchOnFunctionError`, `MaximumRecordAgeInSeconds`. All update without interruption.
  "Splitting batches doesn't consume the retry quota." The execution role needs
  `sqs:SendMessage` for an SQS destination.
- For a stream, an SQS destination receives **metadata only**: "Because Lambda sends only the
  metadata for these destination types, use the `streamArn`, `shardId`,
  `startSequenceNumber`, and `endSequenceNumber` fields to obtain the full original record
  [...] you must process this record and retrieve them from the stream before they expire and
  are lost." (Only an S3 destination carries the payload.)
- `AWS::Lambda::EventInvokeConfig`: `FunctionName` (required), `Qualifier` (required; "To
  specify the unpublished version, use `$LATEST`"), `DestinationConfig`,
  `MaximumEventAgeInSeconds` (60 to 21600), `MaximumRetryAttempts` (0 to 2). "By default,
  Lambda retries an asynchronous invocation twice [...] retains events in a queue for up to six
  hours." The destination queue must be a standard queue; the execution role needs
  `sqs:SendMessage`. The on-failure record carries the event:
  `{ version, timestamp, requestContext: { requestId, functionArn, condition, approximateInvokeCount }, requestPayload, responseContext, responsePayload }`.
- `AWS::Scheduler::Schedule` `Target.DeadLetterConfig: { Arn: <sqs queue arn> }`: "EventBridge
  Scheduler delivers failed events that could not be successfully delivered to a target to the
  queue."

Not confirmed from a document (planner's knowledge; **verify before coding or before stating it
in docs**): EventBridge Scheduler sends to its dead-letter queue with the schedule's execution
role, which therefore needs `sqs:SendMessage`; `aws sqs start-message-move-task` only moves
messages that SQS itself dead-lettered from another SQS queue; the DynamoDB Streams record
uses `DDBStreamBatchInfo` where Kinesis uses `KinesisBatchInfo`; how exactly Lambda combines
`ReportBatchItemFailures`, bisecting and an exhausted retry count.

### State after plan 027 (expected; verify)

Plan 027 (`.factory/plans/027-data-resource-retention.md`) gives `dynamodbTable()`,
`s3Bucket()` and `secret()` `DeletionPolicy: "Retain"`, `UpdateReplacePolicy: "Retain"` and
`Metadata.VokeRetain: true` in the resource loop, driven by a `dataBearing` marker and a
`dataBearingTypes` list, and adds a deploy pre-flight that refuses to remove a retained
resource. It decides that `sqsQueue()` is **not** data-bearing ("records in transit with a
bounded lifetime; a retained queue has no consumer") and leaves the dead-letter queue to this
plan. Decision 9 answers it.

## Findings checked and corrected

- "Bisect-on-error reverses plan 016's default": wrong. `bisectOnError` is already `true` by
  default (`stream-batch.ts:61`, ADR 0012). Only the retry bound changes.
- "One dead-letter queue per Event Source Function": refined for SQS. A queue has one redrive
  policy and may be consumed by several Functions, so the queue owns its dead-letter queue
  (decision 2).
- "The CloudFormation 500-resource budget": nothing in the code counts resources. This plan
  documents the cost; it adds no check.
- `packages/idempotency/src/batch.ts:40-43` (a silent `catch`) belongs to plan 032.

## Decisions taken in this plan

1. **On by default, on every stage.** A project gets the failure path without asking. Reverse
   by flipping the default in the two places decision 3 names.
2. **Who owns the queue, and its logical id.**
   - SQS: the **source queue** owns it. Every queue that at least one Function consumes gets
     `<QueueLogicalId>DeadLetterQueue` and a `RedrivePolicy`. A queue nobody in the project
     consumes is left alone (its consumer is elsewhere, and a redrive policy would change that
     consumer's behaviour).
   - Kinesis, DynamoDB stream, SNS, EventBridge, S3, schedule: the **Function** owns it:
     `<FunctionLogicalId>DeadLetterQueue` (for example `OrderCreatedFunctionDeadLetterQueue`).
     Reason: AWS and `CONTEXT.md` both put SQS redrive on the queue; the other failure paths are
     Lambda settings of one Function. Reverse (one queue per stack) by emitting a single queue
     from `synthesizeStack`; the on-failure records name the Function.
3. **One opt-out spelling: `deadLetterQueue: false`,** written on the owner:
   `sqsQueue({ deadLetterQueue: false })` for SQS, and
   `kinesis | dynamodbStream | sns | eventBridge | s3 | schedule({ ..., deadLetterQueue: false })`
   for the rest. `sqs()` gets no such option. The type is `boolean`, default `true`. There is
   no `aws({ ... })` switch and no option to pass a queue of your own in this version.
4. **`maxReceiveCount` is 5** (the AWS recommendation quoted above) and is not configurable.
   The escape hatch: a hand-written queue resource whose `properties` already contain
   `RedrivePolicy` is left untouched and gets no dead-letter queue. Reverse by adding
   `sqsQueue({ deadLetterQueue: { maxReceiveCount } })`.
5. **Stream retries are bounded to 10 when there is a dead-letter queue**, and bisecting stays
   on. `maxRetryAttempts` (existing option) defaults to `10` when `deadLetterQueue` is on and
   stays unset (retry until the record expires) when it is `false`, so a mapping never
   discards records silently by default. `-1` still means "until expiry". Ten is small enough
   that a bad record leaves the shard quickly (bisecting does not consume retries) and larger
   than the 1 to 3 of most samples so a short downstream blip does not empty a shard into the
   queue. This supersedes the `MaximumRetryAttempts` paragraph of ADR 0012. Reverse by
   changing the constant.
6. **Stream failures go to SQS, not S3.** One kind of dead-letter queue for every source and
   no bucket to manage. The cost, stated in the guides: the message holds pointers (stream
   ARN, shard, first and last sequence number), not the records; they must be read from the
   stream before its retention ends (24 hours for DynamoDB Streams and for `kinesisStream()`
   without `retentionHours`). An S3 destination that keeps the payload is deferred.
7. **Push sources use `AWS::Lambda::EventInvokeConfig`** on `$LATEST` with an `OnFailure`
   destination, and keep Lambda's defaults (two retries, six hours). Not the older Function
   `DeadLetterConfig`: the destination record includes the response and the reason.
   `MaximumRetryAttempts` and `MaximumEventAgeInSeconds` are not set and not exposed.
8. **Schedules also set `Target.DeadLetterConfig`** to the same queue, so an invocation that
   EventBridge Scheduler could not deliver is kept too. The matching delivery-side settings
   for SNS (`RedrivePolicy` on the subscription) and EventBridge (`DeadLetterConfig` on the
   rule target) are **deferred**: each needs an `AWS::SQS::QueuePolicy`, and they only cover
   Lambda refusing the invoke call, not a Function that fails.
9. **Queue settings.** `MessageRetentionPeriod: 1209600` (14 days, the maximum; a standard
   queue keeps the original enqueue time, so it must outlast the source's 4 days). No name
   (CloudFormation generates it), no KMS key (SSE-SQS is the default), no binding, no stack
   output, no IAM for user code. If the source queue's properties have `FifoQueue: true`
   (only possible with a hand-written resource; `sqsQueue()` cannot make a FIFO queue and
   FIFO is not a supported SQS Event Source), its dead-letter queue gets `FifoQueue: true`
   so the stack still deploys; nothing else about FIFO is in scope. No `RedriveAllowPolicy`:
   naming the source queue there would make the two queues depend on each other.
   **A dead-letter queue is not retained**: no `DeletionPolicy`, no `UpdateReplacePolicy`, no
   `dataBearing` marker, the same as plan 027 decides for `sqsQueue()`. Its messages expire
   after 14 days anyway, a retained queue with a generated name would be orphaned on every
   Function or queue rename, and plan 027's pre-flight would then refuse every removal of an
   Event Source Function. The cost, stated in the guide: renaming or removing the owner, or
   setting `deadLetterQueue: false`, deletes the queue and the messages in it, so drain it
   first. Reverse by marking the queue data-bearing as plan 027's maintenance notes describe.
10. **IAM.**

    | Path                         | Who sends                         | Statement added                                                     |
    | ---------------------------- | --------------------------------- | ------------------------------------------------------------------- |
    | SQS redrive                  | SQS itself                        | none                                                                |
    | Stream `OnFailure`           | Lambda, as the Function role      | `sqs:SendMessage` on that Function's queue, on that Function's role |
    | Push `EventInvokeConfig`     | Lambda, as the Function role      | the same                                                            |
    | Scheduler `DeadLetterConfig` | Scheduler, as `VokeSchedulerRole` | `sqs:SendMessage` on the scheduled Functions' queues, on that role  |

    Statements go through the adapter's `roleStatements`, so only the owning Function's role
    gets them. No Function can read any dead-letter queue.

11. **Resource count** (CloudFormation allows 500 per stack): +1 per consumed queue; +1 per
    stream Function; +2 per SNS, EventBridge, S3 or schedule Function (queue and
    `EventInvokeConfig`). A push-source Function goes from 5 resources to 7. Documented, not
    enforced; `deadLetterQueue: false` gives them back.
12. **Local runs do not change.** `functions.sendEvent` still returns the batch result or
    throws; nothing retries and nothing is dead-lettered. The resources-only template
    (`voke local bootstrap`, AWS Emulator) contains no dead-letter queue and no
    `RedrivePolicy`, because no adapter runs for it. Tests assert on the returned
    `batchItemFailures` or the thrown error.
13. **Reading and redriving is documented, not built.** No `voke` command; the guide shows the
    AWS console and CLI path.
14. **Stored properties.** The six non-SQS builders always store `deadLetterQueue: true | false`
    in the Event Source properties (the model holds no `undefined`, and the Dev Function
    Summary prints it). `sqsQueue()` stores `deadLetterQueue: false` in its
    `provider.aws.properties` only when opted out; SQS Event Source properties do not change,
    so core's tests of them stay as they are.

## Commands you will need

| Purpose           | Command                                                    | Expected on success |
| ----------------- | ---------------------------------------------------------- | ------------------- |
| One AWS test file | `cd packages/aws && bun test test/<file>.test.ts`          | 0 fail              |
| AWS package       | `cd packages/aws && bun test && bun run typecheck`         | 0 fail, exit 0      |
| Core fixture test | `cd packages/core && bun test test/cloudformation.test.ts` | 0 fail              |
| Examples          | `cd examples/<name> && bun test && bun run typecheck`      | 0 fail, exit 0      |
| Docs samples      | `cd apps/docs && bun run check:samples guides/<page>.mdx`  | exit 0              |
| Docs tests, links | `cd apps/docs && bun run test && bun run lint:links`       | exit 0              |
| Format            | `bun x ultracite fix`                                      | exit 0              |
| Repo gates        | `bun run check && bun run typecheck && bun run test`       | exit 0              |

`bun run check`, `bun run typecheck` and `bun run test` ran green at `1c59d39`. The
package-scoped forms are the repository's standard scripts; they were not run during planning.
Do not use root `bun test` as a gate (plan 022 owns its failures).

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`): write the failing synthesis test, then the code.
- No change under `packages/core/src`. No new dependency. No new public export: the new
  option fields live on types that are already exported (`SqsQueueOptions`,
  `StreamEventSourceOptions`, the `*FunctionDefinitionInput` types), so
  `packages/core/test/public-surface.test.ts` needs no export change.
- Logical ids must stay stable: they derive from the queue key or the Function key, never
  from an index.
- Update fixtures by regenerating them from the synthesizer and reading the diff: it may add
  only the resources and properties this plan names. Do not hand-edit other parts.
- Adapters must give the same result when called twice (`resourceProperties` is called once
  per Event Source).
- Ultracite style, no `console.log`, early returns, no `Bun` global in `packages/aws/src`.
- Every `ts` fence on a docs page must be ` ```ts twoslash ` and compile
  (`apps/docs/test/samples.test.ts`); shell fences are free.

## Scope

**In scope**:

- `packages/aws/src/dead-letter-queue.ts` (create), `sqs.ts`, `stream-batch.ts`, `kinesis.ts`,
  `dynamodb-stream.ts`, `sns.ts`, `eventbridge.ts`, `s3.ts`, `schedule.ts`,
  `event-sources.ts`, `cloudformation-template.ts`, and in `cloudformation-synthesis.ts` only:
  `SqsQueueOptions` / `sqsQueue`, `awsCloudFormationResource` and its types,
  `toEventSourcePolicyStatements`, and the adapter merge at `:1132-1135`.
- `packages/aws/test/dead-letter-queue-synthesis.test.ts` (create), the three fixtures in
  `packages/aws/test/fixtures/`, and the existing tests listed under "Tests that pin the
  affected output".
- `packages/core/test/fixtures/sqs-event-source-cloudformation.json` (fixture only).
- `examples/sqs-events`, `examples/event-sources`, `examples/stream-events`: `test/` only.
- Docs under `apps/docs/content/docs/`: `guides/dead-letter-queues.mdx` (create),
  `meta.json`, the seven Event Source guides, `guides/resources.mdx`, `guides/deploy.mdx`,
  `guides/troubleshooting.mdx`, `guides/testing.mdx` (one sentence), `reference/config.mdx`;
  `packages/core/test/public-surface.test.ts` (`teachingSurfaceFiles` entry for the new page
  only).
- `docs/adr/` (one new ADR; one-line "superseded in part" notes in 0003, 0011 and 0012),
  `CONTEXT.md`.

**Out of scope**:

- `packages/core/src/**`.
- Retention and replacement policies and the deploy pre-flight (plan 027); per-Function
  resource linking (plan 029), apart from keeping this plan's statements per Function.
- `packages/idempotency` (plan 032).
- A `voke` command to list or redrive dead-letter queues; alarms on queue depth.
- Bindings or IAM that let user code read a dead-letter queue; a user-supplied queue.
- FIFO queue support in `sqsQueue()` / `sqs()`.
- SNS subscription `RedrivePolicy`, EventBridge target `DeadLetterConfig`, S3 destinations.
- Invokable Functions called asynchronously (`functions.invoke` with an event invocation
  type): they are not Event Sources.
- Delivering events, retries or dead-lettering in `voke dev` or the AWS Emulator.

## Git workflow

- Branch `feature/dead-letter-queues`, stacked on the branch of the previous plan in the
  round (`origin/main` stops at PR #52; newer work is stacked on feature branches).
- Commit subjects are imperative sentences that state the outcome, one per slice, for example
  "Move failed SQS messages to a dead-letter queue". Commit only if the task authorizes it. Do
  not push or open a PR unless told.

## Where this plan can be split

Step 1 (SQS) is a complete slice. Step 2 (streams) and Step 3 (push sources and schedules)
are each complete after it. If one session cannot finish, stop after Step 1 or Step 2, and in
that session still do the parts of Steps 4 and 5 that concern the sources already shipped:
write the ADR and the `CONTEXT.md` entry in full (the decision covers every source; add one
line naming the sources not yet implemented), create the guide page with the shipped sections,
and leave the other guides' "there is no dead-letter queue" lines untouched. Report which
slices remain.

## Steps

### Step 0: Check the base

Run the drift check. Confirm `grep -rn "RedrivePolicy\|EventInvokeConfig" packages/aws/src`
is still empty. If plan 027 landed, confirm it left `sqsQueue()` without a retention policy;
if it retains queues after all, apply the first STOP condition.

### Step 1: SQS (complete slice)

Tests first, in `packages/aws/test/dead-letter-queue-synthesis.test.ts` (model the helpers on
`packages/aws/test/stream-synthesis.test.ts:16-78`):

1. A consumed queue: `Resources.OrdersQueueDeadLetterQueue` equals
   `{ Type: "AWS::SQS::Queue", Properties: { MessageRetentionPeriod: 1209600 } }` exactly (no
   deletion policy, decision 9), and `Resources.OrdersQueue.Properties` equals
   ```json
   {
     "VisibilityTimeout": 90,
     "RedrivePolicy": {
       "deadLetterTargetArn": {
         "Fn::GetAtt": ["OrdersQueueDeadLetterQueue", "Arn"]
       },
       "maxReceiveCount": 5
     }
   }
   ```
2. `sqsQueue({ deadLetterQueue: false })`: no `RedrivePolicy`, no dead-letter queue.
3. A queue with no consumer: unchanged.
4. Two Functions consuming one queue: one dead-letter queue, one policy, no error.
5. One Function with `queues: ["a", "b"]`: two dead-letter queues.
6. A hand-written queue resource (spread `sqsQueue()` and add
   `properties: { RedrivePolicy: { ... } }`): properties untouched, no dead-letter queue.
7. A hand-written queue with `FifoQueue: true`: its dead-letter queue has `FifoQueue: true`.
8. `scope: "resources"`: the queue has no `RedrivePolicy` and the template has no
   `...DeadLetterQueue`.
9. A declared resource keyed `ordersQueueDeadLetterQueue` next to a consumed `ordersQueue`:
   synthesis throws a `VokeModelError` that names both and suggests renaming the resource or
   `deadLetterQueue: false`.
10. `findReferenceCycle(template)` is `undefined`.
11. No Function role gains a statement for the dead-letter queue.

Then implement:

- `packages/aws/src/dead-letter-queue.ts`, the one place that knows the queue's shape:
  ```ts
  export const deadLetterQueueLogicalId = (ownerLogicalId: string): string =>
    `${ownerLogicalId}DeadLetterQueue`;
  export const deadLetterQueueArn = (logicalId: string): CloudFormationValue => ({
    "Fn::GetAtt": [logicalId, "Arn"],
  });
  export const deadLetterQueueResource = (options?: { fifo?: boolean }): CloudFormationResource;
  export const sendToDeadLetterQueueStatement = (logicalId: string): CloudFormationValue;
  // { Action: ["sqs:SendMessage"], Effect: "Allow", Resource: deadLetterQueueArn(logicalId) }
  ```
  Name the constants (`deadLetterRetentionSeconds = 1_209_600`, `sqsMaxReceiveCount = 5`).
- `sqsQueue`: add to `SqsQueueOptions`
  ```ts
  /**
   * A queue that a Function consumes gets a dead-letter queue: after 5 failed receives SQS
   * moves the message there and keeps it for 14 days. `false` turns it off, and a failing
   * message is then delivered again until the queue's retention ends. Default true.
   */
  deadLetterQueue?: boolean;
  ```
  and record `deadLetterQueue: false` in `provider.aws.properties` when opted out (extend
  `awsCloudFormationResource`, `StackResourceDefinition["provider"]` and
  `AwsCloudFormationResourceProvider` with an optional `deadLetterQueue?: boolean`). Check
  that `packages/aws/test/model-extension-records.test.ts` and core's model validation accept
  the extra key (see STOP conditions).
- `sqsEventSourceAdapter` (`sqs.ts`): one helper decides for a context whether the queue gets
  a dead-letter queue (queue resource present, marker not `false`, no `RedrivePolicy` in its
  properties) and returns its logical id and whether it is FIFO. `synthesize` adds the queue
  resource next to the mapping; a new `resourceProperties` returns
  `{ ...properties, RedrivePolicy: { deadLetterTargetArn, maxReceiveCount } }` or the
  properties unchanged.
- `cloudformation-synthesis.ts:1132-1135`: replace the bare `Object.assign` with a merge that
  throws `VokeModelError.validation` when an adapter resource would replace an existing
  template resource with different content (compare with `JSON.stringify`; identical content
  is the shared-queue case and is allowed). Message shape:
  `Function "<key>" needs the logical id "<Id>" for its dead-letter queue, but resource "<name>" already uses it. Rename the resource, or turn the dead-letter queue off with deadLetterQueue: false.`
  Keep the guard generic (any adapter resource), and word the hint for the dead-letter case
  only when the id ends in `DeadLetterQueue`.
- Regenerate `packages/core/test/fixtures/sqs-event-source-cloudformation.json`.

**Evidence**: `cd packages/aws && bun test test/dead-letter-queue-synthesis.test.ts` and
`cd packages/core && bun test test/cloudformation.test.ts` pass; the fixture diff adds one
queue and one `RedrivePolicy` per consumed queue and nothing else.

### Step 2: Kinesis and DynamoDB streams

Tests first (same new test file, plus the existing ones):

1. Default mapping for each source has
   `DestinationConfig: { OnFailure: { Destination: { "Fn::GetAtt": ["<Fn>DeadLetterQueue", "Arn"] } } }`,
   `MaximumRetryAttempts: 10` and `BisectBatchOnFunctionError: true`; the queue resource
   exists; the consuming Function's role has `sqs:SendMessage` on exactly that ARN, and no
   other role has it (follow `stream-synthesis.test.ts`'s `roleStatements` helper).
2. `deadLetterQueue: false`: no `DestinationConfig`, no `MaximumRetryAttempts`, no queue, no
   statement.
3. `deadLetterQueue: false, maxRetryAttempts: 3`: `MaximumRetryAttempts: 3`, no destination.
4. `maxRetryAttempts: -1` with the default dead-letter queue: `MaximumRetryAttempts: -1` and
   the destination is still set.
5. Stored properties: `kinesis({...}).events[0].properties` gains `deadLetterQueue: true` and
   `maxRetryAttempts: 10` (update `kinesis.test.ts:230-241` and the DynamoDB equivalent).
6. A non-boolean `deadLetterQueue` in the model fails validation with a message naming the
   Function and the path `functions.<key>.eventSources.<i>.properties.deadLetterQueue`.
7. Resources-only list unchanged (`stream-synthesis.test.ts:297-300` stays green).

Then implement:

- `StreamEventSourceOptions` (`stream-batch.ts`): add `deadLetterQueue?: boolean` and rewrite
  the `maxRetryAttempts` comment:
  ```ts
  /**
   * Keep a record of batches Lambda gives up on in a dead-letter queue. The message holds the
   * stream, shard and sequence numbers, not the records. Default true.
   */
  deadLetterQueue?: boolean;
  /**
   * Retries before Lambda gives up on a failing batch, -1 (until the record expires) to 10000.
   * Default 10 with a dead-letter queue. Without one it is unset, so Lambda retries until the
   * record expires rather than discarding it silently.
   */
  maxRetryAttempts?: number;
  ```
  `streamEventSourceProperties` stores `deadLetterQueue` always and resolves
  `maxRetryAttempts` (`options.maxRetryAttempts ?? (deadLetterQueue ? 10 : undefined)`).
  `StreamEventSourceProperties` gains the required `deadLetterQueue`.
- `streamEventSourceMappingProperties` takes an optional `deadLetterQueueArn` and sets
  `DestinationConfig` from it.
- `event-sources.ts`: `roleStatements?(context: AwsEventSourceSynthesisContext)`;
  `toEventSourcePolicyStatements` in `cloudformation-synthesis.ts` receives and passes the
  Function's logical id (the call site has `logicalId`, `:1029`).
- `kinesisEventSourceAdapter` and `dynamodbStreamEventSourceAdapter`: add the queue to
  `synthesize`, the destination to the mapping, the statement to `roleStatements`, all gated
  on `eventSource.properties.deadLetterQueue !== false`.
- A shared `deadLetterQueueOptionIssues(context)` in `dead-letter-queue.ts` (boolean check),
  called from `streamOptionIssues`.
- Regenerate `stream-event-sources-cloudformation.json`.

### Step 3: SNS, EventBridge, S3 and schedules

Tests first:

1. For each of the four sources, by default:
   `Resources.<Fn>DeadLetterQueue` exists;
   `Resources.<Fn>EventInvokeConfig` equals
   ```json
   {
     "Type": "AWS::Lambda::EventInvokeConfig",
     "Properties": {
       "DestinationConfig": {
         "OnFailure": {
           "Destination": { "Fn::GetAtt": ["<Fn>DeadLetterQueue", "Arn"] }
         }
       },
       "FunctionName": { "Ref": "<Fn>" },
       "Qualifier": "$LATEST"
     }
   }
   ```
   and that Function's role, and only it, has `sqs:SendMessage` on the queue.
2. Schedule: the schedule's `Target` gains
   `DeadLetterConfig: { Arn: { "Fn::GetAtt": ["<Fn>DeadLetterQueue", "Arn"] } }`, and
   `VokeSchedulerRole` gains a second statement, `sqs:SendMessage` on the queues of the
   scheduled Functions that have one (update `event-source-synthesis.test.ts:146-147`). With
   every schedule opted out the role has only the `lambda:InvokeFunction` statement.
3. `deadLetterQueue: false` on each source: no queue, no `EventInvokeConfig`, no statement,
   no `DeadLetterConfig`.
4. Stored properties gain `deadLetterQueue` (update `sns.test.ts:104-107`,
   `eventbridge.test.ts:113-120` and the `s3` / `schedule` equivalents).
5. Resources-only lists unchanged; `findReferenceCycle` is `undefined` for a template with all
   seven sources (extend the S3 cycle test's approach, `s3-synthesis.test.ts:~223`).

Then implement:

- `dead-letter-queue.ts`: `asyncFailureResources(lambdaLogicalId)` returning the queue and the
  `EventInvokeConfig`.
- Add `readonly deadLetterQueue?: boolean` (doc comment: "Keep events this Function fails
  after Lambda's retries in a dead-letter queue. Default true.") to
  `SnsFunctionDefinitionInput`, `EventBridgeFunctionDefinitionInput`,
  `S3FunctionDefinitionInput` and `ScheduleFunctionDefinitionInput`, store it in each Event
  Source's properties (and in the `*EventSourceDefinition` property types), and add
  `deadLetterQueueOptionIssues` to each adapter's `validate`.
- Each adapter: spread `asyncFailureResources` into `synthesize` and add `roleStatements`.
  `eventBridgeRuleResources` itself does not change.
- `schedule.ts`: `DeadLetterConfig` on the target; `schedulerRole` takes the dead-letter queue
  logical ids and adds the statement when the list is not empty. Before coding, confirm in the
  EventBridge Scheduler User Guide ("Configuring a dead-letter queue") that the execution role
  is what needs `sqs:SendMessage`; if it requires a queue policy instead, apply the STOP
  condition.
- Regenerate `event-sources-cloudformation.json` and `s3-event-sources-cloudformation.json`.

### Step 4: Examples

Add one assertion per example test, no source change:
`examples/sqs-events/test/synthesis.test.ts` (the consumed queue has a `RedrivePolicy`),
`examples/stream-events/test/synthesis.test.ts` (both mappings have a `DestinationConfig`),
`examples/event-sources/test/synthesis.test.ts` (one `AWS::Lambda::EventInvokeConfig` per
push-source Function). Run each example's `bun test` and `bun run typecheck`.

### Step 5: ADR, vocabulary and docs

- **ADR** with the next free number at execution time (0018 at `1c59d39`; three files share
  0007), titled as a decision, for example "Failed events go to a dead-letter queue by
  default". Record decisions 1 to 12 in prose, the AWS facts they rest on, and that it
  supersedes: the `MaximumRetryAttempts` paragraph of ADR 0012, the DLQ deferral in ADR 0003
  and the "dead-letter queues, Lambda `OnFailure` destinations" deferral in ADR 0011. Add one
  line at the end of each of those three ADRs pointing to it. List what stays deferred
  (decision 8, S3 destinations, a redrive command, FIFO, asynchronous `functions.invoke`).
- **`CONTEXT.md`**: add after **Stream Batch Result**:

  > **Dead-Letter Queue**: The SQS queue Voke creates to keep an event that a **Function**
  > could not process after its **Event Source**'s retries. A consumed queue owns one; for
  > every other **Event Source** the **Function** owns one.
  > _Avoid_: DLQ as a user-declared resource, error queue, failure topic

  Replace the two dialogue pairs at `:528-532` and the bullet at `:696` ("DLQ/redrive
  configuration is deferred") with the new rule: on by default, `deadLetterQueue: false` on
  `sqsQueue()` for SQS and on the Event Source Function for the others; redrive stays manual.

- **`guides/dead-letter-queues.mdx`** (new; add to `apps/docs/content/docs/meta.json` after
  `guides/s3-events` and to `teachingSurfaceFiles` in
  `packages/core/test/public-surface.test.ts`). Sections: what happens to a failed event per
  source (a table: source, what retries, when the event is dead-lettered, what the message
  contains); the logical id rule and how to find the queue
  (`aws cloudformation describe-stack-resource --stack-name <name>-<stage> --logical-resource-id OrdersQueueDeadLetterQueue --query StackResourceDetail.PhysicalResourceId --output text`
  prints the queue URL; the stack is `<name>-<stage>`, `packages/aws/src/deploy.ts:517`);
  reading messages (`aws sqs receive-message`, or the SQS console's "Send and receive
  messages"); message shapes (an SQS source: the original message; a push source: the Lambda
  invocation record with `requestPayload`; a schedule that could not be delivered: the
  schedule envelope; a stream: pointers only, with the retention warning of decision 6);
  sending events back (SQS console "Start DLQ redrive" for an SQS source; re-publish or
  re-invoke for the others; state the `start-message-move-task` limit only after checking it
  in the SQS API reference); turning it off (one `ts twoslash` sample for `sqsQueue` and one
  for a builder); cost (resources per Function, decision 11; an empty queue costs nothing);
  local runs (decision 12).
- **Event Source guides**: replace each statement that there is no dead-letter queue with the
  new behaviour and a link. `sqs-events.mdx:161-166` (the callout) and `:306-309` (the Limits
  bullet); `sns-events.mdx:80-81,166`; `eventbridge-events.mdx` (~93, 150);
  `s3-events.mdx` (~83); `scheduled-functions.mdx:124`; `kinesis-events.mdx` (option table
  `:186-187`: add `deadLetterQueue`, change `maxRetryAttempts` to "10, or not set without a
  dead-letter queue"; rewrite "When a record can never succeed", `:193-204`; "What gets
  deployed"); `dynamodb-stream-events.mdx:159-170` likewise.
- `guides/resources.mdx:40` (`sqsQueue` row: add `deadLetterQueue`);
  `reference/config.mdx:206-218` (two rows in "Defaults": dead-letter queue "on" with where to
  change it, stream retries "10"); `guides/deploy.mdx:120-128` (a stack with any Event Source
  creates SQS queues, so the deploying identity needs SQS permissions even without a declared
  queue); `guides/troubleshooting.mdx` (one entry: "An event failed and I cannot find it");
  `guides/testing.mdx` (one sentence from decision 12).

**Evidence**: `cd apps/docs && bun run check:samples guides/dead-letter-queues.mdx`,
`bun run test` and `bun run lint:links` exit 0;
`grep -rn "no dead-letter queue" apps/docs/content` returns no match.

### Step 6: Gates

`bun x ultracite fix`, then `bun run check && bun run typecheck && bun run test`.

## Test plan

- New: `packages/aws/test/dead-letter-queue-synthesis.test.ts` with the cases listed in Steps
  1 to 3 (about 25). Pattern: `packages/aws/test/stream-synthesis.test.ts` for building a
  project and reading role statements; `packages/aws/test/s3-synthesis.test.ts` for the cycle
  check with `findReferenceCycle`.
- Changed: four fixtures; the property and scheduler-role assertions named in "Tests that pin
  the affected output"; one assertion in each of three examples.
- Must stay green unchanged: the three resources-only tests, `packages/core/test/model.test.ts`
  and `public-api-redesign.test.ts` (SQS Event Source properties do not change),
  `packages/aws/test/lambda-defaults.test.ts` (derived visibility timeout).
- All tests are synthesis or model tests: no network, no AWS, no timers.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] A template with one Function per source (SQS, SNS, EventBridge, schedule, S3, Kinesis,
      DynamoDB stream) contains a dead-letter queue for each, wired as decisions 2 to 8 say,
      and `findReferenceCycle` returns `undefined` (test in the new file)
- [ ] `deadLetterQueue: false` removes every added resource, property and statement for that
      source (one test per source)
- [ ] Only the owning Function's role (and `VokeSchedulerRole` for schedules) can send to a
      dead-letter queue (tests)
- [ ] The resources-only template contains no dead-letter queue and no `RedrivePolicy` (tests)
- [ ] `git diff --stat <base> -- packages/core/src` is empty
- [ ] `grep -rn "RedrivePolicy\|EventInvokeConfig\|DestinationConfig\|DeadLetterConfig" packages/aws/src`
      matches only `sqs.ts`, `stream-batch.ts`, `schedule.ts` and `dead-letter-queue.ts`
- [ ] The ADR exists and ADRs 0003, 0011 and 0012 point to it; `CONTEXT.md` defines
      **Dead-Letter Queue** and no longer says DLQ is deferred
- [ ] `grep -rn "no dead-letter queue" apps/docs/content` returns no match; the new guide is in
      `meta.json`; docs samples, tests and links pass
- [ ] The report says which AWS facts marked "verify" were checked, and that no real-AWS
      deploy was run
- [ ] No files outside the in-scope list are modified (`git status --short`)

## STOP conditions

- Plan 027 changed synthesis so that an adapter can no longer add an `AWS::SQS::Queue`
  resource or patch a queue's properties, or it added its own dead-letter or redrive option to
  `sqsQueue()`, or it retains queues declared with `sqsQueue()` (decision 9 assumes it does
  not). Report the conflict instead of keeping two spellings or two rules.
- Core's model validation rejects the extra `deadLetterQueue` key in a resource's
  `provider.aws.properties`, so the opt-out for SQS cannot be stored without a change in
  `packages/core/src`. Report it; do not move the option to `sqs()` on your own (decision 3).
- EventBridge Scheduler needs a queue resource policy rather than a role statement for its
  dead-letter queue. Ship the `EventInvokeConfig` path for schedules, leave
  `DeadLetterConfig` out, and report it.
- The synthesized template has a reference cycle that only a `DependsOn` or a restructure of
  the role policies can break.
- `voke local bootstrap` output changes (any dead-letter queue or `RedrivePolicy` in the
  resources-only template). That would put untested resources into the AWS Emulator.

A changed excerpt or line number is a reason to adapt, not to stop.

## Maintenance notes

- **Not proven on AWS.** No deploy ran. The first real-AWS smoke deploy should include one
  SQS, one stream and one push-source Function and check: the stack creates (Lambda validates
  the role's `sqs:SendMessage` when it creates the `EventInvokeConfig` and the mapping; the
  statement is inline in the role, which the Function depends on), a poison SQS message
  reaches its dead-letter queue after five receives, a thrown SNS handler produces an
  invocation record, and a bad stream record leaves the shard. Also observe how Lambda
  combines `ReportBatchItemFailures`, bisecting and the retry count; the docs here describe
  the outcome, not that mechanism.
- **Streams keep pointers, not payloads** (decision 6). If users lose records because the
  stream expired first, switch the stream destination to S3 or raise the default
  `kinesisStream()` retention; both are one-place changes.
- **Plan 029** (per-Function IAM): the dead-letter statements already come from
  `roleStatements` and must stay on the owning Function's role only.
- **Plan 027**: renaming a Function or a queue renames its dead-letter queue's logical id, so
  CloudFormation deletes the old queue with its messages (decision 9). If that loses failed
  events in practice, mark the queue data-bearing and accept that the pre-flight then guards
  every removal of an Event Source Function.
- If an Event Source ever allows several sources per Function (a plural form), the
  Function-owned queue and the single `EventInvokeConfig` still hold; only the SQS rule is per
  queue.
- Reviewers should check: no change in `packages/core/src`; the fixture diffs contain only
  the named additions; the resources-only tests are untouched; every opt-out test removes the
  IAM statement as well as the resources.
- Deferred, with the reason: SNS subscription and EventBridge target dead-letter settings
  (need a queue policy; cover only a refused invoke call); S3 failure destinations; a
  configurable `maxReceiveCount` or retention; a user-supplied queue; bindings to read a
  dead-letter queue from code; a `voke` redrive command; alarms; FIFO; asynchronous
  `functions.invoke`.
