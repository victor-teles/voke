# Plan 006: A new user goes from nothing to a deployed API with three commands and clear CLI feedback

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare `git diff --stat a7741eb -- packages/core/src/cli.ts packages/core/src/config.ts packages/core/package.json packages/core/test README.md apps/docs/content`
> and `git status --short` with the recorded current state. Reconcile routine drift;
> pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `.factory/plans/004-one-command-deploy.md` (scaffold scripts and docs reference `voke deploy`)
- **Category**: dx
- **Planned at**: commit `a7741eb`, 2026-11-14

## Why this matters

First impressions decide whether a framework feels easy. Today the scaffold command prints
nothing, generates a project whose `voke` dependency cannot be installed, and leaves the user
to guess the next step. `--help` on a command is an error, `--version` is an unknown command,
and a mistyped flag is silently ignored. After this plan the path is:
`voke create my-api`, `cd my-api`, `bun run deploy`, with the CLI telling the user what happened
and what to do next at each step.

## Current state

Verified by running the CLI from source in a scratch copy.

- `voke create api demo` exits 0 and prints nothing. Handler: `packages/core/src/cli.ts:712-724`;
  generator: `createApiProject` (`cli.ts:434-464`).
- The generated `package.json` (`cli.ts:375-397`) depends on `` voke: `^${packageJson.version}` ``,
  which is `^0.0.0` today, names the project `@voke/<name>`, and pins
  `"@typescript/native-preview": "^7.0.0-dev.20260516.1"`. There is no install step. Running
  `voke synth` inside the new project failed with
  `Cannot find package 'voke' imported from .../demo/voke.config.ts`.
- The scaffold writes `package.json`, `tsconfig.json`, `voke.config.ts`, `src/index.ts`,
  `src/routes/health.ts`, `test/api.test.ts`. It writes no `.gitignore`, no README, and no
  `deploy` script. The health route template has stray indentation (`cli.ts:321-326`).
- `voke dev --help` → `Invalid CLI usage: Missing value for --help`. `voke --version` →
  `Invalid CLI usage: Unknown command: --version`. Only bare `voke`, `voke --help`, and `voke -h`
  print help (`cli.ts:778-781`).
- `parseFlags` (`cli.ts:131-168`) accepts any flag name. `voke synth --stag prod` silently
  ignores the typo and synthesizes the default stage. (Plan 004 adds boolean flags to this parser.)
- `voke synth`, `voke migrate serverless`, and `voke remote generate` print nothing on success
  (`cli.ts:744-769`). `synth()` returns the output path but the handler drops it.
- Without a config file, `loadConfigFromFlags` (`cli.ts:415-432`) names the project `api`.
- Path handling uses `split("/")` and `Bun.$\`mkdir -p ...\``, for example `cli.ts:177-181`,
`cli.ts:442`, `cli.ts:524-528`, `packages/core/src/local.ts:58-62`, and
`packages/core/src/config.ts:216` (`path.startsWith("/")` as the absolute-path test). These
  break on Windows.
- `packages/core/package.json`: `"version": "0.0.0"`, `"bin": { "voke": "./src/cli.ts" }`
  (Bun shebang), `exports` point at TypeScript source, and there is no `description`, `license`,
  `repository`, `files`, or `engines`. The repository has no `LICENSE` file.
- Docs: `apps/docs/content/docs/getting-started.mdx` starts from "add `voke.config.ts`" by hand
  and ends at `voke synth`; it never mentions `voke create` or deploying. `README.md:75-87`
  lists CLI commands, with deploy and remove fixed by plan 004.
- CLI conventions: `CliUsageError` (`cli.ts:49-54`), per-command usage strings in `commandUsage`
  (`cli.ts:89-101`), messages shaped `Invalid CLI usage: <problem>\nUsage: ...`
  (`docs/error-conventions.md`). Output is injectable through `CliOptions.output` (`cli.ts:20-26`).
- `test/api.test.ts` contains "generated starter test suite passes with local package links",
  which scaffolds a project, links the local package, and runs its tests. Keep that mechanism.
- `docs/stable-public-surface.md`: the CLI module is not a public subpath; CLI behavior is still
  user-facing and covered by `test/cli-contract.test.ts`.

## Owner decisions

Decided on 2026-11-14:

