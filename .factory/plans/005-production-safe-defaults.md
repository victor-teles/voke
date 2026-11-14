# Plan 005: A freshly deployed Voke stack has production-safe Lambda and HTTP defaults

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 3435023 -- packages/core/src packages/core/test packages/aws/src packages/aws/test examples/hello-api README.md apps/docs/content docs/error-conventions.md`
> and `git status --short` with the recorded current state. Plans 009, 003, 008, 004 and 010
> land before this one and change these files on purpose (see "State after the prerequisite
> plans"). Reconcile that drift; pause only if it invalidates a protected contract or a decision
> listed below.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**:
  - `.factory/plans/009-*.md` (`@voke/aws` reaches parity; core's AWS copies, including
    `packages/core/src/cloudformation.ts`, are deleted; per-Function IAM roles and Runtime
    Variable IAM are ported to `@voke/aws`)
  - `.factory/plans/003-registry-discovery-and-lambda-entries.md` (the Provider is set only in
    `voke.config.ts`; `voke synth` works for `examples/hello-api`)
  - `.factory/plans/008-one-spelling-per-setting.md` (one spelling for config; `VokeApiConfig`
    holds only `name`; `resources`/`environment` are top-level)
  - Independent of 004, 006 and 007. Recommended order: 001 → 002 → 009 → 003 → 008 → 004 → 010 → 005.
- **Category**: dx
- **Planned at**: commit `3435023`, 2026-11-14

## Why this matters

An easy framework is one whose defaults are right, so the first deploy does not need tuning.
Today a Voke Lambda gets AWS's raw defaults: a 3-second timeout, 128 MB of memory, `x86_64`,
and logs that never expire and outlive the stack. There is no way to change timeout or memory.
A browser cannot call a deployed API because CORS cannot be configured, and any thrown error's
message is sent to the client. Each of these is a support question waiting to happen. This plan
adds safe defaults while keeping the package boundary: provider-neutral settings in `voke`,
AWS-only settings in `@voke/aws`.

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`:
  > The core package owns provider-neutral Function, Gateway, config, contract, route, and
  > Provider capability contracts; `@voke/aws` depends on public `voke` and owns the full AWS
  > workflow, including AWS runtime adapters, resource helpers, SQS and authorizer entrypoints,
  > local AWS workflow helpers, and CloudFormation synthesis under `@voke/aws/cloudformation`.
  > [...] provider-specific data appears in the provider-neutral model through Provider Extension
  > Records that each Provider validates and interprets.
  > This keeps future providers possible without making root `voke` depend on AWS,
  > CloudFormation, SQS, or API Gateway concepts.
- ADR `docs/adr/0007-opinionated-framework.md`: one spelling per setting; "per-Function
  `synthesis` overrides for Lambda settings" is the Function-level escape hatch; "New options
  should be added only when a use case cannot be met through the default or the layer's escape
  hatch"; removals happen without deprecation aliases (the package is unreleased).
- Owner decision U3 (2026-11-14): AWS-only settings live in provider options,
  `aws({ lambda: { ... } })`, and per-Function AWS overrides are Provider Extension Records. Core
  keeps only provider-neutral settings: Function `timeout`, `memory`, and `api.cors`.
  `runtime.lambda` leaves core in this plan.
- Owner decision U2: the Provider is set only in `voke.config.ts` (`provider: aws()`). Plan 003
  implements it.
- Core `src` must not import `@voke/*` (turbo rejects the workspace cycle). Core tests resolve
  `@voke/*` through `paths` in `packages/core/tsconfig.json`. AWS behavior reaches core only
  through the configured Provider (`packages/core/src/provider.ts`).

### Code at `3435023` (line numbers will move after the prerequisite plans)

- **The live template code is `@voke/aws`.** `voke synth` (`packages/core/src/cli.ts:509-545`)
  calls `config.provider.synthesis.synthesize`. `aws()` (`packages/aws/src/index.ts:93-129`)
  wires that to `synthesizeCloudFormationFromModel`
  (`packages/aws/src/cloudformation-synthesis.ts:690`). Its Lambda resource
  (`cloudformation-synthesis.ts:770-790`) has only these `Properties`:
  ```ts
  Code: { ZipFile: "..." }, Environment: { Variables: environmentVariables },
  FunctionName: definition.deployedName, Handler: definition.handler,
  Role: { "Fn::GetAtt": ["FunctionRole", "Arn"] }, Runtime: definition.runtime,
  ```
  It has no `Timeout`, `MemorySize`, `Architectures` or `LoggingConfig`, and the code
  synthesizes no `AWS::Logs::LogGroup`. The core copy `packages/core/src/cloudformation.ts` is
  deleted by plan 009. Do not edit it.
- HTTP API resource, `cloudformation-synthesis.ts:571-575`: only `Name` and
  `ProtocolType: "HTTP"`. It has no `CorsConfiguration`.
