# Plan 010: `voke local` and `voke dev` reach local AWS only through the configured Provider

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index (it does for
> this plan set: report status to the coordinator instead).
>
> **Drift check**: Compare `git diff --stat 3435023 -- packages/core/src/provider.ts packages/core/src/config.ts packages/core/src/model.ts packages/core/src/dev.ts packages/core/src/cli.ts packages/core/src/local.ts packages/core/src/local-provider.ts packages/core/src/e2e.ts packages/core/src/cloudformation.ts packages/core/src/aws-lambda.ts packages/core/src/api.ts packages/core/src/index.ts packages/core/test packages/aws/src packages/aws/test examples/hello-api examples/e2e README.md docs/e2e-testing.md apps/docs/content`
> and `git status --short` with the recorded current state below. Plans 009, 003, 008 and 004 run
> before this one and are expected to have changed several of these files; reconcile with what
> they left (see "Expected state after earlier plans"). Pause if drift invalidates scope, a
> protected contract, or an unresolved product decision.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `.factory/plans/009-*.md` (core AWS copies deleted; CloudFormation lives only in `@voke/aws`). Runs after 003 (Provider set only in `voke.config.ts`), 008 and 004 in the coordinator's order: 001 → 002 → 009 → 003 → 008 → 004 → **010** → 005 → 006 → 007.
- **Category**: tech-debt
- **Planned at**: commit `3435023`, 2026-11-14

## Why this matters

The core/provider package split stopped halfway for local development. `voke dev` already asks the
configured Provider for its local environment, but `voke local start|stop|reset|bootstrap` still runs
a Floci-specific copy of the local code that lives in core. The Local AWS Provider is also configured
on core config (`local.provider`), which puts AWS concepts in the provider-neutral package. So two
copies of the same code run, and an AWS emulator choice leaks into core. After this plan, core only
knows a typed, provider-neutral local workflow contract. `@voke/aws` owns the Local AWS Provider,
configured as `aws({ local: floci() })`, and both CLI paths go through it. Plan 007 then adds the AWS
Emulator as one more Local AWS Provider without touching core.

## Current state (at 3435023)

Vocabulary (from `CONTEXT.md`; use these names in code and comments):

> **Provider**: A platform adapter that gives a **Gateway** runtime, deployment, synthesis, and local workflow behavior while keeping **Function** authoring provider-neutral.
> **Provider Capability**: A focused part of a **Provider** contract, such as runtime, invocation, build, synthesis, or local workflow behavior.
> **Local AWS Provider**: A local development implementation that emulates AWS services for a **Voke Project**. _Avoid_: Provider, Gateway provider, local runtime.
> A **Local AWS Provider** is distinct from a **Provider** because it emulates local AWS services rather than defining the Gateway's deployment target.

ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: "The core package owns
provider-neutral Function, Gateway, config, contract, route, and Provider capability contracts;
`@voke/aws` depends on public `voke` and owns the full AWS workflow, including ... local AWS workflow
helpers". Core `src` must not import `@voke/*` (that would be a workspace cycle, which turbo rejects).
Core tests may import `@voke/aws` through the `paths` mapping in `packages/core/tsconfig.json:9-17`.

ADR `docs/adr/0007-opinionated-framework.md`: one supported way per layer, "the `LocalProvider`
interface for local emulation" is the local layer's escape hatch, and removals happen without
deprecation aliases (the package is unreleased, version `0.0.0`).

Binding user decision U3: AWS-only settings live in provider options,
`aws({ lambda: {...}, local: awsEmulator() })`. `local.provider` leaves core, and this plan removes it.
Floci stays the default in this plan. Plan 007 switches the default to the AWS Emulator.

Files and facts:

- `packages/core/src/provider.ts:31-40`: the local capability is untyped, and nothing calls `workflow`.
  ```ts
  export interface ProviderLocalCapability<TWorkflow = unknown> {
    devEnvironment?: (input: {
      config: VokeConfig;
      endpoint?: string;
      model: VokeModel;
      region: string;
      stage: string;
    }) => Record<string, string>;
    workflow?: (input: { config: VokeConfig; model: VokeModel }) => TWorkflow;
  }
  ```