- **License: MIT, for everything in the repository.** Root `LICENSE`, and `"license": "MIT"` in
  every `package.json` (root, `packages/core`, each example, `apps/docs`).
- **Bun 1.4.4** is the supported toolchain (plan 001 raises the pin). `engines.bun` is `>=1.4.4`.

Still open (do not guess):

- **Package name and registry.** Whether the framework publishes to npm as `voke` (name
  availability was not checked) or under a scope. Only the docs install command and the
  registry check in step 7 depend on it; the `name` field stays `voke` until decided.

## Commands you will need

| Purpose               | Command                                                                             | Expected on success                 |
| --------------------- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| Install               | `bun install`                                                                       | exit 0                              |
| Core tests            | `cd packages/core && bun test`                                                      | all pass                            |
| One test file         | `cd packages/core && bun test test/cli-contract.test.ts`                            | all pass                            |
| Core typecheck        | `cd packages/core && bun run typecheck`                                             | exit 0                              |
| Repo gates            | `bun run typecheck && bun run test`                                                 | exit 0                              |
| Lint/format           | `bun run check`                                                                     | exit 0                              |
| Manual scaffold check | `cd "$(mktemp -d)" && bun <repo>/packages/core/src/cli.ts create demo --no-install` | prints created files and next steps |

## Implementation rules relevant to this plan

- Test first: each CLI behavior gets a case in `test/cli-contract.test.ts` using the injected
  `output` and `run` seams. Tests must not hit the network; `bun install` in the scaffold runs
  through the injected runner so tests assert the command instead of executing it.
- Success output is short and factual: what was written, then the next command. No emoji, no
  banners. Errors keep the `Invalid CLI usage: ...\nUsage: ...` shape.
- Use `node:path` (`dirname`, `join`, `isAbsolute`, `resolve`) and `node:fs/promises`
  (`mkdir(dir, { recursive: true })`) instead of string splitting and shell `mkdir -p`.
- One name per command (ADR `docs/adr/0007-opinionated-framework.md`): the scaffold command is
  `voke create <name> [directory]`. The old `voke create api <name>` form is removed, not aliased;
  it fails with a usage error that shows the new form.
- No new dependencies.
- Generated project code must pass the repository's own lint/format rules (Ultracite).

## Scope

**In scope**:

- `packages/core/src/cli.ts`, `packages/core/src/config.ts` (path handling in `loadVokeConfig` only), `packages/core/src/local.ts` (directory creation only), `packages/core/src/remote.ts` (directory creation in `generateRemoteModules` only)
- `packages/core/src/doctor.ts` (create)
- `LICENSE` (create), `package.json`, `packages/core/package.json`, `examples/*/package.json`, `apps/docs/package.json` (license and package metadata only)
- `packages/core/test/cli-contract.test.ts`, `test/api.test.ts` (scaffold assertions), `test/doctor.test.ts` (create)
- `README.md`, `apps/docs/content/docs/getting-started.mdx`, `apps/docs/content/docs/reference/cli.mdx`, `apps/docs/content/docs/index.mdx`
- `.factory/plans/README.md` (status only)

**Out of scope**:

- Publishing to a registry, release automation, changelog tooling.
- Compiling the package to JavaScript for non-Bun consumers. Voke stays Bun-first.
- Interactive prompts or multiple project templates beyond the API starter.
- `voke logs`, `voke invoke`, `voke event` (see the plans index, deferred opportunities).
- Rewriting `packages/core/src/serverless-migration.ts` path handling.

## Git workflow

- Branch: `feature/first-run-experience`
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Help, version, and flag validation

- `voke --version` and `voke -v` print `voke <version>`.
- `voke <command> --help` (and `-h`) prints that command's usage, a one-line description, and
  its flags, then exits 0. Extend `commandUsage` into a small per-command spec:
  `{ usage, description, flags: Record<string, { description, boolean? }> }`. Generate
  `printHelp` from the same spec so the two cannot drift.
- Unknown flags are errors: `Invalid CLI usage: Unknown flag --stag for "synth". Did you mean --stage?`
  followed by the usage line. Suggest the closest known flag by edit distance when one is within
  distance 2. `migrate serverless` re-parses its own flags (`cli.ts:751`); give it its own spec.
- `voke help <command>` is an alias for `voke <command> --help`.