- `sqsQueue()` takes no options and has `properties: {}` (`cloudformation-synthesis.ts:174-187`;
  re-exported from `packages/aws/src/resources.ts:12`; plan 009 moves resource builders to
  `@voke/aws/cloudformation`). Queues get the 30-second default visibility timeout. AWS rejects an
  SQS event source mapping when the queue's visibility timeout is lower than the Function timeout.
- AWS model validation hook: `validateAwsModel` (`packages/aws/src/index.ts:68-91`) is passed as
  `VokeProvider.validate` and is called by core at `packages/core/src/model.ts:660`
  (`config.provider?.validate?.(model)`). It throws a plain `Error` today. New AWS checks go
  here.
- `aws()` takes no options today (`packages/aws/src/index.ts:93`). Plan 010 adds a
  `local` option (`aws({ local: awsEmulator() })`). This plan adds `lambda`.
- Core config, `packages/core/src/config.ts:89-93`:
  ```ts
  export type VokeNodeRuntime = "nodejs22.x" | "nodejs24.x";
  export interface VokeRuntimeConfig {
    lambda: VokeNodeRuntime;
  }
  ```
  validated by `defineNodeRuntime` (`config.ts:198-209`) and used by `defineRuntimeConfig`
  (`config.ts:211-213`, default `"nodejs22.x"`). Error shape:
  `VokeConfigError.validation([{ message: 'expected one of "nodejs22.x", "nodejs24.x"; received "..."', path: "runtime.lambda" }])`.
- Other places that use the runtime name:
  - `VokeNodeRuntime` is imported by `packages/core/src/invoke.ts:10` and
    `packages/core/src/model.ts:7`.
  - `VokeModelFunction.runtime` is at `model.ts:84`.
  - The model resolves it at `model.ts:539`
    (`definition.synthesis?.runtime ?? config.runtime.lambda`) and at `model.ts:592`.
  - `packages/aws/src/sqs.ts:150-155` has its own inline `synthesis` type with
    `runtime?: "nodejs22.x" | "nodejs24.x"`.
  - The serverless migrator emits it at `packages/core/src/serverless-migration.ts:1950` and
    `:2005`.
  - Tests use it in `packages/core/test/config-typecheck.ts:37-60`,
    `invoke-typecheck.ts:114` and `:204`, and `model-typecheck.ts:39` and `:61`.
  - `examples/hello-api/voke.config.ts:14-16` sets `runtime: { lambda: "nodejs24.x" }`.
- Per-Function overrides, `packages/core/src/invoke.ts:97-102`:
  ```ts
  export interface FunctionSynthesisConfig {
    entrypoint?: string;
    environment?: Record<string, string>;
    handler?: string;
    runtime?: VokeNodeRuntime;
  }
  ```
  It is exported from `voke` (`packages/core/src/index.ts:23`) and accepted as `synthesis` by
  `fn`/`http` (`invoke.ts:525`, `:600`) and by request authorizers
  (`packages/aws/src/authorizers.ts:57`). `sqs()` duplicates it inline (`aws/src/sqs.ts:150`).
- `VokeModelFunction` (`model.ts:78-89`) has no `provider` field. Provider Extension Records
  exist only on resources (`model.ts:112`; record shape `VokeModelProviderExtensionRecord { type; properties }`
  at `model.ts:125-128`, exported from `voke`). The AWS resource pattern to mirror is
  `resource.provider?.aws?.properties.cloudFormationType` (`aws/src/index.ts:76-77`).
- Model API shape, `model.ts:47-52` (`VokeModelApi { authorizers?, name, protocol, routes }`),
  built at `model.ts:623-632`. It has no CORS.
- Error handler, `packages/core/src/app.ts:112-133`. This is the leak:
  ```ts
  return responseError(
    error instanceof InvokeError
      ? publicRouteErrorMessage(error)
      : error.message || "Internal server error",
    { status: 500 }
  );
  ```
  It is registered at module level with `app.onError(handleRouteError)` in `createApiApp`
  (`app.ts:140-167`, where `config` is in scope; user middleware is applied at `app.ts:152-154`).
  No test asserts a leaked message.
- Response helpers: `error(message, { code, details, issues, status })` in
  `packages/core/src/response.ts:43-63`. The public body is
  `{ error: { code?, details?, issues?, message } }`.
- Dev signal: `voke dev` sets `VOKE_DEV_SUMMARY: "1"` and `VOKE_STAGE` (`packages/core/src/dev.ts:128-129`).
  `app.ts:205` already reads `readEnv("VOKE_DEV_SUMMARY")`. **Do not use `stage === "local"` as
  the dev signal.** `defineConfig` defaults stage to `"local"` (`config.ts:230`), nothing sets
  `VOKE_STAGE` on deployed Lambdas, and `examples/hello-api/voke.config.ts` hard-codes
  `stage: "local"`. A stage check would leak error messages in production.
