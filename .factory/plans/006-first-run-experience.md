# Plan 006: A new user goes from nothing to a deployed API with three commands and clear CLI feedback

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 3435023 -- packages/core/src/cli.ts packages/core/src/config.ts packages/core/src/provider.ts packages/core/src/dev.ts packages/core/package.json packages/core/test packages/aws/src packages/aws/package.json packages/aws/test packages/*/package.json package.json examples/*/package.json apps/docs/package.json README.md apps/docs/content`
> and `git status --short` with the recorded current state. Plans 004, 008, 009 and 010 land
> before this one and are expected to have changed `cli.ts`, `provider.ts`, `config.ts`, and
> `packages/aws`: line numbers below are at `3435023`, so re-locate code by symbol name. Reconcile
> routine drift; pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `.factory/plans/004-one-command-deploy.md` (top-level `voke deploy`/`remove` through a provider deploy capability; the scaffold's `deploy`/`remove` scripts and the AWS credential diagnostic use it), `.factory/plans/008-one-spelling-per-setting.md` (removes the `voke experimental` group and other duplicate surface, so the command spec is built once over the final command set), `.factory/plans/010-*.md` (new plan, not yet written at planning time; `voke local` runs through `ProviderLocalCapability.workflow`; core `local.ts`/`local-provider.ts` are deleted). Plan 009 (core AWS copies deleted) lands earlier still, via 003/004.
- **Category**: dx
- **Planned at**: commit `3435023`, 2026-11-14

## Why this matters

First impressions decide whether a framework feels easy. Today `voke create` prints nothing,
generates a project whose three framework dependencies (`voke`, `@voke/aws`, `@voke/testing`)
cannot be installed from anywhere, and forces the project name into the framework's own `@voke`
scope. `--help` on a command is an error, `--version` is an unknown command, a mistyped flag is
silently ignored, and running without a config file fails with a bare "No provider configured".
After this plan the path is `voke create my-api`, `cd my-api`, `bun run deploy`, with the CLI
saying what happened and what to do next, and `voke doctor` explaining what is missing.

## Current state

Verified at `3435023` by reading the source and running the starter test (it passes).

### Architecture the plan must respect

The repository is split into packages (ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`):

> `voke` is the provider-neutral core (Function, Gateway, config, contract, route, Provider
> capability contracts). `@voke/aws` depends on public `voke` and owns the full AWS workflow [...]
> Specialized non-provider helpers belong to `@voke/schema`, `@voke/http`, `@voke/testing`,
> `@voke/remote`, `@voke/build`.

- Core source (`packages/core/src`) must not import any `@voke/*` package: that would be a
  workspace dependency cycle, which turbo rejects. AWS behavior reaches core only through the
  Provider configured in `voke.config.ts` (`provider: aws()`). After plan 003 the Provider is set
  only in config, not as an option to `voke(functions, ...)`.
- Provider contract: `packages/core/src/provider.ts`. At `3435023`:

  ```ts
  export interface VokeProvider<TGatewayExtension = object> {
    build?: ProviderBuildCapability;
    invoke?: ProviderInvokeCapability;
    local?: ProviderLocalCapability;
    name: string;
    runtime?: ProviderRuntimeCapability<TGatewayExtension>;
    synthesis?: ProviderSynthesisCapability;
    validate?: (model: VokeModel) => void;
  }
  ```

  Plan 004 adds `deploy?: ProviderDeployCapability { deploy, remove }` and plan 010 gives
  `local.workflow` a typed contract. `VokeProviderCapability` (same file) is the union of
  capability interfaces. The AWS implementation is `aws()` in `packages/aws/src/index.ts`.

- There are 7 publishable packages, all `"version": "0.0.0"`, internal dependencies as
  `workspace:*`, `exports` pointing at TypeScript source (for example `packages/aws/package.json`:
  `.`, `./cloudformation`, `./local`, `./testing` → `./src/*.ts`): `voke` (`packages/core`,
  `bin: { "voke": "./src/cli.ts" }` with a `#!/usr/bin/env bun` shebang), `@voke/aws`,
  `@voke/build`, `@voke/http`, `@voke/remote`, `@voke/schema`, `@voke/testing`. None has
  `license`, `description`, `repository`, `files`, or `engines`. The repository has no `LICENSE`
  file. The root `package.json` has a `catalog` with `"@typescript/native-preview": "^7.0.0-dev.20260516.1"`.