### Step 2: Say what happened

Each command prints a result through `options.output ?? console.log`:

- `synth` → `Wrote CloudFormation template to <path> (<n> resources)`
- `build` → after the bundler output, `Built <outdir>/index.js`
- `migrate serverless` → `Wrote migration skeleton to <dir>` and the report path
- `remote generate` → one line per generated module
- `local start|stop|reset|bootstrap` → one confirmation line after the provider command succeeds

Change the handler signatures as needed; exported functions that tests call directly
(`synth`, `build`, `dev`, `local`, `createApiProject`, `migrateServerless`) keep their current
parameters and return values.

### Step 3: A scaffold that works immediately

`voke create <name> [directory]` (replacing `voke create api <name> [directory]`; a first
argument of `api` followed by a name produces `Invalid CLI usage: "voke create api" was replaced by: voke create <name> [directory]`):

- Refuse to write into a non-empty directory: `CliUsageError` naming the directory, unless `--force`.
- Validate the name (npm-safe: lowercase letters, digits, `-`, optional scope).
- Project `package.json`: `name` is the given name (no forced `@voke/` scope); scripts add
  `"deploy": "voke deploy --stage dev"` and `"remove": "voke remove --stage dev"`; TypeScript
  tooling uses the same versions as this repository's root `package.json` catalog entry at the
  time of the change, defined in one constant.
- Additional files: `.gitignore` (`node_modules`, `dist`, `.voke`, `.env*`, `coverage`) and a
  short `README.md` (dev, test, deploy, remove commands).
- Fix the health route template formatting; generated files must be Ultracite-clean.
- Run `bun install` in the new directory through the injected runner unless `--no-install`.
  If install fails, keep the files and print the command to retry.
- Print:

  ```
  Created my-api in ./my-api

  Next steps:
    cd my-api
    bun run dev        # local API on http://localhost:3000
    bun test
    bun run deploy     # deploy the dev stage to AWS
  ```

- The `voke` dependency version: keep `` `^${packageJson.version}` `` and the local-link
  mechanism the existing starter test uses. The published name is an owner decision (step 7).

### Step 4: Sensible zero-config defaults

In `loadConfigFromFlags`, when no config file exists and `--name` is absent, use the `name` from
`./package.json` (strip a scope: `@acme/orders` → `orders`) before falling back to `api`.

### Step 5: `voke doctor`

Create `packages/core/src/doctor.ts` exporting `runDoctor({ run, output, config? })`, wired as
`voke doctor`. Checks, each printed as `ok | warn | fail  <check>  <detail or fix>`:

- Bun version satisfies `engines.bun` in `packages/core/package.json` (`>=1.4.4`, added in step 7).
- `voke.config.ts` loads and the entrypoint exists.
- Project discovery works (`loadProject` from plan 003): number of Functions and routes found.
- AWS credentials resolve for the configured region (through the plan 004 client seam: a
  `describeStack` call on the bootstrap stack; "not found" counts as ok). Never print identity
  secrets; account id and region are fine.
- Docker is available (`docker --version`), reported as `warn` when missing because it is only
  needed for `voke local`.

Exit code 1 when any check fails. All external calls go through injected seams for tests.

### Step 6: Cross-platform paths

Replace `split("/")`/`mkdir -p` directory handling in the in-scope files with `node:path` and
`node:fs/promises`. In `loadVokeConfig` use `isAbsolute`/`resolve` and `pathToFileURL` for the
dynamic import URL. Behavior on macOS and Linux must not change.

### Step 7: License and package metadata

- Add `LICENSE` at the repository root with the standard MIT text. Copyright line:
  `Copyright (c) 2026 Victor Mesquita` (the git author identity of this repository; the owner can
  name a different holder in review).
- Add `"license": "MIT"` to the root `package.json`, `packages/core/package.json`, every
  `examples/*/package.json`, and `apps/docs/package.json`. Do not put a license in the scaffold's
  generated `package.json`: that project belongs to the user.
- In `packages/core/package.json` add `description`, `repository`
  (`https://github.com/victor-teles/voke`, `directory: "packages/core"`), `homepage`, `keywords`,
  `files` (`src`, `README.md`, `LICENSE`), and `engines: { "bun": ">=1.4.4" }`.