- `hono` is a dependency of core and ships `hono/cors`. Runtime code must not use the `Bun`
  global (plan 002); use `packages/core/src/runtime-env.ts` `readEnv`.
- At `3435023`, `cd examples/hello-api && bun ../../packages/core/src/cli.ts synth` fails with
  `Invalid CLI usage: No provider configured for synthesis.`, because the provider is passed to
  `voke(...)` in `src/index.ts:89` and not in `voke.config.ts`. Plan 003 fixes this. If it still
  fails when this plan starts, apply the STOP condition.
- No default in this plan exists anywhere at `3435023`: `grep -rn "MemorySize\|LogGroup\|CorsConfiguration\|VisibilityTimeout\|Architectures" packages/*/src`
  finds nothing outside `dist/`.

### State after the prerequisite plans (expected; verify)

- 009: `packages/core/src/cloudformation.ts` is gone. `@voke/aws` synthesis has per-Function
  roles (`<FunctionLogicalId>Role`) plus Secrets Manager/SSM statements for Runtime Variables.
  Resource builders (`sqsQueue`, ...) are exported from `@voke/aws/cloudformation`. Core tests
  for synthesis live in `packages/aws/test/`.
- 003: `provider: aws()` is in `voke.config.ts`. `voke(functions, ...)` has no `provider`
  option. Functions come from the entrypoint, not `config.functions`.
- 008: `VokeApiConfig` is `{ name }`. `resources` and `environment` are top-level on config.
- 010: `aws()` accepts `{ local }`, and `local.provider` is gone from core config.

## Decisions taken in this plan

| Setting                    | Default                         | Where it is configured                                                            | Package     |
| -------------------------- | ------------------------------- | --------------------------------------------------------------------------------- | ----------- |
| Function timeout (seconds) | 15                              | `runtime.timeout` in config; per Function `synthesis.timeout`                     | `voke`      |
| Function memory (MB)       | 1024                            | `runtime.memory` in config; per Function `synthesis.memory`                       | `voke`      |
| HTTP CORS                  | off                             | `api.cors: true \| { origins, methods, headers, credentials, maxAgeSeconds }`     | `voke`      |
| Lambda Node.js runtime     | `"nodejs22.x"` (unchanged)      | `aws({ lambda: { runtime } })`; per Function `synthesis.provider.aws` record      | `@voke/aws` |
| Lambda architecture        | `"arm64"`                       | `aws({ lambda: { architecture } })`; per Function `synthesis.provider.aws` record | `@voke/aws` |
| Log retention (days)       | 14                              | `aws({ lambda: { logRetentionDays } })`                                           | `@voke/aws` |
| SQS visibility timeout     | `6 × attached Function timeout` | `sqsQueue({ visibilityTimeoutSeconds })`                                          | `@voke/aws` |

- `runtime.lambda` is **removed** from core, with no alias (ADR 0007, opinionated framework).
  `defineConfig` rejects it with
  `'"runtime.lambda" moved to the AWS provider; use aws({ lambda: { runtime } })'` at
  path `runtime.lambda`, matching the existing `build.target` removal pattern (`config.ts`
  `assertNoBuildTarget`). `synthesis.runtime` is removed the same way. A Function that sets it
  fails type-checking, and a runtime value reports
  `'"synthesis.runtime" moved; use synthesis.provider.aws'`.
- Neutral `timeout`/`memory` are validated in core only as positive integers. AWS limits
  (memory 128–10240, timeout 1–900, the CloudWatch retention value set, the 30-second HTTP API
  integration limit) are checked by `@voke/aws`, either in `aws()` option parsing or in
  `validateAwsModel`.
- **Over-30-second timeout on an HTTP-routed Function is a hard error** from the AWS provider's
  `validate`. API Gateway HTTP API integrations time out at 30 s. No warnings plumbing.
- Per-Function AWS overrides use the existing escape hatch: `synthesis.provider`, a
  `Record<string, VokeModelProviderExtensionRecord>`, mirroring resources. `@voke/aws` exports a
  builder that returns the `aws` record, e.g.
  `synthesis: { timeout: 60, provider: awsLambda({ architecture: "x86_64", runtime: "nodejs24.x" }) }`.
  The model copies it to `VokeModelFunction.provider` untouched; `@voke/aws` validates and reads
  it. Core never interprets it.
- `timeout`/`memory` stay in the `synthesis` bag (not top-level on `fn`/`http`) so they do not
  collide with the invoke option `timeoutMs` (`invoke.ts:850`).
