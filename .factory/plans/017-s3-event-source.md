# Plan 017: A Function can react to objects created or deleted in an S3 bucket

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 4015c46 -- packages/aws/src packages/aws/test packages/core/test examples apps/docs/content CONTEXT.md docs`
> and `git status --short` with the recorded current state. Plans 014 and 015 land first and
> change the Event Source types, the adapter table, `eventbridge.ts` and
> `cloudformation-synthesis.ts` on purpose. Reconcile that drift; pause only if it invalidates a
> protected contract or a decision listed below.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**:
  - `.factory/plans/014-open-event-source-contract.md` (hard: the adapter table)
  - `.factory/plans/015-sns-eventbridge-schedule-event-sources.md` (hard: this plan reuses its
    EventBridge rule and Lambda permission synthesis, and extends its example)
  - Ordering only: `.factory/plans/016-kinesis-dynamodb-stream-event-sources.md` edits the same
    adapter interface, `index.ts`, the public-surface test and `meta.json`; do not run in parallel.
- **Category**: direction
- **Planned at**: commit `4015c46`, 2026-11-14

## Why this matters

"Run code when a file is uploaded" is one of the first things people build on Lambda: thumbnails,
imports, virus scans. Voke can declare a bucket with `s3Bucket()` but cannot trigger a Function
from it, and the classic way to wire that trigger in CloudFormation produces a circular dependency
in Voke's templates. This plan adds an `s3()` Event Source that avoids the cycle by routing bucket
events through EventBridge, gives the handler one normalized object event, and is testable locally
through `functions.sendEvent`.

## Current state

### Vocabulary (from `CONTEXT.md`; use these terms)

- **Function**, **Function Registry**, **Provider**, **Event Source** ("a trigger relationship
  where an external event provider invokes a Function"), **Event Invocation**
  (`functions.sendEvent(key, event)`).
- Binding rules: Event Source Functions do not mix with routes or invokable handlers; an Event
  Source references its resource by Voke resource key; "`sqsQueue()` defines a queue resource;
  `sqs({ queue })` attaches a queue as an SQS Event Source". Here `s3Bucket()` declares the bucket
  and `s3({ bucket })` attaches the Event Source.

### Architecture rules (binding)

- `docs/adr/0007-specialized-provider-and-helper-packages.md`: all AWS code lives in `@voke/aws`.
- `docs/adr/0007-opinionated-framework.md`: one way per thing; no aliases. So there is one S3
  trigger mechanism, not a choice between bucket notifications and EventBridge.
- `docs/adr/0009-aws-emulator-local-provider.md`: "Resource bindings come from stack outputs, not
  from guessed names. CloudFormation generates physical names such as
  `hello-api-local-UsersTable-EF186B141961`". Voke never sets a bucket name, so a bucket's name
  and ARN are only available through `Ref` and `Fn::GetAtt`.

### Why classic bucket notifications do not work here (verified in code at `4015c46`)

In `synthesizeCloudFormationFromModel` (`packages/aws/src/cloudformation-synthesis.ts`):

- `:974` and `:990-992` collect policy statements for **every** declared resource into one list:
  ```ts
  policyStatements.push(
    ...toResourcePolicyStatements(logicalId, resource, provider)
  );
  ```
  For a bucket these reference the bucket by `{ "Fn::GetAtt": [logicalId, "Arn"] }` (`:343-365`).
- `:1012-1018` builds **every** Function's role from that whole list:
  ```ts
  templateResources[roleLogicalId] = functionRoleResource([
    ...policyStatements,
    ...toRuntimeVariablePolicyStatements(definition.variables, model.resources),
  ]);
  ```
  So each role depends on the bucket.
- `:1066` each Lambda depends on its role: `Role: { "Fn::GetAtt": [roleLogicalId, "Arn"] }`.

A classic trigger puts the Lambda ARN in the bucket's
`NotificationConfiguration.LambdaConfigurations`, so the bucket depends on the Lambda. The result
is Bucket → Lambda → Role → Bucket, which CloudFormation rejects as a circular dependency. The
usual workaround is to give the bucket a fixed name and write its ARN as a string, which Voke
does not do (generated names, above).

With EventBridge the bucket only gets a flag and references nothing:
Rule → Bucket (name), Rule → Lambda, Permission → Lambda and Rule, Lambda → Role → Bucket. There
is no path back to the rule, so there is no cycle.

### Other code facts

- `s3Bucket()` (`cloudformation-synthesis.ts:218-232`) takes no options: `properties: {}`,
  binding attribute `name` (`Ref`), `policyResource: "s3ArnWithObjects"`, actions `s3:GetObject`,
  `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`. Every Function role therefore can already
  read the objects an event names.
- Resource properties can be patched at synthesis time from the Functions that use the resource:
  `withDerivedVisibilityTimeout` (`:905-918`) does it for queues and is applied at `:987`. With
  `scope: "resources"` the model is first reduced by `resourcesOnly` (`:939-948`, `:965-966`,
  `functions: {}`), so such patches do not appear in the local resources-only template.
- The migrator reports S3 events as manual work
  (`packages/core/src/serverless-migration.ts:1291-1292`): "S3 notifications require bucket
  notification wiring and permissions that Voke does not generate in this migration phase."
  Asserted at `packages/core/test/serverless-migration.test.ts:732`.
- Docs rule: every `ts`/`tsx` fence under `apps/docs/content/docs` must be `twoslash` and compile
  (`apps/docs/test/samples.test.ts`; `legacyUncheckedPages` stays empty). Pages are listed in
  `apps/docs/content/docs/meta.json`.

### State after plans 014 and 015 (expected; verify)

- `@voke/aws` has an internal adapter per Event Source (`toInvocation`, `toResponse`, `validate`,
  `synthesize`), and an `eventBridge()` source whose synthesis builds an `AWS::Events::Rule` with
  an optional bus, an event pattern and one Lambda target, plus an `AWS::Lambda::Permission` for
  `events.amazonaws.com`. Plan 015's maintenance notes ask that this rule builder stay a reusable
  function.
- `examples/event-sources/` exists with SNS, EventBridge and schedule Functions.

## Decisions taken in this plan

1. **One entrypoint from `@voke/aws`: `s3`.**
   ```ts
   s3({
     bucket: "uploadsBucket", // key of an s3Bucket() resource
     on: ["created"], // "created" | "deleted"; default ["created"]
     prefix: "incoming/", // optional
     suffix: ".jpg", // optional
     handler: async (event, context) => {
       event.kind;
       event.bucket;
       event.key;
       event.size;
     },
   });
   // event: { kind, bucket, key, size?, etag?, versionId?, sequencer?, reason?, deletionType?, time, id, raw }
   ```
   There is no schema option: an S3 event carries object metadata, not an application payload.
   The handler returns nothing. One bucket per Function in v1.
2. **EventBridge, not bucket notifications.** Synthesis for each `s3()` Function:
   - the bucket gets `NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: true } }`,
     merged into any `NotificationConfiguration` the resource already has;
   - one `AWS::Events::Rule` on the default bus with
     `source: ["aws.s3"]`, `detail-type` from `on` (`"Object Created"`, `"Object Deleted"`), and
     `detail: { bucket: { name: [{ Ref: <Bucket> }] }, object: { key: [<matcher>] } }` when a
     prefix or suffix is set;
   - one `AWS::Lambda::Permission` for `events.amazonaws.com` scoped to the rule.
     The rule and permission come from plan 015's builder.
3. **Key matcher.** Only `prefix` → `{ prefix }`; only `suffix` → `{ suffix }`; both →
   `{ wildcard: "<prefix>*<suffix>" }` with `*` and `\` in the user's values escaped.
4. **The bucket flag is derived, not declared.** A bucket gets the EventBridge flag when at least
   one Function has an `s3` Event Source for it; `s3Bucket()` gains no option. This needs a
   resource-property hook on the adapter interface, modeled on `withDerivedVisibilityTimeout`.
   It does not run for `scope: "resources"` (local), which is correct: nothing delivers S3 events
   locally.
5. **Semantics the guide must state.** "Created" covers every way an object comes to exist
   (`PutObject`, `POST Object`, `CopyObject`, `CompleteMultipartUpload`; the cause is in
   `event.reason`). "Deleted" covers permanent deletes and delete markers
   (`event.deletionType`). Delivery is at least once and unordered. Enabling EventBridge on a
   bucket sends all of that bucket's events to the account's default bus.
6. **Validation.** `bucket` must be a declared `AWS::S3::Bucket` resource; `on` must be non-empty
   and contain only the two known values; `prefix` and `suffix` must be non-empty strings when
   given.
7. **Local Event Invocation.** `functions.sendEvent("onUpload", { key: "incoming/a.jpg" })`;
   optional `kind` (default: the first value of `on`), `bucket` (default: the resource key),
   `size`, `etag`, `versionId`. Locally the prefix and suffix are **not** applied: `sendEvent`
   always calls the handler, as it does for every source. State this in the guide.
8. **The migrator only changes wording** for `s3` events (point to `s3()` and say that the bucket
   must be a Voke resource); code generation is deferred.

Facts to verify against AWS documentation, or a real event, before coding (not confirmed during
planning):

- Whether `detail.object.key` in the EventBridge event is URL-encoded. The classic notification
  format encodes it (`red flower.jpg` → `red+flower.jpg`,
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html`);
  the EventBridge format page
  (`https://docs.aws.amazon.com/AmazonS3/latest/userguide/ev-events.html`) does not say. Contract:
  `event.key` is always the real object key. If the delivered key is encoded, decode it in the
  adapter; either way add a test with a space, a `+` and a non-ASCII character.
