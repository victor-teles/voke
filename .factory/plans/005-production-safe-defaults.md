# Plan 005: A freshly deployed Voke stack has production-safe Lambda and HTTP defaults

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare `git diff --stat a7741eb -- packages/core/src packages/core/test README.md apps/docs/content`
> and `git status --short` with the recorded current state. Reconcile routine drift;
> pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `.factory/plans/003-registry-discovery-and-lambda-entries.md` and `.factory/plans/008-one-spelling-per-setting.md` (same config and model files; land after both). Independent of plan 004.
- **Category**: dx
- **Planned at**: commit `a7741eb`, 2026-11-14

## Why this matters

An easy framework is one whose defaults are right, so the first deploy does not need tuning.
Today a Voke Lambda gets AWS's raw defaults: a 3-second timeout, 128 MB of memory, x86, and
logs that never expire and outlive the stack. There is no way to change timeout or memory.
A browser cannot call a deployed API because CORS cannot be configured, and any thrown error's
message is sent to the client. Each of these is a support question waiting to happen.

## Current state

- `packages/core/src/cloudformation.ts:744-766` — Lambda `Properties` are `Code`, `Environment`,
  `FunctionName`, `Handler`, `Role`, `Runtime`. No `Timeout`, `MemorySize`, `Architectures`, or
  logging configuration. AWS defaults apply: 3 s, 128 MB, `x86_64`.
- No `AWS::Logs::LogGroup` resource is synthesized. Lambda creates `/aws/lambda/<name>` on first
  invoke with no retention, and the group is not part of the stack.
- Config has one runtime knob, `packages/core/src/config.ts:66-70`:
  ```ts
  export type VokeNodeRuntime = "nodejs22.x" | "nodejs24.x";
  export interface VokeRuntimeConfig {
    lambda: VokeNodeRuntime;
  }
  ```
  validated in `defineNodeRuntime` (`config.ts:158-169`) with `VokeConfigError.validation([{ message, path }])`.
- Per-Function overrides, `packages/core/src/invoke.ts:80-85`:
  ```ts
  export interface FunctionSynthesisConfig {
    entrypoint?: string;
    environment?: Record<string, string>;
    handler?: string;
    runtime?: VokeNodeRuntime;
  }
  ```
  accepted as `synthesis` by `fn`, `http`, `sqs`, and `requestAuthorizer`
  (`invoke.ts:558`, `packages/core/src/authorizers.ts:59`), read in `packages/core/src/model.ts:509-522`.
  `VokeModelFunction` is at `model.ts:86-96`.
- `sqsQueue()` takes no options (`cloudformation.ts:101-114`, `properties: {}`), so queues use the
  30-second default visibility timeout. AWS rejects an SQS event source mapping when the queue's
  visibility timeout is lower than the Function timeout.
- HTTP API resource, `cloudformation.ts:530-536`: only `Name` and `ProtocolType`. No
  `CorsConfiguration`. `VokeApiConfig` (`config.ts:31-36`) has `name`, `protocol`, `function`, `routes`.
- Error handler, `packages/core/src/app.ts:108-129`:
  ```ts
  return responseError(
    error instanceof InvokeError
      ? publicRouteErrorMessage(error)
      : error.message || "Internal server error",
    { status: 500 }
  );
  ```
  Any thrown `Error` reaches the client with its message (connection strings, SQL, internal
  names) and no error code. Nothing logs the error. AGENTS.md requires avoiding "leaking internal
  details through public responses".
- Response helpers: `error(message, { code, details, issues, status })` in
  `packages/core/src/response.ts:44-63`; `jsonError` in `packages/core/src/http.ts` adds default
  codes (`NOT_FOUND`, `BAD_REQUEST`, `INTERNAL_SERVER_ERROR`).
- The Gateway app is built in `createApiApp` (`app.ts:136-163`); user middleware is applied with
  `app.use("*", middleware)`. hono is a peer dependency (`^4.0.0`) and ships `hono/cors`.
- Dev mode is signaled by `VOKE_DEV_SUMMARY=1` (set by `voke dev`, `packages/core/src/dev.ts:99`)
  and stage `local`.
- Roadmap v2 phase 3 lists CORS and error responses as P0 HTTP hardening; phase 8 lists structured
  logging. This plan takes the minimum of each that a first deploy needs.
- ADR `docs/adr/0007-opinionated-framework.md` applies: "New options should be added only when a
  use case cannot be met through the default or the layer's escape hatch", and each setting has
  one spelling. The settings this plan adds are the ones without a workable default for every
  project (timeout, memory, architecture, log retention, CORS origins). By the time this plan
  runs, plans 003 and 008 have changed the config shape described above: `VokeApiConfig` holds
  only `name`, the single-function template is gone, and resources and environment are top-level
  (`config.resources`, `config.environment`). Line numbers above are from commit `a7741eb`.

## Decisions taken in this plan