- `packages/core/src/config.ts:10-11` imports core `local-provider`. `:79-87` defines
  `VokeLocalConfig { provider: LocalProvider; providerOptional: boolean }` and the input variant with
  `LocalProviderInput`. `:105` is `local?: Partial<VokeLocalConfigInput>`. `:190-193`:
  `defineLocalConfig` → `resolveLocalProvider(input.local?.provider)` (Floci default),
  `providerOptional ?? true`. `providerOptional` is read only by the model.
- `packages/core/src/model.ts:32` declares `local: VokeModelLocal`. `:147-155` declares
  `VokeModelLocal { provider: { adapter: string; optional: boolean } }`, filled at `:639-644` from
  `config.local.provider.name`.
- `packages/core/src/local-provider.ts` (213 lines) and `packages/core/src/local.ts` (244 lines) are
  copies of `packages/aws/src/local-provider.ts` and `packages/aws/src/local.ts`. They differ only in
  imports. Core `local.ts` uses core `cloudformation.ts`, the outdated duplicate.
  - `LocalProvider` (`aws/src/local-provider.ts:67-78`): `name`, `defaults {accountId, endpoint, region}`,
    `bootstrapPlan`, `composeConfig`, `environment`, `startCommand`, `stopCommand` and `resetCommand`.
    The last three take `{ composePath }`.
  - `LocalProviderInput = "floci" | LocalProvider` (`:80`); `LocalProviderError` (`:82-99`);
    `createFlociLocalProvider` (`:106-203`); `resolveLocalProvider` (`:205-213`).
  - `aws/src/local.ts`: `createLocalAwsEnvironment`, `createFlociComposeConfig`,
    `createLocalResourceBindings` (guessed names: table = logical id, queue URL =
    `${endpoint}/${accountId}/${logicalId}`, ...), and `createLocalBootstrapPlan`, which loads config and
    reads `config.local.provider` (`:214`).
- `packages/core/src/cli.ts`:
  - `:9-10` imports core `./local`.
  - `:28-36` defines `CommandRunner` / `CommandRunOptions { env?, stdoutFilter? }`.
  - `:65-68` is the help text with `--compose`.
  - `:172-195` is `writeLocalCompose`, which reads `config.local.provider.composeConfig`.
  - `:222-249` is `runCommand`; the child env is `{ ...Bun.env, ...options.env }`.
  - `:262-280` is `localProviderErrorMessage`, which contains Floci-specific guidance.
  - `:282-304` is `runLocalProviderCommand`, which wraps failures in `LocalProviderError`.
  - `:572-595` is `dev`.
  - `:597-669` is `local`: start/stop/reset/bootstrap through `config.local.provider` and core
    `createLocalBootstrapPlan`.
  - `:845-851`: the CLI prints `error.message` and exits 1.
- `packages/core/src/dev.ts:21-59` is `createProviderLocalEnvironment`. It calls
  `config.provider.local.devEnvironment` synchronously. If the provider lacks it and the project has
  resources, it throws `VokeConfigError` ("No provider configured for dev local environment." /
  `Provider "<name>" does not support dev local environment.`). `:100-134` is `createDevPlan`, which
  merges the provider env first.
- `packages/aws/src/index.ts:96-129`: `aws()` takes no options. Its `local.devEnvironment` reads
  `config.local.provider`, then calls `createLocalAwsEnvironment` and `createLocalResourceBindings`
  over `synthesizeCloudFormationFromModel(model)`.
- `packages/core/src/e2e.ts` (internal; core `package.json` exports only `"."`) imports core `./local`
  (`:19-23`) for `createStackTestContext` (`:419-460`). The published equivalents already exist:
  `@voke/aws/testing` `createStackTestContext` (`packages/aws/src/testing.ts:133`, which uses aws
  `createLocalAwsEnvironment()` with the Floci default), and `@voke/testing` `createTestClient` /
  `createInvokeTestClient`. Users of core `e2e.ts` are `test/e2e.test.ts`, `test/node-runtime.test.ts:6`
  (`createHttpApiEvent`) and `test/cli-contract.test.ts:234` (`createTestClient`).
