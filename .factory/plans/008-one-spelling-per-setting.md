# Plan 008: Every config setting and authoring API has exactly one spelling

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare `git diff --stat a7741eb -- packages/core/src packages/core/test examples README.md apps/docs/content docs`
> and `git status --short` with the recorded current state. Plans 002 and 003 land before this
> one and change the same files; read their results first. Reconcile routine drift; pause
> dependent work if drift invalidates scope, a protected contract, or an unresolved product or
> permission decision.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (wide, mostly mechanical; touches many tests)
- **Depends on**: `.factory/plans/003-registry-discovery-and-lambda-entries.md`. Run before plan 005. Can run alongside plan 004 if the two coordinate on `cloudformation.ts`.
- **Category**: tech-debt
- **Planned at**: commit `a7741eb`, 2026-11-14

## Why this matters

ADR 0007 makes Voke an opinionated framework: one supported way per layer, no aliases while the
package is unreleased. Plans 002 and 003 remove the big alternatives (the Bun build target, the
config-first registry, the single-function mode). What remains is smaller duplication that still
makes two Voke projects look different and doubles what docs, tests, and the migrator must
cover: settings with two spellings, authoring helpers with two names, and entry points that ADR
0005 retired but that are still in source. Removing them now is cheap; after a first release each
one needs a deprecation cycle.

## Current state

Decisions that govern this plan (quote them in code review if needed):

- `docs/adr/0007-opinionated-framework.md`: "Each setting has one spelling and each API has one
  name." It removes "the duplicate `cloudFormation.resources` and `cloudFormation.environment`
  spellings, the `config` named export for config files, the `STAGE` environment fallback" and
  says "The names ADR 0005 retired but that still exist in source (`defineFunction`,
  `defineFunctions`, `api`, `createGateway`, `createApiApp`, `routeModule`) are deleted or made
  internal." Escape hatches that stay: raw CloudFormation resource definitions in config, Hono
  middleware on the Gateway, per-Function `synthesis` overrides, `build.external`, and the
  `LocalProvider` interface.
- `docs/adr/0005-entrypoint-specific-function-authoring-api.md`: "The old authoring names should
  be removed instead of kept as deprecated aliases because the package is still unreleased."
  The canonical names are `createFunctions`, `fn`, `http`, `sqs`, `route`, `voke`.

Facts at commit `a7741eb` (plans 002 and 003 will have changed some line numbers):

1. **Resources and environment have two spellings.** `packages/core/src/config.ts:123-143`:
   ```ts
   environment: { ...input.environment, ...cloudFormation.environment },
   ...
   resources: { ...input.resources, ...cloudFormation.resources },
   ```
   `VokeConfigInput` accepts both `resources`/`environment` at the top level (`config.ts:86-87`)
   and inside `cloudFormation` (`config.ts:79`, type `VokeCloudFormationConfig` at `:44-49`).
   The resolved config exposes them as `config.cloudFormation.environment` and
   `config.cloudFormation.resources`, read in `packages/core/src/model.ts:434,514` and
   `packages/core/src/dev.ts:89`.
   Usage: README (`README.md:18-23`), `apps/docs/content/docs/getting-started.mdx`,
   `examples/hello-api/voke.config.ts`, and the migrator (`packages/core/src/serverless-migration.ts:2139-2141`)
   use `cloudFormation: { resources, environment }`. Tests use both: `cloudFormation: {` appears 19
   times across `test/api.test.ts`, `local.test.ts`, `model.test.ts`, `dev.test.ts`,
   `error-design.test.ts`, `cloudformation.test.ts`; top-level `resources:`/`environment:` appears
   about 27 times across `local`, `model`, `e2e`, `serverless-migration`, `dev`, `cloudformation`,
   `bindings`, `api` tests and `model-typecheck.ts`. The scaffold (`packages/core/src/cli.ts:328-342`)
   uses only `cloudFormation: { out }`.
2. **Config files have two accepted exports.** `config.ts:226` and `packages/core/src/app.ts:216`:
   `module.default ?? module.config`. No example, test fixture, or doc uses `export const config`.
3. **Stage has two environment variables.** `config.ts:189`:
   `input.stage ?? Bun.env.VOKE_STAGE ?? Bun.env.STAGE ?? "local"` (plan 002 changes `Bun.env` to
   the runtime-env helper). `voke dev` sets `VOKE_STAGE` (`packages/core/src/dev.ts:100`).