- The defaults (1024 MB, 15 s, `arm64`, 14 days) are kept from the reviewed plan. They are
  reversible, but **verify each against current AWS documentation at execution** (Lambda quotas,
  `AWS::Lambda::Function` `LoggingConfig`, `AWS::Logs::LogGroup` `RetentionInDays` allowed values,
  `AWS::ApiGatewayV2::Api` `CorsConfiguration`, SQS visibility-timeout guidance for Lambda). If AWS
  contradicts a value or property, apply the STOP condition.

## Commands you will need

| Purpose        | Command                                                                                | Expected on success      |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------ |
| Install        | `bun install`                                                                          | exit 0                   |
| Core tests     | `cd packages/core && bun test`                                                         | 0 fail                   |
| AWS tests      | `cd packages/aws && bun test`                                                          | 0 fail                   |
| Core typecheck | `cd packages/core && bun run typecheck`                                                | exit 0                   |
| AWS typecheck  | `cd packages/aws && bun run typecheck`                                                 | exit 0                   |
| Repo gates     | `bun run typecheck && bun run test`                                                    | exit 0                   |
| Lint/format    | `bun run check`                                                                        | exit 0                   |
| Synth example  | `cd examples/hello-api && bun ../../packages/core/src/cli.ts synth --out <tmp>/t.json` | exit 0, template written |

## Implementation rules relevant to this plan

- Test first. Template behavior is tested in `packages/aws/test/` against
  `synthesizeCloudFormationFromModel(createVokeModel(...))`. Model `packages/aws/test/model-extension-records.test.ts`
  and `provider.test.ts`. Core config and model behavior is tested in `packages/core/test/`.
- Core `src` must not import from `@voke/aws` or mention CloudFormation, Lambda, SQS or API
  Gateway names in new types. The neutral model carries `timeout`, `memory`, `cors` and the
  opaque `provider` record. Only `@voke/aws` turns them into `MemorySize`, `Timeout`,
  `CorsConfiguration`, etc.
- Validate config at `defineConfig` time with `VokeConfigError.validation([{ message, path }])`.
  Message shape: `expected <expectation>; received <JSON value>`. Paths look like
  `runtime.memory`, `api.cors.origins`, `functions.<name>.synthesis.timeout`.
- AWS-provider validation errors must name the Function and setting path and state both numbers
  where relevant, for example
  `Function "orders" timeout 45s exceeds the 30s API Gateway HTTP API integration limit; lower synthesis.timeout to 30 or less, or move the work to an SQS Function`.
  Prefer a `VokeConfigError.validation` / `VokeModelError.validation` issue list over a bare
  `Error` when one is reachable from `@voke/aws` through public `voke` exports. Otherwise keep the
  existing plain-`Error` pattern of `validateAwsModel`.
- Local and deployed CORS must match: the same normalized `cors` value drives `hono/cors` in the
  local Gateway and `CorsConfiguration` in the template.
- Runtime code must not use the `Bun` global (plan 002). No new dependencies.
- The public error body shape `{ error: { code?, message, issues?, details? } }` stays as is.

## Scope

**In scope**:

- `packages/core/src/config.ts`: remove `runtime.lambda` and `VokeNodeRuntime`; add
  `runtime.timeout`, `runtime.memory`, `api.cors`.
- `packages/core/src/invoke.ts`: `FunctionSynthesisConfig` only. Remove `runtime`; add
  `timeout`, `memory`, `provider`.
- `packages/core/src/model.ts`: `VokeModelFunction` and `VokeModelApi` fields and their resolution.
- `packages/core/src/app.ts`: error handler and CORS middleware.
- `packages/core/src/serverless-migration.ts`: emit `aws({ lambda: { runtime } })` /
  `synthesis.provider` instead of `runtime.lambda` / `synthesis.runtime`, only at the lines that
  emit the runtime.
- `packages/core/src/index.ts`: export any new neutral types (`VokeCorsConfig`).
- `packages/core/test/`: `config-typecheck.ts`, `model-typecheck.ts`, `invoke-typecheck.ts`,
  `model.test.ts`, `api.test.ts` or `route-builder.test.ts`, `error-design.test.ts`, and
  `serverless-migration.test.ts` (runtime emission only).
- `packages/aws/src/index.ts` (`aws({ lambda })`, `validateAwsModel`, `awsLambda` export),
  `packages/aws/src/cloudformation-synthesis.ts` (or wherever 009 left the synthesis and resource
  builders), `packages/aws/src/sqs.ts` (reuse `FunctionSynthesisConfig` from `voke` instead of
  the inline type), `packages/aws/src/authorizers.ts` (type only, if it still declares one).
- `packages/aws/test/`: new or extended tests for defaults, overrides, log group, CORS, SQS and
  validation.
- `examples/hello-api/voke.config.ts`: drop `runtime.lambda`; move it to `aws({ lambda })`; show
  `api: { cors: true }`.
