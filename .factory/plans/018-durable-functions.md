# Plan 018: A Function declared with `durable(...)` runs as an AWS Lambda durable function, locally and when deployed

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 4015c46 -- packages/core/src packages/core/test packages/aws/src packages/aws/test examples apps/docs/content docs CONTEXT.md roadmap-v2.md`
> and `git status --short` with the recorded current state. Plans 014–017 (Event Sources) and
> 019 (Plugins) edit some of the same files (`packages/aws/src/lambda-handlers.ts`,
> `packages/aws/src/cloudformation-synthesis.ts`, `packages/core/src/invoke.ts`). Reconcile that
> drift; pause only if it invalidates a protected contract or a decision listed below.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH (new AWS feature; the deployed path can only be proven on real AWS)
- **Depends on**: none (hard). Ordering only: land after `.factory/plans/014-*.md` if 014 is in
  flight, because both edit `handlerFor` in `packages/aws/src/lambda-handlers.ts` and the
  Function loop in `packages/aws/src/cloudformation-synthesis.ts`.
- **Category**: direction
- **Planned at**: commit `4015c46`, 2026-11-14

## Why this matters

Multi-step work that must survive failures and long waits (order fulfilment, approvals, sagas,
AI agent loops) is the most common thing Lambda users reach outside Lambda for. Until
late 2025 the answer was Step Functions, which needs a second language (ASL) and a second
deployment unit. AWS Lambda durable functions let the same work be written as ordinary
TypeScript: `step`, `wait`, `waitForCallback`, with checkpoints and replay handled by Lambda,
and executions that last up to a year. That is a direct fit for Voke's principle "prefer typed
code over YAML". Today Voke has no orchestration story at all; the migration report tells
`serverless-step-functions` users to move everything by hand. After this plan a user writes one
`durable({ input, output, handler })` Function, tests it with `bun test`, and `voke deploy` puts a
correctly configured durable Lambda on AWS.

## Owner decisions this plan applies

Decided 2026-11-14:

- **Durable functions only.** Voke makes AWS Lambda durable functions first-class. Step
  Functions gets no builder and no workflow DSL; it stays reachable through raw CloudFormation
  resource definitions in `voke.config.ts` (the infrastructure escape hatch of ADR 0007).
- This supersedes roadmap-v2 phase 10's "typed `workflow(...)` exploration"; step 9 updates the
  roadmap.

Still open (defaults adopted here; each is reversible):

| Decision                                                                                                                                                                  | Default in this plan                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add `@aws/durable-execution-sdk-js` (runtime, bundled into Lambda) and `@aws/durable-execution-sdk-js-testing` (local only, never bundled) as dependencies of `@voke/aws` | Yes. AGENTS.md asks for minimal dependencies; these are the AWS-owned implementation of the feature and re-implementing replay is not reasonable |
| Default `executionTimeout` when the user gives none                                                                                                                       | Required, no default. A year-long default is a cost risk and a 15-minute default hides the feature                                               |
| Alias name for durable Functions                                                                                                                                          | `live`                                                                                                                                           |
| Authorize a real-AWS smoke deploy for the done criteria                                                                                                                   | Not run without explicit approval; the plan is then marked "DONE (real-AWS proof not run)" like plan 004                                         |

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: "The core package owns
  provider-neutral Function, Gateway, config, contract, route, and Provider capability
  contracts; `@voke/aws` depends on public `voke` and owns the full AWS workflow [...]
  provider-specific data appears in the provider-neutral model through Provider Extension
  Records that each Provider validates and interprets." Core (`packages/core`) cannot import
  `@voke/*`; that would be a workspace cycle. So `durable` lives in `@voke/aws`, and core learns
  nothing about durable execution except one neutral invoke hook (step 5).
- ADR `docs/adr/0007-opinionated-framework.md`: "Voke will offer one supported way to do each
  thing [...] and will remove alternatives instead of keeping them as options." One authoring
  helper, one alias name, one local path. The package is unreleased, so no deprecation aliases.
- ADR `docs/adr/0005-entrypoint-specific-function-authoring-api.md`: first-party authoring helpers
  "make each Function entrypoint kind explicit at the callsite". `durable(...)` is such a helper.
- `CONTEXT.md` vocabulary to use in names, comments and docs: **Function**, **Function
  Registry**, **Function Contract** ("The input and output schemas that define what a Function
  accepts and returns"), **Gateway**, **Provider**. "Function invocation belongs to a Function
  Registry, not a global invoke helper." New terms this plan adds are listed in step 9.

### Files and their roles

- `packages/core/src/invoke.ts` — Function definitions and invocation.
  - `fn(...)` builds an `InvokableFunctionDefinition` (`kind: "invokable"`, lines 505–524) whose
    `handler` is `(payload, context: InvokeContext) => result` (lines 476–483).
    `InvokeContext` is `{ functionName, trace, variables }` (lines 88–94).
  - `invokeFunction` (lines 1765–1795) picks the path: `resolveRuntime(options) === "aws"` →
    `invokeAws` (needs `options.transport`); `mode: "async"` → `runQueuedLocalFunction` and an
    immediate `{ accepted: true }`; otherwise `runLocalFunction` (lines 1614–1641), which parses
    the payload with `input`, loads Runtime Variables, calls `definition.handler`, and parses
    the result with `output`.
  - `resolveRuntime` (lines 1037–1043) returns `"aws"` only when `options.runtime` says so or
    `VOKE_INVOKE_RUNTIME === "aws"`. The synthesized template never sets that variable, so
    **deployed `functions.invoke` runs the target in-process** inside the calling Lambda.
  - `invokeAws` (lines 1687–1763) wraps the payload as `{ payload, trace }` (`InvokeRequest`,
    lines 799–806) and unwraps a `{ data }` result (`unwrapPayload`, lines 1672–1685).
  - `createFunctions` copies each definition with `{ ...definition, key }` and freezes it (lines
    2197–2201): only own enumerable properties survive, and `handler` keeps its identity.
  - `activateFunctionRegistry(registry, activationKey, { variableOverrides, variableProviders })`
    (lines 990–1030) stores a `FunctionRegistryActivation` per registry and per definition.
  - `InvokeErrorCode` (lines 51–59): `INVALID_PAYLOAD`, `INVALID_RESULT`,
    `LOCAL_FUNCTION_FAILED`, `MISSING_FUNCTION`, `MISSING_TRANSPORT`, `TIMEOUT`,
    `TRANSPORT_FAILED`, `TRANSPORT_STATUS_ERROR`.
- `packages/core/src/provider.ts` — the Provider contract. `ProviderInvokeCapability` is
  `{ transport?: () => InvokeTransport }` (lines 28–30). Nothing reads it at runtime today and
  `aws()` does not set `invoke` (`packages/aws/src/index.ts:140-207`).
- `packages/core/src/app.ts` — `createGatewayApp` calls `activateFunctionRegistry` with the
  Provider's Runtime Variable providers (lines 187–190).
- `packages/aws/src/lambda-handlers.ts` — `createLambdaHandlers(project)` returns one Lambda
  handler per Function. The default case of `handlerFor` (lines 177–211) is
  `createInvokableHandler` (lines 154–175), which treats the raw Lambda event as the payload:

  ```ts
  return await functions.invoke(
    key as never,
    event as never,
    { runtime: "local" } as never
  );
  ```

  `resolveProject` (lines 121–152) activates a registry-only project with the AWS Runtime
  Variable provider.

- `packages/aws/src/lambda-settings.ts` — `awsLambda(options)` returns the Provider Extension
  Record stored in `synthesis.provider.aws` (lines 62–66, record type `"lambda.function"`,
  options `{ architecture?, runtime? }`); `functionRecordIssues` validates it (lines 113–142);
  `validateAwsLambdaModel` (lines 203–217) collects issues into `VokeModelError.validation`;
  `resolveFunctionLambdaSettings` (lines 220–233) reads the record at synthesis.
- `packages/aws/src/cloudformation-synthesis.ts` — `synthesizeCloudFormationFromModel` (line
  961). Per Function it creates a role (`functionRoleResource`, lines 473–508, managed policy
  `AWSLambdaBasicExecutionRole` plus an inline `VokeResourceAccess` policy), the
  `AWS::Lambda::Function` (lines 1038–1071, `FunctionName: definition.deployedName`, `Code` from
  `options.artifact` `{ bucket, key }` or a 501 placeholder) and a log group. Every Function's
  environment receives every resource binding.
- `packages/aws/src/lambda-invoke-transport.ts` — `createAwsLambdaInvokeTransport` sends
  `InvokeCommand` with `FunctionName`, `InvocationType`, `Payload` and loads
  `@aws-sdk/client-lambda` lazily (lines 50–88).
- `packages/aws/src/deploy.ts` — deploys through a change set. `discardPreview` prints
  `change.action`, `change.resourceType`, `change.logicalId` (lines 285–304); `ChangeSetChange`
  in `packages/aws/src/deploy-clients.ts:22-26` has only those three fields (no replacement
  flag). The bundle key is content-addressed: `sha256Hex(bundle).slice(0, 16)` (line 495).
- `packages/aws/src/build.ts` — `createAwsBuildPlan`; the bundler command gets one
  `--external <pattern>` per `build.external` entry (`packages/build/src/index.ts:112`). The
  default external list is `["@aws-sdk/*"]` (`packages/core/src/config.ts:187`).
- `packages/core/src/serverless-migration.ts:2501-2511` — the `serverless-step-functions`
  plugin entry: "Move Step Functions definitions and IAM permissions manually; Voke does not
  synthesize state machines [...]".
- Exemplars to copy: `packages/aws/src/sqs.ts` (an entrypoint helper in `@voke/aws`),
  `packages/aws/test/lambda-handlers.test.ts` (handler tests with a hand-written Standard Schema
  fake, lines 24–35), `packages/aws/test/lambda-defaults.test.ts` (synthesis assertions),
  `examples/sqs-events` (a small example with `test/` and `voke.config.ts`).

### AWS facts (read from AWS documentation on 2026-11-14)

Sources: Lambda developer guide pages `durable-configuration`, `durable-security`,
`durable-invoking`, `durable-invoking-esm`, `durable-getting-started-iac`,
`durable-supported-runtimes`, `durable-step-functions`; the CloudFormation template reference
for `AWS::Lambda::Function DurableConfig`; the `aws/aws-durable-execution-sdk-js` repository.

- **CloudFormation**: `AWS::Lambda::Function.DurableConfig` =
  `{ ExecutionTimeout: Integer (seconds, required, 1–31622400), RetentionPeriodInDays: Integer (optional, 1–90, default 14), KMSKeyArn?: String }`.
  Its sub-properties update in place, but adding or removing `DurableConfig` itself is
  **"Update requires: Replacement"**: "You can only enable durable execution when creating a
  function." Voke sets a fixed `FunctionName`, and CloudFormation cannot replace a custom-named
  resource, so turning an already-deployed Function durable under the same deployed name fails.
- **IAM**: the execution role needs `lambda:CheckpointDurableExecution` and
  `lambda:GetDurableExecutionState` on a **qualified** ARN pattern,
  `arn:aws:lambda:<region>:<account>:function:<name>:*`. An unqualified ARN never matches.
  CloudFormation deployments must add these themselves.
- **Invocation**: a durable function must be invoked with a qualifier (version, alias or
  `$LATEST`); unqualified names are rejected. `$LATEST` is "for prototyping only": a paused
  execution would resume on new code. Executions pin to the version that started them. The
  official template uses `AWS::Lambda::Version` plus `AWS::Lambda::Alias`.
  `RequestResponse` is capped at 15 minutes; `Event` runs up to the execution timeout. Lambda
  does not retry failed durable executions.
- **Idempotent start**: the Invoke parameter `DurableExecutionName` (1–64 characters,
  `[a-zA-Z0-9-_]+`). Same name and payload returns the existing execution; a different payload
  raises `DurableExecutionAlreadyStartedException`. The response carries the execution ARN.
- **Event source mappings** can target a durable function only when `ExecutionTimeout` is 15
  minutes or less; AWS recommends a plain function that starts the durable one with `Event`.
- **Runtimes**: `nodejs22.x` and `nodejs24.x` are supported (the two Voke allows).
- **SDK**: `@aws/durable-execution-sdk-js` 3.0.0 (2026-10-26), Node ≥ 22, ESM and CJS, no native
  dependencies. `withDurableExecution(handler: (event, context: DurableContext) => Promise<T>)`.
  `DurableContext` has `step`, `wait`, `invoke`, `runInChildContext`, `waitForCallback`,
  `createCallback`, `waitForCondition`, `map`, `parallel`, `promise.{all,allSettled,any,race}`,
  `logger`. The managed runtime includes the SDK "for testing and development"; AWS recommends
  bundling it. On first checkpoint it runs `import("@aws-sdk/client-lambda")`; Voke keeps
  `@aws-sdk/*` external, so the runtime's own SDK copy must contain the durable commands.
  Since 3.0 an execution suspends after 3 ms of idleness, so an `await` on work that is not a
  durable operation, while a durable wait is pending, can cause re-execution.
- **Testing**: `@aws/durable-execution-sdk-js-testing` 1.3.2.
  `LocalDurableTestRunner.setupTestEnvironment({ skipTime: true })` (installs fake timers),
  `new LocalDurableTestRunner({ handlerFunction }).run({ payload })` →
  `getStatus()`, `getResult()`, `getError()`, `getOperations()`; "requires no AWS credentials, no
  deployment, and no containers". Its documentation shows Vitest only. **Not verified**: that it
  runs under `bun test` (it uses `worker_threads` and `@sinonjs/fake-timers`). Step 1 checks.
- **Limits**: 1 MB per operation payload, 30,000 operations and 100 MB per execution.
- **Regions**: not every region has the feature; there is no consolidated list.

## Commands you will need

| Purpose         | Command                                            | Expected on success                                          |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| Install         | `bun install`                                      | exit 0 (lockfile changes only from the two new dependencies) |
| Lint and format | `bun run check`                                    | exit 0                                                       |
| Fix formatting  | `bun run fix`                                      | exit 0                                                       |
| Typecheck       | `bun run typecheck`                                | exit 0                                                       |
| All tests       | `bun run test`                                     | all pass                                                     |
| One file        | `cd packages/aws && bun test test/durable.test.ts` | all pass                                                     |

Commands are the root `package.json` scripts at `4015c46`; none was run during planning.

## Implementation rules relevant to this plan

- Test first (AGENTS.md): write the failing test for each step before the implementation.
- Core stays provider-neutral. No `durable`, `DurableConfig`, alias or ARN vocabulary in
  `packages/core`; the only core change is the neutral invoke hook in step 5.
- Do not wrap or rename the AWS SDK's `DurableContext`. Voke passes it through as
  `context.durable`; re-implementing its surface would drift from AWS.
- Deployed bundles must never contain the testing package (assert it in a build test).
- Errors: throw `VokeConfigError` for authoring mistakes, `VokeModelError.validation([...])`
  for model limits (see `lambda-settings.ts`), `InvokeError` for invocation failures,
  `VokeDeployError` for deploy failures. Messages say what to change.
- No secrets in logs. Do not log payloads.
- Exports change: update `docs/stable-public-surface.md` and
  `packages/core/test/public-surface.test.ts` (the single test that pins every package's
  exports) in the same change.

## Scope

**In scope**

- `packages/aws/src/durable.ts` (create), `packages/aws/src/index.ts`,
  `packages/aws/src/lambda-handlers.ts`, `packages/aws/src/lambda-settings.ts`,
  `packages/aws/src/cloudformation-synthesis.ts`, `packages/aws/src/lambda-invoke-transport.ts`,
  `packages/aws/src/build.ts`, `packages/aws/src/deploy.ts`,
  `packages/aws/src/deploy-clients.ts`, `packages/aws/src/testing.ts`,
  `packages/aws/package.json`, `bun.lock`
- `packages/aws/test/durable.test.ts`, `durable-synthesis.test.ts`,
  `durable-invoke.test.ts` (create); existing aws tests and fixtures that the new template
  output touches
- `packages/core/src/provider.ts`, `packages/core/src/invoke.ts`, `packages/core/src/app.ts`,
  `packages/core/src/index.ts` (the neutral invoke hook and its types only), matching tests in
  `packages/core/test/`
- `packages/core/src/serverless-migration.ts` (the one plugin entry) and its report fixture
- `examples/durable-workflow/` (create), `packages/core/test/public-surface.test.ts`
- `apps/docs/content/docs/guides/durable-functions.mdx` (create), `guides/meta.json` or the
  equivalent navigation file, `reference/packages.mdx`, `reference/errors.mdx`,
  `guides/troubleshooting.mdx`
- `docs/stable-public-surface.md`, `docs/adr/<next free number>-durable-functions.md` (create),
  `CONTEXT.md`, `roadmap-v2.md` (phase 10 only)
- `.factory/plans/README.md` (status only)

**Out of scope**

- Step Functions builders, ASL, a workflow DSL.
- Event Sources that trigger a durable Function directly. Document the pattern instead: an
  Event Source Function calls `functions.invoke(durableKey, payload, { mode: "async" })`.
- General cross-Lambda `functions.invoke` for non-durable Functions. It stays in-process (see
  "Opportunities" in `.factory/plans/README.md`). Step 5 adds only the hook durable needs.
- `voke executions` commands (list, inspect, stop) and callback helper functions. Users call
  `@aws-sdk/client-lambda` (`SendDurableExecutionCallbackSuccess`, ...) for now; the guide shows it.
- Cleaning up retained Lambda versions (see Maintenance notes).
- `KMSKeyArn`, Lambda Managed Instances, tenant isolation.

## Git workflow

- `origin/main` stops at PR #52; PRs #53–#62 were merged into each other's branches. The base
  for this work is the stack tip `origin/feature/docs-site-platform` (commit `4015c46`) or
  whatever branch the previous plan in the stack produced.
- Branch: `feature/durable-functions`. Commit subjects are imperative sentences describing the
  outcome ("Run durable Functions as AWS Lambda durable functions"), as in `git log`.
- Commit only if the task authorizes it. Do not push or open a PR unless told.

## Steps

### Step 1: Prove the local runner works under Bun (time-boxed spike, half a day)

Add the two dependencies to `packages/aws/package.json` and write
`packages/aws/test/durable.test.ts` with one test: a handler wrapped with
`withDurableExecution` that runs a `step`, a `wait({ seconds: 30 })` and returns a value, run
through `LocalDurableTestRunner` with `setupTestEnvironment({ skipTime: true })` under
`bun test`. Then a second test without `skipTime` and a 1-second wait.

Outcomes:

- **Both pass** → Strategy A (below) for everything.
- **Only the non-skipping run passes** → Strategy A, and `setupDurableTests()` in step 6
  documents that time is real; open an issue upstream; note it in the ADR.
- **The runner cannot run under Bun** → Strategy B: a Voke-owned in-process context in
  `packages/aws/src/durable-local.ts` that implements the SDK's `DurableContext` type for
  `step` (honours `retryStrategy`, skips delays), `wait` (skipped), `runInChildContext`,
  `parallel`, `map`, `promise.*`, `waitForCondition` and `invoke` (through the Function
  Registry), and throws a clear "not supported by the local durable context" error for
  `createCallback`/`waitForCallback`. It runs the handler once and does not simulate replay;
  the guide must say so. Record the choice and the reason in the ADR.

**Evidence**: `cd packages/aws && bun test test/durable.test.ts` → the spike tests pass, or the
ADR records which strategy was chosen and why.

### Step 2: `durable(...)` authoring helper

Create `packages/aws/src/durable.ts` and export `durable` (and its option types) from
`packages/aws/src/index.ts`.

```ts
import { durable } from "@voke/aws";

export const fulfilOrder = durable({
  input: orderSchema,
  output: receiptSchema,
  executionTimeout: { hours: 24 },
  handler: async (order, context) => {
    const reservation = await context.durable.step("reserve-stock", () =>
      reserveStock(order)
    );
    await context.durable.wait("cooling-off", { minutes: 10 });
    return { orderId: order.id, reservationId: reservation.id };
  },
});
```

- Options: `input?`, `output` (required, like `fn`), `handler`, `executionTimeout` (required; the
  SDK's `Duration` shape `{ days?, hours?, minutes?, seconds? }`), `retentionDays?`, plus the
  common `name?`, `synthesis?`, `variables?`.
- The user handler receives `(payload, context)` where `context` is the normal `InvokeContext`
  plus `durable: DurableContext` (the SDK type, re-exported as a type from `@voke/aws`).
- `durable(...)` returns an `InvokableFunctionDefinition` (`kind: "invokable"`), so the Function
  Contract, `functions.invoke` typing, the Function Contract Artifact and Remote Function
  Registries work without change. Its stored `handler` is a normal
  `(payload, context) => result` function (step 3 defines what it does).
- Durable settings travel in the existing Provider Extension Record: extend
  `AwsLambdaFunctionOptions` in `lambda-settings.ts` with
  `durable?: { executionTimeoutSeconds: number; retentionDays?: number }`, and have
  `durable(...)` merge it into `synthesis.provider` (a user-supplied `awsLambda({...})` record
  keeps its `architecture`/`runtime`).
- `@voke/aws` must recognise a durable definition later. Keep a module-level
  `WeakMap<Function, DurableSpec>` keyed by the stored `handler` function (its identity survives
  `createFunctions`' spread), holding the user handler and the settings.
- Validation at authoring time (`VokeConfigError`): `executionTimeout` missing or not positive.
  In `validateAwsLambdaModel`: 1 ≤ `executionTimeoutSeconds` ≤ 31,622,400; 1 ≤ `retentionDays`
  ≤ 90; `functionRecordIssues` accepts the new `durable` property and rejects unknown shapes.

**Evidence**: type tests (a `*-typecheck.ts` file like `packages/core/test/invoke-typecheck.ts`)
prove `context.durable.step` is typed and `functions.invoke("fulfilOrder", ...)` infers input
and output; unit tests cover the validation errors.

### Step 3: Run durable Functions locally and in tests

The stored `handler` decides at call time:

1. **Inside a durable execution on Lambda** (step 4 sets an ambient `DurableContext` with
   `AsyncLocalStorage` from `node:async_hooks`): call the user handler with
   `{ ...context, durable: ambientContext }`.
2. **Otherwise (local Gateway, `voke dev`, tests)**: run through the strategy chosen in step 1.
   Strategy A: build `withDurableExecution((event, durableContext) => userHandler(event, { ...context, durable: durableContext }))`,
   run it with `LocalDurableTestRunner`, return `getResult()` on success and throw the
   execution's error otherwise. Load the testing package with a dynamic `import()` so it is
   never evaluated on Lambda.

Core has already parsed the payload with `input` before the stored handler runs and parses the
result with `output` afterwards (`runLocalFunction`), so Function Contract validation needs no
new code. Document that durable inputs, step results and outputs must be JSON-serializable.

Local time is real: a `wait({ minutes: 10 })` under `voke dev` waits ten minutes. Tests skip
time through step 6's helpers.

**Evidence**: `packages/aws/test/durable.test.ts`: `voke(functions, { config })` then
`functions.invoke("fulfilOrder", payload)` returns the validated output; an invalid payload
rejects with `InvokeError` code `INVALID_PAYLOAD` before any step runs; a step that throws
is retried per its `retryStrategy`; a failing execution rejects with the step's error.

### Step 4: The deployed Lambda handler

In `handlerFor` (`packages/aws/src/lambda-handlers.ts`), before the default
`createInvokableHandler`, detect a durable definition through the `WeakMap` and return:

```ts
withDurableExecution(
  async (event, durableContext) =>
    await durableStorage.run({ context: durableContext, key }, () =>
      functions.invoke(
        key as never,
        event as never,
        { runtime: "local" } as never
      )
    )
);
```

The raw Lambda event is the Function's payload, as it is for every invokable Function today.
Because the call goes through `functions.invoke`, input parsing, Runtime Variables and output
parsing are the same code as local runs, and replays re-validate the same event.

Keep the testing package out of the bundle: add `@aws/durable-execution-sdk-js-testing` to the
externals the **AWS build plan** passes to the bundler (`packages/aws/src/build.ts`), not to
core's `defaultBuildExternal`. `@aws/durable-execution-sdk-js` itself is bundled.

**Evidence**: a handler test calls the generated handler with a fake durable invocation only if
the SDK offers a supported way to do so; otherwise assert that `createLambdaHandlers` returns a
function produced by `withDurableExecution` for durable keys (spy on the SDK import) and that
the ambient context reaches the user handler. A build test asserts the plan's command contains
`--external @aws/durable-execution-sdk-js-testing`.

### Step 5: Starting a durable Function from deployed code (neutral invoke hook)

Problem: deployed `functions.invoke` runs the target in-process (see Current state). A durable
Function started in-process inside another Lambda would not be durable at all.

Core change (provider-neutral):

- `packages/core/src/provider.ts`: extend `ProviderInvokeCapability` with
  `target?: (input: { key: string; definition: AnyFunctionDefinition }) => { functionName: string } | undefined`.
  Returning a target means "this Function must be invoked through `transport()`, not
  in-process".
- `activateFunctionRegistry` accepts `invoke?: ProviderInvokeCapability` and stores it in
  `FunctionRegistryActivation`; `createGatewayApp` passes `config.provider?.invoke`;
  `resolveProject`'s registry-only branch passes the AWS capability.
- `invokeFunction`: when the activation's `invoke.target(...)` returns a target and
  `options.runtime` is not set explicitly, invoke through `invoke.transport()` with that
  `functionName`. On this path the Lambda payload is the **parsed payload itself** (no
  `{ payload, trace }` envelope) and the response payload is the raw result (do **not** apply
  `unwrapPayload`: it would strip a legitimate top-level `data` property). The existing
  `runtime: "aws"` path and its tests stay unchanged.
- `InvokeOptions.executionName?: string` → `InvokeRequest.executionName` →
  `DurableExecutionName`. Using it on an invocation that is not Provider-routed rejects with
  an `InvokeError` (add code `INVALID_OPTIONS`). `AsyncInvokeResult` and
  `InvokeTransportResponse` gain an optional `executionId` (the durable execution ARN).
  `mode: "async"` → `Event`; the default → `RequestResponse` (15-minute cap; the guide says to
  use `mode: "async"` for anything longer).

`@voke/aws`:

- `aws()` sets `invoke: { transport: () => createAwsLambdaInvokeTransport(), target }`. `target`
  returns `{ functionName: process.env.VOKE_INVOKE_TARGET_<KEY> }` only when the definition is
  durable, that variable is set, and the call is not already inside that Function's own durable
  execution (the ambient context from step 4). Locally the variable is absent, so local runs
  stay in-process (step 3).
- Synthesis (step 6) sets `VOKE_INVOKE_TARGET_<KEY>` = `<deployedName>:live` on every Function,
  using `toEnvKey` from `packages/aws/src/resources.ts`.
- The transport passes `DurableExecutionName` and returns the execution ARN. Check the exact
  field names on `InvokeCommandInput`/`InvokeCommandOutput` in the installed
  `@aws-sdk/client-lambda` before coding.

**Evidence**: `packages/aws/test/durable-invoke.test.ts` with a fake `AwsLambdaInvokeClient`
(see `packages/core/test/aws-lambda-invoke-transport.test.ts` for the pattern): with the
variable set, `functions.invoke("fulfilOrder", payload, { mode: "async", executionName: "order-1" })`
sends `FunctionName: "<name>:live"`, `InvocationType: "Event"`, the bare payload and the name,
and returns `{ accepted: true, executionId }`; without the variable it runs locally; a
non-durable Function still runs in-process; `executionName` on a non-durable Function rejects
with `INVALID_OPTIONS`. Core tests cover the hook with a fake Provider and no AWS vocabulary.

### Step 6: Synthesis, deploy guard and test helpers

In `synthesizeCloudFormationFromModel`, for a Function whose record has `durable`:

- `DurableConfig: { ExecutionTimeout, RetentionPeriodInDays? }` on the `AWS::Lambda::Function`.
- Role: one more statement allowing `lambda:CheckpointDurableExecution` and
  `lambda:GetDurableExecutionState` on
  `{ "Fn::Sub": "arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:<deployedName>:*" }`.
  Build the ARN from the deployed name string, not `Fn::GetAtt`, so the role does not depend on
  the Function (the Function already depends on the role).
- `AWS::Lambda::Version` for the Function, with `DeletionPolicy: Retain` and
  `UpdateReplacePolicy: Retain` so executions pinned to an older version keep running after a
  deploy. Its logical id must change whenever the code or the Function's properties change, or
  CloudFormation will not publish a new version: suffix it with a short hash of
  `options.artifact.key` plus the Function's synthesized `Properties` (a fixed suffix when
  there is no artifact).
- `AWS::Lambda::Alias` named `live` pointing at that version.
- For every Function in the stack: environment `VOKE_INVOKE_TARGET_<KEY>` =
  `<deployedName>:live` for each durable Function, and a role statement allowing
  `lambda:InvokeFunction` on the alias ARN (string-built, same reason as above). This matches
  the current model, where every Function can reach every declared resource.

Deploy guard: add `replacement?: string` to `ChangeSetChange` (from the change set's
`ResourceChange.Replacement`) and, in `deployStack` before executing, fail with a
`VokeDeployError` when an `AWS::Lambda::Function` change has `Replacement: "True"`: "Function
`<logicalId>` must be replaced, which CloudFormation cannot do for a named Lambda. Durable
execution can only be enabled when a Function is created: give the Function a new registry key
or `name`, deploy, then remove the old one." Delete the change set first, as the existing
failure paths do. `--dry-run` prints the same condition as a warning.

Test helpers in `packages/aws/src/testing.ts` (`@voke/aws/testing`): `setupDurableTests()` /
`teardownDurableTests()` (the runner's time-skipping environment, Strategy A) and
`runDurable(functions, key, payload)` returning the result plus the recorded operations, so a
test can assert "step `reserve-stock` ran once" and "waited 10 minutes".

**Evidence**: `packages/aws/test/durable-synthesis.test.ts` asserts the template shape above for
a registry with one durable and one plain Function, that a plain-only registry's template is
byte-identical to before this plan (existing fixtures unchanged), and that the version logical
id changes when the artifact key changes. `packages/aws/test/deploy.test.ts` gains the
replacement-guard cases using its existing fake clients.

### Step 7: Example

`examples/durable-workflow/` modelled on `examples/sqs-events`: `voke.config.ts` with
`provider: aws()`, an `http` Function with `POST /orders` that starts `fulfilOrder` with
`mode: "async"` and an `executionName`, the durable Function with two steps and a wait, and
tests using `runDurable` and `functions.invoke`. Add its source files to
`firstPartyExampleFiles` in `packages/core/test/public-surface.test.ts`.

**Evidence**: `cd examples/durable-workflow && bun test` passes; `bun run typecheck` passes.

### Step 8: Real-AWS proof (needs explicit approval and credentials)

Deploy `examples/durable-workflow` to a region that has durable functions, start an execution
through the HTTP route, and confirm with `aws lambda list-durable-executions-by-function` that
it completes; redeploy with a code change while an execution is waiting and confirm the paused
execution finishes on its original version. This also proves the managed runtime's
`@aws-sdk/client-lambda` contains the durable commands; if it does not, bundle
`@aws-sdk/client-lambda` for projects with durable Functions and record it in the ADR. Remove
the stack afterwards. If approval is not given, skip this step and mark the plan
"DONE (real-AWS proof not run)".

### Step 9: Documentation and decisions

- `apps/docs/content/docs/guides/durable-functions.mdx`: when to use a durable Function, the
  authoring example, determinism rules (side effects only inside `step`; no untracked `await`
  while a wait is pending), starting executions (`mode: "async"`, `executionName`), testing,
  what local runs do and do not simulate, limits, the "create a new Function to enable it" rule,
  the Event Source pattern, callbacks through `@aws-sdk/client-lambda`, region availability, and
  "need Step Functions? declare the state machine as a raw CloudFormation resource". The docs
  site checks its code samples at build time (plan 012, `apps/docs` script
  `"test": "fumadocs-mdx && bun test"`): read `.factory/plans/012-docs-site-platform.md` and an
  existing guide such as `guides/sqs-events.mdx` for the sample conventions, and keep the
  legacy-sample allowlist empty. Add the page to the navigation and to
  `teachingSurfaceFiles` in `public-surface.test.ts`.
- `reference/packages.mdx`, `reference/errors.mdx` (`INVALID_OPTIONS`), `guides/troubleshooting.mdx`
  (the replacement error, the unqualified-ARN error), `docs/stable-public-surface.md`.
- `docs/adr/<next free number>-durable-functions.md` (0001–0009 exist; three share 0007): durable
  functions are the supported orchestration model; Step Functions is an escape hatch; the SDK's
  `DurableContext` is passed through unwrapped; version plus `live` alias with retained
  versions; the local strategy from step 1; the neutral invoke hook.
- `CONTEXT.md`: add **Durable Function** ("A Function whose handler runs as a checkpointed,
  replayable execution that can pause and resume. _Avoid_: workflow, state machine, saga
  function"), **Durable Execution** ("One run of a Durable Function, identified by an execution
  id and optionally a caller-chosen name") and the relationships (a Durable Function is an
  invokable Function; it does not mix with HTTP routes or Event Sources; deployed invocations of
  a Durable Function always go through the Provider).
- `roadmap-v2.md` phase 10: replace the `workflow(...)` exploration with the outcome of this plan.
- `packages/core/src/serverless-migration.ts:2501-2511`: point `serverless-step-functions`
  users at `durable(...)` for Lambda-centric workflows and at raw CloudFormation resources for
  state machines they keep; update the report fixture the tests compare against.

## Test plan

- `packages/aws/test/durable.test.ts`: spike tests; local invoke happy path; payload and result
  validation; step retry; failure propagation; `runDurable` operation assertions.
- `packages/aws/test/durable-synthesis.test.ts`: `DurableConfig`, role statements, version
  (retain policies, changing logical id), alias, invoke-target variables and grants; no change
  for projects without durable Functions; model validation limits.
- `packages/aws/test/durable-invoke.test.ts` and core tests for the invoke hook.
- `packages/aws/test/deploy.test.ts`: replacement guard, dry-run warning.
- `packages/aws/test/build.test.ts`: the testing package is external.
- Type tests for `durable(...)` inference.
- Structural patterns: `packages/aws/test/lambda-handlers.test.ts`,
  `packages/aws/test/lambda-defaults.test.ts`, `packages/core/test/aws-lambda-invoke-transport.test.ts`.
- Verification: `bun run check && bun run typecheck && bun run test` → all pass.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] `durable` is exported from `@voke/aws` and pinned in `public-surface.test.ts`; nothing
      durable-specific is exported from `voke`
- [ ] `grep -rn "durable\|DurableConfig" packages/core/src` finds nothing except the neutral
      `executionName`/`executionId` fields and their comments
- [ ] A project without durable Functions synthesizes the same template as before (existing
      fixtures unchanged)
- [ ] `examples/durable-workflow` tests pass and its synthesized template contains
      `DurableConfig`, a retained `AWS::Lambda::Version` and the `live` alias
- [ ] The build plan keeps `@aws/durable-execution-sdk-js-testing` out of the bundle
- [ ] The guide, ADR, `CONTEXT.md`, roadmap and stable-surface inventory are updated; docs
      sample checks pass
- [ ] Real-AWS proof ran, or the index row says "DONE (real-AWS proof not run)"
- [ ] `.factory/plans/README.md` status row updated

## STOP conditions

- Neither local strategy in step 1 works under Bun 1.4.4. Report what failed; do not ship a
  deployed-only feature without a local path.
- `AsyncLocalStorage` context does not reach the user handler through `withDurableExecution`
  and `functions.invoke`, and no in-scope alternative keeps core's validation in the path.
- The SDK's suspension rules make core's pre-handler work (schema parsing, Runtime Variable
  loading) cause re-execution loops in the real-AWS proof. Report it; the fix may need a
  durable-specific handler path instead of `functions.invoke`.
- The invoke hook in step 5 cannot be added without putting AWS or durable vocabulary into
  `packages/core`.
- The owner declines the two new dependencies.

Continue independent in-scope work otherwise. A changed excerpt or a failing check is a reason
to investigate and adapt, not an approval checkpoint.

## Maintenance notes

- Retained `AWS::Lambda::Version` resources accumulate: one per durable Function per deploy
  that changes the bundle (all Functions share one bundle, so every code change publishes a new
  version of every durable Function). Lambda's code storage quota is 75 GB per region. A
  follow-up should prune versions with no running executions (`voke prune` or a deploy step).
- `voke remove` deletes the Functions, which deletes their versions and ends running
  executions. The confirmation prompt should say so once `voke executions` exists.
- When least-privilege resource linking lands (roadmap-v2 phase 5), narrow the
  `lambda:InvokeFunction` grants and `VOKE_INVOKE_TARGET_*` variables to Functions that declare
  they start a given Durable Function.
- Plan 019's plugin `wrap` hook should run inside the durable handler path automatically,
  because step 4 goes through `functions.invoke`. Plan 021 (idempotency) should treat
  `executionName` as the idempotent-start mechanism for Durable Functions instead of adding its
  own record.
- Reviewers should scrutinize: the version logical-id hash (a stable id means no new version is
  ever published), the two string-built ARNs (a `Fn::GetAtt` there creates a dependency cycle),
  and that the envelope-free payload path does not change the existing `runtime: "aws"` tests.
- Deferred on purpose: `voke executions`, callback helpers, Event Sources targeting durable
  Functions, KMS keys for execution state, a `VOKE_DURABLE_SKIP_TIME` switch for `voke dev`.
