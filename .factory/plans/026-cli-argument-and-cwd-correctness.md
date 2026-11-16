# Plan 026: The CLI rejects arguments it does not use and finds the project from the process working directory

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/core/src/cli.ts packages/core/src/cli-spec.ts packages/core/src/project.ts packages/core/src/config.ts packages/core/src/app.ts packages/core/src/plugin.ts packages/core/test apps/docs/content/docs/reference/cli.mdx apps/docs/content/docs/reference/errors.mdx apps/docs/content/docs/guides/plugins.mdx examples/*/package.json`
> and `git status --short` with the recorded current state. Plans 022, 023 and 025 land first
> and touch some of these files on purpose (see "State after the earlier plans"). Reconcile
> that drift; pause only if it invalidates a decision listed below.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none. Ordering only: (`.factory/plans/022-root-test-run.md`, which edits
  `packages/core/test/api.test.ts`), (plan 023, which edits other functions of
  `packages/core/src/app.ts`), (plan 025, which edits the `migrate` handler in
  `packages/core/src/cli.ts`).
- **Category**: bug / dx
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

`voke deploy prod` and `voke remove prod --yes` do not act on `prod`: the word is dropped and the
command runs against the stage in the config. The same happens with `voke deploy -s prod`. A
person who believes they removed `prod` removed another stage, with no message.

The CLI also reads the project directory from the `PWD` environment variable instead of the
process working directory. `PWD` is unset in Windows `cmd` and PowerShell, and it is stale
whenever a tool starts `voke` with a `cwd` option (`bun --cwd`, `Bun.spawn({ cwd })`, Node
`spawn({ cwd })`). With `PWD` unset, `voke synth` fails with `Cannot find module '/src/index.ts'`;
with a stale `PWD`, Voke looks for `voke.config.ts` in the wrong directory.

After this plan every argument a user types is either used or rejected with a usage error that
names the right flag, and every command resolves the project from `process.cwd()`.

## Current state

### Architecture rules (binding)

- `docs/adr/0007-opinionated-framework.md`: one supported way per layer, one spelling per
  setting, and removals **without** deprecation aliases (the package is unreleased, `0.0.0`).
- `docs/adr/0015-plugin-contract.md`: "`cli.commands` adds `voke <plugin> <command>`. Built-in
  commands win". A Plugin cannot add flags to built-in commands.
- `packages/core/src/cli-spec.ts:55-58`: "Every command, its usage, and the flags it reads. Help,
  usage errors and flag validation all come from this one table, so they cannot drift apart."
  This plan keeps that property and extends the table; it does not add a second source.
- `voke` (core) must not import `@voke/*`.
- Vocabulary (`CONTEXT.md`): **Voke Project**, **Provider**, **Plugin**, **Function**,
  **Local AWS Provider**. This plan adds no domain term.

### How arguments are parsed today (`1c59d39`)

`runCli` (`packages/core/src/cli.ts:947-986`) splits `argv` into `[command, ...args]`, calls
`parseFlags(command, args)`, then `assertKnownFlags`, then `handler(args, flags, options)`.

`parseFlags` (`packages/core/src/cli-spec.ts:289-292`) treats everything that does not start
with `--` as a positional:

```ts
if (!arg.startsWith("--")) {
  positional.push(arg);
  continue;
}
```

So `-s` and `prod` both become positionals. Nothing checks the positionals against the command.
A flag value is stored as given, including an empty one (`--stage=` stores `""`).

The spec (`cli-spec.ts:21-25`) has no field for positionals; the `usage` string is the only
place they appear:

```ts
export interface CliCommandSpec {
  usage: string;
  description: string;
  flags: Readonly<Record<string, CliFlagSpec>>;
}
```

Per command, what the usage declares and what the handler reads (`cli.ts:648-799`):

| Command            | Usage declares                    | Handler reads                                                                    | What is dropped or wrong                                                              |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `build` (`:649`)   | `[entrypoint] [outdir]`           | `positional[0] ?? --entrypoint`, `positional[1] ?? --outdir`                     | 3rd+ positional ignored; with both spellings the flag is ignored                      |
| `create` (`:663`)  | `<name> [directory]`              | `positional[0]`, `positional[1]`                                                 | 3rd+ ignored                                                                          |
| `deploy` (`:685`)  | none                              | none (`_args`)                                                                   | **every positional ignored**                                                          |
| `dev` (`:703`)     | `[entrypoint]`                    | `positional[0] ?? --entrypoint`; `Number(flags.values.port)` (`:715`)            | 2nd+ ignored; `--port abc` becomes `NaN`                                              |
| `doctor` (`:721`)  | none                              | none                                                                             | every positional ignored                                                              |
| `local` (`:736`)   | `<start\|stop\|reset\|bootstrap>` | raw `args[0]`                                                                    | flags before the subcommand break it; 2nd+ positional ignored                         |
| `migrate` (`:740`) | `serverless [serverless.yml]`     | `positional[0]`, `[1]`, and `[2]` as the output directory (`:170`, undocumented) | 4th+ ignored                                                                          |
| `remote` (`:754`)  | `generate [name]`                 | raw `args[0]`; names = `positional.slice(1)`                                     | flags before `generate` break it; **no name generates nothing**                       |
| `remove` (`:764`)  | none                              | none (`_args`)                                                                   | **every positional ignored**                                                          |
| `synth` (`:780`)   | `[entrypoint] [out]`              | `--entrypoint ?? positional[0]`, `--out ?? positional[1]`                        | 3rd+ ignored; with both spellings the positional is ignored (the opposite of `build`) |

Verified by running `runCli` against a recording Provider whose config sets `stage: "staging"`:

```txt
deploy prod --dry-run      -> "Building routed (staging)", provider got deploy:staging
deploy -s prod --dry-run   -> "Building routed (staging)", provider got deploy:staging
remove prod --yes          -> "Removed routed-staging"
local --config <path> start        -> Invalid CLI usage: Usage: voke local <start|stop|reset|bootstrap>
remote --config <path> generate    -> Invalid CLI usage: Usage: voke remote generate [name]
remote generate --config <path>    -> exit 0, no output, no fetch (two remotes configured)
dev --port abc             -> VOKE_DEV_ORIGIN=http://localhost:NaN
dev --port ""              -> VOKE_DEV_ORIGIN=http://localhost:0
```

The `remote generate` no-op comes from `cli.ts:621-624`: with `positional = ["generate"]` the
names are `[]`, and `generateRemoteModules` (`packages/core/src/remote.ts:648`) only falls back
to every remote when `names` is `undefined`:

```ts
names:
  flags.positional.length === 0 ? undefined : flags.positional.slice(1),
```

Other facts:

- `resolveStage` (`cli.ts:325-326`) is `flags.values.stage ?? readEnv("VOKE_STAGE") ?? config.stage`.
  An empty `--stage=` (for example `--stage=$STAGE` with `STAGE` unset in CI) is kept, so the
  stack name becomes `<name>-`. Read, not run.
- `build` without a Provider says `No provider configured for build.` (`cli.ts:291`), and it
  imports the project before it checks the Provider. `synth`, `deploy`, `remove` and `local`
  call `assertProviderConfigured` first and print `missingProviderMessage` (`cli-spec.ts:13-17`),
  whose comment says it is "The one message every Provider-dependent command gives".
  `apps/docs/content/docs/reference/cli.mdx:64-67` documents the shared message for `build` too.
- `withUsage` (`cli.ts:804-808`) turns a `CliUsageError` thrown by a handler into
  `Invalid CLI usage: <message>\nUsage: <spec.usage>`. Throw plain messages; it adds the rest.
- Plugin commands (`cli.ts:876-945`) go through the same `parseFlags` and `assertKnownFlags`
  with `pluginCommandSpecs(...)`, then call `command.run({ ..., positional: flags.positional })`.
  `PluginCommand` (`packages/core/src/plugin.ts`, near line 94) has `description`, `usage`,
  `flags?` and `run`. `voke openapi generate out.json` ignores `out.json` (the command reads
  `--out`).
- `-h` and `--help` are handled before `parseFlags` (`isHelpRequest`, `cli.ts:916,969`), and
  `-v` at the top level (`cli.ts:838`). They are the only short flags.

### How the working directory is read today

Six places read `PWD`; none reads `process.cwd()`:

```ts
// packages/core/src/project.ts:88     (loadProject)
const cwd = options.cwd ?? readEnv("PWD") ?? ".";
// packages/core/src/config.ts:372     (loadVokeConfig)
const cwd = options.cwd ?? readEnv("PWD") ?? ".";
// packages/core/src/cli.ts:423        (deployProject)
const cwd = options.cwd ?? readEnv("PWD") ?? ".";
// packages/core/src/cli.ts:813        (helpPlugins)
const path = resolve(readEnv("PWD") ?? ".", "voke.config.ts");
// packages/core/src/cli.ts:923        (runPluginCommand)
const cwd = readEnv("PWD") ?? ".";
// packages/core/src/app.ts:266-267    (loadRuntimeConfig, used by voke(functions) with no config)
const cwd = readEnv("PWD") ?? ".";
const path = `${cwd}/voke.config.ts`;
```

`loadProject` then builds the import URL by hand (`project.ts:52-60,96`):
`toAbsolutePath` only treats a path that starts with `/` as absolute, and the result goes into
`new URL(\`file://${entrypoint}\`)`. With `cwd === "."`that is`file://./src/index.ts`, which is
`/src/index.ts`.

Everything else in the CLI already uses the process working directory, through relative paths:
`Bun.file(configPath).exists()` (`cli.ts:213,219,884`), `Bun.file("package.json")` (`:183`),
the build's `Bun.write(path, contents)` and `runCommand(plan.command)` (`:309-313`), the synth
output (`:268-269`), `createDevPlan`'s entrypoint check, and `runDoctor`
(`packages/core/src/doctor.ts:183`, `options.cwd ?? process.cwd()`). The two sources disagree
whenever `PWD` is not the working directory.

Verified from `examples/hello-api`:

```txt
env -u PWD voke synth              -> Could not import the project entrypoint ./src/index.ts: Cannot find module '/src/index.ts'
env -u PWD voke openapi generate   -> the same error
env -u PWD voke doctor             -> works (it uses process.cwd())
PWD=<other dir> voke synth         -> Voke config file not found: <other dir>/voke.config.ts
```

and `bun --cwd examples/hello-api -e ...`, `Bun.spawn([...], { cwd })` and Node
`execFileSync(..., { cwd })` all leave `process.env.PWD` at the parent's directory.

**Why `PWD` is there**: tests inject a directory through it. `git log -S'"PWD"'` shows it arriving
with the test changes of `edb640c`, `d29d8a1`, `fac21a8` and `121378d`.
`packages/core/test/support/isolate-env.ts:4` says "PWD is kept because config loading resolves
paths from it." Seven test sites set it:

- `packages/core/test/cli-contract.test.ts:658-665` and `:679-686` (`voke --help` Plugin lines)
- `packages/core/test/build-cli.test.ts:45-56` and `:111-121`
- `packages/core/test/api.test.ts:522-534` (`withPwd`), used at `:568`
- `packages/core/test/public-api-redesign.test.ts:92-116` and `:121-140` (`voke(functions)`
  auto-loading `voke.config.ts`)

`cli-contract.test.ts:314-346` uses `process.chdir` instead, because `packageJsonName` reads
`./package.json` from the real working directory.

### Examples and docs

- All seven examples (`examples/{cross-function,durable-workflow,e2e,event-sources,hello-api,sqs-events,stream-events}/package.json`)
  have `"deploy": "voke deploy"` and `"remove": "voke remove"`. No example config sets a
  deployable stage (`hello-api` sets `stage: "local"`, the others default to `local`,
  `packages/core/src/config.ts:339`), so `bun run deploy` always stops with
  `Stage "local" is reserved for the local emulator. Deploy to AWS with: voke deploy --stage dev`
  (`cli.ts:333-336`; run and confirmed in `examples/hello-api`).
- The scaffold already writes `deploy: "voke deploy --stage dev"` and
  `remove: "voke remove --stage dev"` (`packages/core/src/scaffold.ts:150-155`, pinned by
  `packages/core/test/api.test.ts:314-315`).
- `apps/docs/content/docs/reference/cli.mdx` reproduces `voke --help` and every command's
  `--help`. No test compares it with the real output. Compared by eye during planning, the
  help blocks match `formatHelp()` and `formatCommandHelp(name)`; the only false statement
  found is the Provider callout for `build` (above).

### State after the earlier plans (expected; verify)

- Plan 022 wraps the test "runs create and build through the CLI parser" in
  `packages/core/test/api.test.ts` in `process.chdir` to the `packages/core` directory. Keep
  that: the test runs the real `bun build`, the generated entry `.voke/build/index.ts` is
  written relative to the process working directory, and it imports `@voke/aws`, which only
  resolves from inside the workspace. The `cwd` option of this plan does not move build output
  (decision 7).
- Plan 023 edits error mapping in `packages/core/src/app.ts` (around lines 65-129). This plan
  edits only `loadRuntimeConfig` (line 265).
- Plan 025 edits `packages/core/src/serverless-migration.ts` and may touch the `migrate`
  handler and its spec entry. Apply decision 2 to whatever positionals `migrate` has by then.

## Decisions taken in this plan

1. **Positionals are declared in the spec table and checked before the handler runs.**
   Default: `CliCommandSpec` gets `positionals?: readonly CliPositionalSpec[]` (omitted = the
   command takes none) and `strayArgumentFlag?: string`. One function, `assertPositionals`,
   rejects a missing required positional, a value outside `choices`, and any extra argument.
   Reason: it is the only way a command cannot forget to check, and it keeps one table.
   Reverse: delete the `assertPositionals` call in `runCli`.
2. **An extra argument is a usage error that names the flag.** `voke deploy prod` fails with
   `Unexpected argument "prod" for "deploy". Did you mean --stage prod?`. `deploy` and `remove`
   set `strayArgumentFlag: "stage"`; `migrate` sets `"out"`. No positional stage is added: the
   stage has one spelling (ADR 0007). Reverse: declare a positional in the spec.
3. **Short flags are rejected, not added.** An argument that starts with one `-`, is longer than
   `-`, and was not consumed as a flag value fails with
   `Short flags are not supported: -s. Did you mean --stage?`. The suggestion is the closest
   known flag for a multi-letter spelling (`-stage`), otherwise the first known flag that
   starts with that letter, otherwise none. `-h` and `-v` keep working because they are handled
   before parsing. A lone `-` stays a positional. Reverse: remove the branch in `parseFlags`.
4. **A flag with an empty value is a missing value.** `--stage=`, `--stage ""` and `--yes=`
   fail with `Missing value for --stage`. Reason: `--stage=$UNSET` must not deploy a stage
   named `""`. Reverse: remove the check.
5. **One setting given twice is an error.** `build`, `dev` and `synth` keep both spellings of
   the entrypoint and output (positional and flag) because tests, docs and scripts use both,
   but passing both fails with
   `Got both the argument "./a.ts" and --entrypoint. Pass the entrypoint once.`
   This also removes the opposite precedence of `build` and `synth`. Removing one spelling is a
   separate product decision (deferred). `migrate`'s undocumented third positional (output
   directory) is removed; `--out` is its one spelling. Reverse: drop `flag` from the positional
   specs.
6. **Plugin commands declare positionals too.** `PluginCommand` gets
   `positionals?: readonly CliPositionalSpec[]`; without it the command takes none and an extra
   argument is rejected. Reason: `voke openapi generate out.json` silently writes
   `openapi.json` today. A Plugin command that reads `positional` must now declare it. Reverse:
   skip `assertPositionals` in `runPluginCommand`.
7. **The working directory is `process.cwd()`, with one injection point.** Every `PWD` read
   becomes `process.cwd()`. `runCli(argv, { cwd })` gets a `cwd` option, default
   `process.cwd()`, that replaces what tests did with `PWD`: it is where the config file,
   `package.json`, the project entrypoint, the deploy artifact and `.voke/outputs` resolve, and
   it is the `cwd` a Plugin command receives. It does **not** move relative output paths or
   spawned tools (the build's generated entry, the synth output, `voke dev`'s child process,
   the Local AWS Provider): those keep using the real working directory, exactly as today. A
   full redirect needs changes to `dev.ts`, the Provider contract and `@voke/aws`, and belongs
   to a `--cwd` flag (deferred). Reverse: none needed; `PWD` is never read again.
8. **`voke(functions)` auto-load uses `process.cwd()`; its two tests use a scoped
   `process.chdir`.** `voke()` has no option that could carry a directory, and adding one is a
   new public setting. `voke()` is synchronous, so a `chdir` wrapped around that one call
   cannot interleave with other work; plan 022 and `cli-contract.test.ts:331-345` already use
   the same convention.
9. **`--port` is validated in the `dev` handler.** Digits only, 1 to 65535, otherwise
   `Invalid value for --port: "abc". Expected a port number from 1 to 65535.` It is the only
   numeric built-in flag, so no value type is added to `CliFlagSpec` (a public Plugin type).
   Reverse: move the check into the spec when a second numeric flag appears.
10. **`build` gives the shared missing-Provider message, before importing the project.** The
    code changes to match `cli.mdx` and the comment on `missingProviderMessage`, not the
    reverse.
11. **Example scripts match the scaffold**: `voke deploy --stage dev` and
    `voke remove --stage dev`.

No ADR: each decision is a few lines to reverse and none changes a stored format.

## Commands you will need

| Purpose                  | Command                                                   | Expected on success |
| ------------------------ | --------------------------------------------------------- | ------------------- |
| One core test file       | `cd packages/core && bun test test/cli-arguments.test.ts` | all pass            |
| Core tests               | `cd packages/core && bun test`                            | all pass            |
| Core types               | `cd packages/core && bun run typecheck`                   | exit 0              |
| Docs tests               | `cd apps/docs && bun test`                                | all pass            |
| All tests (what CI runs) | `bun run test` (repo root)                                | all tasks green     |
| All types                | `bun run typecheck` (repo root)                           | exit 0              |
| Lint and format check    | `bun run check` (repo root)                               | exit 0              |
| Format                   | `bun x ultracite fix`                                     | exit 0              |

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`): write the failing test, then the change.
- Bun APIs first; `node:path` and `node:url` are already used in `config.ts`.
- `packages/core/src/app.ts` and `config.ts` ship inside Lambda bundles that run on Node: no
  `Bun` global there. `process.cwd()`, `node:path` and `node:url` are fine.
  `packages/core/test/node-runtime.test.ts` must stay green.
- Ultracite: no `console.log`, no `.only`/`.skip`, `for...of` over `.forEach`, top-level regex
  literals, no barrel files.
- Tests are deterministic: no network, no real AWS. Use `tempPath` from
  `packages/core/test/support/temp.ts` and `withEnv`/`setEnv` from
  `packages/core/test/support/env.ts` (assigning `undefined` to an environment variable stores
  the string `"undefined"` in Bun; `setEnv` deletes instead).
- Throw `CliUsageError` with the bare message; `withUsage` adds `Invalid CLI usage:` and the
  usage line.

## Scope

**In scope** (the only files you should modify or create):

- `packages/core/src/cli-spec.ts`
- `packages/core/src/cli.ts`
- `packages/core/src/plugin.ts` (the `CliPositionalSpec` type and `PluginCommand.positionals`)
- `packages/core/src/index.ts` (export the `CliPositionalSpec` type next to `PluginCommand`)
- `packages/core/src/project.ts`
- `packages/core/src/config.ts` (line 372 only)
- `packages/core/src/app.ts` (`loadRuntimeConfig` only)
- `packages/core/test/cli-arguments.test.ts` (create)
- `packages/core/test/cli-working-directory.test.ts` (create)
- `packages/core/test/cli-contract.test.ts`, `build-cli.test.ts`, `api.test.ts`,
  `public-api-redesign.test.ts`, `deploy-cli.test.ts`, `local.test.ts`,
  `serverless-migration.test.ts`, `support/isolate-env.ts` (comment)
- `examples/*/package.json` (the `deploy` and `remove` scripts of the seven examples)
- `apps/docs/content/docs/reference/cli.mdx`, `apps/docs/content/docs/reference/errors.mdx`,
  `apps/docs/content/docs/guides/plugins.mdx`
- `docs/stable-public-surface.md` (add `CliPositionalSpec` to the Plugin type list, line 15)

**Out of scope** (do NOT touch):

- `packages/core/src/doctor.ts`: it already uses `process.cwd()`.
- `packages/core/src/dev.ts`, `packages/core/src/provider.ts`, `packages/aws/**`: moving build
  output, the dev child process or the Local AWS Provider to another directory is the deferred
  `--cwd` work.
- `packages/core/src/remote.ts` and `packages/remote/**` (plan 031). The `remote generate` fix
  is in `cli.ts`.
- `packages/core/src/serverless-migration.ts` (plan 025).
- `packages/core/src/scaffold.ts`: its scripts are already right.
- New flags or output modes: see "Deferred".
- `.factory/plans/README.md`.

## Git workflow

- Branch: `feature/cli-argument-and-cwd-correctness`, from the branch that holds plans 022-025.
- Commit only if the operator asked. Subjects are imperative sentences that state the outcome,
  for example "Reject CLI arguments no command reads" and "Find the project from the process
  working directory".
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Failing tests for arguments

Create `packages/core/test/cli-arguments.test.ts`. Build one fixture project in a temp
directory, modelled on `packages/core/test/deploy-cli.test.ts:260-328`: a `voke.config.ts` whose
Provider records `deploy:<stage>`, `remove:<stage>` and `local:<subcommand>` into an array on
`globalThis` (use a name of its own, such as `vokeArgumentCalls`, so it cannot collide with
`vokeDeployCalls` in a single-process run), with `stage: "staging"`, two `remotes`, an absolute
`entrypoint`, a `build.plan` that points at a pre-written `index.js`, and
`local.workflow` with the four subcommands. Pass `--config <absolute path>` and
`run: () => {}`.

Cases (each asserts the message and that the recording array stayed empty where a Provider call
was possible):

| Arguments                                                              | Expected                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy prod --dry-run`                                                | rejects: `Invalid CLI usage: Unexpected argument "prod" for "deploy". Did you mean --stage prod?\nUsage: voke deploy`                                                                        |
| `remove prod --yes`                                                    | rejects: `Unexpected argument "prod" for "remove". Did you mean --stage prod?`                                                                                                               |
| `deploy -s prod`                                                       | rejects: `Short flags are not supported: -s. Did you mean --stage?`                                                                                                                          |
| `deploy -stage prod`                                                   | rejects, suggests `--stage`                                                                                                                                                                  |
| `remove -y`                                                            | rejects, suggests `--yes`                                                                                                                                                                    |
| `deploy -x`                                                            | rejects: `Short flags are not supported: -x.` with no suggestion                                                                                                                             |
| `deploy --stage= --dry-run` and `deploy --stage "" --dry-run`          | rejects: `Missing value for --stage`                                                                                                                                                         |
| `doctor extra`                                                         | rejects: `Unexpected argument "extra" for "doctor".`                                                                                                                                         |
| `synth a b c`                                                          | rejects: `Unexpected argument "c" for "synth".`                                                                                                                                              |
| `synth ./a.ts --entrypoint ./b.ts`, `build ./a.ts --entrypoint ./b.ts` | rejects: `Got both the argument "./a.ts" and --entrypoint. Pass the entrypoint once.`                                                                                                        |
| `local --stage dev start`                                              | resolves; the workflow ran `start`; the config it received has `stage: "dev"`                                                                                                                |
| `local`                                                                | rejects: `Missing argument: <start\|stop\|reset\|bootstrap>`                                                                                                                                 |
| `local strat`                                                          | rejects: `Unknown argument "strat" for "local". Expected one of: start, stop, reset, bootstrap.`                                                                                             |
| `local start extra`                                                    | rejects: `Unexpected argument "extra" for "local".`                                                                                                                                          |
| `remote --stage staging generate users`                                | reaches the remote: rejects with the fetch error for `users`, not a usage error (point the remote target at `http://127.0.0.1:1`, or assert on the `VokeConfigError`/connection error class) |
| `remote generate`                                                      | attempts **every** remote (same assertion: not a silent success)                                                                                                                             |
| `remote generate users extra`                                          | rejects: `Unexpected argument "extra" for "remote".`                                                                                                                                         |
| `migrate serverless a.yml out`                                         | rejects: `Unexpected argument "out" for "migrate". Did you mean --out out?`                                                                                                                  |
| `create`                                                               | rejects: `Missing argument: <name>` and the usage line                                                                                                                                       |
| `dev --port abc`, `--port 0`, `--port 70000`, `--port 1e3`, `--port=`  | reject; `abc` gives `Invalid value for --port: "abc". Expected a port number from 1 to 65535.`                                                                                               |
| `dev --port 4000`                                                      | resolves; `VOKE_DEV_ORIGIN` is `http://localhost:4000`                                                                                                                                       |
| `build` with a config that has no Provider                             | rejects with `No provider configured. Add a provider to voke.config.ts, for example:` and does not import the entrypoint (give the config an entrypoint path that does not exist)            |

To avoid a real network call in the two `remote` cases, prefer asserting through an injected
failure that needs no socket if you find one; a refused connection to `127.0.0.1:1` is local and
deterministic, and is acceptable.

Add a spec test in the same file: for every entry of `commandSpecs`, each declared positional
appears in `usage` (`choices.join("|")` when it has choices, otherwise `<name>` when required
and `[name]` when optional), and `strayArgumentFlag`, when set, is a key of `flags`.

Add a Plugin case to `packages/core/test/cli-contract.test.ts`: the fixture command
`docs export` declares `positionals: [{ name: "file" }]` and still receives
`positional: ["openapi.json"]`; `docs export a.json b.json` rejects with
`Unexpected argument "b.json" for "docs export".`.

**Evidence**: `cd packages/core && bun test test/cli-arguments.test.ts` fails on the new cases.

### Step 2: Declare and check positionals; tighten the parser

`packages/core/src/plugin.ts`, next to `CliFlagSpec`:

```ts
export interface CliPositionalSpec {
  /** The word shown in `usage`, for example "entrypoint". */
  name: string;
  /** The only accepted values, for a subcommand position. */
  choices?: readonly string[];
  /** The flag that sets the same value; passing both is an error. */
  flag?: string;
  required?: boolean;
}
```

Add `readonly positionals?: readonly CliPositionalSpec[];` to `PluginCommand`. Export the type
from `packages/core/src/index.ts` beside `PluginCommand` and name it in
`docs/stable-public-surface.md:15`. It is a type, so the runtime export list pinned by
`packages/core/test/public-surface.test.ts` does not change; run that test to confirm.

`packages/core/src/cli-spec.ts`:

- `CliCommandSpec` gains `positionals?: readonly CliPositionalSpec[]` and
  `strayArgumentFlag?: string` ("the flag an extra argument most likely meant").
- Fill the table. Do not change any `usage` or `description` string:

  | Command   | `positionals`                                                          | `strayArgumentFlag` |
  | --------- | ---------------------------------------------------------------------- | ------------------- |
  | `build`   | `entrypoint` (flag `entrypoint`), `outdir` (flag `outdir`)             |                     |
  | `create`  | `name` (required), `directory`                                         |                     |
  | `deploy`  | none                                                                   | `stage`             |
  | `dev`     | `entrypoint` (flag `entrypoint`)                                       |                     |
  | `doctor`  | none                                                                   |                     |
  | `local`   | `subcommand` (required, choices `start`, `stop`, `reset`, `bootstrap`) |                     |
  | `migrate` | `source` (required, choices `serverless`), `serverless.yml`            | `out`               |
  | `remote`  | `action` (required, choices `generate`), `name`                        |                     |
  | `remove`  | none                                                                   | `stage`             |
  | `synth`   | `entrypoint` (flag `entrypoint`), `out` (flag `out`)                   |                     |

  Move the `localSubcommands` list out of `cli.ts` into the spec (or import it there) so the
  four names exist once.

- `pluginCommandSpecs` copies `spec.positionals` into the spec it builds.
- Export `assertPositionals(command, flags, specs = commandSpecs)`, in declared order:
  1. missing and `required` → `Missing argument: <label>`, where the label is
     `<a|b|c>` for choices and `<name>` otherwise;
  2. present with `choices` and not one of them →
     `Unknown argument "<value>" for "<command>". Expected one of: a, b, c.`;
  3. present with `flag` and `flags.values[flag] !== undefined` →
     `Got both the argument "<value>" and --<flag>. Pass the <name> once.`;
  4. an argument beyond the declared ones →
     `Unexpected argument "<value>" for "<command>".`, followed by
     ` Did you mean --<strayArgumentFlag> <value>?` when the spec has one and that flag was not
     passed.
- `parseFlags`:
  - before pushing a positional: if the argument starts with `-`, is not `-` alone, throw
    `Short flags are not supported: <arg>.` plus the suggestion of decision 3. Reuse
    `closestFlag` for the multi-letter case.
  - a value that is the empty string, inline (`--key=`) or as the next argument, throws
    `Missing value for --<key>` for every flag, boolean or not.

`packages/core/src/cli.ts`, in `runCli` after `assertKnownFlags`, and in `runPluginCommand`
after its `assertKnownFlags`: call `assertPositionals`.

**Evidence**: the spec test and the "unexpected", "short flag", "missing value" cases pass.

### Step 3: Handlers read parsed input only

In `packages/core/src/cli.ts`:

- Change `CommandHandler` to `(flags: ParsedFlags, options: CliOptions) => Promise<void>` and
  the call in `runCli` to `handler(flags, options)`. No handler receives raw arguments again.
- `local`: pass `flags.positional[0]`. Keep the guard inside the exported `local()` function
  (it is also called directly).
- `remote`: subcommand is `flags.positional[0]`; names are
  `flags.positional[1] === undefined ? undefined : [flags.positional[1]]`.
- `build`, `dev`, `synth`: read `flags.positional[n] ?? flags.values.<flag>`; the order no
  longer matters because both at once was rejected.
- `build`: call `assertProviderConfigured(config)` before `loadProject`, and make the
  `build()` function's own message `missingProviderMessage(config.name)` when
  `config.provider === undefined`. Update `packages/core/test/build-cli.test.ts:117`.
- `create`: delete the `name === undefined` check (the spec covers it). Keep the
  `"voke create api" was replaced by` message.
- `migrate`: `migrateServerless` stops reading `flags.positional[1]` as the output directory.
- `dev`: replace `Number(flags.values.port)` with a small `portFromFlags(flags)` that returns
  `undefined` when the flag is absent, and throws the decision 9 message unless the value
  matches `/^\d+$/u` and is between 1 and 65535. Put the regex at module top level.

Update existing tests whose expectation moved (search the test directory for
`Usage: voke local`, `Usage: voke remote`, `Usage: voke migrate`, `Missing the project name`).
The usage line is still appended, so most `toThrow("Usage: ...")` assertions keep passing.

**Evidence**: `cd packages/core && bun test` passes; every case of step 1 passes.

### Step 4: Failing tests for the working directory

Create `packages/core/test/cli-working-directory.test.ts`:

1. **Real process, stale `PWD`.** Write a project in a temp directory: `voke.config.ts` with a
   Provider that has only `synthesis.synthesize` (see `writeProviderConfig`,
   `packages/core/test/cli-contract.test.ts:9-45`), `name: "here"`, and a **relative**
   `entrypoint: "./src/index.ts"`; the entrypoint imports core by absolute path as the other
   tests do. Write a second directory with a `voke.config.ts` named `"elsewhere"` and no
   source. Spawn `[process.execPath, "<abs>/packages/core/src/cli.ts", "synth", "--out", "<abs out>"]`
   with `cwd: <project>` and `env: { ...process.env, PWD: <second directory> }`. Expect exit
   code 0 and the written `Description` to name `here`.
2. **Real process, no `PWD`.** The same spawn with `PWD` removed from `env`. Expect exit code 0.
3. **`runCli` with `cwd`.** `withEnv({ PWD: <second directory> }, () => runCli(["synth", "--out", out], { cwd: <project> }))`
   resolves and names `here`: the option wins and `PWD` is ignored.
4. **`loadVokeConfig` and `loadProject` defaults.** With `PWD` set to a directory that does not
   exist, `loadVokeConfig({ path: <absolute> })` and
   `loadProject({ config, entrypoint: <absolute> })` still work, and
   `loadProject({ config, cwd: <project> })` resolves the relative entrypoint.

Tests 1 and 2 fail today with the errors quoted under "Current state".

### Step 5: Read `process.cwd()`

- `packages/core/src/config.ts:372`: `const cwd = options.cwd ?? process.cwd();`
- `packages/core/src/project.ts`: `const cwd = options.cwd ?? process.cwd();`. Replace
  `toAbsolutePath` with `isAbsolute(path) ? path : resolve(cwd, path)` and build the import URL
  with `pathToFileURL(entrypoint).href`, as `config.ts:373,381` does. Remove the unused
  `readEnv` import. `project.entrypoint` stays an absolute path
  (`packages/core/test/project.test.ts:85-94` pins it).
- `packages/core/src/app.ts`, `loadRuntimeConfig`:
  `const path = resolve(process.cwd(), "voke.config.ts");` (import `resolve` from `node:path`).
  The error text is unchanged.
- `packages/core/src/cli.ts`:
  - `CliOptions` gains
    `/** The project directory: where the config file, package.json and the entrypoint resolve. Default: the working directory. */ cwd?: string;`
    and one helper `const projectDirectory = (options: CliOptions): string => options.cwd ?? process.cwd();`.
  - `packageJsonName(cwd)`, `configPathFromFlags(flags, cwd)` and `loadConfigFromFlags(flags, cwd)`
    check existence at `resolve(cwd, path)` and call `loadVokeConfig({ cwd, path })`.
    `configPathFromFlags` still returns the path as typed: the generated build entry computes
    its import from it.
  - Pass `cwd` to every `loadProject`, to `deployProject`, to `runDoctor`, to `helpPlugins`
    (through `printTopLevel`), and in `runPluginCommand` to the existence check,
    `loadVokeConfig` and the command's `cwd`.
  - `deployProject`: `const cwd = options.cwd ?? process.cwd();`
  - The exported `local()` takes the directory as an optional last parameter.
- `grep -rn '"PWD"' packages/*/src` must return nothing afterwards.

Then move the tests off `PWD`:

- `cli-contract.test.ts:654-690`: `runCli(["--help"], { cwd: directory, output })`.
- `cli-contract.test.ts:314-346`: drop `process.chdir`; pass `{ cwd: directory }`.
- `build-cli.test.ts`: `runCli([...], { cwd: directory, run })`. The generated entry and
  `./configured-dist` still land in the process working directory; keep the cleanup.
- `api.test.ts`: delete `withPwd`; the synth test passes `{ cwd: directory }`. Leave plan 022's
  `process.chdir` around the build test.
- `public-api-redesign.test.ts:91-142`: replace the `PWD` writes with a `process.chdir`
  wrapped around the `voke(functions)` call only (restore in `finally`, before any `await`).
  `process.cwd()` returns the real path, and the OS temp directory is a symlink on macOS
  (`/var` → `/private/var`), so build the expected error message from
  `realpathSync(directory)`.
- `support/isolate-env.ts:4`: rewrite the last sentence of the comment; `PWD` is no longer
  read.

**Evidence**: `cd packages/core && bun test` passes, including the two spawn tests;
`bun test test/node-runtime.test.ts` passes.

### Step 6: Example scripts

In the seven `examples/*/package.json` files set `"deploy": "voke deploy --stage dev"` and
`"remove": "voke remove --stage dev"`. Add a test to `packages/core/test/cli-contract.test.ts`
that scans `examples/*/package.json` with `Bun.Glob` (resolve the directory from
`import.meta.dir`) and expects those two values wherever the scripts exist. Write the test
first; it fails seven times.

### Step 7: Docs

`apps/docs/content/docs/reference/cli.mdx`:

- Line 45 paragraph ("Flags take a value as ..."): add that an argument a command does not
  take, a short flag such as `-s`, and a flag with an empty value are usage errors, with one
  example block:

  ```txt
  Invalid CLI usage: Unexpected argument "prod" for "deploy". Did you mean --stage prod?
  Usage: voke deploy [--stage dev] [--region us-east-1] [--config voke.config.ts] [--dry-run]
  ```

  Only `-h` and `-v` are short.

- "Project flags": add that relative paths (`--config`, `entrypoint`) resolve against the
  working directory, including when `--config` points at a file in another directory.
- `build`, `dev`, `synth`: one sentence that the entrypoint (and output) can be given as an
  argument or as the flag, not both.
- `dev`: `--port` must be a number from 1 to 65535. Keep the "`--port` does not move the
  server" callout.
- `local`: flags that the Local AWS Provider declares go after the subcommand
  (`voke local start --rebuild`); core flags may come before it.
- The Provider callout (lines 64-67) becomes true with step 3; leave its text.

`apps/docs/content/docs/reference/errors.mdx:96`: add "an argument a command does not take" and
"a short flag" to the list of `CliUsageError` causes.

`apps/docs/content/docs/guides/plugins.mdx`, after the sentence at line 161: a command that
takes arguments declares them in `positionals` (`[{ name: "file" }]`); Voke rejects any other
argument and passes the declared ones to `run` as `positional`. If you change the sample, it
must stay a compiling ` ```ts twoslash ` block (`apps/docs/test/samples.test.ts`).

Pin the reference page: add a test to `packages/core/test/cli-contract.test.ts` that reads
`../../../apps/docs/content/docs/reference/cli.mdx` (as
`packages/core/test/public-surface.test.ts:77-78` reads files) and expects it to contain
`formatHelp()` and `formatCommandHelp(name)` for every key of `commandSpecs`. It should pass
before your doc edits; if it does not, the page was already wrong: fix the page to the real
output.

### Step 8: Gates

Run `bun x ultracite fix`, then `bun run check`, `bun run typecheck` and `bun run test` from
the repository root, and `cd apps/docs && bun test`.

## Test plan

- New `packages/core/test/cli-arguments.test.ts`: the table in step 1 plus the spec/usage
  consistency test. Pattern: `packages/core/test/deploy-cli.test.ts:260-328`.
- New `packages/core/test/cli-working-directory.test.ts`: two real-process cases (stale `PWD`,
  no `PWD`), `runCli` with `cwd`, and the `loadVokeConfig`/`loadProject` defaults.
- `packages/core/test/cli-contract.test.ts`: Plugin positionals, example scripts, `cli.mdx`
  pinned to the real help output; the three directory tests use `{ cwd }`.
- Updated: `build-cli.test.ts` (shared Provider message, `{ cwd }`), `api.test.ts`,
  `public-api-redesign.test.ts`.
- Verification: `cd packages/core && bun test` and root `bun run test` are green.

## Done criteria

- [ ] `voke deploy prod`, `voke remove prod` and `voke deploy -s prod` reject with a usage
      error that names `--stage`, and the Provider is not called (tests in
      `cli-arguments.test.ts`).
- [ ] `voke local --stage dev start` runs `start`; `voke remote generate` with no name
      generates every remote.
- [ ] `--port abc` and `--stage=` are usage errors.
- [ ] `grep -rn '"PWD"' packages/*/src` returns nothing, and `grep -rn 'env.PWD' packages/*/test`
      returns only lines that set a **stale** `PWD` on purpose.
- [ ] The two real-process tests pass: `synth` finds the project with `PWD` stale and unset.
- [ ] `grep -n '"deploy"\|"remove"' examples/*/package.json` shows `--stage dev` on all 14 lines.
- [ ] `cli.mdx` contains the exact output of `formatHelp()` and every `formatCommandHelp(name)`
      (pinned by a test), and no usage string changed.
- [ ] `bun run check`, `bun run typecheck`, `bun run test` exit 0; `cd apps/docs && bun test`
      passes.
- [ ] `git status --short` shows only in-scope files (plus the three entries that predate this
      round: `apps/docs/next-env.d.ts`, `apps/docs/.gitignore`, `apps/docs/.impeccable/`).

## STOP conditions

Pause and report when:

- Plan 025 made a positional output directory a **documented** spelling of `voke migrate`, or
  added positionals this plan's table does not cover and whose meaning is unclear. Otherwise
  just declare what `migrate` reads.
- A Plugin command shipped in this repository reads `positional` in a way a fixed list of
  `positionals` cannot describe (for example a variable number of arguments). Today none does:
  `grep -rn "positional" packages/*/src` finds only `packages/core`.
- A test outside `packages/core` fails only because it relied on `PWD` differing from the
  working directory. None was found (`grep -rn "PWD" packages examples apps/docs/test`), so a
  hit means the code moved.
- Making a command work needs `cwd` to move build output, the dev child process or the Local
  AWS Provider's files. That is the deferred `--cwd` work, not a detail of this plan.

A changed line number, a message another test pins, or a spawn test that needs
`process.execPath` instead of `bun` are things to adapt, not reasons to stop.

## Findings checked and dropped or changed

- "`cli.mdx` says `build` fails with an example `provider: aws()` line": confirmed. Fixed in
  the code (decision 10), not in the page.
- "`--config` in another directory still resolves the entrypoint against cwd
  (`doctor.ts:93`)": true, and `loadProject` does the same, so every command agrees. It is
  documented in step 7 and left as is; resolving against the config file's directory is part of
  the deferred `--cwd` decision.
- "`--port` does not move the server": true and documented in `cli.mdx:159-163`. Deferred.
- "Only `error.message` is printed and every failure exits 1 (`cli.ts:992`)": true. Deferred
  with `--verbose`.
- Found while verifying, and fixed here: `voke remote generate` with no name is a silent no-op;
  a stale `PWD` selects the wrong directory (not only an unset one); an empty flag value is
  accepted; `build` and `synth` resolve "positional and flag" in opposite orders; `migrate`
  accepts an undocumented output positional.
- Not changed: `voke help synth extra` and `voke --version extra` ignore the extra word. They
  print help or a version and act on nothing.

## Deferred (one line each)

- `--json`: machine-readable output for `deploy`, `synth`, `doctor`; needs an output contract.
- `--verbose` and distinct exit codes: print the error cause and stack, separate usage errors
  from failures.
- Short flags (`-s`, `-y`): rejected with a hint for now; adding them means one more spelling
  per setting (ADR 0007).
- `--cwd`: run a command against another directory; needs build output, `voke dev`'s child
  process and the Provider's local workflow to take a directory, and a decision on resolving
  paths against the config file.
- `--port`/`--hostname` moving the dev server (setting `PORT` for the child process).
- Validating the `PORT` environment variable in `createDevPlan` (`PORT=abc` still yields `NaN`
  in `VOKE_DEV_ORIGIN`, `packages/core/src/dev.ts:78-80`).
- One spelling for the entrypoint and output of `build`, `dev` and `synth` (argument or flag).
- A boolean marker for Provider-declared `voke local` flags: they are
  `Record<string, string>` descriptions (`packages/core/src/provider.ts:173`), so
  `voke local --rebuild start` reads `start` as the value of `--rebuild` and then reports a
  missing subcommand.

## Maintenance notes

- A new command, or a new argument of an existing one, must be declared in `commandSpecs`
  (`positionals`); the consistency test fails when `usage` and `positionals` disagree, and the
  `cli.mdx` test fails when the page is not updated.
- `runCli`'s `cwd` option covers lookups only (decision 7). If a later plan adds `--cwd`, it
  should make that option cover writes and spawned tools too, and then plan 022's
  `process.chdir` in `api.test.ts` and the cleanup of `.voke` and `./configured-dist` in
  `build-cli.test.ts` can go.
- Not verified on Windows: there is no Windows machine or CI job (`.github/workflows/ci.yml`
  runs `ubuntu-latest`). `process.cwd()`, `resolve` and `pathToFileURL` are the portable
  primitives; the hand-built `file://` URL in `project.ts` was the known non-portable part.
- Reviewers should check two things closely: that no handler reads raw `argv` any more, and
  that no source file reads `PWD`.
- Plan 025 may add stage validation to `defineConfig`; the parser's empty-value check stays
  either way, because it applies to every flag.
