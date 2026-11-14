# Plan 003: Every Function declared in the entrypoint is synthesized and gets a working Lambda handler

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare `git diff --stat a7741eb -- packages/core/src packages/core/test packages/core/package.json examples docs`
> and `git status --short` with the recorded current state. Reconcile routine drift;
> pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH (removes the single-function mode and the config-first registry; many template tests change)
- **Depends on**: `.factory/plans/002-node-lambda-runtime-portability.md`
- **Category**: bug
- **Planned at**: commit `a7741eb`, 2026-11-14

## Why this matters

Voke's promise is "declare Functions in code, get the AWS wiring for free". Today
`voke synth` never looks at the code: it reads only `voke.config.ts`, so routes, SQS Event
Sources, and authorizers declared in `src/index.ts` do not reach the CloudFormation template.
When Functions are passed through config, the template points each Lambda at a handler file
that no build step produces, and two Function kinds have no deployed adapter at all. This plan
makes the entrypoint the source of truth for synthesis and generates one Lambda entry module
with a real handler for every Function.

## Current state

Vocabulary to use (from `CONTEXT.md`/`README.md`): **Function**, **Function Registry**
(`createFunctions({...})`), **Gateway** (`voke(functions)`), **Route Builder**, **SQS Event
Source Function**, **Request Authorizer Function**, **Voke Project**. In `fn`, `http`, `sqs`,
"name" means the optional deployed Lambda name; the registry key is the stable identity.

Facts (verified by reading source and by running `voke synth` on `examples/hello-api` in a scratch copy):

- `packages/core/src/cli.ts:759-769` — `voke synth` builds its input from `loadConfigFromFlags`
  only. `synth()` (`cli.ts:505-533`) calls `synthesizeCloudFormation({...config})`. Nothing imports
  the project entrypoint.
- `examples/hello-api/src/index.ts` declares six routes in a Function Registry and passes it to
  `voke(functions, { config })`. Its `voke.config.ts` has no `functions`. Synth output therefore
  contains one Lambda and one `$default` route: the "legacy" branch at
  `packages/core/src/model.ts:549-575`.
- Product principle in `roadmap-v2.md`: "Do not move Function composition into `voke.config.ts`."
  So config-only synthesis cannot be the answer.
- The Gateway already carries what synthesis needs. `packages/core/src/app.ts:236-259`:
  ```ts
  const config = defineConfig({ ...configInput, functions });
  ...
  return { app, config, fetch, functions, handler, name: config.name, request };
  ```
- When Functions do reach the model, each gets a handler string that matches no built file.
  `packages/core/src/model.ts:198-205`:
  ```ts
  definition.synthesis?.handler ??
    (definition.synthesis?.entrypoint === undefined
      ? `${name}.handler`
      : createHandlerNameFromEntrypoint(definition.synthesis.entrypoint));
  ```
  `voke build` only builds `config.build.entrypoints` (default `./src/index.ts` → `dist/index.js`),
  so `processOrder.handler` refers to a `processOrder.js` that does not exist.
- The Gateway module has no named `handler` export. `import("./dist/index.js")` exposes only
  `default`; Lambda's `index.handler` would not resolve. (`default.handler` exists.)
- Deployed adapters that exist: HTTP (`createAwsLambdaHandler`, `packages/core/src/aws-lambda.ts:18`,
  wrapping `hono/aws-lambda`) and SQS (`createSqsEventHandler`, `packages/core/src/invoke.ts:1762-1770`).
- Deployed adapters that do not exist:
  - **Invokable Functions** (`fn(...)`, `kind: "invokable"`): nothing receives a direct Lambda
    Invoke payload and runs the Function. The client side exists
    (`packages/core/src/aws-lambda-invoke-transport.ts`).
  - **Request Authorizer Functions** (`requestAuthorizer(...)`, `kind: "authorizer"`,
    `packages/core/src/authorizers.ts:137-150`): the template wires an API Gateway Lambda authorizer
    with `AuthorizerPayloadFormatVersion: "2.0"` and `EnableSimpleResponses: true`
    (`packages/core/src/cloudformation.ts:429-443`), but no code converts that event into an
    `AuthorizerRequest` (`authorizers.ts:32-36`: `{ headers: Headers; raw: Request; request: Request }`)
    or returns `{ isAuthorized, context }`.