### `voke create` (`packages/core/src/cli.ts`)

- Handler `create` at `cli.ts:731-741` requires `voke create api <name> [directory]` and prints
  nothing. Generator `createApiProject` at `cli.ts:438-468`:

  ```ts
  const packageName = options.name.includes("/")
    ? options.name
    : `@voke/${options.name}`; // cli.ts:442-444, forced framework scope
  await Bun.$`mkdir -p ${directory}/src/routes ${directory}/test`; // cli.ts:446
  ```

- `createPackageJson` (`cli.ts:377-392`) writes dependencies `@voke/aws`, `@voke/testing`, and
  `voke`, each `` `^${packageJson.version}` `` (`^0.0.0`), plus `hono: "^4.0.0"`; devDependencies
  `@types/bun: "latest"` and a hard-coded `@typescript/native-preview` version; scripts `build`,
  `clean`, `dev`, `local`, `synth`, `test`, `typecheck`. No `deploy`/`remove`.
- Templates: test (`cli.ts:306-319`) imports `createTestClient` from `@voke/testing`; health route
  (`cli.ts:321-325`) has stray indentation in `handler`; config (`cli.ts:328-343`) imports `aws`
  from `@voke/aws` and sets `provider: aws()`; index (`cli.ts:346-358`) calls
  `voke(functions, { config })`. No `.gitignore`, no README.