- `@voke/aws/local` exports, asserted in `packages/core/test/public-surface.test.ts:167-180`:
  `LocalProviderError`, `createFlociComposeConfig`, `createFlociLocalProvider`,
  `createLocalAwsEnvironment`, `createLocalBootstrapPlan`, `createLocalResourceBindings`,
  `resolveLocalProvider`.
- Tests using `local:` config or core local: `packages/core/test/local.test.ts` (16 tests, including
  CLI start/stop/reset/bootstrap, a custom provider, and the error-wrapping messages at `:639-720`),
  `dev.test.ts:118,197,248`, `api.test.ts:114-118,484-488`, `model.test.ts:118,292`,
  `config-typecheck.ts:65-79` and `remote-functions.test.ts:312`.
- Examples and docs: `examples/hello-api/src/local.ts` (uses `createFlociComposeConfig`,
  `createLocalAwsEnvironment` and `createLocalBootstrapPlan`, and appears in the public-surface docs
  list at `public-surface.test.ts:40`), `examples/e2e/test/local-floci.e2e.test.ts`, the README section
  "Local AWS With Floci" (`README.md:283-306`), and `docs/e2e-testing.md:97-141`.

### Expected state after earlier plans (reconcile, do not redo)

- 009 (`.factory/plans/009-finish-aws-package-split.md`, decision D5) deletes core `aws.ts`,
  `authorizers.ts`, `aws-lambda-invoke-transport.ts` and the SQS code in `invoke.ts`. It keeps three
  core files **frozen**, only for `local.ts`, `local-provider.ts` and `e2e.ts`, and marks each with
  this first line:
  `// Retained only for local.ts / local-provider.ts / e2e.ts until plan 010 deletes them. Do not add code or importers.`
  - `packages/core/src/cloudformation.ts`: reduced to the template types (`CloudFormationTemplate`,
    `CloudFormationResource`, `CloudFormationOutput`, `CloudFormationValue`) plus
    `synthesizeCloudFormation` and the private code it calls. Its resource builders are deleted.
    Imported by `local.ts:2-6`, `local-provider.ts:1` and `e2e.ts:8`.
  - `packages/core/src/aws-lambda.ts`: identical to `aws/src/lambda.ts`. Imported by `e2e.ts:2-7`
    (and `api.ts:2`).
  - `packages/core/src/api.ts`: `api()`, a retired name. Imported by `e2e.ts:1` (type `VokeApi`).
  - Their only allowed importers after 009 are those three files and their own tests
    (`local.test.ts`, `e2e.test.ts`). 009's table also lists `api.test.ts` as a test importer of
    `api.ts`/`aws-lambda.ts`. `node-runtime.test.ts:6` imports `createHttpApiEvent` from core `e2e.ts`.
  - This plan deletes all six files: `local.ts`, `local-provider.ts`, `e2e.ts`, `cloudformation.ts`,
    `aws-lambda.ts` and `api.ts` (Step 7).
  - 009 also leaves core `remote.ts` (D6) and `build.ts` (plan 003 deletes it). This plan does not touch them.
- 003 (U2) makes `voke.config.ts` the only place the Provider is set (`provider: aws()`), and adds it to
  the examples. `examples/hello-api/voke.config.ts` has no `provider` at 3435023.
- 008 may have renamed or removed exports. Follow 008's names when they conflict with the names below,
  and report the conflict.
- 004 may have added `ProviderDeployCapability` to `provider.ts`. Keep it and follow its style.

## Commands you will need

| Purpose           | Command                                          | Expected on success |
| ----------------- | ------------------------------------------------ | ------------------- |
| Install           | `bun install`                                    | exit 0              |
| Core tests        | `cd packages/core && bun test`                   | 0 fail              |
| AWS package tests | `cd packages/aws && bun test`                    | 0 fail              |
| One file          | `cd packages/aws && bun test test/local.test.ts` | 0 fail              |
| Package typecheck | `cd packages/<core\|aws> && bun run typecheck`   | exit 0              |
| Repo gates        | `bun run typecheck && bun run test`              | exit 0              |
| Lint              | `bun run check`                                  | exit 0              |

