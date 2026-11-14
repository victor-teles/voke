# Plan 003: Every Function declared in the entrypoint is synthesized and gets a working Lambda handler

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Plan 009 runs first and changes many of the files below. Compare
> `git diff --stat 3435023 -- packages/core/src packages/core/test packages/aws packages/build packages/testing examples README.md docs apps/docs/content/docs`
> and `git status --short` with the state recorded here. Expected drift from 009 is described under
> "State after plan 009". Line numbers below are at `3435023`; re-locate symbols by name. Pause if drift
> invalidates scope, a protected contract, or a decision listed here.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH (removes the config-first registry, the single-function mode and `voke()`'s `provider` option; changes CLI `synth`/`build`, the Provider contract, and many template tests)
- **Depends on**: `.factory/plans/009-finish-aws-package-split.md` (AWS code lives only in `@voke/aws`), `.factory/plans/002-node-lambda-runtime-portability.md` (DONE)
- **Category**: bug
- **Planned at**: commit `3435023`, 2026-11-14

## Why this matters

Voke's promise is "declare Functions in code, get the AWS wiring for free". Today `voke synth` never
imports the project entrypoint. It builds the model from `voke.config.ts` alone, so routes, SQS Event
Sources and authorizers declared in `src/index.ts` never reach the template. No example config sets a
Provider, so `voke synth` fails outright for every example. When Functions do reach the model, each Lambda
points at a handler file that no build produces. Invokable and Request Authorizer Functions have no
deployed adapter. Route keys keep `:param` syntax, which API Gateway treats as literal text. This plan
makes the entrypoint the source of truth for synthesis, generates one Lambda entry with a real handler per
Function through the AWS Provider, and removes the config-first and single-function modes, as ADR
`docs/adr/0007-opinionated-framework.md` requires.

## Current state

### Binding decisions

- ADR `docs/adr/0007-opinionated-framework.md`:
  - "The project entrypoint is the only place Functions are declared. `voke.config.ts` holds project
    metadata and infrastructure resources and must use a default export; it does not accept a Function
    Registry."
  - "A project whose entrypoint exports neither a Gateway nor a Function Registry is a configuration error,
    not a legacy mode."
  - It removes "the config-first Function Registry, the single-function `$default` mode and its
    `api.function`, `api.routes`, and `handler` settings", with no deprecation aliases.
- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: core `voke` is provider-neutral, and
  `@voke/aws` owns AWS runtime adapters, SQS and authorizer entrypoints, and CloudFormation synthesis.
  Core src must not import `@voke/*`: the workspace cycle is rejected by turbo. Core tests reach the
  packages through `paths` in `packages/core/tsconfig.json`.
- **U2 (user decision)**: the Provider is set only in config (`provider: aws()`). Remove the `provider`
  option from `voke(functions, ...)`. The Gateway takes it from config. Fix the examples and the
  Serverless migrator so they set it.
- **Adopted defaults** (reversible; do not ask again):
  - `createLambdaHandlers` is exported from the `@voke/aws` index, with no new subpath.
  - The generated Lambda entry comes from the Provider `build.plan` capability, and the CLI calls it.
    `@voke/aws` implements it on top of the provider-neutral base plan in `@voke/build`. Handler export
    naming stays in core.
  - The deployed authorizer result is trusted through a provider runtime hook,
    `ProviderRuntimeCapability.routeAuth`. Core route auth stays provider-neutral. JWT results are trusted
    when deployed; local JWT enforcement is out of scope and tracked separately.
  - Deployed Function names are uniformly `${name}-${stage}-${key}`, replacing the `api.function` special
    case.
- **Plan decision D1 (reversible)**: once the Provider comes only from config, `voke()` can no longer infer
  a typed provider extension. Remove `ProviderRuntimeCapability.gateway` and the Gateway `handler`
  property. The HTTP Lambda handler comes from `createLambdaHandlers`. The only users of `gateway.handler`
  are tests: `packages/aws/test/provider.test.ts:25-39` and `packages/core/test/api.test.ts` (`api()`
  service handlers, which are not Gateway handlers).

### State after plan 009 (expected; verify)

- AWS synthesis exists only in `packages/aws/src/cloudformation-synthesis.ts`. It already has
  per-Function roles (`FunctionRole` for the "API Function", `<Name>FunctionRole` for the others).
  Resource builders live in `@voke/aws/cloudformation`, and Runtime Variable `secret`/`parameter` in
  `@voke/aws`.
- Core keeps, frozen until plan 010: `src/cloudformation.ts` (reduced), `src/aws-lambda.ts` and
  `src/api.ts`. Only compile-only edits to them are allowed here.
- Core `src/build.ts` still exists (009 D6). **This plan deletes it.**
- `ProviderRuntimeCapability` has `variables?` (009 D1). `createGateway` takes `provider` (009).
- Core `authorizers.ts` is types-only. Core `invoke.ts` has no SQS values. The root exports
  `RequestAuthorizerFunctionDefinition`, `InvokeContext`, `VokeModelError` and the related types.

### Facts at 3435023

- **CLI.**
  - `voke synth` (`packages/core/src/cli.ts:509-548`) does
    `defineConfig({...options.config, ...})`, then `config.provider?.synthesis?.synthesize`, then
    `synthesize({ config, model: createInternalModel(config) })`. It throws
    `CliUsageError("No provider configured for synthesis.")` when the config has no provider (`:526-532`).
    The command handler is at `:778-788`. Nothing imports the project entrypoint.
  - `voke build` (`:550-568`, handler `:721-730`) calls core `createBuildPlan` (`src/build.ts:30-92`),
    runs `plan.command`, then writes `plan.files`.
  - `loadConfigFromFlags` is at `:419-436`.
  - The scaffolded config already sets `provider: aws()` (`:330-344`).
- **Examples have no configured Provider.**
  - `examples/hello-api/voke.config.ts` has resources and `entrypoint: "./src/index.ts"`, but no `provider`.
  - `examples/hello-api/src/index.ts:86-90` passes `provider: aws()` to `voke()`.
  - `examples/e2e/src/index.ts:58-61` passes `config: { name: "e2e-api" }, provider: aws()`.
  - `examples/cross-function/src/index.ts:71-72` passes an inline config without a provider.
  - `examples/sqs-events` has no `voke.config.ts`. Its `package.json` build script is
    `voke build ./src/functions.ts`, and `src/functions.ts` exports `functions` plus a hand-written
    `handler = createSqsEventHandler({ function: "processOrder", functions })`, which
    `test/sqs-events.test.ts:3,26` uses.
  - `hello-api` declares six routes: `GET /`, `GET /health`, `GET /typed`, `GET /users`,
    `GET /users/:id`, `POST /users` (`src/index.ts:29-60`).
- **Gateway** (`packages/core/src/app.ts`).
  - `VokeOptions` (`:49-56`) has `config`, `middleware`, `provider` and `variables`.
  - `voke()` (`:250-282`) does `const { functions: _configuredFunctions, ...gatewayConfig } = configInput;`
    then `createGateway({ config: gatewayConfig, functions, ... })`. It continues with
    `const config = defineConfig({ ...configInput, functions });`
    `const provider = options.provider ?? config.provider;` and spreads
    `provider?.runtime?.gateway?.({ app, config })` into the result.
  - `createGateway` (`:169-215`) contains the "Pass functions either top-level or in config.functions,
    not both" branch (`:170-177`) and `functions: options.functions ?? options.config?.functions` (`:181`).
- **Config** (`packages/core/src/config.ts`).
  - `functions` appears in `VokeConfig` (`:30`) and `VokeConfigInput` (`:104`).
  - `VokeApiConfig { name; protocol: "http"; function; routes }` is at `:37-42`, defaults at `:114-119`
    (`function: "api"`, `routes: ["$default"]`).
  - `VokeCloudFormationConfig.handler` is at `:53`, and top-level `handler` at `:109`.
  - `defineCloudFormationConfig` handler fallback is at `:173-176`.
  - `defineBuildConfig` reads `input.functions` for `synthesis.entrypoint`s (`:148-152`), skipping only the
    key `invoke`.
- **Model** (`packages/core/src/model.ts`).
  - `toFunctionHandler` (`:168-175`) gives `` `${name}.handler` `` unless `synthesis.handler` or
    `synthesis.entrypoint` is set. That points at `processOrder.js`, which no build produces.
  - `toRouteKey` (`:177-179`) is `` `${route.method} ${route.path}` `` and keeps `:param`.
  - The registry filter at `:480-482` skips `invoke` and `route` but not `sendEvent`.
  - `generatedFunctionName` (`:484-487`) special-cases `config.api.function`.
  - The legacy `$default` branch spans `:568-597`, `hasHttpApi` is at `:608`, and `apis.http` uses
    `config.api.protocol` (`:623-631`).
  - `createInternalModel(input: VokeConfig | VokeConfigInput)` is at `:453`. It is exported as
    `createVokeModel`, which `@voke/aws` calls in `synthesizeCloudFormation` (`cloudformation-synthesis.ts:851-854`).
- **Build packages.**
  - `@voke/build` (`packages/build/src/index.ts`) is identical to core `build.ts` apart from imports. It
    reads `config.functions` (`:42`) and `config.cloudFormation.handler` (`:64`). Its only consumer is
    `packages/core/test/package-boundaries.test.ts`.
  - `ProviderBuildCapability.plan?: (input: { build; config }) => BuildPlan` (`provider.ts`) is never called.
- **Registry shape check.** `activateFunctionRegistry` already decides membership by shape
  (`invoke.ts:1017-1022`: an object with `kind` and `key`). `FunctionKind` is
  `"authorizer" | "event" | "invokable" | "route"` (`invoke.ts:268`). `fn()` can produce an `invokable`
  Function with routes (`invoke.ts:2074-2081`).
- **Invocation.** `invokeRegistryFunction` throws in the local runtime unless the registry is activated
  (`invoke.ts:1940-1956`). Only `voke()` / `createGateway` / `@voke/testing` activate a registry.
- **Local route auth.** `evaluateLocalAuthorizer` (`invoke.ts:1551-1655`) does the following:
  - checks the identity headers, giving a 401 `UNAUTHORIZED` when they are missing;
  - for a `kind: "lambda"` authorizer whose target is a registry key, runs the Request Authorizer Function
    with `{ headers, raw: request, request }` and an invoke context;
  - loads Runtime Variables;
  - treats a non-boolean `authorized` as a 500, and `authorized !== true` as a 403 `FORBIDDEN`;
  - validates `context` against `target.context`;
  - returns `RouteAuthContext { context; source: "lambda" }` (`:271-274`).

  JWT authorizers return `undefined`, so they are not enforced locally. In a deployed Lambda,
  `hono/aws-lambda` puts the raw event on `c.env.event`, and API Gateway passes its authorizer result in
  `event.requestContext.authorizer.lambda` (Lambda authorizers with simple responses) or
  `.jwt.claims` (JWT).

- **AWS synthesis** (`packages/aws/src/cloudformation-synthesis.ts`).
  - `apiFunctionName = apiRoutes[0]?.function ?? Object.keys(model.functions).at(0) ?? "api"`
    (`:694-695`) chooses which Function gets the bare `Function`/`FunctionRole`/`Permission` ids, so the
    ids depend on route order.
  - The route loop (`:597-615`) makes `Route`/`Integration` for index 0 and
    `<Function><Route>Route`/`Integration` for the rest: one Integration per route.
  - `RouteKey: apiRoute.route` (`:509`).
  - The Lambda authorizer resource (`:460-498`) uses `AuthorizerPayloadFormatVersion: "2.0"` and
    `EnableSimpleResponses: true`.
- **AWS adapters that exist.** HTTP: `createAwsLambdaHandler(app)` (`aws/src/lambda.ts:18-20`, wrapping
  `hono/aws-lambda`). SQS: `createSqsEventHandler({ function, functions })` (`aws/src/sqs.ts:369-375`).
  No adapter exists for invokable or authorizer Functions.
- **`aws()`** (`aws/src/index.ts:96-129`) has `local.devEnvironment`, `runtime.gateway` (the `handler`),
  `synthesis.synthesize` and `validate`.
- **Serverless migrator** (`packages/core/src/serverless-migration.ts`).
  - The generated `voke.config.ts` (`:2112-2145`) imports `functions` from `./src/functions` when the
    service has worker Functions, emits `functions,` into `defineConfig`, and has no `provider`.
  - `createIndexTemplate` (`:2147+`) imports `functions as workerFunctions`.
  - The generated Functions carry `synthesis` blocks (`:1979`, `:2028`).

## Commands you will need

| Purpose           | Command                                                             | Expected on success                                                    |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Install           | `bun install`                                                       | exit 0                                                                 |
| Core tests        | `cd packages/core && bun test`                                      | 0 fail                                                                 |
| AWS tests         | `cd packages/aws && bun test`                                       | 0 fail                                                                 |
| One file          | `cd packages/aws && bun test test/lambda-handlers.test.ts`          | 0 fail                                                                 |
| Typecheck         | `bun run typecheck`                                                 | exit 0                                                                 |
| All tests         | `bun run test`                                                      | exit 0                                                                 |
| Lint/format check | `bun run check`                                                     | exit 0                                                                 |
| Synth hello-api   | `cd examples/hello-api && bun ../../packages/core/src/cli.ts synth` | writes `dist/cloudformation.json`                                      |
| Build hello-api   | `cd examples/hello-api && bun ../../packages/core/src/cli.ts build` | writes `dist/index.js`, `dist/package.json`, `dist/voke-manifest.json` |

## Implementation rules relevant to this plan

- Test first for each unit: adapter tests before adapters, model tests before model changes.
- Local and deployed paths share parsing, validation and auth logic. Adapters translate AWS event shapes,
  then call registry methods (`functions.invoke`, `functions.sendEvent`) or the Gateway app. Do not
  re-implement contract parsing in adapters.
- Core stays provider-neutral. No AWS event shapes in core src; core src must not import `@voke/*`.
- Runtime code must not use the `Bun` global (plan 002). CLI-time code (`cli.ts`, the new `project.ts`)
  may use Bun APIs.
- No new third-party dependencies. `@voke/aws` gains the workspace dependency `"@voke/build": "workspace:*"`.
  That is not a cycle, because `@voke/build` depends only on `voke`.
- User-fixable errors are `VokeError` subclasses with a path and a next step (`docs/error-conventions.md`),
  for example `VokeConfigError.validation([{ message, path }])`.
- Generated files start with `// Generated by voke build. Do not edit.` and live under `.voke/`.
- Keep the root runtime values list (`packages/core/test/package-boundaries.test.ts`) deliberate. Every
  root addition below is listed, so update that test and `docs/stable-public-surface.md` with it.

## Scope

**In scope**:

- Core:
  - `packages/core/src/`: `app.ts`, `config.ts`, `model.ts`, `invoke.ts` (registry-entries helper, shared
    authorizer runner, `routeAuth` hook), `provider.ts`, `cli.ts` (`synth`, `build` and their handlers),
    `index.ts`, `project.ts` (create), `serverless-migration.ts` (generated config and entrypoint
    templates only)
  - Delete `packages/core/src/build.ts`. Compile-only edits to the retained `cloudformation.ts` are allowed.
  - `packages/core/test/**`: `model`, `api`, `build` (moves to `packages/build/test`), `node-runtime`,
    `cli-contract`, `error-design`, `config-typecheck`, `model-typecheck`, `local`, `dev`,
    `serverless-migration`, `package-boundaries`, `public-surface`, `project` (create)
- `@voke/aws`:
  - `packages/aws/src/`: `index.ts`, `lambda-handlers.ts` (create), `build.ts` (create),
    `cloudformation-synthesis.ts`
  - `packages/aws/test/**`, `packages/aws/package.json`
- `@voke/build`: `packages/build/src/index.ts`, `packages/build/test/**` (create), `packages/build/package.json`
  (drop `--pass-with-no-tests` once it has tests)
- Examples:
  - `examples/hello-api/{voke.config.ts,src/index.ts}`
  - `examples/sqs-events/{voke.config.ts (create),src/functions.ts,test/sqs-events.test.ts,package.json}`
  - `examples/e2e/src/index.ts`, `examples/cross-function/src/index.ts`
  - `examples/serverless-migration/**` fixtures
- Docs: `README.md` (quickstart, the SQS section, any `voke(functions, { provider })` snippet),
  `docs/stable-public-surface.md`, `docs/serverless-framework-migration.md`,
  `apps/docs/content/docs/reference/config.mdx`, `apps/docs/content/docs/guides/functions.mdx`

**Out of scope**:

- Zip packaging, S3 upload and CloudFormation API calls (plan 004). This plan's build output is what 004
  packages.
- Per-Function bundles and per-Function IAM scoping beyond what 009 delivered (roadmap phases 5 and 6).
- Cross-Lambda `functions.invoke` over the AWS transport. Deployed code keeps in-process invoke.
- Local JWT enforcement; new Event Sources; the `voke local` workflow and core `local.ts`/`e2e.ts`
  (plan 010).
- Moving `runtime.lambda` or any other AWS-only setting into `aws({...})` options (plan 005, decision U3).
- Other one-spelling cleanups (plan 008).

## Git workflow

- Branch: `feature/registry-discovery-lambda-entries`
- Commit only if authorized; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: One helper for registry entries (core)

Add to `invoke.ts`, and export from the root:

```ts
export const functionRegistryEntries = (
  registry: FunctionRegistry | FunctionRegistryInput
): [string, AnyFunctionDefinition][];
```

Decide membership by shape: an object whose `kind` is one of the four `FunctionKind` values and which has
a `key`. Reuse the check at `invoke.ts:1017-1022`. Use the helper in `model.ts` (replacing `:480-482`),
`config.ts:148-152`, `activateFunctionRegistry` and the dev summary loop. The registry methods `invoke`,
`route` and `sendEvent` are never entries.

### Step 2: Provider only in config (U2, D1)

- `app.ts`: remove `provider` and the `TProvider` generic from `VokeOptions` and `voke()`. `voke()` uses
  `defineConfig(configInput).provider` and passes it to `createGateway`. Remove `ProviderGatewayExtension`
  and the `runtime.gateway` spread.
- `provider.ts`: remove `ProviderRuntimeCapability.gateway` and the `TGatewayExtension` generic from
  `VokeProvider`. Fix the `aws()` signature in `aws/src/index.ts`.
- Examples:
  - `examples/hello-api/voke.config.ts` imports `aws` from `@voke/aws` and sets `provider: aws()`.
  - `examples/hello-api/src/index.ts` drops `provider: aws()` from `voke()`.
  - `examples/e2e/src/index.ts` moves `provider: aws()` into its inline `config`.
  - `examples/cross-function` gets `provider: aws()` in its inline config.
- `packages/aws/test/provider.test.ts` sets the provider in config. Replace its `gateway.handler`
  assertion with `createLambdaHandlers` (step 6) or `handleAwsLambdaRequest(gateway.app, ...)`.

### Step 3: Remove the config-first registry and the single-function mode

- `config.ts`:
  - Remove `functions` from `VokeConfig` and `VokeConfigInput`. `defineConfig` given a `functions` key
    throws `VokeConfigError.validation([{ path: "functions", message: "Functions are declared in the project entrypoint, not in voke.config.ts" }])`.
  - Remove `api.function`, `api.routes` and `api.protocol` (keep `api.name`), plus top-level `handler`
    and `cloudFormation.handler`. Make `defineConfig` reject `handler` (path `handler`), `api.function`
    and `api.routes` with the same style of message.
  - `defineBuildConfig` no longer reads Functions. The extra entrypoints come from the build plan
    (step 5).
- `createVokeModel` (`model.ts:453`) takes
  `input: (VokeConfig | VokeConfigInput) & { functions?: FunctionRegistry | FunctionRegistryInput }`. It
  splits `functions` off before calling `defineConfig`. Do the same for `@voke/aws`
  `synthesizeCloudFormation` and the build plan input. Existing tests that pass `functions` to these APIs
  then remain valid.
- `model.ts`:
  - Delete the legacy branch (`:568-597`) and its use in `hasHttpApi` and `apis.http.routes`. `apis.http`
    no longer has `protocol`.
  - `generatedFunctionName` becomes `` `${config.name}-${config.stage}-${key}` `` for every Function.
  - A model with no Functions has only resources and their outputs.
- `app.ts`: delete the "both" branch and the `options.config?.functions` fallback in `createGateway`.
  `voke()` keeps returning `functions` and `config`, and `config` no longer embeds the registry.
- The retained core `cloudformation.ts` (009 D5) and `aws/src/cloudformation-synthesis.ts` must not
  reference the removed settings. In `@voke/aws`, a model with no Functions emits no `FunctionRole`,
  `AWS::Lambda::Function` or `Api`.
- Rewrite the tests that asserted the single-function template for a bare config. Pass a small registry
  when the test is about Lambda or API output, or assert the resources-only template when it is about
  resources and bindings.

### Step 4: Handler export names (core, provider-neutral)

Add to core, and export from the root, `createHandlerExportName(key: string): string`:

- Keep keys that are valid JS identifiers and not reserved words.
- Otherwise convert to camelCase, and prefix `fn_` when the result starts with a digit.

Add `assertUniqueHandlerExportNames(keys)`, which throws `VokeConfigError` naming both colliding keys.
`model.ts` `toFunctionHandler` gives `index.<exportName>` when neither `synthesis.handler` nor
`synthesis.entrypoint` is set. The explicit overrides keep working (`FunctionSynthesisConfig`,
`invoke.ts:97-102`).

### Step 5: Build through the Provider

- `provider.ts`: move the `BuildPlan` and `BuildPlanOutput` types here, and export them from the root as
  types. Change the capability to
  `plan?: (input: { build: VokeBuildConfig; config: VokeConfig; entrypoint: string; functions: FunctionRegistry | FunctionRegistryInput }) => BuildPlan`.
  Add `manifest: { functions: Record<string, { file: string; handler: string }> }` to `BuildPlan`.
- `@voke/build` is the provider-neutral base plan: the bundler command, the ESM `package.json`, and the
  explicit `synthesis.entrypoint` outputs. It takes `functions` as input and does not read
  `config.functions` or `cloudFormation.handler`. Move `packages/core/test/build.test.ts` to
  `packages/build/test/`.
- `@voke/aws` `aws/src/build.ts` implements `aws().build.plan`. It does three things:
  1. Adds the generated file `.voke/build/index.ts`:

     ```ts
     // Generated by voke build. Do not edit.
     import * as project from "<path from .voke/build to the entrypoint>";
     import { createLambdaHandlers } from "@voke/aws";

     const handlers = createLambdaHandlers(project);

     export const http = handlers["http"];
     export const processOrder = handlers["processOrder"];
     ```

     It has one export per registry entry, named by `createHandlerExportName`.

  2. Makes that file the bundle entry, so the output is `<outdir>/index.js`.
  3. Fills `manifest` and writes `<outdir>/voke-manifest.json`. Plan 004 reads it.

  Functions with an explicit `synthesis.entrypoint` keep their own build entry and handler. Bun computes
  a common root when given several entrypoints, so assert the real output paths in a test and make the
  manifest match them.

- `cli.ts` `build`: call `config.provider?.build?.plan`. When it is missing, throw the same style of
  `CliUsageError` as synth (`No provider configured for build.` /
  `Provider "<name>" does not support build.`). Write `plan.files` and run `plan.command`. The positional
  `[entrypoint]` overrides the project entrypoint, not the bundle entry list.
- Delete core `src/build.ts`. Update `src/index.ts`/`provider.ts` imports, and point
  `test/node-runtime.test.ts` at `aws().build.plan`.

### Step 6: Lambda adapters in `@voke/aws` (`createLambdaHandlers`)

Create `aws/src/lambda-handlers.ts` and export it from the `@voke/aws` index:

```ts
export interface LambdaProjectModule {
  default?: unknown;   // a Gateway from voke(functions, { config })
  functions?: unknown; // a Function Registry from createFunctions(...)
}

export type LambdaHandler = (event: unknown, context?: unknown) => Promise<unknown>;

export const createLambdaHandlers = (
  project: LambdaProjectModule
): Record<string, LambdaHandler>;
```

**Resolution.**

- If `project.default` is a Gateway (has `app`, `functions` and `config`), use `gateway.functions`, and
  build the HTTP handler with `createAwsLambdaHandler(gateway.app)`. That Gateway was activated by `voke()`
  with the configured Provider's variable providers.
- Otherwise use `project.functions`, and activate it with `activateFunctionRegistry` and the AWS Runtime
  Variable provider (009).
- If neither is present, throw `VokeConfigError`:
  `The project entrypoint must export a Gateway (export default voke(functions, { config })) or a Function Registry (export const functions = createFunctions({ ... })).`

**One handler per entry** (`functionRegistryEntries`), keyed by `createHandlerExportName(key)`:

- `route`: the HTTP handler. A route Function without a Gateway default export is a `VokeConfigError`
  with that explanation.
- `event` (SQS): `createSqsEventHandler({ function: key, functions })`.
- `invokable`: the Lambda event is the payload. Call `functions.invoke(key, event, { runtime: "local" })`
  and return the result, letting `InvokeError` propagate so Lambda reports a function error. If the
  Function also has routes, dispatch by event shape: `event.version === "2.0"` with
  `event.requestContext.http` goes to the HTTP handler, and anything else goes to direct invoke.
- `authorizer`: this is the Request Authorizer adapter.
  - Build a `Request` from the HTTP API Lambda authorizer event (payload 2.0): `headers`, `rawPath`,
    `rawQueryString`, `requestContext.http.method`, `requestContext.domainName`, `cookies`.
  - Call core's shared authorizer runner (step 7).
  - Return `{ isAuthorized: true, context }` or `{ isAuthorized: false }`.
  - A thrown error returns `{ isAuthorized: false }` and logs with `console.error`, without leaking the
    message to the caller.

Update `examples/sqs-events`:

- `src/functions.ts` drops the hand-written `handler`.
- `test/sqs-events.test.ts` uses `createLambdaHandlers({ functions }).processOrder`.
- Add `voke.config.ts` with `name: "sqs-events"`, `entrypoint: "./src/functions.ts"`, `provider: aws()`,
  and `cloudFormation.resources.ordersQueue: sqsQueue()` from `@voke/aws/cloudformation`.
- The `package.json` build script becomes `voke build`.

### Step 7: Shared authorizer runner and deployed trust hook (core, provider-neutral)

- Extract the "run a Request Authorizer Function" part of `evaluateLocalAuthorizer` (`invoke.ts:1551-1655`)
  into an exported core function. It covers the invoke context, Runtime Variable loading, boolean result
  validation and `context` schema validation. Example shape:
  `runRequestAuthorizer(definition, { headers, raw, request }): Promise<{ authorized: boolean; context: Record<string, unknown> }>`.
  It throws `InvokeError` on invalid results. `evaluateLocalAuthorizer` keeps its exact local HTTP
  responses (401 missing identity, 403 denied, 500 invalid or failed).
- `provider.ts`: add
  `routeAuth?: (input: { env: unknown }) => RouteAuthContext | undefined` to `ProviderRuntimeCapability`.
  Export `RouteAuthContext` from the root as a type, and widen `source` to `"lambda" | "jwt"`.
- In the route auth path, before evaluating an authorizer locally, call
  `provider?.runtime?.routeAuth?.({ env: c.env })` with the Gateway's configured Provider. If it returns a
  context, use it and skip local evaluation.
- `aws()` implements `routeAuth`:
  - `env.event?.requestContext?.authorizer?.lambda` gives `{ context: lambda, source: "lambda" }`;
  - `.jwt?.claims` gives `{ context: claims, source: "jwt" }`;
  - otherwise it returns `undefined`.

  `c.env.event` exists only when the request came through `createAwsLambdaHandler`. `voke dev` and
  `gateway.request(...)` keep today's local behaviour.

### Step 8: Correct HTTP API route synthesis (`@voke/aws`)

In `aws/src/cloudformation-synthesis.ts`:

1. **Route keys.** Convert `:name` segments to `{name}` and a trailing `*` to `{proxy+}` where `RouteKey`
   is written (`:509`). The core model keeps Route Builder syntax; the dev summary and contracts read it.
   A path form with no API Gateway equivalent (regex or optional params) throws `VokeModelError` naming the
   route.
2. **Logical ids.**
   - Every route id is derived from Function + method + path (`<Function><Method><Path>Route`).
   - The Integration id comes from the Function (`<Function>Integration`), so reordering routes or
     Functions renames nothing.
   - Replace `apiFunctionName` (`:694-695`) with a stable rule: the bare `Function`/`FunctionRole`/
     `Permission` ids go to the Function keyed `http` when it exists, and every other Function uses
     `<Name>…`. Record this rule in a code comment and in the test.
3. **Integrations.** Create one `AWS::ApiGatewayV2::Integration` per Function, and point every route of
   that Function at it.

Keep the `Api` and `Stage` ids.

### Step 9: Project loader and CLI wiring (core)

Create `packages/core/src/project.ts` (CLI-time):

```ts
export interface LoadedProject {
  config: VokeConfig;
  functions: FunctionRegistry | FunctionRegistryInput;
}

export const loadProject = async (options: {
  config: VokeConfig;
  entrypoint?: string;
  cwd?: string;
}): Promise<LoadedProject>;
```

- Import the entrypoint (`options.entrypoint ?? config.entrypoint`) by absolute `file://` URL.
- A Gateway default export (`app`, `functions`, `config`) or a `functions` export gives the registry.
  Anything else is the `VokeConfigError` from step 6, prefixed with the entrypoint path.
- Set `process.env.VOKE_SYNTH = "1"` during the import, and restore the previous value after.
- If the import throws, wrap the error in a `VokeConfigError` that names the entrypoint and includes the
  original message, with the hint: "Voke imports your entrypoint to discover Functions; guard side effects
  with `process.env.VOKE_SYNTH`."

In `cli.ts`, the `synth` and `build` handlers call `loadProject` after `loadConfigFromFlags`.

- `synth` builds the model with `createVokeModel({ ...config, functions })`, then calls the provider.
- `build` passes `functions` to `build.plan`.
- `voke dev` is unchanged.

### Step 10: Serverless migrator, docs

- Generated `voke.config.ts`:
  - Has no `functions` import or key.
  - Gains `import { aws } from "@voke/aws";` and `provider: aws(),`.
  - Resource builders come from `@voke/aws/cloudformation` (009).
- Generated `src/index.ts`:
  - Builds one `createFunctions({...})` holding the route-backed and the worker Functions, and does
    `export default voke(functions, { config })`.
  - A worker-only service exports `functions` from the entrypoint.
- Drop the per-Function `synthesis` blocks where the generated Lambda entry covers them.
- Update `test/serverless-migration.test.ts` and `examples/serverless-migration/**`, and keep the
  "generated code typechecks" assertions.
- `apps/docs/content/docs/reference/config.mdx`: remove the `functions` row and every mention of
  `handler`, `api.function`, `api.routes` and `api.protocol`, and document `provider`.
- `README.md` and `apps/docs/content/docs/guides/functions.mdx`:
  - The provider is set in `voke.config.ts`.
  - The SQS section no longer hand-writes `createSqsEventHandler` exports.
- `docs/stable-public-surface.md`: list the new root exports (`functionRegistryEntries`,
  `createHandlerExportName`, `runRequestAuthorizer`, and the `BuildPlan`/`RouteAuthContext` types) and
  `createLambdaHandlers` in `@voke/aws`.

## Test plan

- `packages/aws/test/lambda-handlers.test.ts` (create):
  - Gateway resolution and registry resolution, plus the error when neither is exported.
  - A route Function without a Gateway is a config error.
  - HTTP v2 event through the Gateway.
  - SQS batch through `sendEvent`.
  - Invokable direct payload, an `InvokeError` that propagates, and invokable+routes dispatch by event
    shape.
  - Authorizer allow with validated context, deny, invalid context, and a thrown error giving
    `{ isAuthorized: false }`.
  - A Runtime Variable read inside an invokable Function for a functions-only registry.
- `packages/aws/test` route auth:
  - With `aws()` configured, a request through `createAwsLambdaHandler` carrying
    `requestContext.authorizer.lambda` reaches the route with that context, and the authorizer Function is
    not called.
  - The JWT claims variant.
  - Without the event, local evaluation runs as before (the existing `route-builder.test.ts` cases stay
    green).
- Synthesis:
  - `/users/:id` becomes `GET /users/{id}`; a wildcard becomes `{proxy+}`; an unsupported form gives
    `VokeModelError`.
  - One integration per Function.
  - Reordering two routes and two Functions leaves every logical id unchanged.
  - A resources-only config emits no Lambda, role or API.
- Core:
  - `test/project.test.ts` (create) covers: Gateway default export; `functions` export; neither; import
    error wrapping; `VOKE_SYNTH` set during the import and restored after. Use temporary fixture files, as
    in `test/public-api-redesign.test.ts`.
  - `createHandlerExportName` cases and the collision error.
  - `defineConfig` rejects `functions`, `handler`, `api.function` and `api.routes` (`test/error-design.test.ts`).
  - The removed keys are TypeScript errors (`test/config-typecheck.ts`).
  - `voke(functions, { provider })` is a TypeScript error.
  - Deployed names follow `${name}-${stage}-${key}`.
- CLI (`test/cli-contract.test.ts`): `build` without a build-capable provider fails clearly; synth imports
  the entrypoint.
- `packages/build/test/build.test.ts` (moved), and an AWS build-plan test covering the generated entry
  content, the manifest, and an explicit `synthesis.entrypoint` that keeps its handler.
- `test/node-runtime.test.ts`: build through `aws().build.plan` and the generated entry, then call the
  `http` and an SQS export under real Node.

## Done criteria

- [ ] In `examples/hello-api`, `bun ../../packages/core/src/cli.ts synth` exits 0, and then
      `bun -e 'const t=await Bun.file("dist/cloudformation.json").json();const r=Object.values(t.Resources);console.log(r.filter(x=>x.Type==="AWS::ApiGatewayV2::Route").map(x=>x.Properties.RouteKey).sort().join("|"),r.filter(x=>x.Type==="AWS::ApiGatewayV2::Integration").length,r.filter(x=>x.Type==="AWS::Lambda::Function").map(x=>x.Properties.Handler).join("|"))'`
      prints `GET /|GET /health|GET /typed|GET /users|GET /users/{id}|POST /users 1 index.http`
- [ ] `grep -c '/:' examples/hello-api/dist/cloudformation.json` → `0`
- [ ] In `examples/sqs-events`, `bun ../../packages/core/src/cli.ts synth` produces an `AWS::Lambda::EventSourceMapping` and `Handler: index.processOrder`; a unit test proves that an undeclared `ordersQueue` fails with an error at path `functions.processOrder.events.0.queue`
- [ ] In `examples/hello-api`, `bun ../../packages/core/src/cli.ts build` writes `dist/index.js`, `dist/package.json` and `dist/voke-manifest.json`, and `node -e 'import("./dist/index.js").then(m=>console.log(typeof m.http))'` prints `function`
- [ ] The reorder test in `packages/aws/test` passes: no logical id changes when routes or Functions are reordered
- [ ] `grep -rnE "legacyApiRoutes|api\.function|api\.routes|api\.protocol|cloudFormation\.handler|config\.functions" packages/core/src packages/aws/src packages/build/src` → no matches outside `serverless-migration.ts` input parsing
- [ ] `grep -rn "provider: aws()" examples/*/src` → no matches; `grep -ln "provider: aws()" examples/hello-api/voke.config.ts examples/sqs-events/voke.config.ts` lists both
- [ ] `ls packages/core/src/build.ts` → no such file; `grep -rn "build?.plan\|build\.plan" packages/core/src/cli.ts` → a match
- [ ] `defineConfig({ name: "x", functions: {} })` throws `VokeConfigError` at path `functions` (test)
- [ ] An entrypoint that exports neither a Gateway nor `functions` makes `voke synth` exit non-zero with the step 6 message (test)
- [ ] A migrated service with worker Functions yields a `voke.config.ts` with `provider: aws()` and no `functions`, and the generated project typechecks (test)
- [ ] `cd packages/core && bun test`, `cd packages/aws && bun test`, `cd packages/build && bun test` → 0 fail; `bun run typecheck` exits 0; `bun run check` exits 0
- [ ] No files outside the in-scope list are modified (`git status --short`)

## STOP conditions

- Plan 009 has not landed. AWS copies still exist in core outside 009 D5's retained files, or
  `ProviderRuntimeCapability.variables` is missing.
- A Route Builder path form has no API Gateway route-key equivalent and is used by a first-party example.
  Report the forms.
- Extracting `runRequestAuthorizer` would change an observable local response of `gateway.request(...)` or
  `functions.route(...)`.
- Importing an entrypoint at synth time is unworkable for a first-party example, for example a top-level
  side effect that cannot be guarded.
- A Function kind exists that is not one of `authorizer`, `event`, `invokable` or `route`.
- Something outside tests and the migrator depends on `config.functions`, `api.routes`, `handler`,
  `gateway.handler` or `voke()`'s `provider` option in a way this plan does not list. Check
  `@voke/testing`, `@voke/remote`, `apps/docs` and `examples` first. At planning time none of them does.
- A migrated Serverless service cannot be expressed with one entrypoint-owned registry. Keep per-Function
  `synthesis.entrypoint` for those cases, report them, and do not reintroduce `functions` in config.

## Maintenance notes

- Every new Function kind or Event Source needs a branch in `createLambdaHandlers` and a case in
  `packages/aws/test/lambda-handlers.test.ts`, in the same change as its model support.
- One shared bundle means every Lambda loads all Function code. That is acceptable for now; per-Function
  bundles are roadmap phase 6.
- Reviewers should scrutinize:
  - handler export-name stability (renaming a registry key renames its Lambda handler);
  - the `http`-keyed Function rule for bare logical ids;
  - that `routeAuth` trusts only `c.env.event` set by the Lambda adapter;
  - synth-time import side effects.
- Plan 004 consumes `<outdir>/index.js`, `<outdir>/package.json` and `<outdir>/voke-manifest.json` from
  `aws().build.plan`, and `loadProject` for the registry. Plan 008 picks up any remaining duplicate
  spellings. Plan 010 deletes core's retained `cloudformation.ts`, `aws-lambda.ts` and `api.ts`.

## Execution notes (2026-11-14)

Done on branch `feature/registry-discovery-lambda-entries`, stacked on `feature/finish-aws-package-split`
(plan 009, PR #52, open at the time). Uncommitted. Gates: `bun run check` 0 errors, `bun run typecheck`
18/18, `bun run test` 23/23 tasks (core 226, `@voke/aws` 38, `@voke/build` 4, examples all green).

Done criteria, run for real:

- `examples/hello-api`: `voke synth` gives `GET /|GET /health|GET /typed|GET /users|GET /users/{id}|POST /users 1 index.http`;
  `grep -c '/:'` gives 0; `voke build` writes `dist/index.js`, `dist/package.json`, `dist/voke-manifest.json`;
  under Node, `typeof m.http` is `function`.
- `examples/sqs-events`: `voke synth` gives one `AWS::Lambda::EventSourceMapping` and `Handler: index.processOrder`;
  `test/synthesis.test.ts` covers the undeclared `ordersQueue` error at `functions.processOrder.events.0.queue`.
- `packages/core/test/node-runtime.test.ts` builds through `aws().build.plan` (generated entry included) and runs
  the `http` and `processOrder` exports under real Node.

Deviations and findings:

- **Manifest handlers use the output-relative module path.** When a Function has an explicit
  `synthesis.entrypoint`, Bun's common root widens and the generated entry lands at
  `<outdir>/.voke/build/index.js`, so the manifest handler is `.voke/build/index.<export>`. The synthesized
  template (from the model) still says `index.<export>` in that mixed case. Plan 004 must take handlers from
  `voke-manifest.json`, not from the template. The common case (no explicit entrypoints) matches.
- **Generated exports are sorted by name** so `.voke/build/index.ts` does not change when Functions are
  reordered (the formatter reorders object keys, which exposed the order dependence).
- **`VokeRoutes` template metadata** now uses API Gateway route keys too, so the template has one route spelling;
  the core model keeps Route Builder syntax. Nothing read that metadata.
- **`createGateway` takes the Provider from `config.provider`**; plan 009's `GatewayOptions.provider` was removed
  (one spelling, U2).
- **Migrator:** generated Functions drop `synthesis.entrypoint`/`handler` (they pointed at a `handler` export that
  never existed); only an explicit runtime remains. Generated `package.json` gains `@voke/aws`.
- **Examples outside the listed scope:** `examples/cross-function` and `examples/e2e` get a `voke.config.ts`
  (`provider: aws()`), their build script becomes `voke build`, and their tsconfig includes the config. Without
  this their `voke build` fails under U2. `.gitignore` gains `.voke`. New test file
  `examples/sqs-events/test/synthesis.test.ts`.
- **New public surface:** root `functionRegistryEntries`, `createHandlerExportName`, `runRequestAuthorizer`
  and types `BuildPlan`, `BuildPlanFunction`, `BuildPlanOutput`, `ProviderBuildInput`, `RouteAuthContext`,
  `RequestAuthorizerOutcome`, `VokeBuildConfig`, `VokeModelInput`; `@voke/aws` `createLambdaHandlers`;
  `@voke/build` `handlerModule`.
- **Expected grep matches:** `config.ts` mentions `cloudFormation.handler` only in its rejection message;
  `model.ts` `api.routes` reads the model's own HTTP API routes, not the removed config key.
- **Known edge:** an entrypoint that calls `voke(functions)` but exports only `functions` (no default) makes
  `createLambdaHandlers` activate the registry a second time with a different key, which throws. Export the
  Gateway as default in that case. Not covered by an error message yet.
- Local bootstrap and `voke dev` still synthesize from config alone, so their templates are resources-only.
