# Plan 015: A Function can be triggered by an SNS topic, an EventBridge rule or a schedule

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 4015c46 -- packages/aws/src packages/aws/test packages/core/src packages/core/test examples apps/docs/content CONTEXT.md docs`
> and `git status --short` with the recorded current state. Plan 014 lands first and changes
> `invoke.ts`, `model.ts`, `sqs.ts`, `lambda-handlers.ts`, `index.ts` and
> `cloudformation-synthesis.ts` on purpose (see "State after plan 014"). Reconcile that drift;
> pause only if it invalidates a protected contract or a decision listed below.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `.factory/plans/014-open-event-source-contract.md` (hard: this plan only adds
  adapters to the table 014 creates). Ordering only: it edits `packages/aws/src/index.ts`,
  `cloudformation-synthesis.ts` and `packages/core/test/public-surface.test.ts`, like most plans,
  so do not run it in parallel with another plan that edits them.
- **Category**: direction
- **Planned at**: commit `4015c46`, 2026-11-14

## Why this matters

SQS is the only trigger a Voke Function can have besides HTTP and direct invocation. Real
serverless projects fan out with SNS, react to domain events on EventBridge, and run jobs on a
schedule; `roadmap-v2.md` lists schedule and EventBridge as P0 and SNS as P1. Today a user must
hand-write CloudFormation for the trigger and Lambda glue for the event shape, which is what Voke
exists to remove. This plan adds three Event Sources, each typed from a schema, testable locally
through `functions.sendEvent`, and synthesized with the permissions it needs.

## Current state

### Vocabulary (from `CONTEXT.md`; use these terms)

- **Function**, **Function Registry**, **Gateway**, **Provider** as defined there.
- **Event Source**: "A trigger relationship where an external event provider invokes a
  **Function**." **Event Invocation**: "The local test/runtime path that delivers an event-shaped
  payload to an Event Source Function" (`functions.sendEvent(key, event)`).
- Binding rules: "A Function with Event Sources does not mix HTTP routes or invokable handlers in
  v1." "Event Source Functions are tested through `functions.sendEvent(...)`, not
  `functions.invoke(...)` or direct handler calls." Resources are referenced "by Voke resource
  key, not by passing the queue resource object".
- "No, `sqsQueue()` defines a queue resource; `sqs({ queue })` attaches a queue as an SQS Event
  Source." The same split applies here: `snsTopic()` and `eventBus()` declare resources;
  `sns()` and `eventBridge()` attach Event Sources.

### Architecture rules (binding)

- `docs/adr/0007-specialized-provider-and-helper-packages.md`: `@voke/aws` "owns the full AWS
  workflow, including AWS runtime adapters, resource helpers, SQS and authorizer entrypoints";
  root `voke` must not "depend on AWS, CloudFormation, SQS, or API Gateway concepts". All code in
  this plan goes in `packages/aws`.
- `docs/adr/0007-opinionated-framework.md`: "one supported way to do each thing"; "New options
  should be added only when a use case cannot be met through the default or the layer's escape
  hatch"; no aliases. This is why schedules get exactly one implementation.
- `docs/adr/0003-sqs-event-sources.md` is the model to follow: a narrow option surface, a schema
  for one application payload, a normalized handler input with the raw provider record attached,
  local Event Invocation with minimal input and synthesized metadata, a Voke-owned Lambda adapter.
- `docs/adr/0009-aws-emulator-local-provider.md`: local bootstrap deploys "a resources-only
  template, with no IAM role, Lambda, API or event source mapping". Subscriptions, rules and
  schedules are Function-side resources, so they must not appear in that template.

### Code at `4015c46`

- Resource builders exist, with no options (`packages/aws/src/cloudformation-synthesis.ts`):
  ```ts
  export const snsTopic = (): StackResourceDefinition =>
    // :196-205
    awsCloudFormationResource({
      actions: ["sns:Publish"],
      bindingAttribute: "arn",
      bindingValue: "ref",
      cloudFormationType: "AWS::SNS::Topic",
      outputName: "Arn",
      policyResource: "ref",
      properties: {},
    });
  export const eventBus = (): StackResourceDefinition =>
    // :207-216
    awsCloudFormationResource({
      actions: ["events:PutEvents"],
      bindingAttribute: "name",
      bindingValue: "ref",
      cloudFormationType: "AWS::Events::EventBus",
      outputName: "Name",
      policyResource: "getAttArn",
      properties: {},
    });
  ```
  `Ref` of a topic is its ARN and `Ref` of an event bus is its name; both are what this plan
  needs.
- Logical ids: `toLogicalId` (`:264-273`); a Function's Lambda is `Function` when its key is
  `http`, else `<Key>Function` (`:512-513`); its role is `<Key>FunctionRole` (`:465-471`).
- The API Gateway Lambda permission at `:732-747` is the pattern for an `AWS::Lambda::Permission`.
- `synthesizeCloudFormationFromModel` (`:961-1122`): with `scope: "resources"` the model is
  replaced by `resourcesOnly(model)` (`:939-948`, `functions: {}`), so nothing Function-side is
  emitted. Keep that true.
- `sqs()` (`packages/aws/src/sqs.ts:376-429`) is the authoring pattern: validate the input, build a
  frozen definition with `events`, `handler`, `input` (a Standard Schema that normalizes the Event
  Invocation input), `key: ""`, `kind: "event"`, `name`, `routes: []`, `synthesis`, `variables`.
- `createLambdaHandlers` (`packages/aws/src/lambda-handlers.ts:218-229`) builds one Lambda handler
  per Function; the build generates the entry module that calls it
  (`packages/aws/src/build.ts:24-39`). No user writes Lambda glue.
- Public export lists are pinned by `packages/core/test/public-surface.test.ts:111-134` (`@voke/aws`)
  and documented in `docs/stable-public-surface.md` and
  `apps/docs/content/docs/reference/packages.mdx:74`.
- The Serverless migrator treats these events as manual work
  (`packages/core/src/serverless-migration.ts:1289-1299`):
  ```ts
  case "schedule": return "Scheduled triggers require EventBridge rule infrastructure that must be reviewed before migration.";
  case "sns":      return "SNS subscriptions and publish/subscribe permissions are inventory-only in this migration phase.";
  ```
  and generates an "EventBridge worker skeleton" (`:1441-1447`). These strings are asserted in
  `packages/core/test/serverless-migration.test.ts:672,730,733` and
  `packages/core/test/fixtures/serverless-migration-report.md:56,95`.
- Docs samples: every `ts`/`tsx` fence under `apps/docs/content/docs` must be marked `twoslash`
  and compile against the workspace packages; `apps/docs/test/samples.test.ts` fails otherwise and
  its `legacyUncheckedPages` list is empty and must stay empty. Multi-file samples use
  `// @filename: voke.config.ts`; see `apps/docs/content/docs/guides/sqs-events.mdx:15-52`. Pages
  are listed in `apps/docs/content/docs/meta.json`.