## Implementation rules relevant to this plan

- Work test-first: port or write the failing test, then change the code.
- Core `src` must not import `@voke/*`. AWS behavior reaches core only through `config.provider`.
- No aliases for removed names (ADR 0007-opinionated-framework). Remove `createFlociLocalProvider`,
  `resolveLocalProvider`, `LocalProviderInput`, the `"floci"` string and `local.provider` outright.
- Keep Floci behavior byte-for-byte: same compose file, same `docker compose` commands, same
  `aws cloudformation deploy` arguments, same environment variables. The existing tests at
  `packages/core/test/local.test.ts` are the oracle. Port them; do not weaken assertions.
- The CLI keeps flag parsing, name/stage/region resolution and error printing. The Provider owns
  everything AWS- or Floci-specific, including the Floci guidance text in errors.
- CLI-time code may use Bun APIs. Lambda runtime modules must not (plan 002); local code is CLI-time.
- Unit tests must not start Docker or touch the network. Use an injected command runner.
- Never log credential values.

## Scope

**In scope**:

- `packages/core/src/provider.ts`, `config.ts`, `model.ts`, `dev.ts`, `cli.ts` and `index.ts` (type exports)
- `packages/core/src/local.ts`, `packages/core/src/local-provider.ts`, `packages/core/src/e2e.ts` (delete)
- `packages/core/src/cloudformation.ts`, `packages/core/src/aws-lambda.ts`, `packages/core/src/api.ts`
  (the 009 D5 frozen files; delete)
- Core tests that import the six deleted files: `local.test.ts`, `e2e.test.ts`, `api.test.ts`,
  `node-runtime.test.ts`, plus any other file that `grep` finds (rewire to `@voke/aws`,
  `@voke/aws/cloudformation`, `@voke/aws/testing` or `@voke/testing` through `paths`, move to
  `packages/aws/test`, or delete when the behavior is already covered there)
- `packages/aws/src/index.ts`, `local.ts`, `local-provider.ts`, `testing.ts`
- `packages/core/test/*` (files that use `local:` config, core `local`, or core `e2e`) and
  `packages/aws/test/local.test.ts` (create), `packages/aws/test/testing.test.ts`
- `examples/hello-api/src/local.ts`, `examples/hello-api/voke.config.ts` (only if 003 left no
  provider), `examples/e2e/test/local-floci.e2e.test.ts`
- `README.md` (local section), `docs/e2e-testing.md`, `apps/docs/content/docs/reference/config.mdx`
  (only if it documents `local`)

**Out of scope**:

- The AWS Emulator provider, resources-only synthesis, and the stack-outputs file (plan 007).
- Switching the default Local AWS Provider (plan 007).
- Deploy capability or CloudFormation clients (plan 004).
- `runtime.lambda` and other AWS settings moving into `aws({...})` (plan 005). Only `local` moves here.
- ADRs, `CONTEXT.md`, other plans, `.factory/plans/README.md`.

## Git workflow

- Branch: `feature/local-workflow-through-provider`
- Commit only if authorized; short imperative sentence-case messages (e.g. "Move local workflow behind the provider").
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Type the local capability in core

In `packages/core/src/provider.ts`, replace `ProviderLocalCapability<TWorkflow>` with a
provider-neutral contract. Target shape (names may be adjusted; the semantics are load-bearing):