- Tests: `packages/core/test/api.test.ts:363-401` ("creates a starter API project") asserts
  `packageJson.name === "@voke/created-api"` and the `@voke/aws` dependency.
  `packages/core/test/api.test.ts:403-433` ("generated starter test suite passes with local
  package links") scaffolds a project, symlinks `voke`, `@voke/aws`, `@voke/testing`, and
  `hono` into its `node_modules`, and runs `bun test` there; it passes. Keep that mechanism.
  `packages/core/test/cli-contract.test.ts:180-240` has two more starter tests, and
  `cli-contract.test.ts:129-143` asserts the old `Usage: voke create api <name> [directory]`.

### Help, flags, output

- `printHelp` (`cli.ts:56-76`) writes with `console.log`, not the injected output. Per-command
  usage strings: `commandUsage` (`cli.ts:89-101`). Bare `voke`, `--help`, `-h` are handled in
  `runCli` (`cli.ts:797`); `voke dev --help` fails with `Missing value for --help`;
  `voke --version` fails with `Unknown command: --version`.
- `parseFlags` (`cli.ts:131-168`) accepts any flag name, so `voke synth --stag prod` silently
  synthesizes the default stage. Plan 004 adds boolean flags to this parser. `migrate` re-parses
  its own args (`cli.ts:770`).
- `synth` (`cli.ts:509-547`) returns the output path, which the handler (`cli.ts:778-788`)
  drops. `migrate serverless` and `remote generate` also print nothing on success.
- CLI conventions: `CliUsageError` (`cli.ts:49-54`); messages shaped
  `Invalid CLI usage: <problem>\nUsage: ...` (`cliUsageMessage`, `cli.ts:103-111`;
  `docs/error-conventions.md`). Output is injectable through `CliOptions.output` and commands
  through `CliOptions.run` (`cli.ts:20-24`).

### Zero-config

`loadConfigFromFlags` (`cli.ts:419-436`) without a config file returns
`defineConfig({ name: flags.values.name ?? "api", ... })` with no Provider. `synth` then throws
`No provider configured for synthesis.` (`cli.ts:526-532`); `createDevPlan`
(`packages/core/src/dev.ts:32-33`) reads `provider?.local?.devEnvironment` and silently gets none.

### Path handling (Windows-unsafe)

String splitting plus shell `mkdir -p`, at `3435023`:

- `cli.ts:177-181` (`writeLocalCompose`; expected to move into the provider by plan 010)
- `cli.ts:446` (`createApiProject`)
- `cli.ts:539-543` (`synth`)
- `config.ts:258` (`path.startsWith("/")` as the absolute-path test in `loadVokeConfig`, then a
  string-built dynamic `import(...)` at `config.ts:265`)
- `config.ts:122` (`entrypoint.split("/")`)
- Duplicated copies: `core/src/local.ts:58-62`, `core/src/remote.ts:547-551`,
  `core/src/build.ts:25`, `packages/aws/src/local.ts:59-62`, `packages/remote/src/index.ts:554-558`,
  `packages/build/src/index.ts:28`. Plans 009 and 010 delete the core copies of local, remote
  and build. Only the code that remains after those plans is in scope here.

### Docs

`apps/docs/content/docs/getting-started.mdx` starts from a hand-written `voke.config.ts` (it
already shows `@voke/aws` and `provider: aws()`) and never mentions `voke create` or deploying.
`README.md:84` and `apps/docs/content/docs/reference/cli.mdx:25` still show
`voke create api <name> [directory]`.

### Applicable ADR

`docs/adr/0007-opinionated-framework.md`: "Each setting has one spelling and each API has one
name." Because the package is unreleased, removals happen without deprecation aliases.

## Owner decisions

Decided on 2026-11-14 (binding):

- **License: MIT** for everything in the repository: root `LICENSE`, `"license": "MIT"` in every
  `package.json` (root, all 7 packages, each example, `apps/docs`).
- **Bun 1.4.4** is the supported toolchain. `engines.bun` is `>=1.4.4`.
- **Lockstep versions**: all 7 packages always share one version. The scaffold pins every Voke
  dependency to `` `^${packageJson.version}` `` from the CLI's own `package.json`.
- **No forced scope**: the generated project's `name` is exactly what the user typed.
- **`voke doctor` provider checks go through a new optional provider capability**
  (`diagnostics`). Core never imports `@voke/aws`.
- **Zero-config without a Provider** stays provider-less but fails with a helpful error pointing
  to `provider: aws()` in `voke.config.ts`. The Provider is set only in config.
- **Path fixes** apply only to code that remains after plans 009 and 010.

Still open (do not guess):

- **Package name and npm scope.** Whether the framework publishes as `voke` plus the `@voke/*`
  scope (availability of the `voke` name and ownership of the `@voke` npm org not checked) or
  under a different name/scope. Only the docs install command and the pre-publish registry check
  depend on it. Keep the current names and report the decision as open.

## Commands you will need

| Purpose               | Command                                                                             | Expected on success                  |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| Install               | `bun install`                                                                       | exit 0                               |
| Core tests            | `cd packages/core && bun test`                                                      | 0 fail                               |
| One test file         | `cd packages/core && bun test test/cli-contract.test.ts`                            | 0 fail                               |
| AWS package tests     | `cd packages/aws && bun test`                                                       | 0 fail                               |
| Package typecheck     | `cd packages/<pkg> && bun run typecheck`                                            | exit 0                               |
| Repo gates            | `bun run typecheck && bun run test`                                                 | exit 0                               |
| Lint/format           | `bun run check`                                                                     | exit 0                               |
| Pack check            | `cd packages/<pkg> && bun pm pack --dry-run`                                        | lists `src/`, `README.md`, `LICENSE` |
| Manual scaffold check | `cd "$(mktemp -d)" && bun <repo>/packages/core/src/cli.ts create demo --no-install` | prints created files and next steps  |

## Implementation rules relevant to this plan

- Test first: each CLI behavior gets a case in `packages/core/test/cli-contract.test.ts` using the
  injected `output` and `run` seams. Tests must not hit the network or AWS. The scaffold's
  `bun install` runs through the injected runner so tests assert the command instead of running it.
- Success output is short and factual: what was written, then the next command. No emoji, no
  banners. Errors keep the `Invalid CLI usage: ...\nUsage: ...` shape.
- All help and result output goes through `options.output ?? console.log` (including `printHelp`).
- Use `node:path` (`dirname`, `join`, `isAbsolute`, `resolve`), `node:url` (`pathToFileURL`)
  and `node:fs/promises` (`mkdir(dir, { recursive: true })`) instead of string splitting and
  shell `mkdir -p`.
- Core stays provider-neutral: no `@voke/*` import in `packages/core/src`, no AWS wording in core
  except the zero-config hint text, which names `@voke/aws` as the example Provider.
- One name per command (ADR 0007 opinionated framework): the scaffold command is
  `voke create <name> [directory]`. The old `voke create api <name>` form is removed, not aliased.
- No new dependencies.
- Generated project code must pass the repository's own lint/format rules (Ultracite).
- Never print credentials, tokens, or secret values from diagnostics. Account id and region are fine.

## Scope

**In scope**:

- `packages/core/src/cli.ts`
- `packages/core/src/config.ts` (path handling in `loadVokeConfig` and entrypoint file-name handling only)
- `packages/core/src/provider.ts` (add the `diagnostics` capability and its types only)
- `packages/core/src/doctor.ts` (create)
- `packages/core/src/index.ts` (export the new diagnostics types only, if the public-surface test requires listing them)
- `packages/aws/src/index.ts` and `packages/aws/src/diagnostics.ts` (create): the AWS `diagnostics` implementation
- Path handling in modules that remain after plans 009/010 and that the CLI's write paths call:
  `packages/aws/src/local.ts` (or its 010 successor), `packages/remote/src/index.ts`,
  `packages/build/src/index.ts` (directory/file-name handling only)
- `LICENSE` (create); `package.json`; `packages/*/package.json` (all 7); `examples/*/package.json`; `apps/docs/package.json` (license and package metadata only)
- `packages/core/test/cli-contract.test.ts`, `packages/core/test/api.test.ts` (scaffold assertions), `packages/core/test/doctor.test.ts` (create), `packages/aws/test/diagnostics.test.ts` (create), the public-surface test if new exported types must be listed
- `README.md`, `apps/docs/content/docs/getting-started.mdx`, `apps/docs/content/docs/reference/cli.mdx`, `apps/docs/content/docs/index.mdx`
- `.factory/plans/README.md` (status only, unless the coordinator owns it)

**Out of scope**:

- Publishing to a registry, reserving names, release automation, changelog tooling.
- Compiling packages to JavaScript for non-Bun consumers. Voke stays Bun-first.
- Interactive prompts or project templates beyond the API starter.
- Moving or deleting core AWS/local/remote/build copies (plans 009 and 010). If one still exists
  when this plan runs, do not fix its paths; report it.
- Deploy logic itself (plan 004) and local workflow internals (plan 010).
- `voke logs`, `voke invoke`, `voke event`.
- `packages/core/src/serverless-migration.ts` path handling.
- ADRs and `CONTEXT.md`. If the `diagnostics` capability needs a glossary term, report it for the coordinator.

## Git workflow

- Branch: `feature/first-run-experience`
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Command spec, help, version, and flag validation

- Replace `commandUsage` with one per-command spec covering the commands that exist after plans
  004/008/010 (expected: `build`, `create`, `deploy`, `dev`, `doctor`, `local`, `migrate`,
  `remote`, `remove`, `synth`; no `experimental`):
  `{ usage, description, flags: Record<string, { description: string; boolean?: boolean }> }`.
  Generate `printHelp` and `cliUsageMessage` from it so they cannot drift.
- `voke --version` and `voke -v` print `voke <version>`.
- `voke <command> --help` / `-h` prints usage, a one-line description, and flags, then exits 0.
  `voke help <command>` is an alias.
- Unknown flags are errors: `Invalid CLI usage: Unknown flag --stag for "synth". Did you mean --stage?`
  plus the usage line. Suggest the closest known flag within edit distance 2. `migrate serverless`
  gets its own spec for the flags it re-parses.

**Evidence**: `bun packages/core/src/cli.ts synth --stag prod` → non-zero, message contains
`Unknown flag --stag` and `--stage`.

### Step 2: Say what happened

Each command prints a result through `options.output ?? console.log`:

- `synth` → `Wrote <artifact> to <path> (<n> resources)` (count `Resources` keys when the
  artifact has them; otherwise omit the count; core must not assume CloudFormation)
- `build` → `Built <outdir>`
- `migrate serverless` → `Wrote migration skeleton to <dir>`
- `remote generate` → one line per generated module
- `local <subcommand>` → one confirmation line after the provider workflow succeeds

Exported functions that tests call directly (`synth`, `build`, `dev`, `createApiProject`,
`migrateServerless`, and the 004/010 deploy/local entry points) keep their parameters and return
values; print from the command handlers.

### Step 3: A scaffold that works immediately

`voke create <name> [directory]` replaces `voke create api <name> [directory]`. A first argument
`api` followed by another argument produces
`Invalid CLI usage: "voke create api" was replaced by: voke create <name> [directory]`.

- Validate the name (npm-safe: lowercase letters, digits, `-`, `.`, `_`, optional `@scope/`). The
  `package.json` `name` is exactly the given name: remove the `@voke/` prefix logic at
  `cli.ts:442-444`. The `voke.config.ts` `name` is the name with any scope stripped.
- Refuse a non-empty target directory with a `CliUsageError` naming it, unless `--force`.
  `--force` writes the scaffold files over existing ones and never deletes other files.
- `package.json`: keep dependencies `voke`, `@voke/aws`, `@voke/testing` from one constant list,
  all `` `^${packageJson.version}` `` (lockstep), and `hono: "^4.0.0"`. Add scripts
  `"deploy": "voke deploy --stage dev"` and `"remove": "voke remove --stage dev"` (use the exact
  flag names plan 004 shipped). Take the `@typescript/native-preview` version from one constant
  that matches the root `catalog` entry.
- Add `.gitignore` (`node_modules`, `dist`, `.voke`, `.env*`, `coverage`) and a short `README.md`
  (dev, test, deploy, remove commands).
- Fix the health-route indentation; generated files must be Ultracite-clean.
- Use `node:fs/promises` `mkdir(..., { recursive: true })` and `join` for all writes.
- Run `bun install` in the new directory through the injected runner unless `--no-install`. If
  install fails, keep the files, print the retry command, and exit non-zero.
- Print, through the injected output:

  ```
  Created my-api in ./my-api

  Next steps:
    cd my-api
    bun run dev        # local API on http://localhost:<port>
    bun test
    bun run deploy     # deploy the dev stage to AWS
  ```

  Use the default dev port from `createDevPlan` (`packages/core/src/dev.ts`); do not hard-code a
  number that differs from it.

- Keep the 4-symlink local-link mechanism in `api.test.ts:403-433`. Add a guard to that test:
  every `voke`/`@voke/*` dependency in the generated `package.json` must have a matching symlink, so
  a new scaffold dependency cannot silently break the smoke test.

### Step 4: Zero-config behavior

In `loadConfigFromFlags`, when no config file exists and `--name` is absent, take `name` from
`./package.json` (strip a scope: `@acme/orders` → `orders`) before falling back to `api`.

Commands that need a Provider (`synth`, `deploy`, `remove`, `local`) and run without one throw
`CliUsageError` with this message (the exact wording is the contract):

```
No provider configured. Add a provider to voke.config.ts, for example:

  import { aws } from "@voke/aws";
  export default defineConfig({ name: "<name>", provider: aws() });
```

Keep the existing `Provider "<name>" does not support <capability>.` error for a configured
Provider that lacks the capability. `voke dev` without a Provider keeps working and prints the
same hint once as a note, since the local Gateway runs without one.

### Step 5: `voke doctor` and the `diagnostics` provider capability

In `packages/core/src/provider.ts` add:

```ts
export type DiagnosticStatus = "ok" | "warn" | "fail";
export interface DiagnosticResult {
  check: string;
  status: DiagnosticStatus;
  detail: string;
}
export interface ProviderDiagnosticsCapability {
  run: (input: {
    config: VokeConfig;
    model: VokeModel;
  }) => Promise<DiagnosticResult[]>;
}
// VokeProvider gains: diagnostics?: ProviderDiagnosticsCapability;
// and VokeProviderCapability includes ProviderDiagnosticsCapability.
```

Create `packages/core/src/doctor.ts` exporting `runDoctor({ output, config?, bunVersion? })`,
wired as `voke doctor`. Core checks:

- Bun version satisfies `engines.bun` from `packages/core/package.json` (added in step 6).
- `voke.config.ts` loads and the entrypoint exists.
- Project discovery works (`loadProject` from plan 003): number of Functions and routes.
- A Provider is configured (otherwise `warn` with the step-4 hint). If it has `diagnostics`, run
  it and print its results. A thrown error becomes a single `fail` row with the error message.

Each row prints as `ok | warn | fail  <check>  <detail or fix>`. Exit code 1 when any row is `fail`.

In `@voke/aws` implement `diagnostics` (`packages/aws/src/diagnostics.ts`, attached by `aws()`):

- AWS credentials resolve for the configured region, through plan 004's AWS client seam (a
  describe call on the bootstrap/stack; "not found" counts as `ok`). Print account id and region
  only.