### State after plan 014 (expected; verify)

- Core `EventSourceDefinition` is `{ source: string; resource?: string; properties: VokeModelRecord }`
  and the model event source is `{ type: string; resource?: string; properties }`.
- `EventFunctionDefinition` has a result type parameter; `functions.sendEvent` resolves to the
  handler's own result.
- `@voke/aws` has an internal adapter table (`packages/aws/src/event-sources.ts` in the plan) with
  `source`, `toInvocation`, `toResponse`, `validate`, `synthesize` per source; an unknown source is
  an error in `createLambdaHandlers` and in `validateAwsModel`.
- `createFunctions` rejects an Event Source Function with routes, an output schema, or mixed
  sources.

## Decisions taken in this plan

1. **Three entrypoints exported from `@voke/aws`: `sns`, `eventBridge`, `schedule`.** Each returns
   an `EventFunctionDefinition` and is a distinct Function entrypoint. Handlers return nothing;
   `functions.sendEvent` resolves to `undefined` for them.
2. **Singular in v1.** One topic, one rule or one schedule per Function. The definition's `events`
   array already allows more, so a plural form is additive later. (`sqs` keeps `queue`/`queues`.)
3. **SNS.** Authoring and handler input:
   ```ts
   sns({
     topic: "ordersTopic", // key of an snsTopic() resource
     message: orderCreated, // Standard Schema for one JSON message body
     filterPolicy: { type: ["created"] }, // optional, copied to the subscription
     filterPolicyScope: "MessageAttributes", // optional: "MessageAttributes" | "MessageBody"
     handler: async (message, context) => {
       message.body.orderId;
     },
   });
   // message: { body, id, subject?, attributes, topicArn, timestamp, raw }
   ```
   Synthesis: one `AWS::SNS::Subscription` (`Protocol: "lambda"`, `TopicArn: { Ref: <Topic> }`,
   `Endpoint: { "Fn::GetAtt": [<Function>, "Arn"] }`, plus the filter fields when set) and one
   `AWS::Lambda::Permission` (`Principal: "sns.amazonaws.com"`, `SourceArn: { Ref: <Topic> }`).
   SNS delivers one record per invocation; the adapter reads `Records[0].Sns`. The body is parsed
   as JSON and validated. An invalid body throws, so the invocation fails and Lambda's
   asynchronous retry and failure handling apply. There is no per-message failure report because
   there is no batch.