```ts
export interface ProviderCommandRunOptions {
  env?: Record<string, string>;
  /** Names removed from the inherited process environment before `env` is applied. */
  unsetEnv?: readonly string[];
}
export type ProviderCommandRunner = (
  command: string[],
  options?: ProviderCommandRunOptions
) => void | Promise<void>;

export interface ProviderLocalDevEnvironment {
  environment: Record<string, string>;
  /** Variables the `voke dev` child must not inherit (e.g. real AWS credentials). */
  unsetEnvironment?: readonly string[];
}

export interface ProviderLocalWorkflowContext {
  config: VokeConfig; // already resolved with CLI name/stage/region overrides
  model: VokeModel; // built from that config
  options: Readonly<Record<string, string>>; // remaining `voke local` flags; the provider reads its own (e.g. compose, data, image, port, hostname, endpoint, template)
  run: ProviderCommandRunner;
}

export interface ProviderLocalWorkflow {
  bootstrap: (context: ProviderLocalWorkflowContext) => Promise<void>;
  reset: (context: ProviderLocalWorkflowContext) => Promise<void>;
  start: (context: ProviderLocalWorkflowContext) => Promise<void>;
  stop: (context: ProviderLocalWorkflowContext) => Promise<void>;
}

export interface ProviderLocalCapability {
  devEnvironment?: (input: {
    config: VokeConfig;
    endpoint?: string;
    model: VokeModel;
    region: string;
    stage: string;
  }) => ProviderLocalDevEnvironment | Promise<ProviderLocalDevEnvironment>;
  workflow?: ProviderLocalWorkflow;
}
```

Decision recorded here (reversible): `devEnvironment` may be async and returns `unsetEnvironment`.
Plan 007 needs both. The emulator environment requires checking that the emulator is running and
reading a file, and its child processes must not inherit real AWS credentials. Defining it once now
avoids a second core contract change. Export the new types from `packages/core/src/index.ts` next to
the existing provider types.

### Step 2: Honor `unsetEnv` in the CLI runner

`cli.ts` `CommandRunOptions` gains `unsetEnv?: readonly string[]`. `runCommand` builds the child env
by copying `Bun.env`, deleting each `unsetEnv` name, then applying `env`. `CommandRunner` must
satisfy `ProviderCommandRunner`. Test this through the injected runner and a direct `runCommand`
check that a deleted variable is absent from a child (`bun -e "console.log(process.env.X ?? '')"` is
acceptable; it is local and fast).

### Step 3: Dispatch `voke dev` and `voke local` through the Provider

- `dev.ts`: `createProviderLocalEnvironment` awaits `devEnvironment`. `DevPlan` gains
  `unsetEnvironment: readonly string[]` (empty when the provider gives none). `cli.ts` `dev` passes it
  as `unsetEnv`. Keep the existing `VokeConfigError` messages for missing support.
- `cli.ts` `local`: drop `writeLocalCompose`, `localProviderErrorMessage`, `runLocalProviderCommand`
  and the `./local` import. Resolve name/stage/region from flags plus config (as today), build
  `defineConfig({...config, name, stage, region, entrypoint})` and its model, then call
  `config.provider?.local?.workflow?.[subcommand](context)`. With no provider or no workflow, throw a
  `VokeConfigError` that matches the dev wording: `No provider configured for voke local.` /
  `Provider "<name>" does not support voke local.`. Unknown subcommands keep the existing
  `CliUsageError`.
- Help text: keep the `voke local <start|stop|reset|bootstrap>` lines. Describe `--compose` as a Floci
  option, or move it to the README.

### Step 4: Remove `local` from core config and model

- `config.ts`: delete `VokeLocalConfig`, `VokeLocalConfigInput`, the `local` field on
  `VokeConfig`/`VokeConfigInput`, `defineLocalConfig`, and the `local-provider` imports. Remove
  `providerOptional` with it; it is only read by the model. If config validation rejects unknown
  keys, `local` now fails like any unknown key. Otherwise make `defineConfig` throw
  `VokeConfigError.validation` at path `local` with the message
  `local AWS settings moved to the provider: aws({ local: floci() }) from "@voke/aws" and "@voke/aws/local"`,
  so stale configs fail loudly instead of being ignored.
- `model.ts`: delete `VokeModelLocal`, `VokeModelLocalProvider` and the `local` field. If anything
  needs the Local AWS Provider name, it reads it from the Provider. Do not add it back to the
  neutral model.
- Delete `packages/core/src/local.ts` and `packages/core/src/local-provider.ts`.

### Step 5: `@voke/aws` owns the Local AWS Provider and the workflow