- The local container tool used by the configured local workflow (plan 010) is available
  (`docker --version`): `warn` when missing, because only `voke local` needs it.

All external calls go through injected seams.

### Step 6: License and package metadata (all 7 packages)

- Root `LICENSE`: standard MIT text, `Copyright (c) 2026 Victor Mesquita` (the git author; the
  owner may name another holder in review).
- `"license": "MIT"` in the root `package.json`, every `packages/*/package.json`, every
  `examples/*/package.json`, and `apps/docs/package.json`. The scaffold's generated
  `package.json` gets no license: that project belongs to the user.
- In each of the 7 package manifests add `description`, `repository`
  (`{ "type": "git", "url": "https://github.com/victor-teles/voke", "directory": "packages/<dir>" }`),
  `homepage`, `keywords`, `files` (`src`, `README.md`, `LICENSE`; plus whatever `exports`/`bin`
  point at if a plan changed them to `dist`), and `engines: { "bun": ">=1.4.4" }`. Versions stay
  equal across all 7 (lockstep).
- A `prepack` script in each package copies the root `LICENSE` and a README (root `README.md` for
  `voke`; a short package README for each `@voke/*`) into the package directory.
- Check each package with `bun pm pack --dry-run`: the tarball has `src/`, `README.md`, `LICENSE`,
  no tests or fixtures, and internal `workspace:*` dependencies are rewritten to the lockstep
  version. If `bun pm pack` does not rewrite `workspace:*`, stop and report (see STOP conditions).