4. **EventBridge.**
   ```ts
   eventBridge({
     bus: "ordersBus", // optional key of an eventBus() resource; default bus when omitted
     pattern: {
       source: ["orders"],
       detailType: ["OrderCreated"],
       detail: { status: ["PAID"] },
     },
     detail: orderCreated, // Standard Schema for event.detail
     handler: async (event, context) => {
       event.detail.orderId;
     },
   });
   // event: { id, source, detailType, detail, time, account, region, resources, raw }
   ```
   `pattern.source` and `pattern.detailType` are string lists; `pattern.detail` is an EventBridge
   content filter copied untouched. At least one of `source` or `detailType` is required
   (`VokeConfigError`), because EventBridge rejects an empty pattern and a rule that matches
   everything on a bus is almost always a mistake. Synthesis: one `AWS::Events::Rule`
   (`EventBusName: { Ref: <Bus> }` when `bus` is set, `EventPattern` with `source`, `detail-type`
   and `detail`, `State: "ENABLED"`, one target with the Function ARN) and one
   `AWS::Lambda::Permission` (`Principal: "events.amazonaws.com"`,
   `SourceArn: { "Fn::GetAtt": [<Rule>, "Arn"] }`). An invalid `detail` throws, as for SNS.
5. **Schedules use EventBridge Scheduler, and only it.**
   ```ts
   schedule({
     expression: "cron(0 9 * * ? *)", // or "rate(5 minutes)"
     timezone: "America/Sao_Paulo", // optional IANA name; UTC when omitted
     enabled: true, // optional
     handler: async (event, context) => {
       event.scheduledTime;
     },
   });
   // event: { scheduledTime: string /* ISO 8601 */, executionId, attempt, raw }
   ```
   Synthesis: one `AWS::Scheduler::Schedule` per Function (`ScheduleExpression`,
   `ScheduleExpressionTimezone`, `FlexibleTimeWindow: { Mode: "OFF" }`,
   `State: "ENABLED" | "DISABLED"`, `Target: { Arn, RoleArn, Input }`) and **one shared
   `AWS::IAM::Role` per stack** that `scheduler.amazonaws.com` assumes, with
   `lambda:InvokeFunction` on exactly the scheduled Functions. Scheduler invokes through that
   role, so no `AWS::Lambda::Permission` is needed. `Target.Input` is a Voke-owned JSON envelope
   built from Scheduler context attributes, so the adapter never depends on Scheduler's default
   payload:
   ```json
   {
     "voke": "schedule",
     "scheduledTime": "<aws.scheduler.scheduled-time>",
     "executionId": "<aws.scheduler.execution-id>",
     "attempt": "<aws.scheduler.attempt-number>"
   }
   ```
   Trade-off, to record in the ADR. Scheduler gives time zones with daylight saving, one-time
   schedules later, a much higher quota than the 300 rules per bus, and AWS's own documentation
   now titles the alternative "Creating a scheduled rule (legacy)". It costs one IAM role per
   stack, a second service the deploying identity must be allowed to manage
   (`scheduler:CreateSchedule` and friends, `iam:PassRole`), and an event shape Voke defines.
   `AWS::Events::Rule` with `ScheduleExpression` needs only a rule and a permission but is UTC
   only. ADR 0007 says one way, so the rule form is not offered.
   Deferred: `at(...)` one-time schedules, a static typed `input` per schedule, flexible time
   windows, per-schedule retry policy and dead-letter queue.