- `aws/src/local-provider.ts`:
  - Rename `createFlociLocalProvider` to `floci(options?: FlociLocalProviderOptions): LocalProvider`.
  - Delete `LocalProviderInput` and `resolveLocalProvider`.
  - Keep the `LocalProvider` interface as is. Plan 007 reshapes it.
  - Move the Floci guidance from `cli.ts:262-280` here, so a failing command throws `LocalProviderError`
    with the same message text. Replace "You can also configure local.provider in voke.config.ts" with
    "You can also pass a Local AWS Provider: aws({ local: ... })".
- `aws/src/local.ts`:
  - `createLocalBootstrapPlan` takes `{ provider: LocalProvider; model; name; stage; region; endpoint?; templatePath? }`.
    It synthesizes through `synthesizeCloudFormationFromModel(model)`; it no longer loads config or
    reads `config.local`.
  - `createLocalAwsEnvironment` requires a `provider`.
  - Add `createLocalWorkflow(provider: LocalProvider): ProviderLocalWorkflow`. It implements
    start/stop/reset/bootstrap exactly as `cli.ts:597-669` does today: compose path from
    `options.compose ?? ".voke/local/docker-compose.yml"`, compose written before start, and the
    bootstrap template at `options.template ?? ".voke/local/cloudformation.json"`. Each command runs
    through `context.run`, wrapped in `LocalProviderError`.
- `aws/src/index.ts`:
  - `aws(options: { local?: LocalProvider } = {})`, with `local` defaulting to `floci()`.
  - `local.workflow = createLocalWorkflow(localProvider)`.
  - `local.devEnvironment` returns `{ environment: {...env, ...bindings} }` using that provider, not
    `config.local`. Keep the `aws()` call with no arguments working.
- `aws/src/testing.ts`: `createStackTestContext` accepts `local?: LocalProvider`, defaulting to `floci()`.
- `@voke/aws/local` exports after this step: `floci`, `LocalProviderError`, `createLocalAwsEnvironment`,
  `createLocalResourceBindings`, `createFlociComposeConfig` (or drop it in favor of
  `floci().composeConfig`, and record the choice), plus the types. Update
  `public-surface.test.ts:167-180` to the final list.

### Step 6: Move tests and e2e helpers onto the Provider

- Move the provider and helper tests from `packages/core/test/local.test.ts` to
  `packages/aws/test/local.test.ts` (Floci compose, environment, bindings, bootstrap plan, custom
  provider, error messages).
- Keep CLI-level tests in core (`runCli(["local", ...], { run })` with a config whose
  `provider: aws({ local: ... })` comes from `@voke/aws` through `paths`). They assert the same
  command sequences and env as today. Also add tests for missing provider and missing workflow.
- Update `dev.test.ts`, `api.test.ts`, `model.test.ts`, `config-typecheck.ts` and
  `remote-functions.test.ts` to configure local through `aws({ local })`, or to drop `local`.
- Delete core `e2e.ts`. Point `e2e.test.ts` at `@voke/aws/testing` and `@voke/testing`, or move its
  AWS-specific cases to `packages/aws/test/testing.test.ts`. `node-runtime.test.ts` gets
  `createHttpApiEvent` from wherever 009 put it (a test support file is acceptable).
  `cli-contract.test.ts:234` uses `@voke/testing`.
- `examples/hello-api/src/local.ts`: rewrite with the new exports (`floci`,
  `createLocalAwsEnvironment({ provider: floci() })`). Make sure `examples/hello-api/voke.config.ts`
  has `provider: aws()`.

### Step 7: Delete the 009 frozen core files

Once Steps 4 and 6 have removed `local.ts`, `local-provider.ts` and `e2e.ts`, nothing in core `src`
should need the D5 files.

- Run `grep -rnE "from \"\./(cloudformation|aws-lambda|api)\"" packages/core/src packages/core/test`
  and `grep -rnE "src/(cloudformation|aws-lambda|api)(\.ts)?\"" packages/core/test`.
  Both should list only test files.