- Add a "License" section to `README.md` (one line: MIT, link to `LICENSE`).

### Step 7: Cross-platform paths (surviving code only)

Replace string splitting and `mkdir -p` with `node:path`/`node:fs/promises` in:

- `cli.ts` (`createApiProject`, `synth`, and any remaining compose/output write).
- `config.ts` `loadVokeConfig`: `isAbsolute`/`resolve` and `pathToFileURL(...).href` for the
  dynamic import; the entrypoint file name via `basename`.
- Whichever of `packages/aws/src/local.ts` (or its plan-010 successor), `packages/remote/src/index.ts`,
  and `packages/build/src/index.ts` still contain the pattern after 009/010.

Before editing, list matches with
`grep -rn 'mkdir -p\|split("/")' packages/*/src --include=*.ts | grep -v serverless-migration`;
any match in a core file that 009/010 were supposed to delete is reported, not fixed. Behavior on
macOS and Linux must not change.

### Step 8: Docs

- `getting-started.mdx`: rewrite as the three-command path (create → dev/test → deploy), then
  explain the generated files and the `provider: aws()` line. Keep manual setup as a second section.
- `reference/cli.mdx`: copy the real `voke --help` and per-command help (add `create`, `doctor`,
  `help`, `--version`, per-command `--help`).