- Copy the root `README.md` and `LICENSE` into the package at pack time (a `prepack` script) so
  the registry page is not empty and the tarball carries the license.
- Verify with `cd packages/core && bun pm pack --dry-run`: the tarball contains `src/`,
  `README.md`, `LICENSE`, and no tests or fixtures.
- Add a "License" section to `README.md` (one line: MIT, link to `LICENSE`).

Waiting on the package-name decision only: the install command in the docs
(`bun add <name>`) and confirming the name is available on the registry. Write the docs with
`voke` and report the name as unconfirmed if the decision has not arrived.

### Step 8: Docs

- `apps/docs/content/docs/getting-started.mdx`: rewrite as the three-command path
  (create → dev/test → deploy), then explain the generated files. Keep the manual setup as a
  second section.
- `apps/docs/content/docs/reference/cli.mdx`: generate the command list from the real help text
  (copy it; add `create`, `doctor`, `help`, `--version`, per-command `--help`).
- `README.md`: Quickstart starts with `voke create`; the CLI section matches `voke --help`.

## Test plan

- `test/cli-contract.test.ts`:
  - `--version`, `-v`; `<command> --help` for every command exits without error and includes the
    usage line; `help <command>`
  - unknown flag error with suggestion; unknown flag with no close match
  - success lines for `synth`, `migrate serverless`, `remote generate`
  - `create`: files written (including `.gitignore`, `README.md`), install command issued through
    the runner, `--no-install` skips it, non-empty directory refused, `--force` allowed, invalid
    name rejected, next-steps text printed, `create api <name>` rejected with the replacement hint
  - zero-config name from `package.json`, scope stripped
- `test/api.test.ts`: the existing generated-starter test still passes; add an assertion that the
  generated sources pass `ultracite check` only if that can run offline in the test environment,
  otherwise assert formatting-sensitive snippets (no stray indentation) directly.
- `test/doctor.test.ts`: all-ok run; missing config; credentials failure produces `fail` and exit
  code 1 without secret material; missing Docker produces `warn` and exit code 0.
- Structural pattern: `packages/core/test/cli-contract.test.ts`.

## Done criteria

- [ ] `bun packages/core/src/cli.ts --version` prints the version; `bun packages/core/src/cli.ts dev --help` prints usage and exits 0
- [ ] `bun packages/core/src/cli.ts synth --stag prod` exits non-zero with `Unknown flag --stag` and a `--stage` suggestion
- [ ] In a temp directory, `voke create demo --no-install` prints the created path and next steps, and the directory contains `.gitignore`, `README.md`, and a `deploy` script
- [ ] `voke doctor` runs in `examples/hello-api` and reports each check on its own line
- [ ] `grep -n 'mkdir -p' packages/core/src/cli.ts packages/core/src/local.ts packages/core/src/remote.ts` returns no matches
- [ ] `cd packages/core && bun test` → 0 fail; `bun run typecheck` exits 0; `bun run check` exits 0
- [ ] Getting started documents create → dev → deploy
- [ ] `LICENSE` exists with MIT text; `grep -L '"license": "MIT"' package.json packages/core/package.json examples/*/package.json apps/docs/package.json` prints nothing
- [ ] `cd packages/core && bun pm pack --dry-run` lists `LICENSE` and `README.md` and no test files
- [ ] The package-name decision is either applied to the docs or reported as still open
- [ ] No files outside the in-scope list are modified

## STOP conditions

- Publishing or reserving a package name on a registry. This plan prepares metadata only; do
  not publish and do not pick a different package name.
- Flag validation would reject a flag that a documented workflow or first-party example uses but
  that no command reads today. List such flags and ask whether to keep accepting them.
- Plan 004 has not landed: `deploy`/`remove` scripts and doctor's credential check depend on it.
  Steps 1, 2, 4, and 6 can still proceed.

## Maintenance notes

- New commands must be added to the command spec; help and flag validation come from it.
- When the package is published, the scaffold's `voke` version comes from the CLI's own
  `package.json`, so a release must bump the version before the scaffold is usable from a registry.
- Reviewers should scrutinize the create command's directory safety (`--force` semantics) and
  that doctor output never includes credentials.
- Deferred: project templates (worker, API plus table), interactive prompts, `bunx create-voke`,
  shell completions.