4. **Retired authoring names are still exported.** `packages/core/src/invoke.ts`:
   `export function defineFunction` (`:1772-1797`), `export const fn = defineFunction;` (`:1854`),
   `export const defineFunctions` (`:2175`), `export const createFunctions = defineFunctions;` (`:2262`).
   `voke/invoke` is a public subpath, so both names are importable. No example or doc uses the old
   names. Tests use them heavily: about 170 occurrences of `defineFunction`/`defineFunctions`
   across 13 test files (`invoke.test.ts` 42, `route-builder.test.ts` 26, `model.test.ts` 18,
   `cloudformation.test.ts` 16, `aws-lambda-invoke-transport.test.ts` 15, `e2e.test.ts` 12, and others).
5. **Retired entry points are still in source.**
   - `packages/core/src/api.ts` — `api(app, options)` wraps a raw Hono app (`VokeApi`). Imported by
     `packages/core/src/e2e.ts:1` (`import type { VokeApi } from "./api"`, part of `TestClientTarget`
     at `e2e.ts:29`).
   - `packages/core/src/app.ts` — `createApiApp` (`:136`), `createGateway` (`:165`),
     `getApiAppConfig` (`:133`), `routeModule` (`:261`), `ApiRouteModule` (`:27`), and the `routes`
     option on `ApiAppOptions`/`GatewayOptions` (`:35,42`). `voke()` (`:236-259`) is built on
     `createGateway` → `createApiApp`.
   - `docs/stable-public-surface.md` already says the root should not export `api()`,
     `createGateway()`, `createApiApp()`, `routeModule()`, and that `voke/app`, `voke/api` are not
     package subpaths. They are reachable only by source path, which tests use
     (`test/api.test.ts`, `test/route-builder.test.ts`, `test/e2e.test.ts`,
     `test/remote-functions.test.ts`, `test/invoke.test.ts`, `test/public-surface.test.ts`).
6. Issue #36 (PRD, open) plans to move the resource builders (`dynamodbTable`, `sqsQueue`, ...)
   from `voke/aws` to `voke/cloudformation`. That is a separate change; this plan does not move
   import paths.
7. `CONTEXT.md` vocabulary to keep using: **Function**, **Function Registry**, **Gateway**,
   **Voke Project**. In `fn`, `http`, `sqs`, "name" means the deployed Lambda name.

## Decisions taken in this plan

| Duplicate                  | Kept                               | Removed                                                                              |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `resources`                | top-level `resources`              | `cloudFormation.resources`                                                           |
| `environment`              | top-level `environment`            | `cloudFormation.environment`                                                         |
| CloudFormation output path | `cloudFormation.out`               | — (the `cloudFormation` block keeps only `out`)                                      |
| Config export              | `export default defineConfig(...)` | `export const config`                                                                |
| Stage variable             | `VOKE_STAGE`                       | `STAGE`                                                                              |
| Invokable Function helper  | `fn`                               | `defineFunction`                                                                     |
| Registry helper            | `createFunctions`                  | `defineFunctions`                                                                    |
| Gateway constructor        | `voke(functions, options)`         | `api()`, `routeModule()`, public `createGateway`/`createApiApp`, the `routes` option |

Top-level `resources` and `environment` win because they are shorter, they are what a reader
expects next to `name` and `region`, and the deployment engine's name does not belong in the
everyday config shape. This means the README, docs, example, and migrator change to the
top-level spelling.

## Commands you will need

| Purpose        | Command                                           | Expected on success |
| -------------- | ------------------------------------------------- | ------------------- |
| Install        | `bun install`                                     | exit 0              |
| Core tests     | `cd packages/core && bun test`                    | all pass            |
| One test file  | `cd packages/core && bun test test/model.test.ts` | all pass            |
| Core typecheck | `cd packages/core && bun run typecheck`           | exit 0              |
| Repo gates     | `bun run typecheck && bun run test`               | exit 0              |
| Lint/format    | `bun run check`                                   | exit 0              |
| Autofix        | `bun x ultracite fix`                             | exit 0              |

## Implementation rules relevant to this plan

- No aliases, no deprecation warnings, no compatibility shims. A removed spelling is a
  TypeScript error, and where a runtime value can still arrive (config objects, environment
  variables are not checked) `defineConfig` rejects it with `VokeConfigError.validation` whose
  message names the replacement, for example at path `cloudFormation.resources`:
  `"cloudFormation.resources" was removed; declare resources at the top level: resources: { ... }`.
- Behavior must not change. Every test that asserts behavior which still exists is kept and
  ported to the kept spelling. A test may be deleted only when the thing it asserts is one of the
  removed items in the table above; list each deleted test in the final report.