- `README.md`: Quickstart starts with `voke create`; the CLI section matches `voke --help`; install
  commands use the current names and note that the published name is not final.

## Test plan

- `packages/core/test/cli-contract.test.ts`:
  - `--version`, `-v`; `<command> --help` for every spec entry exits 0 and includes the usage
    line; `help <command>`; help output goes through the injected output
  - unknown flag with suggestion; unknown flag with no close match
  - success lines for `synth` (with and without `Resources`), `migrate serverless`, `remote generate`
  - `create`: files written (including `.gitignore`, `README.md`), name not rescoped
    (`created-api` stays `created-api`, `@acme/x` stays `@acme/x`), all Voke dependencies at the
    same `^<version>`, install command issued through the runner, `--no-install` skips it,
    install failure keeps files and exits non-zero, non-empty directory refused, `--force`
    allowed, invalid name rejected, next-steps text printed, `create api <name>` rejected with
    the replacement hint
  - zero-config: name from `package.json` with scope stripped; `synth` without a provider shows
    the `provider: aws()` hint
  - update `cli-contract.test.ts:129-143` and the starter tests at `:180-240` for the new form
- `packages/core/test/api.test.ts`: update `:363-401` for the unscoped name and new scripts; the
  local-link smoke test (`:403-433`) still passes and gains the dependency/symlink guard; assert
  the health route has no stray indentation.
- `packages/core/test/doctor.test.ts`: all-ok with a fake provider `diagnostics`; missing config;
  no provider → `warn` with hint; provider `fail` row → exit code 1; provider throws → one `fail`
  row; provider without `diagnostics` → core checks only.
- `packages/aws/test/diagnostics.test.ts`: credentials ok (account id and region only, no secret
  material in output); credentials failure → `fail`; missing Docker → `warn`.
- Structural pattern: `packages/core/test/cli-contract.test.ts`.