| Setting       | Default | Config                                                                        |
| ------------- | ------- | ----------------------------------------------------------------------------- |
| Memory        | 1024 MB | `runtime.memory`, per Function `synthesis.memory`                             |
| Timeout       | 15 s    | `runtime.timeout`, per Function `synthesis.timeout`                           |
| Architecture  | `arm64` | `runtime.architecture` (`"arm64" \| "x86_64"`)                                |
| Log retention | 14 days | `runtime.logRetentionDays`                                                    |
| CORS          | off     | `api.cors: true \| { origins, methods, headers, credentials, maxAgeSeconds }` |

Bundles are plain JavaScript, so `arm64` is safe by default and cheaper; projects with native
x86-only dependencies set `x86_64`. Timeout and memory live in the existing `synthesis` bag to
avoid confusion with the invoke option `timeoutMs` (`invoke.ts:733`).

## Commands you will need

| Purpose        | Command                                                    | Expected on success |
| -------------- | ---------------------------------------------------------- | ------------------- |
| Install        | `bun install`                                              | exit 0              |
| Core tests     | `cd packages/core && bun test`                             | all pass            |
| One test file  | `cd packages/core && bun test test/cloudformation.test.ts` | all pass            |
| Core typecheck | `cd packages/core && bun run typecheck`                    | exit 0              |
| Repo gates     | `bun run typecheck && bun run test`                        | exit 0              |
| Lint/format    | `bun run check`                                            | exit 0              |

## Implementation rules relevant to this plan

- Test first; CloudFormation changes need fixture assertions in `test/cloudformation.test.ts`,
  typed config needs cases in `test/config-typecheck.ts` and `test/model-typecheck.ts`.
- Validate config at `defineConfig` time with `VokeConfigError.validation([{ message, path }])`.
  Message shape: `expected <expectation>; received <JSON value>`, path like `runtime.memory`.
- Local behavior must match deployed behavior for CORS: the same config drives API Gateway and
  the local Gateway.
- Runtime code must not use the `Bun` global (plan 002).
- No new dependencies.
- Public response shape `{ error: { code?, message, issues?, details? } }` stays as is.

## Scope

**In scope**:

- `packages/core/src/config.ts`, `invoke.ts` (`FunctionSynthesisConfig` only), `model.ts`, `cloudformation.ts`, `app.ts`
- `packages/core/test/cloudformation.test.ts`, `model.test.ts`, `api.test.ts`, `route-builder.test.ts`, `error-design.test.ts`, `config-typecheck.ts`, `model-typecheck.ts`
- `examples/hello-api/voke.config.ts` (show one setting), `README.md`, `apps/docs/content/docs/reference/config.mdx`, `docs/error-conventions.md`
- `.factory/plans/README.md` (status only)

**Out of scope**:

- Security headers, compression, body parsers, interceptors, OpenAPI (roadmap v2 phase 3).
- A structured logger, metrics, redaction (roadmap v2 phase 8). This plan only logs unhandled errors.
- Dead-letter queues and redrive (ADR 0003 defers them).
- Per-Function IAM roles and resource linking (roadmap v2 phase 5).
- A typed `HttpError` class for user code. Users keep returning `error(...)` from `voke/response`.

## Git workflow

- Branch: `feature/production-safe-defaults`
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Config surface and validation

Extend `VokeRuntimeConfig` and `defineRuntimeConfig`:

```ts
export type VokeArchitecture = "arm64" | "x86_64";

export interface VokeRuntimeConfig {
  lambda: VokeNodeRuntime;
  memory: number; // MB, integer 128..10240, default 1024
  timeout: number; // seconds, integer 1..900, default 15
  architecture: VokeArchitecture; // default "arm64"
  logRetentionDays: number; // one of CloudWatch's allowed values, default 14
}
```

Add `memory?: number` and `timeout?: number` to `FunctionSynthesisConfig`. Validate ranges for
both config-level and per-Function values. For `logRetentionDays`, accept the CloudWatch Logs
set (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557,
2922, 3288, 3653) and report the nearest valid values in the error.

Add `cors?: boolean | VokeCorsConfig` to `VokeApiConfig`, normalized to
`VokeCorsConfig | undefined` (`true` → `{ origins: ["*"], methods: ["*"], headers: ["*"] }`).
Reject `credentials: true` together with a `"*"` origin, with the fix in the message.

### Step 2: Model and template

- `VokeModelFunction` gains `memory`, `timeout`, `architecture`, `logRetentionDays`, resolved from
  per-Function `synthesis` then config.
- Lambda `Properties` gain `MemorySize`, `Timeout`, `Architectures: [architecture]`, and
  `LoggingConfig: { LogGroup: { Ref: <log group logical id> } }`.
- For each Function, synthesize `AWS::Logs::LogGroup` with logical id `<FunctionLogicalId>LogGroup`,
  `LogGroupName: /aws/lambda/<deployedName>`, `RetentionInDays`.
- An HTTP-routed Function with `timeout > 30` gets a model warning surfaced by `voke synth`
  (API Gateway HTTP API integrations time out at 30 s). Implement as a non-fatal `warnings: string[]`
  returned next to the template only if a clean place exists; otherwise validate as an error with
  the explanation. Prefer the error if warnings need new plumbing.

### Step 3: SQS visibility timeout follows the Function timeout