- Local authorizer execution lives in `packages/core/src/invoke.ts` around lines 1343-1410: it runs
  the Request Authorizer Function in-process, returns 401 JSON (`jsonError("Unauthorized", { code: "UNAUTHORIZED", status: 401 })`)
  or a `RouteAuthContext` (`invoke.ts:254`). In a deployed Lambda, API Gateway has already run the
  authorizer and passes its result in `event.requestContext.authorizer` (`.lambda` for Lambda
  authorizers, `.jwt.claims` for JWT). `hono/aws-lambda` exposes the raw event on `c.env.event`.
- Registry key filters are inconsistent: `config.ts:109` and `build.ts:39` skip only the `invoke`
  key; `model.ts:456-458` skips `invoke` and `route`. The registry object returned by
  `createFunctions` also has `sendEvent`.
- `packages/core/package.json` `exports` has no `./lambda` subpath. `docs/stable-public-surface.md`
  requires new exports to be deliberate and covered by `test/public-surface.test.ts`.
- Explicit per-Function overrides exist and must keep working: `FunctionSynthesisConfig`
  (`invoke.ts:80-85`: `entrypoint`, `environment`, `handler`, `runtime`), read in `model.ts:509-522`,
  `config.ts:106-121`, `build.ts:38-51`.
- ADR `docs/adr/0007-opinionated-framework.md` (decided 2026-11-14) governs this plan: "The
  project entrypoint is the only place Functions are declared. `voke.config.ts` holds project
  metadata and infrastructure resources... it does not accept a Function Registry." and "A project
  whose entrypoint exports neither a Gateway nor a Function Registry is a configuration error, not
  a legacy mode." It removes "the config-first Function Registry, the single-function `$default`
  mode and its `api.function`, `api.routes`, and `handler` settings" without deprecation aliases.
- Config surface affected by that ADR today: `functions` in `VokeConfigInput`/`VokeConfig`
  (`packages/core/src/config.ts:25,81`); `VokeApiConfig` with `name`, `protocol`, `function`,
  `routes` (`config.ts:31-36`, defaults at `:90-95`); top-level `handler` and
  `cloudFormation.handler` (`config.ts:46,85,133-136`). Tests pass `functions` to
  `createInternalModel`/`synthesizeCloudFormation`/`createBuildPlan` in `test/model.test.ts`,
  `test/cloudformation.test.ts`, `test/api.test.ts`, and `test/build.test.ts`. No example config,
  README snippet, or docs snippet puts `functions` in `voke.config.ts`; only the config reference
  table lists it.
- ADR `docs/adr/0003-sqs-event-sources.md` and `CONTEXT.md` say Voke owns the deployed SQS adapter
  ("Voke owns the deployed SQS Lambda adapter rather than requiring users to write AWS event glue")
  and that SQS Event Source Functions do not mix with HTTP routes or invokable output contracts in v1.

## Commands you will need

| Purpose            | Command                                                                                             | Expected on success                    |
| ------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Install            | `bun install`                                                                                       | exit 0                                 |
| Core tests         | `cd packages/core && bun test`                                                                      | all pass                               |
| One test file      | `cd packages/core && bun test test/lambda.test.ts`                                                  | all pass                               |
| Core typecheck     | `cd packages/core && bun run typecheck`                                                             | exit 0                                 |
| Repo gates         | `bun run typecheck && bun run test`                                                                 | exit 0                                 |
| Lint/format        | `bun run check`                                                                                     | exit 0                                 |
| Manual synth check | `cd examples/hello-api && bun ../../packages/core/src/cli.ts synth && cat dist/cloudformation.json` | template lists the six declared routes |

## Implementation rules relevant to this plan