6. **Local Event Invocation takes minimal input.** Provider metadata is synthesized when omitted,
   as SQS does (`sqs.ts:194-219`):
   - `functions.sendEvent("onOrder", { message: { orderId: "o1" } })` (SNS; optional `id`,
     `subject`, `attributes`)
   - `functions.sendEvent("onPaid", { detail: { orderId: "o1" } })` (EventBridge; `source` and
     `detailType` default to the first value of the declared pattern; optional `id`, `time`)
   - `functions.sendEvent("nightly", {})` (schedule; optional `scheduledTime`)
     The deployed adapter converts the AWS event to the same input, so both paths run one
     normalization and one validation.
7. **Validation lives in the adapters.** `sns.topic` must be an `AWS::SNS::Topic` resource and
   `eventBridge.bus` an `AWS::Events::EventBus` resource, with messages in the form of the SQS one
   (`Function "<name>" SNS event source references resource "<key>", but it is an "<type>" resource
instead of an "AWS::SNS::Topic".`). `schedule.expression` must start with `rate(` or `cron(`;
   reject `at(` with a message that says one-time schedules are not supported yet.
8. **The migrator only changes wording.** The reasons for `sns` and `schedule` point to the new
   helpers ("Rewrite it with `schedule()` from `@voke/aws`; review the expression and time zone.").
   Generating `sns(...)`, `eventBridge(...)` or `schedule(...)` source from `serverless.yml` is
   deferred: it needs resource resolution like the SQS generator has (`serverless-migration.ts:991-1202`).

Facts to verify against AWS documentation before coding (not confirmed during planning):

- The three Scheduler context attribute names are confirmed
  (`https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-context-attributes.html`).
  Verify that they are substituted inside a JSON `Input` string and whether
  `attempt-number` arrives as a string.
- The exact required property set of `AWS::Scheduler::Schedule` and the recommended trust policy
  condition (`aws:SourceAccount`) for the Scheduler role.
- Whether the AWS Emulator and Floci accept `AWS::Scheduler::Schedule`. It does not matter for
  local bootstrap (resources-only), but say so in the guide if they do not.
- `FilterPolicyScope` allowed values on `AWS::SNS::Subscription`.

## Commands you will need

| Purpose                                      | Command                                                                                                                       | Expected on success        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Install (after adding the example workspace) | `bun install`                                                                                                                 | exit 0, `bun.lock` updated |
| One test file                                | `cd packages/aws && bun test test/sns.test.ts`                                                                                | all pass                   |
| Package tests                                | `cd packages/aws && bun test`                                                                                                 | all pass                   |
| Typecheck                                    | `bun run typecheck`                                                                                                           | exit 0                     |
| All tests                                    | `bun run test`                                                                                                                | all pass                   |
| Lint and format                              | `bun run check` (fix with `bun run fix`)                                                                                      | exit 0                     |
| Docs                                         | `cd apps/docs && bun run test && bun run build`                                                                               | all pass, exit 0           |
| Example synth                                | `cd examples/event-sources && bun run synth` (add a `"synth": "voke synth"` script, as `examples/hello-api/package.json` has) | writes a template          |

