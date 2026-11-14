# Plan 008: Every config setting and public API has exactly one spelling

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Run
> `git diff --stat 3435023 -- packages/core/src packages/core/test packages/aws packages/http packages/remote packages/build examples README.md apps/docs/content docs/stable-public-surface.md docs/serverless-framework-migration.md docs/e2e-testing.md CONTEXT.md`
> and `git status --short`. Plans 009 and 003 land before this one and change most of these
> files; read their final reports first. Expected drift: the core AWS copies are gone
> (009), `secret`/`parameter` Runtime Variable builders are exported from `@voke/aws` and the
> CloudFormation resource builders are imported from `@voke/aws/cloudformation` (009), and
> `handler`, `cloudFormation.handler`, `functions`, `api.function`, `api.routes`, and the
> `provider` option of `voke(...)` are gone (003). Reconcile line numbers and file moves;
> pause if a protected contract or an open decision below is affected.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (wide and mostly mechanical; changes public export lists of four packages and touches many tests)
- **Depends on**: `.factory/plans/009-*.md` (`@voke/aws` reaches parity and core's AWS copies are deleted) and `.factory/plans/003-registry-discovery-and-lambda-entries.md`. Runs before 004, 010, and 005.
- **Category**: tech-debt
- **Planned at**: commit `3435023`, 2026-11-14

## Why this matters

Voke's opinionated-framework ADR says "Each setting has one spelling and each API has one
name", and removals happen without aliases because nothing is released yet. After plans 009
and 003, duplicates still remain: config settings with two spellings, retired authoring and
Gateway names that are still in source, and new duplicates created by the package split
(`toEnvKey` exported from two packages, `@voke/http` aliases, legacy SQS helpers, low-level
Lambda adapters, and the same export-list assertions written in three test files). Each
duplicate doubles what docs, tests, and the Serverless migrator must cover, and after a
first release each one needs a deprecation cycle. Removing them now is cheap.

## Current state

### Governing decisions (quote in review if needed)

- `docs/adr/0007-opinionated-framework.md` (three ADRs currently share number 0007; the file
  may be renumbered, find it by title "Voke is an opinionated framework with one escape hatch
  per layer"): "Each setting has one spelling and each API has one name." It removes "the
  duplicate `cloudFormation.resources` and `cloudFormation.environment` spellings, the `config`
  named export for config files, the `STAGE` environment fallback" and says "The names ADR
  0005 retired but that still exist in source (`defineFunction`, `defineFunctions`, `api`,
  `createGateway`, `createApiApp`, `routeModule`) are deleted or made internal." Escape
  hatches that stay: raw CloudFormation resource definitions in config, Hono middleware on
  the Gateway, per-Function `synthesis` overrides, `build.external`, and the `LocalProvider`
  interface.
- `docs/adr/0005-entrypoint-specific-function-authoring-api.md`: "The old authoring names
  should be removed instead of kept as deprecated aliases because the package is still
  unreleased." Canonical names: `createFunctions`, `fn`, `http`, `sqs`, `route`, `voke`.
- `docs/adr/0007-specialized-provider-and-helper-packages.md`: `voke` is the provider-neutral
  core; `@voke/aws` owns AWS runtime adapters, resource helpers, SQS and authorizer entrypoints,
  local AWS helpers, and CloudFormation synthesis (`@voke/aws/cloudformation`). Specialized
  helpers live in `@voke/schema`, `@voke/http`, `@voke/testing`, `@voke/remote`, `@voke/build`.
  `voke/*` subpaths no longer exist.
- Coordinator decisions (2026-11-14, binding; reversible only by the owner):
  - Core's AWS copies are deleted by plan 009. This plan edits only the surviving copies
    (`packages/aws`, `packages/build`, `packages/remote`, and provider-neutral core files).
  - The `secret`/`parameter` relocation (Runtime Variable builders in `@voke/aws`, resource
    builders in `@voke/aws/cloudformation`) is owned by plan 009, not this plan.
  - The Provider is set only in `voke.config.ts` (`provider: aws()`); plan 003 removes the
    `provider` option from `voke(...)` and fixes examples and the migrator.
  - This plan absorbs the split's new duplicates: remove `sqsEventSource`/`sqsMessageBatch`
    exports (update `CONTEXT.md`), make `@voke/http` `json`/`jsonError` internal, keep
    `toEnvKey` only in `@voke/aws` (an intentional root API change), make
    `createAwsLambdaHandler`/`handleAwsLambdaRequest` internal unless examples need them, and
    deduplicate export-list assertions between the public-surface and package-boundary tests.
  - New ADRs, if any, use the next free ADR number; do not assume 0008/0009 are free.

### Package exports at `3435023`

- `packages/core/package.json` `exports` is `{ ".": "./src/index.ts" }` only. There is no
  `voke/invoke` (or any other `voke/*`) subpath, so retired names in core source are reachable
  only by relative source path from tests.
- Root `voke` runtime exports (`packages/core/src/index.ts`): `InvokeError`, `VokeConfigError`,
  `activateFunctionRegistry`, `createFunctions`, `createHandlerNameFromEntrypoint`,
  `createVokeModel`, `defineConfig`, `fn`, `http`, `invokeRegistryFunction`, `loadVokeConfig`,
  `route`, `toEnvKey` (`index.ts:36`, from `./env-key`), `voke`.
- `@voke/aws` (`packages/aws/src/index.ts:10-75`) exports, among others: `toEnvKey`
  (`:41`, implemented separately in `packages/aws/src/resources.ts:31`),
  `createAwsLambdaHandler`, `handleAwsLambdaRequest` (`:46-52`, from `./lambda`),
  `sqs`, `createSqsEventHandler`, `sqsEventSource`, `sqsMessageBatch` (`:58-75`).
- `@voke/http` (`packages/http/src/index.ts`) exports `ok :25`, `created :31`, `noContent :37`,
  `error :43`, `response :65` (an object grouping the four), and two aliases:
  `json :95` (calls `ok`) and `jsonError :98` (calls `error` with a default code derived from
  status: 404 → `NOT_FOUND`, other 4xx → `BAD_REQUEST`, else `INTERNAL_SERVER_ERROR`; default
  status 500).

### Duplicates this plan removes (facts at `3435023`; 009/003 will move lines)

1. **`resources` and `environment` have two spellings.** `packages/core/src/config.ts`:
   `VokeConfigInput` accepts top-level `environment`/`resources` (`:110-111`) and
   `cloudFormation?: Partial<VokeCloudFormationConfig>` (`:102`), where
   `VokeCloudFormationConfig` (`:50-55`) is `{ out; handler; environment; resources }`.
   `defineCloudFormationConfig` (`:163-182`) merges both:
   ```ts
   environment: { ...input.environment, ...cloudFormation.environment },
   ...
   resources: { ...input.resources, ...cloudFormation.resources },
   ```
   Readers of the resolved shape: `packages/core/src/model.ts:458,532,587`
   (`config.cloudFormation.resources|environment`) and `packages/core/src/dev.ts:109,123`.
   (`model.ts:589`, `packages/build/src/index.ts:64` read `cloudFormation.handler`, which plan
   003 removes.) Public options type: `SynthesizeCloudFormationOptions` in
   `packages/aws/src/cloudformation-synthesis.ts:127-132` is
   `VokeConfigInput & { entrypoint?; handler?; environment?; resources? }`, redundant with
   `VokeConfigInput`.
   Usage of the nested spelling: `README.md:19`, `apps/docs/content/docs/getting-started.mdx:26`,
   `examples/hello-api/voke.config.ts:5`, the migrator template
   `packages/core/src/serverless-migration.ts:2139-2141`, and tests (`cloudFormation: {` in
   `api.test.ts` ×9 and ×2 each in `local`, `model`, `dev`, `error-design`, `cloudformation`
   tests). The scaffold (`packages/core/src/cli.ts:328-342`) already uses only
   `cloudFormation: { out }`. `apps/docs/content/docs/reference/config.mdx:30` describes
   `cloudFormation` as "Resource and output declarations".
2. **Config files have two accepted exports.** `config.ts:268` and `app.ts:224`:
   `module.default ?? module.config`. No example, fixture, or doc uses `export const config`.
3. **Stage has two environment variables.** `config.ts:229-230`:
   `input.stage ?? readEnv("VOKE_STAGE") ?? readEnv("STAGE") ?? "local"`. `voke dev` sets
   `VOKE_STAGE` (`dev.ts:129`).
4. **Retired authoring names are still declared.** `packages/core/src/invoke.ts`:
   `export function defineFunction` overloads `:1997-2034`, `export const fn = defineFunction;`
   `:2091`, `export const defineFunctions` `:2425`, `export const createFunctions = defineFunctions;`
   `:2516`. Tests: 222 occurrences of `defineFunction`/`defineFunctions` in 15 files under
   `packages/core/test` (`invoke.test.ts` 57, `route-builder.test.ts` 26,
   `cloudformation.test.ts` 21, `model.test.ts` 21, `aws-lambda-invoke-transport.test.ts` 15,
   `e2e.test.ts` 12, `aws-runtime-variables.test.ts` 10, `invoke-typecheck.ts` 9,
   `remote-functions.test.ts` 9, and 5 or fewer in `api`, `build`, `model-typecheck`,
   `provider-runtime`, `route-builder-typecheck`, `public-surface`). Some of these files are
   moved or deleted by 009; re-count after it lands.
5. **Retired Gateway entry points are still in source.**
   - `packages/core/src/api.ts` — `api(app, options)` wraps a raw Hono app (`VokeApi`,
     `:18-32`); imported by `packages/core/src/e2e.ts:1,31,309`. Plan 009 may already have
     deleted it (it is AWS-only); `@voke/testing` (`packages/testing/src/index.ts:8`) has its
     own `TestClientTarget` without `VokeApi`.
   - `packages/core/src/app.ts` — `ApiRouteModule :27`, `routes` option on `ApiAppOptions :35`
     and `GatewayOptions :42`, `getApiAppConfig :137`, `createApiApp :140`, `createGateway :169`,
     `routeModule :284`. `voke()` (`:250-282`) is built on `createGateway` → `createApiApp`.
     None of these are root exports; tests reach them by source path (`api.test.ts`,
     `aws-runtime-variables.test.ts`, `e2e.test.ts`, `invoke.test.ts`, `local.test.ts`,
     `public-surface.test.ts`, `remote-functions.test.ts`, `route-builder.test.ts`,
     `route-builder-typecheck.ts`).
6. **`toEnvKey` is exported by two packages.** Root `voke` (`core/src/env-key.ts:1`,
   `index.ts:36`) and `@voke/aws` (`aws/src/resources.ts:31`, `index.ts:41`). Consumers:
   `packages/remote/src/index.ts:8` imports `toEnvKey` from `"voke"`; core-internal users
   (`variables.ts:1`, and `remote.ts`/`serverless-migration.ts` until 009) import `./env-key`
   directly. `@voke/remote` depends on `voke` and `@voke/http`, not on `@voke/aws`, and must not
   start depending on `@voke/aws` (it is provider-neutral).
7. **`@voke/http` aliases** `json`/`jsonError` (see above). Users: `packages/remote/src/index.ts:3`
   (`json` at `:605,637`; `jsonError` at `:619` with `code: "CONTRACT_DRIFT", status: 409`,
   `:630` with `code: "NOT_FOUND", status: 404`, `:649` with no code and status 400 or 500).
   Core's own `packages/core/src/http.ts` copy (used by `app.ts:8,157`, `invoke.ts:13`) is
   internal and stays. Examples use `created`, `error` (`examples/hello-api/src/index.ts:2`,
   `examples/e2e/src/index.ts:2`).
8. **Legacy SQS helpers.** `sqsEventSource` (`aws/src/sqs.ts:253`) and `sqsMessageBatch`
   (`:262`) are exported, but `sqs({...})` (`:309`) is the canonical helper and calls them
   internally (`:298,303,341`). Together with the generic `events` field of a Function
   definition (`core/src/invoke.ts:589`) they form a second spelling of an SQS Function:
   `fn({ events: [sqsEventSource("q")], input: sqsMessageBatch(schema) })` (used in
   `core/test/invoke-typecheck.ts:195-197`, `core/test/model.test.ts:680-682`).
   `public-surface.test.ts` already forbids both names in examples and teaching surfaces.
   `CONTEXT.md:396,431,579,589,590` still present them as primary helpers.
9. **Low-level Lambda adapters are public.** `createAwsLambdaHandler`, `handleAwsLambdaRequest`
   (`aws/src/lambda.ts:18,22`). No example, doc, or README imports them; `aws()` uses
   `createAwsLambdaHandler` internally (`aws/src/index.ts:125`). `docs/stable-public-surface.md`
   says low-level Lambda adapter internals should not be public. Plan 003 adds a public
   `createLambdaHandlers` export to the `@voke/aws` index; that one stays.
10. **Export lists are asserted three times.**
    - Root list: `core/test/public-surface.test.ts:62` and `core/test/package-boundaries.test.ts:10`.
    - `@voke/aws` list: `public-surface.test.ts:83` and `core/test/aws-package-boundaries.test.ts:9`.
    - `@voke/http` list: `public-surface.test.ts:134` and `package-boundaries.test.ts:40`.
    - `@voke/schema` list and `package.json` exports: both files.
    - Unique to the boundary files: `@voke/build` list (`package-boundaries.test.ts:55`) and
      `@voke/aws/cloudformation` list (`aws-package-boundaries.test.ts:40`).
    - `core/test/package-boundaries-typecheck.ts` holds type-level `@ts-expect-error`
      assertions; it is not a duplicate and stays.

### Vocabulary

Use `CONTEXT.md` terms: **Function**, **Function Registry**, **Gateway**, **Voke Project**,
**Provider**, **SQS Event Source**, **SQS Message Batch**. In `fn`, `http`, `sqs`, "name"
means the deployed Lambda name.

## Decisions taken in this plan

| Duplicate                  | Kept                                                 | Removed                                                                                     |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `resources`                | top-level `resources`                                | `cloudFormation.resources`                                                                  |
| `environment`              | top-level `environment`                              | `cloudFormation.environment`                                                                |
| CloudFormation output path | `cloudFormation.out`                                 | — (`cloudFormation` keeps only `out`)                                                       |
| Config export              | `export default defineConfig(...)`                   | `export const config`                                                                       |
| Stage variable             | `VOKE_STAGE`                                         | `STAGE`                                                                                     |
| Invokable Function helper  | `fn`                                                 | `defineFunction`                                                                            |
| Registry helper            | `createFunctions`                                    | `defineFunctions`                                                                           |
| Gateway constructor        | `voke(functions, options)`                           | `api()`, `routeModule()`, `createGateway`/`createApiApp`/`getApiAppConfig`, `routes` option |
| SQS Function               | `sqs({ queue, message, handler })` from `@voke/aws`  | exported `sqsEventSource`, `sqsMessageBatch`                                                |
| Env key helper             | `toEnvKey` from `@voke/aws`                          | root `voke` export `toEnvKey` (**intentional root API change**)                             |
| HTTP response helpers      | `ok`, `created`, `noContent`, `error`, `response`    | exported `json`, `jsonError`                                                                |
| Lambda adapter             | `aws()` provider (+ `createLambdaHandlers` from 003) | exported `createAwsLambdaHandler`, `handleAwsLambdaRequest`                                 |
| Export-list assertions     | `core/test/public-surface.test.ts`                   | duplicated lists in `package-boundaries.test.ts`, `aws-package-boundaries.test.ts`          |

Top-level `resources` and `environment` win because they are shorter and sit next to `name`
and `region`; the deployment engine's name does not belong in the everyday config shape.

## Commands you will need

| Purpose           | Command                                           | Expected on success            |
| ----------------- | ------------------------------------------------- | ------------------------------ |
| Install           | `bun install`                                     | exit 0                         |
| Core tests        | `cd packages/core && bun test`                    | 0 fail                         |
| One test file     | `cd packages/core && bun test test/model.test.ts` | all pass                       |
| AWS tests         | `cd packages/aws && bun test`                     | 0 fail                         |
| Package typecheck | `cd packages/<name> && bun run typecheck`         | exit 0                         |
| Repo gates        | `bun run typecheck && bun run test`               | exit 0 (turbo, all workspaces) |
| Lint/format       | `bun run check`                                   | exit 0                         |
| Autofix           | `bun x ultracite fix`                             | exit 0                         |

## Implementation rules relevant to this plan

- No aliases, no deprecation warnings, no compatibility shims. A removed spelling is a
  TypeScript error. Where a runtime value can still arrive (config objects from JS, env vars),
  `defineConfig` rejects it with `VokeConfigError.validation([{ path, message }])` (pattern:
  `defineNodeRuntime` in `config.ts`) naming the replacement, for example at path
  `cloudFormation.resources`: `"cloudFormation.resources" was removed; declare resources at the top level: resources: { ... }`.
- Behavior must not change. Every test asserting behavior that still exists is kept and ported
  to the kept spelling. A test may be deleted only when its subject is a removed item in the
  table above; list each deleted test in the final report.
- Do renames mechanically and separately from behavior edits: one commit-sized unit per step.
- Core `src` must not import any `@voke/*` package (workspace cycle that turbo rejects). Core
  tests resolve `@voke/*` through `paths` in `packages/core/tsconfig.json`; do not add them as
  dependencies.
- Runtime code must not use the `Bun` global; use `readEnv` from `core/src/runtime-env.ts`.
- `docs/stable-public-surface.md` and `core/test/public-surface.test.ts` change together.
- Ultracite style applies to edited tests and generated templates.
- Do not edit ADRs, `docs/reviews/**`, or other plans; they are historical records.

## Scope

**In scope**:

- `packages/core/src/config.ts`, `model.ts`, `dev.ts`, `app.ts`, `invoke.ts` (names only),
  `index.ts` (drop `toEnvKey`), `cli.ts` (scaffold only if it uses a removed spelling),
  `serverless-migration.ts` (generated config template only), `e2e.ts` and `api.ts` only if
  they still exist after 009
- `packages/aws/src/index.ts`, `sqs.ts`, `cloudformation-synthesis.ts` (options type only),
  `lambda.ts` (export visibility only)
- `packages/http/src/index.ts`
- `packages/remote/src/index.ts` (replace `json`/`jsonError`/`toEnvKey` imports only)
- `packages/build/src/index.ts` (config reads only, if any `cloudFormation.*` read survives 003)
- `packages/*/test/**` (spelling and name ports; deletions limited as described)
- `examples/**/voke.config.ts`, `examples/**/src/*.ts`
- `README.md`, `apps/docs/content/docs/**`, `docs/stable-public-surface.md`,
  `docs/serverless-framework-migration.md`, `docs/e2e-testing.md`
- `CONTEXT.md` — only the SQS lines naming `sqsEventSource()`/`sqsMessageBatch()`
- `.factory/plans/README.md` (status only, unless the coordinator owns it)

**Out of scope**:

- Moving `secret`/`parameter`/resource builders between `@voke/aws` and
  `@voke/aws/cloudformation` (plan 009 / issue #36). Use whatever import paths 009 left.
- Setting `provider: aws()` in examples and the migrator, and removing the `provider` option
  of `voke(...)` (plan 003).
- `runtime.lambda` (moves to provider options in plan 005) and `local.provider` (removed in
  plan 010); `cloudFormation.out` placement (see open decision).
- Core-internal `packages/core/src/http.ts` and `env-key.ts`: internal helpers, not exported.
- Renaming `synthesis`, `runtime`, `local`, `remotes`, `build`, or `dev` settings; any new setting.
- ADRs and other plans.

## Git workflow

- Branch: `feature/one-spelling-per-setting`
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `resources` and `environment` at the top level only

- `VokeConfigInput`: keep top-level `resources` and `environment`; `cloudFormation` accepts
  only `{ out?: string }`.
- `VokeConfig` (resolved): add top-level `resources` and `environment`;
  `VokeCloudFormationConfig` becomes `{ out: string }` (003 already removed `handler`; if it
  did not, STOP). Update every reader: `grep -rn "cloudFormation\.\(environment\|resources\)" packages/*/src`
  (at `3435023`: `model.ts:458,532,587`, `dev.ts:109,123`).
- `SynthesizeCloudFormationOptions` (`aws/src/cloudformation-synthesis.ts:127-132`) becomes
  `VokeConfigInput` (or a type alias of it) without redundant members; keep the exported name.
- `defineConfig` rejects `cloudFormation.resources` and `cloudFormation.environment` with the
  replacement message.
- Port tests, `examples/hello-api/voke.config.ts`, `README.md`, `getting-started.mdx`,
  `reference/config.mdx`, and the migrator template (`serverless-migration.ts` emits
  `environment: {...},` and `resources: {...},` at the top level of `defineConfig`).

**Evidence**: `grep -rnE "cloudFormation: \{" packages examples README.md apps/docs/content --include='*.ts' --include='*.md' --include='*.mdx' | grep -v dist`
shows only blocks whose sole key is `out` (inspect each hit).

### Step 2: Default export only; `VOKE_STAGE` only

- `config.ts` `loadVokeConfig` and `app.ts` runtime config loading: use `module.default` only.
  Keep the message "Voke config must export a default config from <path>".
- `defineConfig`: `stage = input.stage ?? readEnv("VOKE_STAGE") ?? "local"`.

### Step 3: One name per authoring helper

- In `core/src/invoke.ts`, make `fn` and `createFunctions` the declared functions (keep the
  overload signatures and generics exactly) and delete `defineFunction`/`defineFunctions`.
  Root exports do not change (they already export `fn`/`createFunctions`).
- Rename in tests mechanically (`defineFunctions(` → `createFunctions(`, `defineFunction(` →
  `fn(`, import specifiers), then typecheck: a local variable already named `fn` collides and
  must be renamed by hand.
- No public-surface assertion is needed for the old names (no subpath exposes `invoke.ts`);
  the evidence grep is the guard.

**Evidence**: `grep -rnE "\bdefineFunctions?\b" packages examples apps/docs/content README.md --exclude-dir=dist --exclude-dir=node_modules`
→ no matches.

### Step 4: One Gateway constructor

- If `core/src/api.ts` still exists, delete it and remove `VokeApi` from `TestClientTarget` in
  `core/src/e2e.ts` (match `@voke/testing`'s `TestClientTarget`).
- In `app.ts`, remove `routeModule`, `ApiRouteModule`, and the `routes` option. Fold
  `createApiApp`/`createGateway`/`getApiAppConfig` into non-exported helpers used by `voke()`;
  keep their behavior (config on `c.env.VOKE_CONFIG`, middleware order, 404 JSON error, error
  handler, unique-route and param-schema assertions, registry activation, dev endpoints).
- Port tests that used `createGateway`/`createApiApp`/`api()` to `voke(...)` when they assert
  kept behavior. Delete only tests whose subject is `api()` itself, `routeModule`, or mounting
  raw Hono route modules. The documented escape hatch is `voke(functions, { middleware })`.

**Evidence**: `grep -rnE "\b(createGateway|createApiApp|routeModule|getApiAppConfig|VokeApi)\b|src/api\"" packages`
→ no matches; `ls packages/core/src/api.ts` fails.

### Step 5: Remove split-era duplicate exports

- **`toEnvKey`**: remove the root export (`core/src/index.ts`). Core keeps `env-key.ts` for
  internal use. `@voke/aws` keeps its export. In `@voke/remote`, replace the `"voke"` import
  with a private, non-exported `toEnvKey` in `packages/remote/src` (same 5-line
  implementation as `aws/src/resources.ts:31-36`); do not add an `@voke/aws` dependency.
  Report this in the final report as an intentional root API change.
- **`@voke/http`**: make `json` and `jsonError` non-exported (delete them; nothing else in the
  package uses them). In `@voke/remote`, use `ok(...)` for `json(...)` and `error(...)` for
  `jsonError(...)` with the same codes and statuses; the call at `:649` has no code, so pass
  `code: error instanceof InvokeError ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR"` to keep the
  response body identical.
- **SQS**: stop exporting `sqsEventSource` and `sqsMessageBatch` from `@voke/aws` (keep them as
  module-private helpers used by `sqs()`; also drop `SqsEventSourceOptions`-style types from the
  index only if nothing public references them). Port tests that build SQS Functions with
  `fn({ events: [sqsEventSource(...)], input: sqsMessageBatch(...) })` to `sqs({ queue, message, handler })`
  when they assert kept behavior; delete only tests whose subject is the two helpers themselves.
  Update `CONTEXT.md:396,431,579,589,590` to name `sqs()` (`queue`/`queues`, `message`,
  `invalidMessageBody`) instead; keep the meaning of each line.
- **Lambda adapters**: stop exporting `createAwsLambdaHandler` and `handleAwsLambdaRequest` from
  the `@voke/aws` index (keep them in `lambda.ts` for internal use and package tests by source
  path). If any example, doc, or plan-003 generated Lambda entry imports either name, STOP.

**Evidence**: `grep -rnE "\b(sqsEventSource|sqsMessageBatch|createAwsLambdaHandler|handleAwsLambdaRequest|jsonError)\b" examples README.md apps/docs/content docs/*.md CONTEXT.md --exclude-dir=dist`
→ no matches; `grep -n toEnvKey packages/core/src/index.ts` → no matches.

### Step 6: One owner for export-list assertions

- `core/test/public-surface.test.ts` is the single place that asserts each package's runtime
  export list (root, `@voke/aws`, `@voke/aws/cloudformation`, `@voke/aws/local`,
  `@voke/aws/testing`, `@voke/build`, `@voke/http`, `@voke/remote`, `@voke/schema`,
  `@voke/testing`) and `packages/core/package.json` exports. Move the `@voke/build` and
  `@voke/aws/cloudformation` assertions into it, then delete the duplicate list tests in
  `package-boundaries.test.ts` and `aws-package-boundaries.test.ts` (delete the files if
  nothing else remains). Keep `package-boundaries-typecheck.ts`.
- Update the lists for steps 3–5: root without `toEnvKey`; `@voke/aws` without
  `createAwsLambdaHandler`, `handleAwsLambdaRequest`, `sqsEventSource`, `sqsMessageBatch`;
  `@voke/http` = `created`, `error`, `noContent`, `ok`, `response`.

**Evidence**: `grep -rln "toSorted()).toEqual(\[" packages/core/test` lists only
`public-surface.test.ts` among surface tests.

### Step 7: Docs

- `docs/stable-public-surface.md`: drop `voke/api`/`voke/app` and the pre-stable names where they
  no longer exist in source; make sure the `@voke/aws` section lists `sqs` and
  `createSqsEventHandler` but not `sqsEventSource`, `sqsMessageBatch`, or the Lambda
  adapters, and that no section lists `toEnvKey` on the root or `json`/`jsonError`; state the
  single-spelling rule with a link to the opinionated-framework ADR.
- `apps/docs/content/docs/reference/config.mdx`: one table, one spelling per setting, as present
  after 003: `name`, `stage`, `region`, `entrypoint`, `provider`, `resources`, `environment`,
  `build`, `cloudFormation.out`, `runtime`, `local`, `remotes`, `api.name`, `dev`. (`runtime` and
  `local` change in 005/010; describe them as they are now.)
- `README.md`, `getting-started.mdx`: top-level `resources` in every config snippet.
- `docs/serverless-framework-migration.md`: generated config shape.

## Test plan

- `core/test/error-design.test.ts`: removal messages for `cloudFormation.resources` and
  `cloudFormation.environment`.
- `core/test/config-typecheck.ts`: `cloudFormation: { resources: {} }` is a type error
  (`// @ts-expect-error`); top-level `resources` typechecks.
- `model`, `cloudformation` (or its `packages/aws/test` successor after 009), `dev`, `local`
  tests: same assertions with top-level spelling; resolved config exposes `config.resources`
  and `config.environment`.
- Config loading: a module with only `export const config` fails with the default-export
  message; `STAGE=prod` alone leaves stage `local`; `VOKE_STAGE=prod` sets it. Use the env
  helpers in `packages/core/test/support/env.ts` / `isolate-env.ts`.
- `public-surface.test.ts`: updated lists (step 6); a test that `"toEnvKey" in voke` is false.
- Remote: an existing remote-functions test (or a new one) asserts the drift (409
  `CONTRACT_DRIFT`), not-found (404 `NOT_FOUND`), and failure envelopes are unchanged after
  replacing `jsonError`.
- `serverless-migration.test.ts`: generated `voke.config.ts` uses top-level `resources` and
  `environment` and still typechecks.
- Ported Gateway and SQS tests keep their assertions; the final report lists every deleted test
  with the removed item it covered.

## Done criteria

- [ ] Every step's evidence grep returns the stated result
- [ ] `grep -rn "module.config" packages/*/src` and `grep -rnE "readEnv\(\"STAGE\"\)|env\.STAGE\b" packages/*/src` return no matches
- [ ] `bun run typecheck`, `bun run test`, and `bun run check` exit 0 for the whole repository, including examples
- [ ] Passing test count is not lower than before this plan minus the deleted tests listed in the report
- [ ] `voke migrate serverless` output for the fixtures uses the kept spellings and typechecks
- [ ] README, getting started, config reference, `docs/stable-public-surface.md`, and `CONTEXT.md` show one spelling per setting and API
- [ ] The final report names the root API change (`toEnvKey` removed from `voke`)
- [ ] No files outside the in-scope list are modified (`git status --short`)

## STOP conditions

- Plan 009 or 003 has not landed, or core AWS copies (`core/src/cloudformation.ts`,
  `aws-lambda.ts`, SQS code in `invoke.ts`) still exist: this plan would have to edit two copies.
- `cloudFormation.handler` or top-level `handler` still exists (003 incomplete).
- A test of `createGateway`, `createApiApp`, or `api()` asserts behavior that `voke(...)` cannot
  express (for example mounting an arbitrary Hono sub-app at a base path) and a first-party
  example or doc relies on it.
- An example, doc, or generated Lambda entry imports `createAwsLambdaHandler`,
  `handleAwsLambdaRequest`, `sqsEventSource`, `sqsMessageBatch`, `json`, or `jsonError`, and
  has no equivalent using the kept API.
- A package outside `@voke/remote` imports `toEnvKey` from root `voke` and cannot reasonably
  use a private copy or `@voke/aws`.
- The mechanical rename changes a test's meaning (for example a test checking both names are
  the same function): delete it and list it.

## Maintenance notes

- Review rule from the opinionated-framework ADR: a new option needs a use case that neither
  the default nor the layer's escape hatch covers. `public-surface.test.ts` (now the single
  export-list owner) and `config-typecheck.ts` are the guards.
- Plan 005 moves `runtime.lambda` into `aws({ lambda: ... })`; plan 010 removes `local.provider`.
  Both must keep `config-typecheck.ts` and the config reference table in sync.
- Reviewers should scrutinize deleted tests (each must map to a removed item), the resolved
  config shape change (`config.resources`, `config.environment`) in every reader including
  `@voke/aws` local and testing helpers, and that `@voke/remote` responses are byte-identical
  after the `jsonError` replacement.
- `toEnvKey` now has three implementations (core internal, `@voke/aws`, `@voke/remote`
  private). If they must stay in sync, a later plan can move it to a shared provider-neutral
  package; not done here to avoid a new export.
- Open decision for the owner (not blocking): `cloudFormation.out` is an AWS-only setting in core
  config, which conflicts with the rule that AWS-only settings live in provider options
  (`aws({ ... })`). This plan keeps it unchanged; plan 005 or a follow-up should decide whether it
  becomes `aws({ cloudFormation: { out } })` or a provider-neutral synth output setting.

## Execution notes (2026-11-14)

Done on branch `feature/one-spelling-per-setting`, stacked on plan 003's branch (PR #53, open). Uncommitted.
Gates: `bun run check` 0 errors, `bun run typecheck` 18/18, `bun run test` 23/23 tasks (core 222,
`@voke/aws` 38, `@voke/build` 4, `@voke/remote` 2, examples all green).

**Intentional root API change:** `toEnvKey` is no longer exported from `voke`; use `@voke/aws`.
`@voke/remote` has a private copy.

Delivered, per step:

1. `resources` and `environment` are top-level only; `cloudFormation` holds only `out`. The resolved config
   exposes `config.resources` and `config.environment`. `cloudFormation.resources` /
   `cloudFormation.environment` are rejected with the top-level replacement. `SynthesizeCloudFormationOptions`
   is `VokeConfigInput & { functions? }`. Examples, README, getting started and the migrator template moved.
2. Config files need `export default`; the stage reads `VOKE_STAGE` only (no `STAGE`).
3. `fn` and `createFunctions` are the declared names; `defineFunction`/`defineFunctions` are gone (tests
   renamed mechanically, 11 files).
4. `api()` (`core/src/api.ts`), `routeModule`, the `routes` option, and exported `createGateway` /
   `createApiApp` / `getApiAppConfig` are gone; `voke()` builds the Gateway through a private helper.
   `core/src/e2e.ts` (frozen until 010) now accepts `{ app }` instead of `VokeApi`.
5. `@voke/aws` no longer exports `sqsEventSource`, `sqsMessageBatch`, `createAwsLambdaHandler`,
   `handleAwsLambdaRequest` (types `AwsLambda*` stay). `@voke/http` no longer exports `json`, `jsonError`
   (and the unused `JsonBody`/`JsonErrorBody` types). `CONTEXT.md` SQS lines name `sqs()`.
6. `core/test/public-surface.test.ts` owns every export list; `package-boundaries.test.ts` and
   `aws-package-boundaries.test.ts` are deleted.
7. Config reference is one table, one spelling per setting; `docs/stable-public-surface.md` states the rule;
   migration doc describes the top-level config.

Deleted tests (each covered a removed item):

- `api.test.ts`: "wraps a Hono app with a default name and handler" (`api()`), "uses createApiApp config
  metadata when wrapping a Hono app" (`createApiApp`/`api()`).
- `package-boundaries.test.ts` (5) and `aws-package-boundaries.test.ts` (2): duplicate export-list
  assertions; the build and `@voke/aws/cloudformation` lists moved into `public-surface.test.ts`.

Ported, not deleted: the Lambda v2 GET/POST tests now go through `voke()` + `createLambdaHandlers`;
"composes route modules and exposes config/context helpers" became "exposes config and Lambda context
helpers to Gateway middleware" (the `routeModule` part was the removed item); SQS tests use `sqs()`; the
fn() mixed-SQS guard test takes its event source and batch schema from a real `sqs()` definition.

Added: removal-message, `VOKE_STAGE`, default-export tests in `error-design.test.ts`; type checks in
`config-typecheck.ts`; `packages/remote/test/dev-endpoints.test.ts` pins the 200/409/404/400/500 envelopes
after the `jsonError` replacement (its `test` script no longer passes `--pass-with-no-tests`).

Evidence greps: the only remaining hits for removed names are the guard lists in `public-surface.test.ts`
and the removal tests themselves. Out-of-scope touches: `packages/aws/test/route-auth.test.ts` (local helper
renamed from `createGateway`), `packages/remote/package.json` (test script).

Drift note: the STOP condition about core `cloudformation.ts`/`aws-lambda.ts` existing was reconciled with
plan 009 D5 — they are retained on purpose until 010, and this plan made no edits to them.