- Rewire or remove each remaining test importer:
  - `api.test.ts`: `api()` is a retired name, so delete the cases that only exercise `api()` or core
    `aws-lambda.ts`. Rewire Lambda-adapter cases to `@voke/aws` (`packages/aws/src/lambda.ts`), or
    move them to `packages/aws/test` if not already covered there.
  - `node-runtime.test.ts:6` (`createHttpApiEvent`): take it from `@voke/aws/testing` if exported
    there, else from a small `packages/core/test/support` helper.
  - Template-type imports (`CloudFormationTemplate`, ...) come from `@voke/aws/cloudformation`.
- Delete `packages/core/src/cloudformation.ts`, `packages/core/src/aws-lambda.ts` and `packages/core/src/api.ts`.
- If `packages/core/src/index.ts`, `docs/stable-public-surface.md` or a public-surface/boundary test
  mentions these files or `VokeApi`, update it in the same change. (Core `package.json` exports only
  `"."`, so no package subpath changes.)

### Step 8: Docs

- README: retitle the section "Local AWS". Show `provider: aws({ local: floci() })` (the default, so
  it is optional), the four commands, and the helper imports from `@voke/aws/local`.
- `docs/e2e-testing.md`: document the `createStackTestContext({ local })` option.
- `apps/docs/content/docs/reference/config.mdx`: remove any `local` config key if documented.

## Test plan

- `packages/aws/test/local.test.ts`: all 16 behaviors from today's core `local.test.ts`, with
  assertions unchanged except for names (`floci()`, the `aws({ local })` wiring and the error hint
  wording). Add: the workflow runs start/stop/reset/bootstrap with the injected runner, writes the
  compose file to the `compose` option path, and wraps a failing command in `LocalProviderError`
  with the Floci hint.
- `packages/core/test/cli-contract.test.ts`:
  - `voke local <cmd>` dispatches to `provider.local.workflow`, using a fake provider object
    (provider-neutral; no `@voke/aws`).
  - Missing provider → `No provider configured for voke local.`
  - A provider without a workflow → `does not support voke local`.
  - A `unsetEnv` name is absent from the child env.
- `packages/core/test/dev.test.ts`: an async `devEnvironment` is awaited; `unsetEnvironment` reaches
  `DevPlan` and the runner options.
- `packages/core/test/model.test.ts`: the model has no `local` key.
- Config: `defineConfig({ local: {...} })` fails with the migration message at path `local`.
- Pattern: model new core tests on `packages/core/test/provider-runtime.test.ts`, and aws tests on
  `packages/aws/test/provider.test.ts`.

## Done criteria

- [ ] `cd packages/core && bun test` and `cd packages/aws && bun test` → 0 fail, without Docker or network
- [ ] `bun run typecheck` and `bun run check` exit 0
- [ ] `ls packages/core/src/local.ts packages/core/src/local-provider.ts packages/core/src/e2e.ts packages/core/src/cloudformation.ts packages/core/src/aws-lambda.ts packages/core/src/api.ts` → "No such file" for all six
- [ ] `grep -rn "Retained only for local.ts" packages/core` → no matches
- [ ] `grep -rnE "(\./|src/)(cloudformation|aws-lambda|api|local|local-provider|e2e)(\.ts)?\"" packages/core/src packages/core/test` → no matches
- [ ] `grep -rn "local\.provider\|providerOptional\|LocalProviderInput\|resolveLocalProvider\|createFlociLocalProvider" packages/*/src examples/*/src examples/*/test README.md docs apps/docs/content` → no matches
- [ ] `grep -rn "@voke/" packages/core/src` → no matches
- [ ] `ProviderLocalCapability.workflow` is typed and called by `voke local`. `voke dev` and `voke local bootstrap` synthesize through `@voke/aws` (one copy).
- [ ] Floci commands, compose file and environment are unchanged (ported tests pass with the same expected values)
- [ ] No files outside the in-scope list are modified

## STOP conditions

- 009 has not landed as described: core `aws.ts`/`authorizers.ts`/SQS copies still exist, or the D5
  files (`cloudformation.ts`, `aws-lambda.ts`, `api.ts`) lack the "Retained only for ..." header, or
  core `src` files other than `local.ts`/`local-provider.ts`/`e2e.ts` import them. Report to the
  coordinator before deleting anything.