All scripts exist in the repository; none was run during planning.

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`): for each source write the authoring test, the adapter test and the
  synthesis test before the code.
- Nothing in `packages/core/src` changes except the three reason strings in
  `serverless-migration.ts`. If a source seems to need a core change, plan 014 is incomplete: stop.
- One source per file (`packages/aws/src/sns.ts`, `eventbridge.ts`, `schedule.ts`), each exporting
  its entrypoint, its public types and its adapter; register the adapters in the table from
  plan 014. Share the "parse JSON, validate with `readStandardResult`, throw `InvokeError` with
  code `INVALID_PAYLOAD` and `issues`" helper with `sqs.ts:234-264` instead of copying it.
- Handlers receive parsed values plus `raw` (the untouched provider record), never only the raw
  AWS event.
- Errors: authoring mistakes throw `VokeConfigError`; model problems use
  `VokeModelError.validation([{ message, path }])`; invalid payloads throw `InvokeError`.
- Logical ids must be stable and derived from the Function key and the resource key (pattern:
  `eventSourceMappingLogicalId`, `cloudformation-synthesis.ts:515-518`), never from array order.
- Ultracite: no `any`, `for...of`, no barrel files, no nested ternaries, top-level regex literals.
- Do not add an npm dependency. Everything here is template JSON and plain parsing.

## Scope

**In scope**:

- `packages/aws/src/sns.ts`, `eventbridge.ts`, `schedule.ts` (create); `event-sources.ts`,
  `index.ts`, `cloudformation-synthesis.ts`, `sqs.ts` (shared body-parsing helper only)
- `packages/aws/test/sns.test.ts`, `eventbridge.test.ts`, `schedule.test.ts`,
  `event-source-synthesis.test.ts`, `event-sources-typecheck.ts` (create),
  `packages/aws/test/fixtures/*.json` (create), `lambda-handlers.test.ts`
- `packages/core/test/public-surface.test.ts` (export list, docs and example file lists),
  `packages/core/src/serverless-migration.ts` (reason strings only),
  `packages/core/test/serverless-migration.test.ts` and
  `packages/core/test/fixtures/serverless-migration-report.md` (the same strings)
- `examples/event-sources/` (create), `bun.lock`
- `apps/docs/content/docs/guides/sns-events.mdx`, `eventbridge-events.mdx`,
  `scheduled-functions.mdx` (create), `meta.json`, `reference/packages.mdx`,
  `guides/resources.mdx` (links), `guides/serverless-migration.mdx` (wording)
- `CONTEXT.md`, `docs/stable-public-surface.md`, a new ADR in `docs/adr/`, `roadmap-v2.md` is not
  edited
- `.factory/plans/README.md` (status only, unless coordinator-owned)

**Out of scope**:

- Options on `snsTopic()` and `eventBus()` (FIFO topics, archives). FIFO topics cannot target
  Lambda directly.
- Kinesis and DynamoDB Streams (plan 016), S3 (plan 017).
- Deferred for the whole event track: a `voke dev` poller that delivers emulator events to local
  Functions, WebSocket APIs, MSK/Kafka/MQ, DLQ and redrive design (including Lambda async
  `OnFailure` destinations), least-privilege per-Function resource linking, typed publishers
  (`topic.publish`, `bus.put`).

## Git workflow

- `origin/main` lacks PRs #53–#62; the base is the stack tip `origin/feature/docs-site-platform`
  plus plan 014's branch.
- Branch: `feature/sns-eventbridge-schedule-event-sources`, stacked on
  `feature/open-event-source-contract`.
- Commit subjects are imperative sentences ("Add the SNS Event Source"). One commit per source is
  a good unit. Commit only if authorized. Do not push or open a PR unless told.

## Steps

### Step 1: SNS

Tests first (`packages/aws/test/sns.test.ts`): `sns()` rejects a missing `topic`; `sendEvent`
with `{ message }` reaches the handler with a parsed `body` and synthesized `id`, `topicArn`,
`timestamp`; an invalid body rejects with `InvokeError` code `INVALID_PAYLOAD` and the handler is
not called; the deployed handler from `createLambdaHandlers({ functions })` accepts a real SNS
Lambda event (`Records[0].EventSource === "aws:sns"`, `Records[0].Sns.Message` a JSON string) and
resolves to `undefined`; Runtime Variables are available on `context` (pattern:
`packages/aws/test/sqs.test.ts:28-50`). Then implement `sns.ts` and register the adapter.

### Step 2: EventBridge

Tests first (`eventbridge.test.ts`): pattern with neither `source` nor `detailType` throws
`VokeConfigError`; `sendEvent({ detail })` fills `source` and `detailType` from the pattern; an
invalid `detail` rejects; the deployed handler accepts a real EventBridge event
(`{ version, id, "detail-type", source, account, time, region, resources, detail }`). Then
implement `eventbridge.ts`.

### Step 3: Schedule

Tests first (`schedule.test.ts`): `expression` not starting with `rate(` or `cron(` throws;
`sendEvent("nightly", {})` calls the handler with an ISO `scheduledTime`; the deployed handler
accepts the Voke envelope from decision 5 and converts `attempt` to a number. Then implement
`schedule.ts`.

### Step 4: Synthesis and validation

Tests first (`event-source-synthesis.test.ts`, with JSON fixtures under
`packages/aws/test/fixtures/`, pattern: `packages/core/test/cloudformation.test.ts:163-194`): one
project with one Function per source; assert the full template against a fixture and, separately,
that (a) each wrong resource kind produces the decision 7 message, (b) two scheduled Functions
share one Scheduler role whose policy lists both Function ARNs, (c) `scope: "resources"` output
contains no `AWS::SNS::Subscription`, `AWS::Events::Rule`, `AWS::Scheduler::Schedule`,
`AWS::Lambda::Permission` or Scheduler role, (d) an `eventBridge()` Function without `bus` has no
`EventBusName`.

Implement `validate` and `synthesize` for the three adapters. The shared Scheduler role needs a
stack-level step: give the adapter interface an optional member that receives every event source
of its type and returns stack-level resources, and call it once after the per-Function loop
(`cloudformation-synthesis.ts`, after the loop that ends near `:1100`).

**Evidence**: `cd packages/aws && bun test` passes; the three existing fixtures under
`packages/core/test/fixtures/` are unchanged (`git diff --stat` prints nothing for them).

### Step 5: Exports, types and surface

Add to `packages/aws/src/index.ts`: `sns`, `eventBridge`, `schedule` and their public types
(`SnsMessage`, `SnsEventInvocationInput`, `EventBridgeEvent`, `EventBridgeEventInvocationInput`,
`EventBridgePattern`, `ScheduledEvent`, `ScheduleEventInvocationInput`). Update the sorted list at
`packages/core/test/public-surface.test.ts:114-131`, `docs/stable-public-surface.md` ("Event
Source Function helpers") and `reference/packages.mdx`. Add
`packages/aws/test/event-sources-typecheck.ts`: handler input is inferred from the schema; the
wrong `sendEvent` shape is a type error; `sendEvent` resolves to `Promise<void>`-compatible;
`routes` on these helpers is a type error.

### Step 6: Example, docs, vocabulary, ADR, migrator wording

- `examples/event-sources/`: copy the layout of `examples/sqs-events` (`package.json`,
  `tsconfig.json`, `voke.config.ts` with `provider: aws()`, `src/functions.ts`,
  `test/*.test.ts`). Domain: an `orderCreated` SNS handler, an `orderPaid` EventBridge handler, a
  `nightlyCleanup` schedule. Tests use `functions.sendEvent` and one deployed-handler call per
  source. Add its source files to `firstPartyExampleFiles` in `public-surface.test.ts:49-59`.
- Three guide pages, each opening with "After reading this page you can ..." like
  `sqs-events.mdx`, each with a declare, handle, test and "what gets deployed" section, every
  fence `ts twoslash`. Register them in `meta.json` after `guides/sqs-events` and in
  `teachingSurfaceFiles` (`public-surface.test.ts:21-47`). State in the schedule page that the
  deploying identity needs EventBridge Scheduler and `iam:PassRole` permissions.
- `CONTEXT.md`: add **SNS Event Source**, **EventBridge Event Source**, **Schedule Event Source**
  and the relationships "delivers one message / one event per invocation", "an invalid payload
  fails the invocation", "references its topic or bus by Voke resource key".
- ADR with the next free number at execution time (0010 was free at planning; plan 014 takes one):
  "Push Event Sources fail the invocation on an invalid payload; schedules use EventBridge
  Scheduler".
- Migrator: change the two reason strings and the tests and fixture lines that quote them.

## Test plan

- New test files and cases as listed in Steps 1–5. Edge cases to include by name: SNS `Message`
  that is not JSON; SNS message attributes mapped to `attributes`; EventBridge event whose
  `detail` is an empty object; schedule envelope without the `voke` marker (reject with a clear
  `InvokeError`); a Function key `http` (bare logical ids) used with `sns()` produces valid,
  unique logical ids.
- Patterns: `packages/aws/test/sqs.test.ts`, `packages/aws/test/lambda-handlers.test.ts:175-184`,
  `examples/sqs-events/test/sqs-events.test.ts`.
- Verification: `bun run test` → all pass; `bun run typecheck` → exit 0;
  `cd apps/docs && bun run test` → 0 fail.

## Done criteria

- [ ] `sns`, `eventBridge`, `schedule` are exported from `@voke/aws` and the surface test passes
- [ ] For each source: a local `functions.sendEvent` test and a deployed-handler test exist and pass
- [ ] The synthesis fixture test passes; the resources-only template has no Function-side resource
- [ ] Two scheduled Functions share one Scheduler role (test exists)
- [ ] `git diff --stat 4015c46 -- packages/core/src` shows only `serverless-migration.ts` beyond
      what plan 014 changed
- [ ] `cd examples/event-sources && bun test` passes
- [ ] Three guide pages exist, are in `meta.json`, and `cd apps/docs && bun run test` passes with
      `legacyUncheckedPages` still empty
- [ ] `bun run check`, `bun run typecheck`, `bun run test` exit 0
- [ ] ADR written; `CONTEXT.md` has the three new terms
- [ ] `.factory/plans/README.md` status row updated by its owner

## STOP conditions

- Plan 014's adapter contract cannot express one of these sources without a core change.
- AWS documentation shows that Scheduler context attributes are not substituted in a JSON `Input`,
  or that Scheduler cannot target a Lambda created in the same template without a circular
  dependency. Report it with the documentation link; the fallback (`AWS::Events::Rule`) is an
  owner decision.
- CloudFormation rejects a template because a permission or subscription creates a dependency
  cycle with a Function role (every role's policy references every declared resource,
  `cloudformation-synthesis.ts:974-993,1012-1018`). The designs here do not, by inspection; a
  cycle means the inspection was wrong.
- Proving a deployed trigger needs real AWS credentials. Do not deploy without explicit approval;
  report "synthesized and unit-tested, real-AWS proof not run".

## Maintenance notes

- Plan 017 reuses the EventBridge rule synthesis for S3; keep the rule builder a function that
  takes a bus (optional), a pattern and a target Function.
- When per-Function resource linking lands (roadmap v2 phase 5), the Scheduler role and the
  permissions here are already least-privilege; only `sns:Publish`/`events:PutEvents` on consumer
  roles become unnecessary.
- A reviewer should scrutinize logical-id stability (renaming a Function replaces its trigger
  resources, which is expected) and the wording of invalid-payload errors, which reach CloudWatch.
- Deferred: plural forms, DLQ and `OnFailure` destinations, one-time schedules, schedule input,
  migrator code generation for these three sources, local delivery in `voke dev`.