- `README.md`, `apps/docs/content/docs/reference/config.mdx`, `docs/error-conventions.md`.
- `.factory/plans/README.md` (status only, unless the coordinator owns it).

**Out of scope**:

- `packages/core/src/cloudformation.ts` and any other core AWS copy. Plan 009 deletes them; if
  one still exists, apply the STOP condition and do not add defaults to it.
- Moving the Provider into `voke.config.ts` (plan 003) or changing `aws({ local })` (plan 010).
- Security headers, compression, body parsers, interceptors, OpenAPI (roadmap v2 phase 3).
- A structured logger, metrics or redaction (roadmap v2 phase 8). This plan only logs unhandled
  errors.
- Dead-letter queues and redrive (ADR 0003 defers them).
- IAM shape changes. Plan 009 owns per-Function roles. This plan adds no IAM statements:
  `AWSLambdaBasicExecutionRole` already covers writing to the explicit log group.
- A typed `HttpError` class for user code. Users keep returning `error(...)` from `voke/response`.
- ADRs and `CONTEXT.md`.

## Git workflow

- Branch: `feature/production-safe-defaults`
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Neutral config and model (core)

In `packages/core/src/config.ts`:

```ts
export interface VokeRuntimeConfig {
  memory: number; // MB, positive integer, default 1024
  timeout: number; // seconds, positive integer, default 15
}

export interface VokeCorsConfig {
  origins: string[];
  methods: string[];
  headers: string[];
  credentials: boolean;
  maxAgeSeconds?: number;
}
// VokeApiConfig (after 008: { name }) gains: cors?: VokeCorsConfig
// VokeConfigInput.api accepts cors?: boolean | Partial<VokeCorsConfig>
```

- Remove `VokeNodeRuntime`, `defineNodeRuntime` and `runtime.lambda`. Reject `runtime.lambda` at
  runtime as described in "Decisions".
- Normalize `cors: true` to `{ origins: ["*"], methods: ["*"], headers: ["*"], credentials: false }`.
  `false` or absent means no CORS. Reject `credentials: true` together with a `"*"` origin, with
  the fix in the message (`list explicit origins`).
- In `invoke.ts` `FunctionSynthesisConfig`: remove `runtime`; add `timeout?: number`,
  `memory?: number`, and `provider?: Record<string, VokeModelProviderExtensionRecord>`. Validate
  per-Function `timeout`/`memory` as positive integers in the model with path
  `functions.<name>.synthesis.<field>`.
- In `model.ts`: `VokeModelFunction` drops `runtime` and gains `timeout`, `memory`
  (Function → config → default) and `provider?` (copied from `synthesis.provider`).
  `VokeModelApi` gains `cors?: VokeCorsConfig`.
- Update the core typecheck files that used `nodejs*` values. In `config-typecheck.ts`, assert
  that `runtime: { lambda: ... }` is a type error and that `api.cors` accepts `true` and an
  object.

### Step 2: AWS provider options and validation (`@voke/aws`)

```ts
export type AwsLambdaRuntime = "nodejs22.x" | "nodejs24.x";
export type AwsLambdaArchitecture = "arm64" | "x86_64";
export interface AwsLambdaOptions {
  runtime?: AwsLambdaRuntime; // default "nodejs22.x"
  architecture?: AwsLambdaArchitecture; // default "arm64"
  logRetentionDays?: AwsLogRetentionDays; // default 14
}
export const aws = (options?: { lambda?: AwsLambdaOptions /* plan 010 adds local */ }) => ...;
export const awsLambda = (input: { runtime?: AwsLambdaRuntime; architecture?: AwsLambdaArchitecture })
  : Record<"aws", VokeModelProviderExtensionRecord> => ({ aws: { type: "lambda.function", properties: { ...input } } });
```

- Validate `aws()` options when it is called. Accepted `logRetentionDays` values: 1, 3, 5, 7, 14,
  30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653.
  Re-verify this list against AWS; the error names the nearest valid values.
- Extend `validateAwsModel` with these checks:
  1. Function `memory` is in 128..10240 and `timeout` is in 1..900.
  2. A Function with HTTP routes and `timeout > 30` fails, with both numbers in the message.
  3. Each `provider.aws` record on a Function has type `"lambda.function"` and valid
     `runtime`/`architecture` values.
  4. An SQS queue with an explicit visibility timeout lower than an attached Function's timeout
     fails at path `resources.<queue>.properties.VisibilityTimeout`, with both numbers.
- `validate` and `synthesis.synthesize` read the options from the `aws()` closure. Keep
  `ProviderSynthesisCapability` unchanged.

### Step 3: Lambda template defaults (`@voke/aws`)

In the Lambda resource built by `synthesizeCloudFormationFromModel`:

- Resolve each value in order: Function `provider.aws` record → `aws({ lambda })` option →
  default. Then set `Runtime`, `Architectures: [architecture]`, `MemorySize: definition.memory`,
  `Timeout: definition.timeout`, and
  `LoggingConfig: { LogGroup: { Ref: "<FunctionLogicalId>LogGroup" } }`.
- For each Function, add `<FunctionLogicalId>LogGroup` of type `AWS::Logs::LogGroup` with
  `LogGroupName: /aws/lambda/<deployedName>` and `RetentionInDays`. Add a `DependsOn` from the
  Function to its log group if AWS docs require it.
- The synthesis entrypoint without a provider closure (`synthesizeCloudFormation` /
  `synthesizeCloudFormationFromModel(model)`) uses the defaults.

### Step 4: SQS visibility timeout follows the Function timeout (`@voke/aws`)

- `sqsQueue(options?: { visibilityTimeoutSeconds?: number })` sets `VisibilityTimeout` when
  given.
- When an SQS event source attaches a Function to a queue that has no explicit visibility
  timeout, synthesize `VisibilityTimeout: 6 * functionTimeout` on that queue. If several
  Functions consume one queue, use the largest timeout.
- `sqs()` in `packages/aws/src/sqs.ts` uses `FunctionSynthesisConfig` from `voke` instead of its
  inline `synthesis` type, so it gets `timeout`, `memory` and `provider`.

### Step 5: CORS in both places

- `@voke/aws`: when `model.apis.http.cors` is set, add `CorsConfiguration` to the `Api` resource
  (`AllowOrigins`, `AllowMethods`, `AllowHeaders`, `AllowCredentials`, and `MaxAge` when set).
- Core `createApiApp` (`app.ts`): when `config.api.cors` is set, register `cors(...)` from
  `hono/cors` with the same values **before** user middleware, so an `OPTIONS` preflight with
  `Origin` through `gateway.request(...)` behaves like the deployed API.

### Step 6: Do not leak unhandled error messages (core)

Replace the module-level `handleRouteError` (`app.ts:112-133`) with a handler created inside
`createApiApp`:

- `InvokeError` handling for `INVALID_PAYLOAD` (400) and `INVALID_RESULT` (500) stays.
- Any other error: log once with `console.error` as one JSON line
  (`{ level: "error", message, name, stack, code? }`), and respond
  `error("Internal server error", { code: "INTERNAL_SERVER_ERROR", status: 500 })`.
- Only when `readEnv("VOKE_DEV_SUMMARY") === "1"` (set solely by `voke dev`), include the
  original message in `details: { message }`. Never use the stage as the dev signal (see
  "Current state").
- Update `docs/error-conventions.md` with a short "HTTP error responses" section describing the
  three cases.

### Step 7: Migrator, docs and example

- `serverless-migration.ts`: emit the runtime as `aws({ lambda: { runtime } })` in the generated
  config (the provider line that plan 003 adds) and as `synthesis.provider: awsLambda({ runtime })`
  per Function. Update the matching migration test expectations.