- Do the renames mechanically and separately from behavior edits, so the diff is reviewable:
  one commit-sized unit per step.
- Root `voke` exports do not change. `docs/stable-public-surface.md` and
  `test/public-surface.test.ts` are updated together.
- Runtime code must not use the `Bun` global (plan 002).
- Ultracite style applies to edited tests and generated templates.

## Scope

**In scope**:

- `packages/core/src/config.ts`, `model.ts`, `dev.ts`, `cloudformation.ts` (option types only), `app.ts`, `invoke.ts` (names only), `e2e.ts` (`TestClientTarget`), `local.ts` (config reads only), `cli.ts` (scaffold template if it uses a removed spelling)
- `packages/core/src/api.ts` (delete)
- `packages/core/src/serverless-migration.ts` (generated config template only)
- `packages/core/test/**` (spelling and name ports; deletions limited as described)
- `examples/**/voke.config.ts`, `examples/**/src/*.ts`, `examples/serverless-migration/**`
- `README.md`, `apps/docs/content/docs/**`, `docs/stable-public-surface.md`, `docs/serverless-framework-migration.md`, `docs/e2e-testing.md`
- `.factory/plans/README.md` (status only)

**Out of scope**:

- Moving resource builders between `voke/aws` and `voke/cloudformation` (issue #36).
- `json` and `jsonError` in `packages/core/src/http.ts`: internal helpers used by `app.ts` and
  `invoke.ts`, not reachable through a package subpath.
- Renaming `synthesis`, `runtime`, `local`, `remotes`, or `build` settings.
- Any new setting. Plan 005 adds `runtime.*` and `api.cors` after this plan.
- `CONTEXT.md` and existing ADRs.

## Git workflow

- Branch: `feature/one-spelling-per-setting`
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `resources` and `environment` at the top level only

- `VokeConfigInput`: keep top-level `resources` and `environment`; `cloudFormation` accepts only
  `{ out?: string }`.
- `VokeConfig` (resolved): add `resources` and `environment` at the top level;
  `VokeCloudFormationConfig` becomes `{ out: string }`. Update readers
  (`model.ts`, `dev.ts`, `local.ts`, and any `config.cloudFormation.resources|environment` use).
- `SynthesizeCloudFormationOptions` (`cloudformation.ts:54-59`) drops its redundant
  `environment`/`resources`/`handler` members if `VokeConfigInput` already provides them.
- `defineConfig` rejects `cloudFormation.resources` and `cloudFormation.environment` with the
  replacement message.
- Port tests, the example config, README, getting started, config reference, and the migrator
  template (`serverless-migration.ts:2139-2141` emits
  `environment: {...},` and `resources: {...},` at the top level).

**Evidence**: `grep -rnE "cloudFormation: \{" packages/core examples README.md apps/docs/content`
shows only blocks whose sole key is `out`.

### Step 2: Default export only; `VOKE_STAGE` only

- `config.ts` `loadVokeConfig` and `app.ts` `loadRuntimeConfig`: use `module.default`. When it is
  missing, the existing message "Voke config must export a default config from <path>" stays.
- `defineConfig`: stage is `input.stage ?? VOKE_STAGE ?? "local"`. Remove the `STAGE` read.
- Tests: a config module with only `export const config` fails with the default-export message;
  `STAGE=prod` alone does not change the stage; `VOKE_STAGE=prod` does.

### Step 3: One name per authoring helper

- In `invoke.ts`, make `fn` and `createFunctions` the declared functions (keep the overload
  signatures and generics exactly) and delete the `defineFunction`/`defineFunctions` exports.
- Rename in tests with a mechanical replace (`defineFunctions(` → `createFunctions(`,
  `defineFunction(` → `fn(`, and the import specifiers), then run typecheck: a local variable
  already named `fn` in a test will collide and must be renamed by hand.
- `test/public-surface.test.ts`: assert `voke/invoke` no longer exports the old names.

**Evidence**: `grep -rnE "\bdefineFunctions?\b" packages examples apps/docs/content README.md`
returns no matches (ADR 0005 and other files under `docs/adr/` and `docs/reviews/` are historical
records and are not edited).

### Step 4: One Gateway constructor

- Delete `packages/core/src/api.ts`. Remove `VokeApi` from `TestClientTarget` in `e2e.ts`; the
  test client accepts a Gateway from `voke(...)`, a deployed URL, and whatever other targets
  exist today that are not `api()` objects.
- In `app.ts`, remove `routeModule`, `ApiRouteModule`, and the `routes` option. Fold
  `createApiApp`/`createGateway`/`getApiAppConfig` into non-exported helpers used by `voke()`;
  keep the behavior they implement (config on `c.env.VOKE_CONFIG`, middleware order, 404 JSON
  error, error handler, unique-route and param-schema assertions, registry activation, dev
  endpoints).
- Port tests that used `createGateway`/`createApiApp`/`api()` to `voke(...)` when they assert
  kept behavior (middleware, 404, error mapping, Lambda handler shape, request context). Delete
  only tests whose subject is `api()` itself, `routeModule`, or mounting raw Hono route modules.
- A user who needs raw Hono behavior uses the documented escape hatch: `voke(functions, { middleware })`.

**Evidence**: `grep -rnE "\b(createGateway|createApiApp|routeModule|getApiAppConfig)\b|from \"\.\./src/api\"" packages/core`
returns no matches; `ls packages/core/src/api.ts` fails.

### Step 5: Docs

- `docs/stable-public-surface.md`: remove the mention of `voke/api` and of the pre-stable names
  as things that "should not be exported" where they no longer exist at all; state the single
  spelling rule with a link to ADR 0007.
- `apps/docs/content/docs/reference/config.mdx`: one table of settings, each with one spelling:
  `name`, `stage`, `region`, `entrypoint`, `resources`, `environment`, `build`, `cloudFormation.out`,
  `runtime`, `local`, `remotes`, `api.name`.
- `README.md` and `apps/docs/content/docs/getting-started.mdx`: top-level `resources` in every
  config snippet.
- `docs/serverless-framework-migration.md`: generated config shape.

## Test plan

- `test/error-design.test.ts`: removal messages for `cloudFormation.resources` and
  `cloudFormation.environment`.
- `test/config-typecheck.ts`: `cloudFormation: { resources: {} }` is a type error
  (`// @ts-expect-error`), top-level `resources` typechecks.
- `test/model.test.ts`, `test/cloudformation.test.ts`, `test/dev.test.ts`, `test/local.test.ts`:
  same assertions as before with top-level spelling; resolved config exposes `config.resources`.
- Config loading: default-export-only and `VOKE_STAGE`-only cases (step 2), using the env helper
  from plan 001 (`packages/core/test/support/env.ts`).
- `test/public-surface.test.ts`: `voke/invoke` export list without the retired names; root
  exports unchanged.
- `test/serverless-migration.test.ts`: generated `voke.config.ts` uses top-level `resources` and
  `environment`; generated project still typechecks.
- Ported Gateway tests keep their assertions; the final report lists every deleted test with the
  removed item it covered.

## Done criteria

- [ ] Each evidence grep in steps 1, 3, and 4 returns the stated result
- [ ] `grep -rn "module.config" packages/core/src` returns no matches; `grep -rnE "env\.STAGE\b|readEnv\(\"STAGE\"\)" packages/core/src` returns no matches
- [ ] `cd packages/core && bun test` → 0 fail; the number of passing tests is not lower than before this plan minus the deleted tests listed in the report
- [ ] `bun run typecheck` and `bun run check` exit 0 for the whole repository, including examples
- [ ] `voke migrate serverless` output for the fixtures uses the kept spellings and typechecks
- [ ] README, getting started, config reference, and `docs/stable-public-surface.md` show one spelling per setting
- [ ] No files outside the in-scope list are modified

## STOP conditions

- A test of `createGateway`, `createApiApp`, or `api()` asserts behavior that `voke(...)` cannot
  express (for example mounting an arbitrary Hono sub-app at a base path) and that a first-party
  example or doc relies on. Report it; the owner decides whether it becomes a supported option
  or is dropped.
- `VokeApi`/`api()` is used by `voke/testing` consumers in `examples/` in a way that has no
  Gateway equivalent.
- Removing `cloudFormation.resources` conflicts with work already merged for issue #36.
- The mechanical rename changes a test's meaning (for example a test that deliberately checked
  that both names refer to the same function). Delete that test and list it.

## Maintenance notes

- Review rule from ADR 0007: a new option needs a use case that neither the default nor the
  layer's escape hatch covers. `test/public-surface.test.ts` and `test/config-typecheck.ts` are
  the guards.
- Issue #36 will later move the resource builders' import path; the config key stays `resources`.
- Reviewers should scrutinize deleted tests (each must map to a removed item) and that the
  resolved config shape change (`config.resources`, `config.environment`) is applied everywhere,
  including `voke/testing` and `voke/local` helpers.