- The `wildcard`, `prefix` and `suffix` operators in EventBridge event patterns, and that
  `wildcard` may be used on `detail.object.key`.
- The exact `detail-type` strings and `detail` fields (`bucket.name`, `object.key`, `size`,
  `etag`, `version-id`, `sequencer`, `reason`, `deletion-type`); confirmed in outline from the
  S3 EventBridge pages, not field by field.
- Whether S3 events delivered to EventBridge are billed, so the guide can say so.
- That `EventBridgeConfiguration` can be set in the same template that creates the rule with no
  ordering requirement.

## Commands you will need

| Purpose         | Command                                         | Expected on success |
| --------------- | ----------------------------------------------- | ------------------- |
| One test file   | `cd packages/aws && bun test test/s3.test.ts`   | all pass            |
| Package tests   | `cd packages/aws && bun test`                   | all pass            |
| Example tests   | `cd examples/event-sources && bun test`         | all pass            |
| Typecheck       | `bun run typecheck`                             | exit 0              |
| All tests       | `bun run test`                                  | all pass            |
| Lint and format | `bun run check` (fix with `bun run fix`)        | exit 0              |
| Docs            | `cd apps/docs && bun run test && bun run build` | all pass, exit 0    |

All scripts exist in the repository; none was run during planning.

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`).
- No change in `packages/core/src` except the migrator reason string.
- Reuse plan 015's rule and permission builder; do not copy it. If it is not reusable as written,
  refactor it in place and keep plan 015's tests green.
- The resource-property hook must be generic (any adapter may patch any resource it references)
  and must merge, not overwrite, existing properties. Moving `withDerivedVisibilityTimeout`
  behind the SQS adapter with the same hook is allowed if the three existing fixtures stay
  byte-identical; it is not required.
- Logical ids derive from the Function key and the bucket key, never from array order.
- Errors: `VokeConfigError` for authoring mistakes, `VokeModelError.validation` for model
  problems, `InvokeError` (`INVALID_PAYLOAD`) for an event the adapter cannot read.
- Ultracite: no `any`, `for...of`, no barrel files, no nested ternaries, top-level regex literals.
- No new dependency.

## Scope

**In scope**:

- `packages/aws/src/s3.ts` (create), `event-sources.ts`, `eventbridge.ts` (builder reuse only),
  `index.ts`, `cloudformation-synthesis.ts`
- `packages/aws/test/s3.test.ts`, `s3-synthesis.test.ts`, `s3-typecheck.ts` (create), a fixture
  under `packages/aws/test/fixtures/`
- `packages/core/test/public-surface.test.ts` (export list and docs file list),
  `packages/core/src/serverless-migration.ts` (one reason string),
  `packages/core/test/serverless-migration.test.ts` (the line that quotes it)
- `examples/event-sources/` (add an S3 Function, a bucket resource and tests)
- `apps/docs/content/docs/guides/s3-events.mdx` (create), `meta.json`,
  `guides/resources.mdx` (link from the `s3Bucket()` row), `reference/packages.mdx`
- `CONTEXT.md`, `docs/stable-public-surface.md`, a new ADR in `docs/adr/`
- `.factory/plans/README.md` (status only, unless coordinator-owned)

**Out of scope**:

- Classic bucket notifications to Lambda, SQS or SNS, and any option on `s3Bucket()`.
- Other S3 event types (restore, tagging, ACL, storage class, replication) and filtering on
  `reason`, size or metadata.
- Buckets that are not Voke resources (existing buckets by name).
- Presigned upload helpers and object helpers.
- Deferred for the whole event track: a `voke dev` poller that delivers emulator events to local
  Functions, WebSocket APIs, MSK/Kafka/MQ, DLQ and redrive design, least-privilege per-Function
  resource linking, typed publishers.

## Git workflow

- `origin/main` lacks PRs #53–#62; the base is the stack tip `origin/feature/docs-site-platform`
  plus the branches of plans 014 and 015 (and 016 if it landed).
- Branch: `feature/s3-event-source`, stacked on the previous plan's branch.
- Commit subjects are imperative sentences ("Add the S3 Event Source through EventBridge").
  Commit only if authorized. Do not push or open a PR unless told.

## Steps

### Step 1: Authoring and Event Invocation

Tests first (`packages/aws/test/s3.test.ts`): `s3()` rejects a missing `bucket`, an empty `on`
and an unknown `on` value with `VokeConfigError`; `sendEvent("onUpload", { key })` calls the
handler with `kind: "created"`, the resource key as `bucket` and synthesized `id` and `time`;
`kind: "deleted"` is accepted only when `on` includes it; Runtime Variables are available on
`context`. Then implement `s3.ts` (definition, input schema, public types).

### Step 2: Deployed adapter

Tests first: the handler from `createLambdaHandlers({ functions })` accepts a real-shaped
EventBridge S3 event for "Object Created" and for "Object Deleted" and passes the normalized
event; the key test from the verification list (space, `+`, non-ASCII); an event whose `source`
is not `aws.s3` or whose `detail` has no `object.key` rejects with `InvokeError`
(`INVALID_PAYLOAD`). Then implement `toInvocation` and register the adapter.

### Step 3: Synthesis and validation

Tests first (`s3-synthesis.test.ts`, with a fixture): a project with one bucket, one `s3()`
Function with a prefix and a suffix, one `s3()` Function on the same bucket for deletes, and an
unrelated `fn`. Assert the template against the fixture and, separately, that (a) the bucket has
the EventBridge flag exactly once; (b) a bucket no Function consumes has no
`NotificationConfiguration`; (c) each rule's pattern has the right `detail-type`, the bucket name
as `{ Ref }` and the matcher from decision 3; (d) the template has no
`LambdaConfigurations`; (e) `scope: "resources"` output has no rule, no permission and no
EventBridge flag; (f) a `bucket` key that is a `dynamodbTable()` produces
`Function "<name>" S3 event source references resource "<key>", but it is an "AWS::DynamoDB::Table" resource instead of an "AWS::S3::Bucket".`;
(g) no resource in the template depends, directly or through `Ref`/`Fn::GetAtt`/`Fn::Sub`, on
itself: write a small test helper that walks the template's references and fails on a cycle, and
run it on this template.

Then add the resource-property hook to the adapter interface, apply it where
`withDerivedVisibilityTimeout` is applied (`cloudformation-synthesis.ts:987`), and implement the
S3 adapter's `validate`, `synthesize` and property hook.

**Evidence**: `cd packages/aws && bun test` passes;
`git diff --stat 4015c46 -- packages/core/test/fixtures` prints nothing.

### Step 4: Exports, example, docs, vocabulary, ADR, migrator wording

- Export `s3` and its public types (`S3ObjectEvent`, `S3EventInvocationInput`, `S3EventKind`)
  from `packages/aws/src/index.ts`; update `public-surface.test.ts:114-131`,
  `docs/stable-public-surface.md`, `reference/packages.mdx`. Add `s3-typecheck.ts`.
- `examples/event-sources/`: add `uploadsBucket: s3Bucket()` and an `imageUploaded` Function with
  a `sendEvent` test and a deployed-handler test.
- `guides/s3-events.mdx`: declare, handle, test, "what gets deployed", and a "Good to know"
  section with decision 5 and the local-filter note from decision 7. All fences `ts twoslash`.
  Register it in `meta.json` and in `teachingSurfaceFiles` (`public-surface.test.ts:21-47`).
- `CONTEXT.md`: add **S3 Event Source** ("An AWS Event Source where object changes in a bucket
  invoke a Function through an EventBridge rule. _Avoid_: bucket notification, S3 trigger") and
  the relationships "delivers one object event per invocation" and "references its bucket by Voke
  resource key".
- ADR with the next free number at execution time: "S3 Event Sources use EventBridge instead of
  bucket notifications", with the cycle explanation from "Current state".
- Migrator: change the `s3` reason string and the test line that quotes it.

## Test plan

- New: `s3.test.ts`, `s3-synthesis.test.ts` (including the reference-cycle helper),
  `s3-typecheck.ts`, example tests.
- Patterns: `packages/aws/test/sqs.test.ts` (authoring), `lambda-handlers.test.ts:175-184`
  (deployed handler), `packages/core/test/cloudformation.test.ts:163-194` (fixture test), and
  plan 015's `eventbridge.test.ts`.
- Verification: `bun run test` → all pass; `bun run typecheck` → exit 0;
  `cd apps/docs && bun run test` → 0 fail.

## Done criteria

- [ ] `s3` is exported from `@voke/aws`; the surface test passes
- [ ] Local `sendEvent` tests and deployed-handler tests for created and deleted events pass
- [ ] The synthesized template has the EventBridge flag, a rule and a permission, no
      `LambdaConfigurations`, and passes the reference-cycle test
- [ ] `event.key` is the real object key for keys with a space, a `+` and a non-ASCII character
- [ ] Existing CloudFormation fixtures are unchanged
- [ ] `cd examples/event-sources && bun test` passes
- [ ] `guides/s3-events.mdx` exists and is in `meta.json`; `cd apps/docs && bun run test` passes
      with `legacyUncheckedPages` still empty
- [ ] `bun run check`, `bun run typecheck`, `bun run test` exit 0
- [ ] ADR written; `CONTEXT.md` has the new term
- [ ] `.factory/plans/README.md` status row updated by its owner

## STOP conditions

- The key-encoding question cannot be settled from documentation and no real event is available.
  Do not guess: report it. A wrong guess corrupts every key with a space or a `+`.
- EventBridge does not support the matcher in decision 3 on `detail.object.key`. Offering only
  `prefix` or only `suffix` is an acceptable fallback; record it in the ADR.
- The reference-cycle test fails on the template. The design assumption is wrong; do not add
  `DependsOn` or string-built ARNs to hide it.
- Plan 015's rule builder cannot be reused without changing its public behaviour.
- Proving the deployed trigger needs real AWS credentials. Do not deploy without explicit approval.

## Maintenance notes

- When per-Function resource linking lands (roadmap v2 phase 5) and roles stop referencing every
  resource, bucket notifications become possible. Keep EventBridge anyway unless there is a
  measured reason: one mechanism is the rule (ADR 0007), and the ADR from this plan records why.
- The reference-cycle test helper is worth reusing for every later synthesis feature.
- A reviewer should scrutinize the property merge on buckets that already have a
  `NotificationConfiguration`, and the key handling.
- Deferred: other S3 event types, filters on `reason`, existing buckets, migrator code
  generation, local delivery in `voke dev`.