- Test first for each unit: adapter tests before adapters, model tests before model changes.
- Local and deployed paths must share parsing, validation, and auth logic (roadmap principle:
  "Make local tests exercise the same normalization, validation, auth, and adapter paths as
  deployed runtime"). Adapters translate AWS event shapes and then call the existing registry
  methods (`functions.invoke`, `functions.sendEvent`, the Gateway app). Do not re-implement
  contract parsing in adapters.
- Runtime code must not use the `Bun` global (plan 002); use `runtime-env.ts`.
- No new dependencies.
- Errors for user-fixable problems are `VokeError` subclasses with path and next step
  (`docs/error-conventions.md`), e.g. `VokeConfigError.validation([{ message, path }])`.
- Root `voke` exports stay unchanged. The new surface is one subpath, `voke/lambda`.
- Generated files carry a header comment `// Generated by voke build. Do not edit.` and live under
  `.voke/` (already git-ignored by convention for local artifacts; add `.voke` to scaffolded
  `.gitignore` in plan 006, not here).

## Scope

**In scope**:

- `packages/core/src/lambda.ts` (create), `packages/core/src/project.ts` (create)
- `packages/core/src/model.ts`, `config.ts`, `build.ts`, `cloudformation.ts`, `app.ts` (registry no longer embedded in config), `cli.ts` (`synth`, `build`, their command handlers), `invoke.ts` (auth context from the AWS event; a shared registry-entries helper)
- `packages/core/src/serverless-migration.ts` (generated config and entrypoint templates only), `packages/core/test/serverless-migration.test.ts`, `examples/serverless-migration/**`, `docs/serverless-framework-migration.md`
- `packages/core/package.json` (`exports["./lambda"]`)
- `packages/core/test/lambda.test.ts` (create), `packages/core/test/project.test.ts` (create), updates to `model.test.ts`, `cloudformation.test.ts`, `build.test.ts`, `api.test.ts`, `local.test.ts`, `dev.test.ts`, `error-design.test.ts`, `config-typecheck.ts`, `model-typecheck.ts`, `cli-contract.test.ts`, `public-surface.test.ts`, `node-runtime.test.ts`
- `examples/sqs-events/src/functions.ts`, `examples/hello-api` (only if a hand-written handler export becomes redundant)
- `README.md` (SQS section and quickstart handler sentence), `docs/stable-public-surface.md`, `apps/docs/content/docs/guides/functions.mdx`, `apps/docs/content/docs/reference/config.mdx`
- `.factory/plans/README.md` (status only)

**Out of scope**:

- Zip packaging, S3 upload, CloudFormation calls (plan 004).
- Per-Function bundles and per-Function IAM roles (roadmap v2 phases 5 and 6). One shared bundle
  with one named export per Function is the target here.
- Cross-Lambda `functions.invoke` over the AWS transport (deployed-name resolution, IAM grant).
  Deployed code keeps the default in-process invoke. See the plans index, deferred findings.
- New Event Sources.

## Git workflow

- Branch: `feature/registry-discovery-lambda-entries`
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: One helper for registry entries

Add to `invoke.ts` (or a small `registry.ts`) a function that returns the Function definitions of
a registry, excluding the registry's own methods:

```ts
export const functionRegistryEntries = (
  registry: FunctionRegistry | FunctionRegistryInput
): [string, AnyFunctionDefinition][]
```

Decide membership by shape (a definition object with a `kind`), not by a list of method names.
Use it in `model.ts:456-458`, `config.ts:108-112`, and `build.ts:38-51`.

### Step 2: Lambda adapters (`voke/lambda`)

Create `packages/core/src/lambda.ts` exporting:

```ts
export interface LambdaProjectModule {
  default?: unknown;   // a Gateway from voke(functions)
  functions?: unknown; // a Function Registry from createFunctions(...)
}

export type LambdaHandler = (event: unknown, context?: unknown) => Promise<unknown>;

export const createLambdaHandlers = (
  project: LambdaProjectModule
): Record<string, LambdaHandler>;
```

Resolution: if `project.default` is a Gateway (has `functions`, `handler`, `config`), use its
registry and its HTTP handler. Otherwise use `project.functions`. If neither exists, throw
`VokeConfigError` saying the entrypoint must `export default voke(functions)` or
`export const functions = createFunctions(...)`.

One handler per registry key, chosen by `definition.kind`:

- `route` → the Gateway's HTTP handler (`gateway.handler`). A route-backed Function without a
  Gateway default export is a config error with that explanation.
- `event` (SQS) → `createSqsEventHandler({ function: key, functions })`.
- `invokable` → direct-invoke adapter: the Lambda event is the payload; call
  `functions.invoke(key, event, { runtime: "local" })` and return the result. Let `InvokeError`
  propagate so Lambda reports a function error. If the Function also has routes, dispatch by
  event shape: an HTTP API v2 event (`event.version === "2.0"` and `event.requestContext.http`
  present) goes to the Gateway handler, anything else to direct invoke.
- `authorizer` → Request Authorizer adapter: build a `Request` from the API Gateway HTTP API
  Lambda authorizer event (payload format 2.0: `headers`, `rawPath`, `rawQueryString`,
  `requestContext.http.method`, `requestContext.domainName`, `cookies`), call the Function's
  handler with `{ headers, raw, request }`, validate `context` with the Function's `context`
  schema when present, and return `{ isAuthorized: result.authorized, context: result.context ?? {} }`.
  A thrown handler error returns `{ isAuthorized: false }` and logs with `console.error`.
  Reuse the local authorizer code path in `invoke.ts` (~1343-1410) by extracting the shared part
  rather than copying it.

Add `"./lambda": "./src/lambda.ts"` to `packages/core/package.json` exports, list `voke/lambda`
under "Specialized Subpaths" in `docs/stable-public-surface.md`, and extend
`test/public-surface.test.ts`.

### Step 3: Deployed routes trust API Gateway's authorizer result

In the route auth path in `invoke.ts`, before running an authorizer in-process, check whether the
request came through Lambda with an authorizer result: `c.env?.event?.requestContext?.authorizer`.

- `authorizer.lambda` present → `RouteAuthContext` with that object as `context`.
- `authorizer.jwt` present → `RouteAuthContext` with `jwt.claims` as `context` (keep the existing
  local shape for JWT context; read the current local JWT handling and match its field names).
- Absent → current local behavior, unchanged.

This avoids running the Request Authorizer Function twice per request in AWS and gives JWT routes
real validated claims.

### Step 4: Project loader for the CLI

Create `packages/core/src/project.ts` (CLI-time; may use Bun APIs):

```ts
export interface LoadedProject {
  config: VokeConfig;
  registry: FunctionRegistry | FunctionRegistryInput;
}

export const loadProject = async (options: {
  config: VokeConfig;
  entrypoint?: string;
  cwd?: string;
}): Promise<LoadedProject>;
```

The entrypoint is the only source of Functions (ADR 0007). Import it (absolute `file://` URL):

- a Gateway default export, or a `functions` export, gives the registry;
- anything else is a `VokeConfigError`:
  `<entrypoint> must export a Gateway (export default voke(functions)) or a Function Registry (export const functions = createFunctions({ ... })).`

Set `process.env.VOKE_SYNTH = "1"` during the import and restore it after, so user code can guard
side effects. If the import throws, wrap in `VokeConfigError` naming the entrypoint and including
the original message, with the hint "Voke imports your entrypoint to discover Functions; guard
side effects with `process.env.VOKE_SYNTH`."

### Step 5: Remove the config-first registry and the single-function mode

ADR 0007 removes both instead of preserving them. Nothing is published, so there are no aliases
and no deprecation period.

- `voke.config.ts` no longer accepts a Function Registry. Remove `functions` from
  `VokeConfigInput` and `VokeConfig` (`config.ts:25,81`). `defineConfig` given a `functions` key
  throws `VokeConfigError.validation` at path `functions`:
  `Functions are declared in the project entrypoint, not in voke.config.ts`.
- The programmatic APIs take the registry as an explicit input next to the config:
  `synthesizeCloudFormation`, `createInternalModel`, and `createBuildPlan` keep accepting
  `functions` in their own option types (`SynthesizeCloudFormationOptions` already is
  `VokeConfigInput & {...}`, `cloudformation.ts:54-59`). They split it off before calling
  `defineConfig`. This keeps the many tests that pass `functions` to these functions valid.
- `voke(functions, { config })` keeps returning `functions` and `config` on the Gateway
  (`app.ts:52-63`); `config` no longer embeds the registry. Remove the
  "Pass functions either top-level or in config.functions, not both" branch (`app.ts:166-173`).
- Delete the single-function `$default` branch in `model.ts:549-575` and what only it used:
  `api.function`, `api.routes`, and `api.protocol` in `VokeApiConfig` (`config.ts:31-36,90-95`,
  leaving `api.name`), the top-level `handler` and `cloudFormation.handler` settings
  (`config.ts:46,85,133-136`), and the main-entrypoint handler mapping in `build.ts:57-62`.
  `createHandlerNameFromEntrypoint` stays for Functions with an explicit `synthesis.entrypoint`.
- A model with no Functions synthesizes only the declared resources and their outputs: no role,
  no Lambda, no API. (`voke dev` and local bootstrap synthesize from config alone; they keep
  working and get a smaller template.)
- The Serverless Framework migrator is the one first-party place that still teaches the
  config-first registry. `packages/core/src/serverless-migration.ts:2116-2141` generates a
  `voke.config.ts` that imports `functions` from `./src/functions` and passes it to
  `defineConfig` when the service has worker Functions. Change the generated project so the
  entrypoint owns the registry: the generated `src/index.ts` (`createIndexTemplate`,
  `serverless-migration.ts:2147+`) builds one `createFunctions({...})` containing the route-backed
  Functions and the worker Functions and exports `voke(functions, { config })`; a service with
  only workers exports `functions` from the entrypoint. The generated config contains no
  `functions`. Per-Function `synthesis` blocks in generated Functions
  (`serverless-migration.ts:2029-2030`) are dropped where the generated Lambda entry covers them.
  Update `test/serverless-migration.test.ts` and the fixtures under `examples/serverless-migration/`,
  and keep the "generated code typechecks" style of assertion.
- Tests that asserted the single-function template for a bare config are rewritten: pass a small
  registry when the test is about Lambda/API output, or assert the resources-only template when
  it is about resources and bindings. Do not delete an assertion about behavior that still exists.

### Step 6: Generated Lambda entry and handler names

In `build.ts`:

- Compute a handler export name per registry key: keep keys that are valid identifiers; otherwise
  convert to camelCase and prefix `fn_` if the result starts with a digit. Detect collisions and
  reserved words and fail with a `VokeConfigError` naming both keys.
- Add to the `BuildPlan` a generated file `.voke/build/index.ts`:

  ```ts
  // Generated by voke build. Do not edit.
  import * as project from "<relative path to entrypoint>";
  import { createLambdaHandlers } from "voke/lambda";

  const handlers = createLambdaHandlers(project);

  export const http = handlers["http"];
  export const processOrder = handlers["processOrder"];
  ```

- Build that file as the entrypoint so the output is `<outdir>/index.js`. Functions with an
  explicit `synthesis.entrypoint` keep their own build entry and handler, as today.
- Add `manifest: { functions: Record<string, { handler: string; file: string }> }` to `BuildPlan`
  and write it to `<outdir>/voke-manifest.json` (plan 004 reads it).

In `model.ts` `toFunctionHandler`: a Function without `synthesis.handler`/`synthesis.entrypoint`
gets `index.<exportName>` (same naming function as the build).

### Step 7: Correct HTTP API route synthesis

Verified by synthesizing the `examples/hello-api` Gateway config in a scratch copy
(`synthesizeCloudFormation(gateway.config)`):

```
Route               => GET /
HttpGETUsersIdRoute => GET /users/:id
integrations: 6 (one per route, all pointing at the same Lambda)
```

Three defects in `packages/core/src/model.ts:207-209` and `packages/core/src/cloudformation.ts:557-575`:

1. Route keys keep the Route Builder's `:param` syntax. API Gateway HTTP APIs need `{param}`
   (`GET /users/{id}`); with `:id` the gateway treats the segment as a literal and real requests
   never match. Convert `:name` segments to `{name}` when building the API Gateway route key in
   the CloudFormation layer. Keep `VokeModelFunction.routes` and Function metadata in the Route
   Builder syntax if other code reads them (the dev summary and contract metadata do); convert at
   the point where `RouteKey` is written. A Hono wildcard segment (`*`) maps to `{proxy+}`.
2. Logical ids depend on route order: the first route is `Route`/`Integration`, the rest are
   derived from function and route. Reordering routes in code would rename resources. Derive
   every route's logical id from function + method + path.
3. One `AWS::ApiGatewayV2::Integration` is created per route. Create one integration per
   Function and point every route of that Function at it.

Keep `Api`, `Stage`, `Function`, `FunctionRole`, and `Permission` logical ids as they are.
Update `test/cloudformation.test.ts` and `test/api.test.ts` expectations.

### Step 8: Wire `voke synth` and `voke build`

In `cli.ts`, the `synth` and `build` command handlers call `loadProject` after
`loadConfigFromFlags` and pass the config and the registry on. `voke dev` is unchanged.

### Step 9: Examples and docs

- `apps/docs/content/docs/reference/config.mdx`: remove the `functions` row from the core fields
  table and any mention of `handler`, `api.function`, or `api.routes`.

- `examples/sqs-events/src/functions.ts`: remove the hand-written
  `export const handler = createSqsEventHandler(...)` if the generated entry replaces it; keep
  `createSqsEventHandler` exported from `voke/invoke` (it is public).
- `README.md`: in "SQS Event Sources", show that exporting `functions` is enough and that Voke
  generates the Lambda handler; keep a short note on `createSqsEventHandler` for custom wiring.
  Fix the quickstart sentence about `handler`.
- `apps/docs/content/docs/guides/functions.mdx`: add a section "How Functions become Lambda
  handlers" (entrypoint discovery, `VOKE_SYNTH`, generated `.voke/build/index.ts`, handler names).

## Test plan

- `test/lambda.test.ts` (new), using a registry with one Function of each kind:
  - HTTP v2 event → 200 with the route's JSON; unknown route → 404 JSON error.
  - SQS event with one valid and one invalid body → `batchItemFailures` contains only the invalid
    message id (same expectation style as existing SQS tests in `test/invoke.test.ts`).
  - Direct invoke payload → parsed by the input contract; invalid payload rejects with
    `InvokeError` code `INVALID_PAYLOAD`.
  - Authorizer event → `{ isAuthorized: true, context }`; handler returning `authorized: false`
    → `{ isAuthorized: false }`; throwing handler → `{ isAuthorized: false }`.
  - Module with neither a Gateway nor `functions` → `VokeConfigError`.
- Route auth from the AWS event: an HTTP v2 event carrying `requestContext.authorizer.lambda`
  reaches the route handler with that context and the local authorizer handler is not called
  (assert with a counter).
- `test/project.test.ts` (new): discovery from a Gateway default export, from a `functions`
  export, the error for an entrypoint that exports neither, import error wrapping, `VOKE_SYNTH` set
  during import and restored after. Use temporary fixture files, modeled after the file-writing
  tests in `test/public-api-redesign.test.ts`.
- `test/model.test.ts` / `test/cloudformation.test.ts`: handler strings `index.<exportName>`;
  key-to-export-name conversion and collision error.
- `test/error-design.test.ts`: `defineConfig({ name, functions })` is rejected at path `functions`;
  removed settings (`handler`, `api.routes`) are TypeScript errors in `test/config-typecheck.ts`.
- `test/cloudformation.test.ts`: a config with resources and no Functions yields only those
  resources and outputs (no `FunctionRole`, `Function`, or `Api`).
- `test/cloudformation.test.ts`: `/users/:id` → `GET /users/{id}`; wildcard → `{proxy+}`; one
  integration per Function; logical ids independent of route order.
- `test/build.test.ts`: generated entry content, manifest, explicit `synthesis.entrypoint` unchanged.
- `test/node-runtime.test.ts` (from plan 002): extend the fixture to build through the generated
  entry and call the `http` and SQS exports under Node.

## Done criteria

- [ ] `cd examples/hello-api && bun ../../packages/core/src/cli.ts synth` produces a template whose `AWS::ApiGatewayV2::Route` resources carry the six declared route keys (`GET /`, `GET /health`, `GET /typed`, `GET /users`, `GET /users/{id}`, `POST /users`), exactly one `AWS::ApiGatewayV2::Integration`, and a Lambda `Handler` of `index.http`
- [ ] `grep -c '/:' examples/hello-api/dist/cloudformation.json` → 0 (no `:param` route keys)
- [ ] Reordering two routes in a test registry leaves all route logical ids unchanged
- [ ] `cd examples/sqs-events && bun ../../packages/core/src/cli.ts synth --name sqs-events` fails with a clear model error if `ordersQueue` is not declared, and with an `sqsQueue()` resource declared produces an `AWS::Lambda::EventSourceMapping` and `Handler: index.processOrder`
- [ ] `grep -nE "legacyApiRoutes|api\.function|api\.routes|cloudFormation\.handler" packages/core/src/*.ts` returns no matches outside `serverless-migration.ts`
- [ ] A `voke.config.ts` generated by `voke migrate serverless` for a service with worker Functions contains no `functions` key, and its generated project typechecks
- [ ] `defineConfig({ name: "x", functions: {} })` throws a `VokeConfigError` at path `functions`; a config with resources and no Functions synthesizes no `AWS::Lambda::Function`
- [ ] An entrypoint that exports neither a Gateway nor `functions` makes `voke synth` exit non-zero with the message from step 4
- [ ] `voke build` writes `dist/index.js` exporting one function per registry key and `dist/voke-manifest.json`
- [ ] Node-load test calls generated `http` and SQS handlers successfully
- [ ] `cd packages/core && bun test` → 0 fail; `bun run typecheck` exits 0; `bun run check` exits 0
- [ ] `docs/stable-public-surface.md` lists `voke/lambda`; `test/public-surface.test.ts` covers it
- [ ] No files outside the in-scope list are modified

## STOP conditions

- A Route Builder path form exists that has no API Gateway route-key equivalent (for example a
  regex-constrained or optional parameter). Fail synthesis with a `VokeModelError` naming the
  route, and report which forms are affected.
- Extracting the shared authorizer logic from `invoke.ts` would change the observable local
  behavior of `gateway.request(...)` or `functions.route(...)`.
- Importing the entrypoint at synth time is unworkable for a first-party example (for instance a
  top-level side effect that cannot be guarded). Report the example and the failure.
- A Function kind exists in `AnyFunctionDefinition` that this plan does not list.
- Something outside tests and the migrator depends on `config.functions`, `api.routes`, or the
  single-function template in a way this plan does not list (for example `voke/testing` helpers
  or `remote.ts`). Report the dependency before removing the setting.
- A migrated Serverless service cannot be expressed with one entrypoint-owned registry (for
  example Functions that need separate entrypoints for packaging reasons). Keep per-Function
  `synthesis.entrypoint` for those cases and report them; do not reintroduce `functions` in config.

## Maintenance notes

- Every new Function kind or Event Source must add a branch in `createLambdaHandlers` and a case
  in `test/lambda.test.ts`; the model and the adapter should be added in the same change.
- One shared bundle means every Lambda loads all Function code. That is acceptable at this size;
  per-Function bundles are roadmap v2 phase 6.
- Reviewers should scrutinize: handler export-name stability (renaming a registry key renames
  the Lambda handler), the authorizer context trust check (only trust `requestContext.authorizer`
  when the event comes through the Lambda adapter), and synth-time import side effects.