- A test importing a D5 file covers behavior that `@voke/aws` does not have (009 should have ported
  it). Report the case; do not keep the core file to save the test.
- 003 did not make `voke.config.ts` the only place to set the Provider. Then `config.provider` may
  be absent in the paths this plan dispatches through. Report; do not re-add `voke(functions, { provider })`.
- A user-visible Floci behavior (command, compose content, env value) would have to change to fit
  the new contract.
- The neutral contract cannot express something the Floci workflow needs without naming AWS,
  Docker or Floci in core types.

## Maintenance notes

- Plan 007 adds `awsEmulator()`, makes it the `aws()` default, and reshapes `LocalProvider`
  (lifecycle files, async environment, `unsetEnvironment`). It relies on this plan's
  `ProviderLocalWorkflow`, async `devEnvironment` and `unsetEnv` runner support.
- After this plan, the only intentional core/package duplicates left are core `remote.ts` (009 D6)
  and, until 003 lands, `build.ts`.
- Reviewers: check that no AWS term entered `packages/core/src/provider.ts`, that removed names have
  no aliases, and that the error text for Floci failures is unchanged apart from the config hint.
- Deferred: a provider `diagnostics` capability for `voke doctor` (plan 006).

## Execution notes (2026-11-14)

Done on branch `feature/local-workflow-through-provider` (PR #56), stacked on plan 004 (`feature/one-command-deploy`,
PR #55, open). Gates: `bun run check` 0 errors, `bun run typecheck` 18/18, `bun run test`
23/23 tasks (core 216, `@voke/aws` 65, `@voke/testing` 1, examples green), no Docker or network.

- `ProviderLocalCapability` is typed (`devEnvironment` may be async and returns
  `{ environment, unsetEnvironment? }`; `workflow` has `start/stop/reset/bootstrap`). `voke local`
  dispatches to `config.provider.local.workflow`; missing provider or workflow is a `VokeConfigError`.
  `runCommand` gained `unsetEnv`, and `voke dev` passes the plan's `unsetEnvironment`.
- Config `local` is removed and rejected with a pointer to `aws({ local: floci() })`. `aws({ local })`
  selects the Local AWS Provider (default `floci()`), which also drives `createStackTestContext({ local })`.
- `createFlociLocalProvider` → `floci`; `resolveLocalProvider`, `LocalProviderInput` and
  `createFlociComposeConfig` removed (use `floci().composeConfig`). No aliases.
  `createLocalBootstrapPlan` options are a union: `model` or a ready `template`.
- Deleted core `local.ts`, `local-provider.ts`, `e2e.ts`, `cloudformation.ts`, `aws-lambda.ts`
  (`api.ts` was already gone in 008). Floci commands, compose content and env values are unchanged;
  only the failure hint now says `aws({ local: ... })`.
- `e2e.test.ts` now uses `@voke/testing` and `@voke/aws/testing`. Cases that only exercised the deleted
  internal helper (`createHttpApiEvent` options, `{ app }` targets, request `context`, `invokeAsync`)
  were dropped; Lambda adapter semantics stay covered by `api.test.ts`.

Deviations outside the in-scope list:

- `packages/testing/src/index.ts`: fixed a 009 regression where a `baseUrl` with a stage path
  (`https://…/prod/`) dropped `/prod` for paths starting with `/`. Regression test in
  `packages/testing/test/client.test.ts`.
- `public-surface.test.ts`: the retired-name guard now matches `new Voke(` instead of `new Voke`, which
  also matched the legitimate `new VokeConfigError(` in `cli.ts`.
- README: `createTestClient()` described as an in-process or deployed-URL client, not "Lambda/API
  Gateway semantics" (it has been a plain fetch client since 009).

Done-criteria greps: the six files are absent; the remaining `@voke/` strings in `packages/core/src`
are generated-code templates (scaffold, migration, remote codegen) and the config migration message,
not imports; the `src/(api|local)…` matches in core tests are fixture entrypoint strings and
`@voke/aws`/example paths.