## Done criteria

- [ ] `bun packages/core/src/cli.ts --version` prints the version; `bun packages/core/src/cli.ts dev --help` prints usage and exits 0
- [ ] `bun packages/core/src/cli.ts synth --stag prod` exits non-zero with `Unknown flag --stag` and a `--stage` suggestion
- [ ] In a temp directory without config, `bun <repo>/packages/core/src/cli.ts synth` fails with the `provider: aws()` hint
- [ ] In a temp directory, `voke create demo --no-install` prints the created path and next steps; `package.json` has `"name": "demo"`, `deploy`/`remove` scripts, and `voke`, `@voke/aws`, `@voke/testing` at the same version; `.gitignore` and `README.md` exist
- [ ] `grep -n '@voke/\${' packages/core/src/cli.ts` returns no forced-scope logic
- [ ] `voke doctor` in `examples/hello-api` prints one row per check, including the AWS provider rows
- [ ] `grep -rn 'from "@voke/' packages/core/src` returns no matches
- [ ] `grep -rn 'mkdir -p' packages/core/src/cli.ts packages/core/src/config.ts packages/aws/src packages/remote/src packages/build/src` returns no matches
- [ ] `cd packages/core && bun test` and `cd packages/aws && bun test` → 0 fail; `bun run typecheck`, `bun run test`, and `bun run check` exit 0 at the root
- [ ] `LICENSE` exists with MIT text; `grep -L '"license": "MIT"' package.json packages/*/package.json examples/*/package.json apps/docs/package.json` prints nothing
- [ ] `bun pm pack --dry-run` in each of the 7 packages lists `LICENSE` and `README.md`, no test files; all 7 versions are equal
- [ ] Getting started documents create → dev → deploy
- [ ] The package-name/npm-scope decision is either applied to the docs or reported as still open
- [ ] No files outside the in-scope list are modified

## STOP conditions

- Publishing or reserving a package name or npm scope. This plan prepares metadata only.
- Plan 004, 008, or 010 has not landed: the `deploy`/`remove` scripts, the AWS credential
  diagnostic, the final command set, and the `local` result line depend on them. Steps 3 (except
  scripts), 4, 6, and 7 can proceed; report what is blocked.
- Making doctor or zero-config work seems to require core to import `@voke/aws` or another
  `@voke/*` package. Do not; report the missing provider capability instead.
- Flag validation would reject a flag that a documented workflow or first-party example uses but
  no command reads. List the flags and ask whether to keep accepting them.
- `bun pm pack` leaves `workspace:*` in packed manifests. Report it: publishing then needs a
  release step that is out of scope here.
- A core AWS/local/remote/build copy that plans 009/010 should have deleted still exists. Report
  it; do not fix its paths.

## Maintenance notes

- New commands must be added to the command spec; help and flag validation come from it.
- Lockstep versions: a release bumps all 7 packages together before the scaffold is usable from a
  registry, because the scaffold pins every Voke dependency to the CLI's own version.
- New scaffold dependencies need a matching symlink in the starter smoke test (the guard enforces it).
- Future providers implement `diagnostics` to appear in `voke doctor`; core rows stay provider-neutral.
- Reviewers should scrutinize `--force` semantics, the npm-name validation, and that diagnostics
  output never includes credentials.
- Deferred: project templates (worker, API plus table), interactive prompts, `bunx create-voke`,
  shell completions, and the package-name/npm-scope decision.

## Execution notes (2026-11-14)

