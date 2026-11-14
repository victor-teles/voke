# Plan 009: `@voke/aws` is the only home of AWS behaviour, and core's AWS copies are gone

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Compare `git diff --stat 3435023 -- packages/core/src packages/core/test packages/core/package.json packages/core/tsconfig.json packages/aws packages/testing packages/remote packages/build examples README.md docs/stable-public-surface.md docs/e2e-testing.md apps/docs/content/docs`
> and `git status --short` with the state recorded below. Reconcile routine drift
> (moved line numbers, renamed locals). Pause if drift invalidates scope, a protected
> contract, or a product decision listed here.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH (moves Runtime Variables and IAM synthesis between packages, changes `@voke/aws` exports, rewires ~20 test files)
- **Depends on**: `.factory/plans/002-node-lambda-runtime-portability.md` (DONE)
- **Category**: tech-debt
- **Planned at**: commit `3435023`, 2026-11-14

## Why this matters

The package split (ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`) moved AWS code into
`@voke/aws`, but core kept diverged copies of that code. The CLI uses the `@voke/aws` copy for `voke synth`,
which is the user path, and core tests mostly exercise the core copy. The two copies have drifted. Runtime
Variables were merged into core after the split, so `@voke/aws` has no per-Function IAM for secrets and
parameters, no `secret`/`parameter` Runtime Variable builders, and no `variables` on `requestAuthorizer` or
`sqs`. Today no package exports the Runtime Variable builders at all. Every later plan (003, 004, 005, 008, 010) would otherwise have to edit two copies. When this plan lands, AWS behaviour lives only in
`@voke/aws`. Core reaches it only through the configured Provider, and core tests prove the package copy
works.

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: "`voke` is the provider-neutral core
  (Function, Gateway, config, contract, route, Provider capability contracts). `@voke/aws` depends on public
  `voke` and owns the full AWS workflow: AWS runtime adapters, resource helpers, SQS and authorizer
  entrypoints, local AWS workflow helpers, and CloudFormation synthesis under `@voke/aws/cloudformation`."
- ADR `docs/adr/0007-runtime-variables-and-aws-export-boundaries.md`: "Runtime Variable providers own
  provider-specific source descriptors, value loading, redacted source labels, and optional deployment
  synthesis contributions such as IAM policy fragments. Voke owns per-Function declarations,
  `context.variables` typing, local and test overrides, environment fallback, caching, ..." and
  "runtime value loading and infrastructure declaration do not share the same import boundary."
  Read its `voke/aws` and `voke/cloudformation` subpaths as `@voke/aws` and `@voke/aws/cloudformation`,
  because the split ADR superseded core subpaths.
- User decision U4: Runtime Variable `secret`/`parameter` are exported from `@voke/aws`. CloudFormation
  resource builders (`dynamodbTable`, `sqsQueue`, `snsTopic`, `eventBus`, `s3Bucket`, `secret`,
  `ssmParameter`) move to `@voke/aws/cloudformation`.
- Workspace cycle: `@voke/aws`, `@voke/build`, `@voke/remote` and `@voke/testing` depend on `voke`. Core
  **src** must not import any `@voke/*` package. Core **tests** may import them: `packages/core/tsconfig.json`
  maps `@voke/aws`, `@voke/aws/*`, `@voke/build`, `@voke/http`, `@voke/remote`, `@voke/schema` and
  `@voke/testing` to `../<pkg>/src` through `paths`, and Bun honours those paths at runtime. Do not add
  `@voke/*` to core `package.json`, because turbo rejects the cycle.
- `CONTEXT.md` terms to use: **Provider**, **Provider Capability**, **AWS Provider**, **Runtime Variable**,
  **Provider Extension Record**.

### Duplicate modules and their callers at 3435023

| Core file                                                                                                                                                                                            | `@voke/*` counterpart                                                                                    | Core **src** importers                                | Core **test** importers                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cloudformation.ts` (23.4K; 382 diff lines)                                                                                                                                                      | `aws/src/cloudformation-synthesis.ts`                                                                    | `local.ts:2-6`, `local-provider.ts:1`, `e2e.ts:8`     | `cloudformation.test`, `model.test`, `model-typecheck`, `api.test`, `bindings.test`, `local.test`, `e2e.test`                                                                                                   |
| `src/aws.ts` (re-exports `parameter`/`secret`, `bindResource`, `createAwsClientConfig`)                                                                                                              | `aws/src/resources.ts`                                                                                   | `serverless-migration.ts:1` (`toEnvKey` only)         | `model`, `cloudformation`, `route-builder`, `remote-functions`, `error-design`, `bindings`, `api`, `local`, `e2e` tests; `test/fixtures/node-runtime/index.ts:3`; `aws-runtime-variables.test` (dynamic import) |
| `src/aws-runtime-variables.ts` (no counterpart)                                                                                                                                                      | none                                                                                                     | `invoke.ts:9`, `aws.ts:5`                             | `aws-runtime-variables.test`                                                                                                                                                                                    |
| `src/authorizers.ts`                                                                                                                                                                                 | `aws/src/authorizers.ts` (no `variables`)                                                                | `invoke.ts:4-8` and `model.ts:1-4` (**types only**)   | `model.test`, `cloudformation.test`, `route-builder.test`, `invoke-typecheck`                                                                                                                                   |
| `src/aws-lambda.ts` (identical)                                                                                                                                                                      | `aws/src/lambda.ts`                                                                                      | `api.ts:2`, `e2e.ts:2-7`                              | `api.test`                                                                                                                                                                                                      |
| `src/aws-lambda-invoke-transport.ts`                                                                                                                                                                 | `aws/src/lambda-invoke-transport.ts`                                                                     | none                                                  | none (the test already imports `@voke/aws`)                                                                                                                                                                     |
| `src/api.ts` (`api()`, a retired name)                                                                                                                                                               | none                                                                                                     | `e2e.ts:1` (type `VokeApi`)                           | `api.test`, `e2e.test`                                                                                                                                                                                          |
| SQS values in `src/invoke.ts` (`sqsEventSource` :1257, `sqsMessageBatch` :1266, `createSqsEventHandler` :1987, `sqs` :2138, helpers `sqsInvocationFromAwsEvent` :1158, `parseSqsMessageBatch` :1171) | `aws/src/sqs.ts`                                                                                         | not exported from core index                          | `invoke.test`, `model.test`, `cloudformation.test`, `route-builder.test`                                                                                                                                        |
| `src/remote.ts`                                                                                                                                                                                      | `remote/src/index.ts` (33 diff lines: imports, `node:crypto` vs `sha256Hex`, `process.env` vs `readEnv`) | `app.ts:19`, `dev.ts`, `cli.ts:12`, `config.ts:17-18` | `remote-functions.test`                                                                                                                                                                                         |
| `src/build.ts`                                                                                                                                                                                       | `build/src/index.ts` (identical apart from imports)                                                      | `cli.ts:4`, `provider.ts:1` (type `BuildPlan`)        | `build.test`, `node-runtime.test`                                                                                                                                                                               |

### Parity gaps: core has these, `@voke/aws` does not

1. **Per-Function IAM roles with Runtime Variable statements.** Core `cloudformation.ts:330-385`
   (`toRuntimeVariablePolicyStatements`) adds `secretsmanager:GetSecretValue` / `ssm:GetParameter(s)` for
   each AWS Runtime Variable. For `.fromResource(...)` variables it adds the resource's own policy
   statements. Core `:387-432` creates one role per Function (`FunctionRole` for the API Function,
   `<Name>FunctionRole` for the others). The loop at `:773-833` gives each Lambda its own role
   (`Role: { "Fn::GetAtt": [roleLogicalId, "Arn"] }`). `@voke/aws` creates one shared `FunctionRole`
   (`cloudformation-synthesis.ts:747-749`, `Role` at `:802`) and never reads `definition.variables`.
   Helpers to port: `secretArn` and `parameterArn` (core, near `:290-312`).
2. **Runtime Variable builders and loader.** `core/src/aws-runtime-variables.ts`: `secret` (`:67`) and
   `parameter` (`:79`), each with `.fromResource`, and `createAwsRuntimeVariableProvider` (`:129`). The
   loader uses `@aws-sdk/client-secrets-manager` and `@aws-sdk/client-ssm` (`:1-5`). No package exports
   them. `README.md:121` and `apps/docs/content/docs/guides/functions.mdx:44,85` import them from
   `"voke/aws"`, a subpath that no longer exists.
3. **AWS variable provider hard-wired in core.** `core/src/invoke.ts:1004-1012`, inside
   `activateFunctionRegistry`:
   ```ts
   variableProviders: [
     createAwsRuntimeVariableProvider(),
     ...(options.variableProviders ?? []),
   ],
   ```
   Core therefore depends on `@aws-sdk/client-secrets-manager` and `@aws-sdk/client-ssm`
   (`packages/core/package.json` dependencies, together with `@aws-sdk/client-lambda`, which only the unused
   `aws-lambda-invoke-transport.ts` copy needs).
4. **Authorizer Runtime Variables.** Core `requestAuthorizer` accepts `variables`, and its handler receives
   `(request, context: InvokeContext<TVariables>)`. The `@voke/aws` copy has neither
   (`diff packages/core/src/authorizers.ts packages/aws/src/authorizers.ts`). The local authorizer runner
   (`invoke.ts:1551-1655`, `evaluateLocalAuthorizer`) already passes a context and loads variables.
5. **`sqs()` Runtime Variables and error type.** Core `sqs()` (`invoke.ts:2138+`) accepts `variables` and
   throws `VokeConfigError`. `@voke/aws` `sqs()` (`aws/src/sqs.ts:309-345`) has no `variables` and throws a
   plain `Error`.
6. **Model errors.** `@voke/aws` declares its own `VokeModelError` class
   (`cloudformation-synthesis.ts:9-24`). Core has `VokeModelError` in `src/errors/model.ts`, but the root
   exports only `VokeConfigError` (`src/index.ts:36`).

### Eager provider validation (protected behaviour)

`core/src/variables.ts:256-268` (`validateRegisteredProviders`) throws when a Function declares a Runtime
Variable whose provider id is not registered. `createRuntimeVariables` (`:352-364`) calls it eagerly,
**before** overrides and environment values are consulted. `test/variables.test.ts:62-84` asserts this.
Today it never fires for `"aws"`, because core always registers the AWS provider. Once that hard-wiring is
removed, every activation without the AWS Provider would throw for AWS Runtime Variables. That includes
`createGateway` in core tests and `@voke/testing`'s `createInvokeTestClient`
(`testing/src/index.ts:104-109`, which activates with no providers), even when the test supplies overrides.

### Root exports today

`test/package-boundaries.test.ts:10-27` pins the root runtime values: `InvokeError`, `VokeConfigError`,
`activateFunctionRegistry`, `createFunctions`, `createHandlerNameFromEntrypoint`, `createVokeModel`,
`defineConfig`, `fn`, `http`, `invokeRegistryFunction`, `loadVokeConfig`, `route`, `toEnvKey`, `voke`.
`test/aws-package-boundaries.test.ts:12-36` pins `@voke/aws` and `@voke/aws/cloudformation` (today only
`synthesizeCloudFormation`). `test/public-surface.test.ts` checks the docs listed at its top (`:6-17`) and
the package export lists.

### Provider contract

`packages/core/src/provider.ts`: `ProviderRuntimeCapability { gateway? }`. The Gateway gets its provider
in `voke()` (`app.ts:266`, `options.provider ?? config.provider`). `createGateway` (`app.ts:169-215`) does
the activation (`:195-201`) and receives no provider.

## Commands you will need

| Purpose           | Command                                                                                     | Expected on success                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Install           | `bun install`                                                                               | exit 0                                                                                                 |
| Core tests        | `cd packages/core && bun test`                                                              | 0 fail                                                                                                 |
| AWS tests         | `cd packages/aws && bun test`                                                               | 0 fail                                                                                                 |
| Testing tests     | `cd packages/testing && bun test`                                                           | 0 fail                                                                                                 |
| One file          | `cd packages/core && bun test test/model.test.ts`                                           | 0 fail                                                                                                 |
| Typecheck (all)   | `bun run typecheck`                                                                         | exit 0                                                                                                 |
| All tests         | `bun run test`                                                                              | exit 0                                                                                                 |
| Lint/format check | `bun run check`                                                                             | exit 0                                                                                                 |
| Synth smoke       | `cd examples/hello-api && bun ../../packages/core/src/cli.ts synth --config voke.config.ts` | see step 8 (the config has no `provider` until plan 003, so this runs through a test, not the example) |

## Implementation rules relevant to this plan

- Test first: for each parity gap, first write a failing test against `@voke/aws`, then port the code.
- Port the core behaviour into the package copy. **Do not** copy the package copy back into core. Where
  both copies differ, the core copy carries the newer Runtime Variables work, and the package copy carries
  the Provider Extension Record work. Keep both.
- Core src may import only core files and third-party packages. `grep -rnE "from \"@voke/" packages/core/src`
  must only match string literals inside code generators (`cli.ts` scaffold templates,
  `serverless-migration.ts` emitters).
- Errors for user-fixable problems are `VokeError` subclasses with a path and a next step
  (`docs/error-conventions.md`). In `@voke/aws`, throw `VokeConfigError`/`VokeModelError` imported from
  `voke`.
- No new third-party dependencies. Move `@aws-sdk/client-secrets-manager` and `@aws-sdk/client-ssm`
  (same versions as core: `^3.1053.0`) from `packages/core/package.json` to `packages/aws/package.json`.
  Then remove all `@aws-sdk/*` from core. `@voke/aws` already has `@aws-sdk/client-lambda`.
- Runtime code must not use the `Bun` global (plan 002). Use `readEnv` from core where core code needs
  env access; `@voke/aws` may use `process.env`.
- Keep test names specific; prefer public behaviour. Do not drop an assertion about behaviour that still
  exists. Re-point it.

## Decisions made for this plan (reversible; recorded so the executor need not ask)

- **D1, configured Runtime Variable providers.** Add `variables?: () => readonly RuntimeVariableProvider[]`
  to `ProviderRuntimeCapability`. `aws()` implements it with `createAwsRuntimeVariableProvider()`. The AWS
  SDK clients are created lazily on first load, so importing `@voke/aws` stays cheap. `voke()` passes the
  resolved provider into `createGateway` (new `GatewayOptions.provider`). Activation registers
  `[...provider.runtime.variables(), ...options.variables.providers]`.
- **D2, activations without a Provider.** Add an option to `createRuntimeVariables`, for example
  `unregisteredProviders: "error" | "defer"`, default `"error"`. `activateFunctionRegistry` uses `"defer"`
  when it has neither a Provider nor explicit providers. With `"defer"`, an unregistered provider id is not
  an error at creation; the override, then the environment value, are tried at load time, and only then
  does the existing "no Runtime Variable provider with that id is registered" error fire. This keeps
  `test/variables.test.ts:62-84` (eager by default) and today's override and environment behaviour in tests
  and `@voke/testing`. If you find this changes another tested behaviour, STOP.
- **D3, authorizer and SQS types stay in core; values move.** `FunctionKind` (`invoke.ts:268`) keeps
  `"authorizer"` and `"event"`, and core model and invoke need the definition shapes. Keep only **types** in
  core:
  - `src/authorizers.ts` becomes types-only.
  - The SQS interfaces stay in `invoke.ts`.
  - Delete the core **values**: `jwtAuthorizer`, `lambdaAuthorizer`, `createAuthorizers`,
    `requestAuthorizer`, `sqs`, `sqsEventSource`, `sqsMessageBatch`, `createSqsEventHandler`, and their
    private helpers.

  Export from the root, as **types only**, what `@voke/aws` needs so it can stop redeclaring them:
  `InvokeContext`, `RuntimeVariableCatalog`, `RuntimeVariableOptions`, `RuntimeVariableProvider`,
  `RuntimeVariableSource`, `RequestAuthorizerFunctionDefinition`, `RequestAuthorizerHandler`,
  `AuthorizerRequest`, `AuthorizerResult`, `HttpAuthorizerDefinition`, `AuthorizerRegistryInput`,
  `LambdaAuthorizerTarget`.

- **D4, new root runtime values** (Runtime Variables are core-owned per the ADR): `createVariableSource`,
  `createVariableProvider`, `VokeModelError`, `VokeRuntimeVariableError`. Update
  `test/package-boundaries.test.ts:10-27` and `docs/stable-public-surface.md`.
- **D5, files kept until plan 010.** Core `local.ts`, `local-provider.ts` and `e2e.ts` are deleted by plan
  010 (`.factory/plans/010-local-workflow-through-provider.md`). Until then, keep the **minimum** they
  import, frozen, and add no code to it:
  - `src/cloudformation.ts`, reduced to the template types (`CloudFormationTemplate`,
    `CloudFormationResource`, `CloudFormationOutput`, `CloudFormationValue`) plus `synthesizeCloudFormation`
    and the private code it calls. Delete its resource builders (`dynamodbTable`, `sqsQueue`, `snsTopic`,
    `eventBus`, `s3Bucket`, `secret`, `ssmParameter`) and `StackResourceDefinition`, unless `local.ts`,
    `local-provider.ts` or `e2e.ts` import them.
  - `src/aws-lambda.ts` (used by `e2e.ts:2-7`) and `src/api.ts` (type `VokeApi`, `e2e.ts:1`).

  Give each kept file this first line:
  `// Retained only for local.ts / local-provider.ts / e2e.ts until plan 010 deletes them. Do not add code or importers.`
  Their only allowed importers are those three files and their own tests (`local.test.ts`, `e2e.test.ts`).
  Later plans may make compile-only edits to them.

- **D6, remote and build copies stay.** Core `remote.ts` serves core features (`voke remote generate` in
  `cli.ts`, dev Function endpoints mounted in `app.ts:204-210`, `remotes` in `config.ts`). Core cannot import
  `@voke/remote`, so both copies remain, and this plan changes neither. Core `build.ts` stays because
  `voke build` calls it (`cli.ts:558`). Plan 003 makes `voke build` call `provider.build.plan`, implemented
  on `@voke/build`, and deletes core `build.ts` then.

## Scope

**In scope**:

- `packages/aws/src/**` (`authorizers.ts`, `sqs.ts`, `cloudformation-synthesis.ts`, `cloudformation.ts`,
  `index.ts`, `resources.ts`, `local.ts` imports, new `runtime-variables.ts`), `packages/aws/test/**`,
  `packages/aws/package.json`
- `packages/core/src/`: `invoke.ts`, `variables.ts`, `provider.ts`, `app.ts` (provider into
  `createGateway`), `index.ts`, `authorizers.ts` (types-only), `model.ts` (import paths only),
  `serverless-migration.ts` (`toEnvKey` import; emitted resource-builder import path), `cloudformation.ts`
  (reduce per D5), `aws-lambda.ts` and `api.ts` (header only)
- Delete: `packages/core/src/aws.ts`, `aws-runtime-variables.ts`, `aws-lambda-invoke-transport.ts`
- `packages/core/package.json` (remove `@aws-sdk/*` dependencies)
- `packages/core/test/**` (rewire imports; move pure `@voke/aws` tests to `packages/aws/test` when they use
  only public `voke` APIs), `packages/core/test/fixtures/node-runtime/index.ts`
- `packages/testing/src/index.ts` and `packages/testing/test/**`, only if D2 needs a provider option there
- Docs and examples for U4 imports: `README.md`, `apps/docs/content/docs/guides/functions.mdx`,
  `apps/docs/content/docs/getting-started.mdx`, `docs/stable-public-surface.md`, `docs/e2e-testing.md`,
  `examples/hello-api/voke.config.ts`, `examples/e2e/test/local-floci.e2e.test.ts`

**Out of scope**:

- Core `local.ts`, `local-provider.ts`, `e2e.ts`, the `voke local` workflow and `local.provider` config
  (plan 010). Only the D5 header and import-path changes are allowed here.
- Removing `config.functions`, `api.*`, `handler`, `voke()`'s `provider` option, and route-key or
  logical-id fixes (plan 003). Do not "fix" the shared-role naming beyond what per-Function roles need.
- Core `remote.ts` and `build.ts` (D6). `context.ts` `awsEvent`/`awsContext`/`requestId` and the AWS-typed
  `VokeBindings`. They are unexported and test-only, so record them for plan 008.
- Renaming or removing `toEnvKey`, `sqsEventSource` or `sqsMessageBatch` from `@voke/aws` (plan 008).
- Making the core model's SQS event-source types provider-neutral (`model.ts` `VokeModelSqsEventSource`).

## Git workflow

- Branch: `feature/finish-aws-package-split`
- Commit only if authorized; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Root exports that `@voke/aws` needs (D3, D4)

In `packages/core/src/index.ts`, add the type and value exports listed in D3 and D4. Update
`test/package-boundaries.test.ts` (root runtime values) and `docs/stable-public-surface.md` (the root
section lists Runtime Variable primitives as provider-neutral).

### Step 2: Runtime Variables in `@voke/aws`

Create `packages/aws/src/runtime-variables.ts` from `core/src/aws-runtime-variables.ts`. Import
`createVariableSource`, `createVariableProvider` and `VokeRuntimeVariableError` from `voke`, and
`createResourceBindingName` from `./resources`. Create the SDK clients lazily inside `load`. Export
`secret` and `parameter` from the `@voke/aws` index. Move the SDK dependencies (rules above). Move
`test/aws-runtime-variables.test.ts` to `packages/aws/test/`, keeping its `mock.module` setup. Its "loads
AWS secrets and parameters through the automatic provider" case becomes "through the configured `aws()`
provider": `voke(functions, { config: { name, provider: aws() } })`.

### Step 3: Provider-supplied variable providers (D1, D2)

- `provider.ts`: add `variables?` to `ProviderRuntimeCapability`.
- `app.ts`: add `provider?: VokeProvider` to `GatewayOptions`. `voke()` passes the provider it resolves at
  `:266`. `createGateway` passes its variable providers to `activateFunctionRegistry`.
- `invoke.ts`: delete the import at `:9` and the hard-wired entry at `:1004-1012`. Implement D2.
- `aws/src/index.ts`: `aws()` gets `runtime.variables`.
- Tests: a Gateway without a Provider resolves an AWS Runtime Variable from an override and from
  `VOKE_VAR_*`-style env (match the existing env naming in `variables.ts`), and fails with the redacted
  "no Runtime Variable provider" error only when neither is set. `test/variables.test.ts:62-84` still
  passes.

### Step 4: Authorizers and SQS parity (D3)

- `aws/src/authorizers.ts`: add `TVariables`, `variables` and the `InvokeContext` handler argument. Use the
  types from `voke` and delete the redeclared ones.
- `aws/src/sqs.ts`: add `variables` (same generic as core `sqs()`) and throw `VokeConfigError`.
- Core: `authorizers.ts` becomes types-only. Delete the SQS values and private helpers from `invoke.ts`
  (D3). Keep `formatEventSourceSummary` and the types used by `EventFunctionDefinition` and `sendEvent`.
- Port the core tests that cover authorizer variables and SQS variables to import from `@voke/aws`.

### Step 5: CloudFormation parity, then U4 export move

In `aws/src/cloudformation-synthesis.ts`, port gap 1: per-Function roles, `toRuntimeVariablePolicyStatements`,
`secretArn` and `parameterArn`. Use the core logical ids (`FunctionRole` for the API Function,
`<Name>FunctionRole` for the others). Replace the local `VokeModelError` class with the one from `voke`.

Then U4: move `dynamodbTable`, `sqsQueue`, `snsTopic`, `eventBus`, `s3Bucket`, `secret` (resource) and
`ssmParameter` from the `@voke/aws` index to `@voke/aws/cloudformation` (`aws/src/cloudformation.ts`).
Also export `StackResourceDefinition` there. The `@voke/aws` index keeps `aws`, `bindResource`,
`createAwsClientConfig`, `createResourceBindingName`, `toEnvKey`, the Lambda and invoke-transport adapters,
the SQS and authorizer helpers, and gains Runtime Variable `secret` and `parameter`. Update
`aws/src/local.ts`, `aws/src/testing.ts` and the `packages/aws/test` imports.

Update the generated-code import in `serverless-migration.ts:2117-2122`
(`from "@voke/aws"` → `from "@voke/aws/cloudformation"`) and its expectations in
`test/serverless-migration.test.ts:766,796`. Update `examples/hello-api/voke.config.ts:1`,
`examples/e2e/test/local-floci.e2e.test.ts:3`, `packages/core/test/dev.test.ts:3`, `README.md:11,121`,
`apps/docs/content/docs/getting-started.mdx:18`, `apps/docs/content/docs/guides/functions.mdx:44,85`,
`docs/stable-public-surface.md:31-42` and `docs/e2e-testing.md:100`.

### Step 6: Delete core copies and keep the D5 minimum

- Delete `src/aws.ts`, `src/aws-runtime-variables.ts` and `src/aws-lambda-invoke-transport.ts`.
  `serverless-migration.ts:1` imports `toEnvKey` from `./env-key`.
- Reduce `src/cloudformation.ts` per D5 and add the header to it, `aws-lambda.ts` and `api.ts`.
- Remove `@aws-sdk/*` from `packages/core/package.json`, then run `bun install`.

### Step 7: Rewire core tests

For each test in the table above:

- Import AWS values from `@voke/aws` / `@voke/aws/cloudformation`.
- Keep the core-internal imports (`../src/model`, `../src/app`, `../src/invoke`) that exercise core.
- Move a test file to `packages/aws/test/` only when it needs nothing beyond public `voke`.
  `cloudformation.test.ts` qualifies if you swap the retired `defineFunction`/`defineFunctions` imports for
  `fn`/`createFunctions`. Otherwise keep it in core and import `synthesizeCloudFormation` from
  `@voke/aws/cloudformation`.
- `local.test.ts` and `e2e.test.ts` keep using the retained core `synthesizeCloudFormation` and `api`, but
  build resources with `@voke/aws/cloudformation`. Check that the retained core synthesis accepts them:
  `resourceProvider` at `core/src/cloudformation.ts:313-328` reads `resource.provider.aws`.
- `test/fixtures/node-runtime/index.ts:3` imports `bindResource` from `@voke/aws`.
- `aws-package-boundaries.test.ts` and `public-surface.test.ts` assert the new export lists.

Where a core-copy assertion has no package-copy equivalent (for example the shared `FunctionRole`
expectations in `@voke/aws` tests), the ported per-Function role behaviour wins. Update the package test.

### Step 8: Verify the live path

Add a `packages/aws/test` case. It builds a registry with an AWS Runtime Variable (`secret("/x")`) and a
`secret.fromResource("s")` variable on two Functions, synthesizes with `aws().synthesis.synthesize`, and
asserts:

- each Function has its own role;
- only the declaring Function's role has the matching statement.

## Test plan

- New in `packages/aws/test/`:
  - `runtime-variables.test.ts` (moved and extended)
  - per-Function IAM synthesis (step 8)
  - authorizer handler receives `context.variables`
  - `sqs({ variables })` typing and runtime
  - `sqs()` misuse throws `VokeConfigError`
  - `aws()` exposes `runtime.variables`
- Core:
  - variables without a Provider (D2)
  - eager validation unchanged
  - root export list (`package-boundaries.test.ts`)
  - every rewired file passes
- Typecheck covers `test/invoke-typecheck.ts`, `model-typecheck.ts`, `config-typecheck.ts`,
  `package-boundaries-typecheck.ts`.

## Done criteria

- [ ] `ls packages/core/src/aws.ts packages/core/src/aws-runtime-variables.ts packages/core/src/aws-lambda-invoke-transport.ts` → no such files
- [ ] `grep -nE "^export const (sqs|sqsEventSource|sqsMessageBatch|createSqsEventHandler) " packages/core/src/invoke.ts` → no matches; `grep -nE "^export const" packages/core/src/authorizers.ts` → no matches
- [ ] `grep -n "createAwsRuntimeVariableProvider\|@aws-sdk" packages/core/src packages/core/package.json -r` → no matches
- [ ] `grep -rnE "^import .*from \"@voke/" packages/core/src` → no matches
- [ ] `head -1 packages/core/src/cloudformation.ts packages/core/src/aws-lambda.ts packages/core/src/api.ts` shows the D5 header on each, and `grep -rlnE "from \"\./(cloudformation|aws-lambda|api)\"" packages/core/src` lists only `local.ts`, `local-provider.ts`, `e2e.ts`, `api.ts`
- [ ] `grep -nE "export const (dynamodbTable|sqsQueue|snsTopic|eventBus|s3Bucket|ssmParameter)" packages/core/src/cloudformation.ts` → no matches
- [ ] `bun -e 'import("@voke/aws").then(m=>console.log(["secret","parameter"].every(k=>k in m), "dynamodbTable" in m))'` run in `packages/aws` → `true false`; the same check for `@voke/aws/cloudformation` and `["dynamodbTable","sqsQueue","secret","ssmParameter"]` → `true`
- [ ] `grep -rn "\"voke/aws\"\|\"voke/cloudformation\"" README.md apps/docs/content docs/*.md examples` → no matches
- [ ] The step 8 test passes: per-Function roles and per-variable IAM statements in the `@voke/aws` template
- [ ] `cd packages/core && bun test`, `cd packages/aws && bun test`, `cd packages/testing && bun test` → 0 fail; `bun run typecheck` exits 0; `bun run check` exits 0
- [ ] No files outside the in-scope list are modified (`git status --short`)

## STOP conditions

- D2 changes an asserted behaviour other than the deferral it introduces. Report the test.
- A core src file outside D5's list needs something from a deleted core copy, and it cannot get it from a
  core-neutral file without importing `@voke/*`.
- Porting per-Function roles changes a logical id that a `packages/aws/test` or `examples/*` test asserts
  as stable, and the old id cannot be kept. Report the ids; plan 003 owns logical-id stability.
- `local.ts`, `local-provider.ts` or `e2e.ts` need more of `cloudformation.ts` than D5 allows (for example
  they import a resource builder). Keep exactly what they import and list it in your report.
- A public doc or example depends on `secret` from `@voke/aws` meaning the CloudFormation resource, and the
  U4 move would silently change its meaning. Report the file.

## Maintenance notes

- Plan 010 must delete the D5 files (`cloudformation.ts`, `aws-lambda.ts`, `api.ts`) along with `local.ts`,
  `local-provider.ts` and `e2e.ts`. Plan 003 deletes core `build.ts`. Core `remote.ts` remains a duplicate
  of `@voke/remote` until the remote CLI and dev endpoints get a non-provider seam. Open a follow-up for
  that.
- A new AWS Runtime Variable source kind needs a loader branch in `aws/src/runtime-variables.ts` and an IAM
  branch in `toRuntimeVariablePolicyStatements`, added in the same change.
- Reviewers: check the U4 `secret` rename across docs (Runtime Variable in `@voke/aws`, resource in
  `@voke/aws/cloudformation`), the D2 deferral, and that no `@voke/*` import crept into core src.
- Left for plan 008: `toEnvKey` exported from both the root and `@voke/aws`; `sqsEventSource` and
  `sqsMessageBatch`; `context.ts` AWS helpers and `VokeBindings`.

## Execution notes (2026-11-14)

Done, on branch `feature/finish-aws-package-split` (uncommitted). All repository gates pass: `bun run check`
0 errors, `bun run typecheck` 17/17, `bun run test` 23/23 tasks (core 217 tests, `@voke/aws` 18).

Deviations and findings:

- **More `@voke/aws` drift than listed.** Porting core behaviour also required: the SQS batch builder
  (dedupes `fail()` and keeps `fail` non-enumerable, so it is not serialized into the Lambda response),
  invalid SQS messages carrying an `InvokeError` (`INVALID_PAYLOAD`), a typed SQS invocation input, and
  `VokeResourceBindingError` from `voke` instead of a private class.
- **Live bug fixed:** the `@voke/aws` SQS adapter JSON-parsed every record body up front, so one malformed
  message failed the whole batch. Bodies now stay raw and each is parsed on its own (regression case in
  `core/test/invoke.test.ts`, "handles deployed AWS SQS events through the Voke adapter").
- **Root exports:** D4 plus `VokeResourceBindingError`, which `@voke/aws` needs for parity.
- **SDK loading:** the Secrets Manager and SSM SDKs load through dynamic `import()` on first read, not only
  lazy clients. A static import made every `aws()` bundle require the SDK at load, which broke the Node
  runtime test (the SDK is external and not installed there).
- **Tests:** `aws-runtime-variables.test.ts` moved to `packages/aws/test/runtime-variables.test.ts` and uses
  only public `voke` plus `aws()`. `aws-lambda-invoke-transport.test.ts` stays in core (it drives core's
  invoke runtime). New: `packages/aws/test/runtime-variable-iam.test.ts`, `packages/aws/test/sqs.test.ts`,
  `packages/core/test/variables-without-provider.test.ts` (D2). `cloudformation.test.ts` synthesizes models
  through `aws().synthesis.synthesize`.
- **`@voke/testing` unchanged:** D2 covers its provider-less activation.
- **Behaviour change:** a model with no Functions now synthesizes no IAM role (roles are per Function).
  No test asserted the old shared role for that case; plan 003 expects this.
- **Done-criteria matches that are expected:** `grep "@aws-sdk" packages/core/src` matches the
  `defaultBuildExternal = ["@aws-sdk/*"]` bundler pattern in `config.ts` (not an import), and
  `grep "^import .*@voke/" packages/core/src` matches a scaffold template string in `cli.ts:308`.
- **Still known, not in scope:** every Function role still receives every resource's statements
  (least privilege is roadmap v2 phase 5).