- `apps/docs/content/docs/reference/config.mdx`: replace the `runtime` row ("including Lambda
  runtime selection"). Document `runtime.timeout`, `runtime.memory`, `synthesis.timeout`,
  `synthesis.memory`, `synthesis.provider`, `api.cors`, `aws({ lambda: { runtime, architecture, logRetentionDays } })`
  and `sqsQueue({ visibilityTimeoutSeconds })`, with the defaults table above.
- `README.md`: one short "Defaults" paragraph and a CORS example.
- `examples/hello-api/voke.config.ts`: `provider: aws({ lambda: { runtime: "nodejs24.x" } })`,
  `api: { cors: true }`, and no `runtime.lambda`.

## Test plan

- `packages/aws/test/` (new file, e.g. `lambda-defaults.test.ts`, modeled on
  `model-extension-records.test.ts`):
  - Every Function has `MemorySize: 1024`, `Timeout: 15`, `Architectures: ["arm64"]`,
    `Runtime: "nodejs22.x"` and `LoggingConfig` pointing at its own log group.
  - The log group resource has the right name and `RetentionInDays: 14`.
  - `aws({ lambda })` options override the defaults; a per-Function `awsLambda(...)` record
    overrides the options; `synthesis.timeout`/`memory` override `runtime.*`.
  - `CorsConfiguration` is present only when `api.cors` is set; `true` maps to wildcards.
  - SQS `VisibilityTimeout`: derived (6×), explicit, largest timeout among several consumers, and
    the too-low error.
  - Validation: memory/timeout outside AWS limits, HTTP Function with a timeout over 30 s, invalid
    `logRetentionDays` (message lists the nearest values), invalid `awsLambda` record.
- `packages/core/test/model.test.ts`: resolution order for `timeout`/`memory`
  (Function → config → default); `synthesis.provider` is copied to the model unchanged;
  `apis.http.cors` is normalized.
- `packages/core/test/error-design.test.ts`: `runtime.lambda` removed-setting message;
  non-positive `memory`/`timeout`; `credentials: true` with a `"*"` origin.
- `packages/core/test/config-typecheck.ts`: `runtime.lambda` is a type error; `api.cors` shapes.
  `invoke-typecheck.ts` / `model-typecheck.ts`: `synthesis.runtime` is a type error;
  `synthesis.timeout`/`memory` are accepted; the model exposes `timeout`/`memory`.
- `packages/core/test/api.test.ts` or `route-builder.test.ts`:
  - A route that throws `new Error("db password=hunter2")` returns 500 with message
    `Internal server error` and code `INTERNAL_SERVER_ERROR`; the body does not contain
    `hunter2`, **including when the config stage is `"local"`** (regression guard for the
    stage-default trap).
  - With `VOKE_DEV_SUMMARY=1`, `details.message` carries the original message. Set and restore
    the variable inside the test.
  - Spy on `console.error` and assert exactly one JSON line.
- CORS parity: `gateway.request("/health", { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "GET" } })`
  returns the allow headers when configured and none when not. The same config in the AWS test
  yields a matching `CorsConfiguration`.

## Done criteria

- [ ] `cd examples/hello-api && bun ../../packages/core/src/cli.ts synth --out <tmp>/t.json` exits 0
      using the provider from `voke.config.ts` (`provider: aws({ lambda: { runtime: "nodejs24.x" } })`;
      U2, delivered by plan 003). In the template, every `AWS::Lambda::Function` has
      `MemorySize: 1024`, `Timeout: 15`, `Architectures: ["arm64"]`, `Runtime: "nodejs24.x"` and
      a `LoggingConfig` that references an `AWS::Logs::LogGroup` with `RetentionInDays: 14`. The
      `Api` resource has `CorsConfiguration`.
- [ ] `grep -rn "runtime?\.lambda\|VokeNodeRuntime\|nodejs2[24]" packages/core/src --include=*.ts | grep -v serverless-migration.ts`
      matches only the `runtime.lambda` removed-setting check in `config.ts` (the migrator may
      still read Serverless `nodejs*` runtimes in order to emit them into `aws({ lambda })`).
- [ ] A thrown plain `Error` in a route never appears in a response body unless
      `VOKE_DEV_SUMMARY=1` (test asserts it, including with stage `"local"`).
- [ ] CORS preflight through `gateway.request(...)` matches the synthesized `CorsConfiguration`
      (tests in both packages use the same config).
- [ ] An HTTP-routed Function with `synthesis.timeout: 31` fails `voke synth` with the 30-second
      message.
- [ ] `cd packages/core && bun test` and `cd packages/aws && bun test` → 0 fail;
      `bun run typecheck` exits 0; `bun run check` exits 0.
- [ ] The config reference documents every new option with its default, and the defaults were
      checked against current AWS docs (note the doc URLs in the PR description).
- [ ] No files outside the in-scope list are modified (`git status --short`).

## STOP conditions

- `packages/core/src/cloudformation.ts` (or another core AWS template copy) still exists, or
  `@voke/aws` synthesis lacks per-Function roles: plan 009 has not landed. Do not add defaults to
  two copies.
- `voke synth` in `examples/hello-api` still reports `No provider configured for synthesis.`, or
  `voke(...)` still accepts `provider`: plan 003 (U2) has not landed.
- An existing test or example relies on thrown error messages reaching HTTP clients as a
  documented contract (none found at `3435023`). Report it; the owner decides.
- AWS docs contradict a chosen default or property: memory or timeout limits, the retention value
  set, `LoggingConfig` with an explicit log group, `CorsConfiguration` fields, or the SQS
  visibility guidance. Report the source and the conflicting value.
- `LoggingConfig` with an explicit log group breaks the local bootstrap path that plans 007/010
  set up (the emulator rejects the template). Report the emulator error; do not drop log
  retention silently.
- Carrying per-Function AWS overrides would require core to understand AWS fields (anything
  beyond copying `synthesis.provider` to the model).

## Maintenance notes

- New Function kinds must receive `timeout`, `memory` and the AWS-resolved runtime, architecture
  and log group. Assert this in the `@voke/aws` template tests.
- If a stack was deployed before this plan and its Functions already ran, the explicit log group
  would collide with the one Lambda created automatically. Mention it in release notes. No such
  stacks are expected (deploy did not work before plan 004).
- Reviewers should scrutinize:
  - The dev-mode check in the error handler. It must key only on `VOKE_DEV_SUMMARY`, never on
    the stage.
  - The CORS credentials validation.
  - That core gained no AWS vocabulary.
- If a second Provider is added, `runtime.timeout`/`memory` keep their neutral meaning and that
  Provider maps and limits them itself.
- Deferred: top-level `timeout`/`memory` on `fn`/`http`/`sqs`, security headers, structured
  logging, DLQs, and an `@voke/aws` log-group retention override per Function.

## Execution notes (2026-11-14)

Done on branch `feature/production-safe-defaults` (PR #57), stacked on plan 010 (`feature/local-workflow-through-provider`,
PR #56, open). Gates: `bun run check` 0 errors, `bun run typecheck` 18/18, `bun run test`
23/23 tasks (core 224, `@voke/aws` 74).

- **Core:** `runtime.lambda` and `VokeNodeRuntime` are gone. `defineConfig` rejects `runtime.lambda` with
  the `aws({ lambda: { runtime } })` pointer, and the model rejects `synthesis.runtime`.
  `runtime.timeout` (default 15) and `runtime.memory` (default 1024) are validated as positive
  integers. `api.cors` normalizes `true` to wildcards and rejects `credentials: true` with a `"*"` origin
  and empty origins. `FunctionSynthesisConfig` gains `timeout`, `memory` and `provider`. The model
  carries `timeout`, `memory`, the untouched `provider` record and `apis.http.cors`.
- **Gateway:** unhandled errors return `INTERNAL_SERVER_ERROR` / `Internal server error`. They are logged once
  as a JSON line, and `details.message` is added only when `VOKE_DEV_SUMMARY=1`. `hono/cors` runs before
  user middleware when `api.cors` is set.
- **`@voke/aws`:** new `lambda-settings.ts` with `aws({ lambda: { runtime, architecture, logRetentionDays } })`
  (validated when `aws()` is called) and `awsLambda()` per-Function records. `validateAwsLambdaModel`
  checks memory 128–10240, timeout 1–900, at most 30 s for HTTP-routed Functions, the record type and
  values, and an explicit queue visibility timeout below a consumer's timeout. Synthesis adds
  `Architectures`, `MemorySize`, `Timeout`, `LoggingConfig` and a per-Function `AWS::Logs::LogGroup`
  (`/aws/lambda/<deployedName>`, 14 days), `CorsConfiguration`, and derived `VisibilityTimeout`.
  `deploy` threads the same settings into its template.
- **Migrator:** emits `aws({ lambda: { runtime } })` and `synthesis.provider: awsLambda({ runtime })`.
- **Done criteria:**
  - `voke synth` for hello-api exits 0 with the expected properties.
  - `synthesis.timeout: 31` on an HTTP Function fails `voke synth` with the 30 s message (checked in a
    temporary project).
  - The `runtime.lambda`/`nodejs` grep over core `src` (excluding the migrator) is empty.

AWS documentation checked on 2026-11-14 (no STOP condition):

- Lambda memory 128–10,240 MB and timeout 1–900 s. CloudFormation now allows 32,768 MB for Lambda
  Managed Instances; Voke keeps the standard Lambda limit.
  https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html,
  https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-function.html
- `LoggingConfig.LogGroup` takes a name, so `Ref` works and implies creation order; no `DependsOn` is
  needed. https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-function-loggingconfig.html
- `RetentionInDays` allowed values match the list exactly.
  https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-logs-loggroup.html
- HTTP API integration timeout: 30 s and it cannot be raised.
  https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html
- `CorsConfiguration` fields, with `*` valid in origins, methods and headers.
  https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-apigatewayv2-api-cors.html
- SQS: visibility timeout at least 6× the Function timeout **plus `MaximumBatchingWindowInSeconds`**, and
  Lambda rejects mappings where the Function timeout exceeds the visibility timeout.
  https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html

Adaptations and deviations:

- The derived visibility timeout adds the batching window, per the AWS guidance above (the plan said 6×).
- The Function timeout and memory limit errors use `VokeModelError.validation` at
  `functions.<name>.synthesis.<field>`, and the `aws()` option errors use `VokeConfigError.validation`
  at `aws.lambda.<field>`.
- New files outside the listed scope:
  - `packages/core/src/numbers.ts`, a positive-integer issue helper shared by config and model;
  - `packages/aws/src/lambda-settings.ts`;
  - `packages/aws/src/deploy.ts`, which passes the settings into the deployed template;
  - the four CloudFormation fixtures under `packages/core/test/fixtures`, regenerated and reviewed;
  - `public-surface.test.ts`, which now lists `awsLambda`.
- `voke` now also exports the `VokeCorsConfig`, `VokeRuntimeConfig` and `VokeModelFunction` types.
- The config reference no longer lists the top-level `local` setting that plan 010 removed.
- `docs/error-conventions.md` does not point users at `voke/response`: core exports no response helpers.
- Not verified: the explicit log group under the local emulator (`voke local bootstrap` against Floci),
  which needs Docker, and any real AWS deploy.