Done on branch `feature/first-run-experience` (PR #58), stacked on plan 005 (`feature/production-safe-defaults`,
PR #57, open). Gates: `bun run check` 0 errors, `bun run typecheck` 18/18, `bun run test`
23/23 tasks (core 243, `@voke/aws` 82, `@voke/build` 5).

- **CLI:** `cli-spec.ts` holds one command table that drives `voke --help`, `voke <command> --help`,
  `voke help <command>`, usage errors and flag validation. `--version`/`-v` print `voke <version>`. Unknown
  flags fail with the closest flag within edit distance 2.
- **Result lines:** `synth` (`Wrote template to <path> (<n> resources)`), `build`, `migrate serverless`,
  `remote generate` and `local <subcommand>` print a result line.
- **Scaffold:** `scaffold.ts` implements `voke create <name> [directory] [--no-install] [--force]`. The name
  is not rescoped. All Voke dependencies are pinned at the lockstep version, with `deploy`/`remove`
  scripts, `.gitignore` and `README.md`. `bun install` goes through the runner, and next steps print the
  `defaultDevPort` from `dev.ts`. `voke create api <name>` is rejected with the replacement.
- **Zero-config:** the name comes from `./package.json` (scope stripped). `synth`/`deploy`/`remove`/`local`
  without a Provider fail with the `provider: aws()` hint before importing the project. `voke dev` prints
  the hint as a note.
- **Doctor:** `voke doctor` (`doctor.ts`) checks Bun against `engines.bun`, the config, the entrypoint,
  Functions/routes, and the Provider, then runs `diagnostics`. Any `fail` row exits non-zero.
- **`@voke/aws` diagnostics:**
  - Credentials are checked with `DescribeStacks` on the bootstrap stack. The output is the account id
    (from the stack ARN, once deployed) and the region only. Credential errors reuse the deploy client's
    message, which echoes nothing.
  - The local tool is the first word of the Local AWS Provider's start command (`docker`), checked on
    PATH; it is a `warn` when missing.
- **Metadata:** root MIT `LICENSE` and `"license": "MIT"` in all 13 manifests. The 7 packages gain
  `description`, `repository`, `homepage`, `keywords`, `files`, `engines.bun >=1.4.4`, and
  `prepack`/`postpack` scripts that copy and remove `LICENSE` (plus the root README for `voke`). Each
  `@voke/*` package has a short README.
  - `bun pm pack --dry-run` lists `LICENSE`, `README.md` and `src/` only.
  - `bun pm pack` rewrites `workspace:*` to the exact version `0.0.0` (pinned, not `^`), so no STOP.
- **Paths:**
  - `synth`, the scaffold, and both remote writers use `mkdir(..., { recursive: true })`/`dirname`.
  - `loadVokeConfig` uses `isAbsolute`/`resolve`/`pathToFileURL`, and the handler file name uses
    `basename`.
- **Docs:** getting started is now create → dev/test → deploy, with manual setup second. The CLI reference
  shows the real `voke --help`, `create`, `doctor` and flag errors. The README Quickstart starts with
  `voke create` and adds a License section.

Adaptations and deviations:

- `cli.ts` was 957 lines, so the spec/parser and the scaffold moved into `cli-spec.ts` and `scaffold.ts`.
  `cli.ts` still re-exports `CliUsageError`, `ParsedFlags` and `createApiProject`.
- `ProviderLocalWorkflow` gains an optional `flags` map. `voke local` validates flags against the core
  flags plus the Provider's, and the AWS workflow declares `compose`, `data`, `endpoint`, `hostname`,
  `image`, `port` and `template`.
- Files touched outside the listed scope:
  - `errors/shared.ts` gains the `CREATE_ERROR` code, used when `bun install` fails after scaffolding.
  - `dev.ts` exports `defaultDevPort`.
  - `deploy-clients.ts` adds `StackDescription.id`, the stack ARN.
  - `packages/build/test/build.test.ts`.
  - `deploy-cli.test.ts` and `project.test.ts` were updated for the new hint and the provider-first check.
- **Hangs:** the credentials check has a 10 s limit, and the CLI entry exits after a successful command so a
  pending SDK socket cannot hang it. Run here, `DescribeStacks` never answered, because the sandbox
  cannot reach AWS.
- **No Bun-only API in diagnostics:** `aws()` ships in Lambda bundles, and the Node-runtime test forbids
  the `Bun` global, so the PATH lookup uses `node:fs`.
- **Build paths:** `packages/build` converts `\` to `/` instead of using `node:path`, because its paths
  become bundle paths and Lambda handler names, which must use `/`. A test covers it.
- **Simpler scaffold config:** the generated `voke.config.ts` no longer repeats the default `build.outdir`
  and `cloudFormation.out`.
- **Not changed:** `packages/core/src/project.ts` (`startsWith("/")`, `file://` import) and
  `packages/aws/src/build.ts` (generated import specifiers) are outside this plan's scope.
- **Still open:** the package name and npm scope. The docs say the published names are not final.
- **`voke doctor` in `examples/hello-api`:** prints Bun, Config, Entrypoint, Project (1 Function,
  6 routes), Provider `aws`, AWS credentials (`fail` here: no AWS access within 10 s) and docker (`ok`).