- `sqsQueue(options?: { visibilityTimeoutSeconds?: number })` sets `VisibilityTimeout` when given.
- When a queue is attached to a Function through `sqs({ queue })` and has no explicit visibility
  timeout, synthesize `VisibilityTimeout: 6 * functionTimeout` (AWS guidance).
- An explicit visibility timeout lower than the attached Function's timeout is a
  `VokeModelError.validation` issue at path `resources.<queue>.properties.VisibilityTimeout`, with
  both numbers in the message.

### Step 4: CORS in both places

- CloudFormation: when `api.cors` is set, add `CorsConfiguration` to the `Api` resource
  (`AllowOrigins`, `AllowMethods`, `AllowHeaders`, `AllowCredentials`, `MaxAge`).
- Local Gateway: in `createApiApp`, when the config has CORS, register `cors(...)` from
  `hono/cors` with the same values before user middleware, so `gateway.request(...)` with an
  `OPTIONS` preflight and an `Origin` header behaves like the deployed API.

### Step 5: Do not leak unhandled error messages

In `handleRouteError` (`app.ts:108-129`):

- `InvokeError` handling for `INVALID_PAYLOAD` (400) and `INVALID_RESULT` (500) stays.
- Any other error: log once with `console.error` as a single JSON line
  (`{ level: "error", message, name, stack, code? }`), and respond
  `error("Internal server error", { code: "INTERNAL_SERVER_ERROR", status: 500 })`.
- In dev mode only (`VOKE_DEV_SUMMARY === "1"` or stage `local`, read through `runtime-env.ts`),
  include the original message in `details` so local debugging stays easy.
- `handleRouteError` needs the stage: build the handler inside `createApiApp` where `config` is
  in scope instead of the module-level function.

Update `docs/error-conventions.md` with a short "HTTP error responses" section describing the
three cases, and adjust tests that asserted a leaked message.

### Step 6: Docs and example

- `apps/docs/content/docs/reference/config.mdx`: document `runtime.*`, `synthesis.memory`,
  `synthesis.timeout`, `api.cors`, `sqsQueue({ visibilityTimeoutSeconds })`, with the defaults table.
- `README.md`: one short "Defaults" paragraph and a CORS example.
- `examples/hello-api/voke.config.ts`: add `api: { cors: true }` or one `runtime` setting so an
  example exercises the new surface.

## Test plan

- `test/cloudformation.test.ts`: defaults present on every Function; per-Function overrides;
  log group resource and `LoggingConfig` reference; `Architectures`; CORS block present only when
  configured; SQS `VisibilityTimeout` derived, explicit, and too-low error.
- `test/model.test.ts`: resolution order (Function → config → default).
- `test/error-design.test.ts`: validation messages for out-of-range memory, timeout, invalid
  retention, credentials with wildcard origin.
- `test/config-typecheck.ts`: `runtime.architecture` rejects other strings at type level.
- `test/api.test.ts` or `test/route-builder.test.ts`: a route that throws `new Error("db password=hunter2")`
  returns 500 with message `Internal server error`, code `INTERNAL_SERVER_ERROR`, and the body
  does not contain `hunter2` when the stage is not `local`; in dev mode `details` carries the
  message. Capture `console.error` with a spy and assert one JSON line was logged.
- CORS parity: `gateway.request("/health", { method: "OPTIONS", headers: { Origin, "Access-Control-Request-Method": "GET" } })`
  returns the allow headers when configured and none when not.
- Structural pattern: existing fixture-style assertions in `packages/core/test/cloudformation.test.ts`.

## Done criteria

- [ ] `cd examples/hello-api && bun ../../packages/core/src/cli.ts synth` → the Lambda has `MemorySize: 1024`, `Timeout: 15`, `Architectures: ["arm64"]`, and a matching `AWS::Logs::LogGroup` with `RetentionInDays: 14`
- [ ] A thrown plain `Error` in a route never appears in a non-local response body (test asserts it)
- [ ] CORS preflight behaves the same through `gateway.request(...)` as the synthesized `CorsConfiguration` declares
- [ ] `cd packages/core && bun test` → 0 fail; `bun run typecheck` exits 0; `bun run check` exits 0
- [ ] Config reference documents every new option with its default
- [ ] No files outside the in-scope list are modified

## STOP conditions

- An existing test or example relies on thrown error messages reaching HTTP clients as a
  documented contract (not just an incidental assertion). Report it; the owner decides.
- `LoggingConfig` with an explicit log group conflicts with the emulator path
  (`voke local bootstrap` on Floci rejects the template). Report the emulator error; do not drop
  log retention silently.
- Plan 003 has not landed and its edits to `model.ts`/`cloudformation.ts` would conflict.

## Maintenance notes

- New Function kinds must receive the same four settings; assert it in the template tests.
- If a stack was deployed before this plan and its Functions already ran, the explicit log group
  would collide with the auto-created one. No such stacks can exist today (deploy did not work),
  but note it in the release notes.
- Deferred: friendlier top-level `timeout`/`memory` options on `fn`/`http`/`sqs`, security
  headers, structured logging, DLQs.
- Reviewers should scrutinize the dev-mode check in the error handler (it must not be true in a
  deployed stage) and the CORS credentials validation.
