# Plan 022: `bun test` from the repository root passes, and no test depends on the shell it runs in

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- package.json AGENTS.md .github/workflows/ci.yml packages/core/bunfig.toml packages/core/test packages/aws/test packages/idempotency/test apps/docs/bunfig.toml`
> and `git status --short` with the recorded current state. At planning time the working tree
> had three unrelated entries (`M apps/docs/next-env.d.ts`, `?? apps/docs/.gitignore`,
> `?? apps/docs/.impeccable/`); leave them alone. Reconcile routine drift; pause only if the
> failures listed under "Current state" no longer reproduce.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. It is first in the 022–034 round so that every later plan starts from a
  green `bun test`.
- **Category**: tests
- **Planned at**: commit `1c59d39` (branch `feature/docs-revamp`), 2026-11-15

## Why this matters

`AGENTS.md` tells every contributor and agent to "run `bun test`", and the root script
`release:check` is `bun run typecheck && bun test`. Run from the repository root at `1c59d39`,
that command reports 5 failures. None is a product bug: all five pass under `bun run test`, the
per-package Turbo run that CI uses. An executor who follows the documented gate therefore sees
red before touching anything, and either wastes time on it or learns to ignore failures.

There is a second, quieter problem with the same cause. Only `packages/core` clears the
developer's shell environment before its tests. `@voke/aws` tests fail when the shell has
`VOKE_STAGE=prod` set, which is a normal thing for a Voke user to have.

After this plan, `bun test` from the root exits 0, gives the same result in any shell, and CI
runs it so it cannot rot again.

## Current state

### How the two test commands differ

- `bun run test` is `turbo run test`. Turbo runs each workspace's own `test` script with that
  workspace as the working directory, so each one's `bunfig.toml` applies. At `1c59d39` all 34
  tasks pass (about 690 tests).
- `bun test` from the root is one Bun process whose working directory is the repository root.
  Bun reads `bunfig.toml` only from the working directory, and there is no root `bunfig.toml`,
  so no preload runs. It discovers every `*.test.ts` in the repository, including `apps/docs`.

### The five failures of root `bun test` at `1c59d39`

Reproduce with `bun test 2>&1 | grep -E "^\(fail\)"` from the root:

```
(fail) every internal link and heading anchor in the docs resolves
(fail) llms.txt lists every docs page with a link
(fail) a page renders as Markdown with its title, description and code
(fail) runs create and build through the CLI parser
(fail) falls back from empty string regions in AWS client config
```

**Failures 1–3: `apps/docs/test/links.test.ts` and `apps/docs/test/llms.test.ts`.** Two causes.

- `apps/docs/bunfig.toml` preloads the MDX compiler, and the root run does not load it:
  ```toml
  [test]
  preload = ["./scripts/mdx-preload.ts"]
  ```
- Even with that preload passed by hand
  (`bun test --preload ./apps/docs/scripts/mdx-preload.ts apps/docs/test`), two tests still
  fail, because Fumadocs resolves its content from the working directory. `apps/docs/source.config.ts`
  declares `dir: "content/docs"`, and the failure is
  `ENOENT: no such file or directory, open 'content/docs/concepts.mdx'`. The package script also
  generates `.source` first: `"test": "fumadocs-mdx && bun test"` (`apps/docs/package.json`).

  These tests can only run with `apps/docs` as the working directory. That is a property of the
  tool, not a defect to fix here.

**Failure 4: `packages/core/test/api.test.ts`, "runs create and build through the CLI parser"
(around lines 587–617).** `voke build` writes its generated entry to the relative path
`.voke/build/index.ts` (`packages/aws/src/build.ts:8`, written by `Bun.write(path, contents)` in
`packages/core/src/cli.ts:308-310`) and then spawns `bun build .voke/build/index.ts ...` in the
process working directory. The generated entry imports `@voke/aws`. From `packages/core` that
import resolves; from the repository root it does not:

```
error: Could not resolve: "@voke/aws". Maybe you need to "bun install"?
    at <repo>/.voke/build/index.ts:4:38
```

The test also ends with `await rm(".voke", { force: true, recursive: true })`, which deletes
`.voke` in whatever directory the run started from.

Verified during planning: with the working directory set to `packages/core` and `PWD` still
pointing at the repository root, the test passes
(`cd packages/core && env PWD=<repo root> bun test test/api.test.ts -t "runs create and build"`).
So changing the process working directory for this one test is enough.

**Failure 5: `packages/aws/test/provider.test.ts`, "falls back from empty string regions in AWS
client config" (lines 90–115).** The test sets `Bun.env.AWS_DEFAULT_REGION = "us-west-2"` and
expects `createAwsClientConfig({ region: "" })` to return that region. The code reads
`process.env` (`packages/aws/src/resources.ts:66-68`). `Bun.env` and `process.env` are normally
the same object, but an earlier test file breaks that:

```ts
// packages/idempotency/test/dynamodb-store.test.ts:68-76
const savedEnv = { ...process.env };

beforeEach(() => {
  delete process.env.VOKE_RESOURCE_IDEMPOTENCY_TABLE_NAME;
});

afterEach(() => {
  process.env = { ...savedEnv };
});
```

Assigning a new object to `process.env` detaches it from `Bun.env` for the rest of the process.
Reproduce with two files:
`bun test packages/aws/test/provider.test.ts packages/idempotency/test/dynamodb-store.test.ts`
(1 fail); `bun test packages/aws/test/provider.test.ts` alone passes.

### Environment isolation exists only in `packages/core`

`packages/core/bunfig.toml`:

```toml
[test]
preload = ["./test/support/isolate-env.ts"]
```

`packages/core/test/support/isolate-env.ts` deletes every `AWS_*` and `VOKE_*` variable plus
`HOST`, `PORT` and `STAGE` from `process.env` before any test file loads. Its comment explains
why: "a developer's shell (an AWS profile, STAGE=prod, a local endpoint) must not change test
results". `packages/core/test/support/env.ts` has the helpers tests use to set a variable for
one test: `setEnv(name, value)` and `withEnv(values, run)`, which restore the previous values in
a `finally`.

No other package has a `bunfig.toml`. Verified during planning, from `packages/aws`:

```
VOKE_STAGE=prod STAGE=prod AWS_REGION=eu-west-1 AWS_ENDPOINT_URL=http://localhost:1 bun test
```

gives 1 failure, in `packages/aws/test/provider.test.ts:57`
(`Expected: "Voke stack for provider-api (local)"`, `Received: "... (prod)"`). The same
environment gives 0 failures in `idempotency`, `openapi`, `remote`, `schema`, `build`,
`testing`, and every example.

### Conventions to follow

- A test that must change the working directory does it inside `try`/`finally` and restores the
  previous directory. Exemplar, `packages/core/test/cli-contract.test.ts:331-345`:

  ```ts
  process.chdir(directory);

  try {
    // ...
  } finally {
    process.chdir(previous);
  }
  ```

- Scratch files go under the OS temp directory through `tempPath(name)`
  (`packages/core/test/support/temp.ts`).
- `AGENTS.md`: "Keep tests deterministic and fast. Avoid real network calls, timers, randomness,
  and shared mutable state unless the test controls them."
- CI (`.github/workflows/ci.yml`) runs `bun run check`, `bun run typecheck`, `bun run test`.

## Decisions taken in this plan

1. **Root `bun test` covers the framework packages and the examples; `apps/docs` is excluded
   from it.** The docs tests need `apps/docs` as the working directory and a generation step, so
   they stay covered by `bun run test` (Turbo), which CI already runs. The exclusion is one line
   in a new root `bunfig.toml`. Reverse it by deleting that line; the three docs tests will fail
   again from the root.
2. **`release:check` runs the full gate, not root `bun test`.** It becomes
   `bun run check && bun run typecheck && bun run test`, the same three commands as CI. Root
   `bun test` is the fast single-process run for development; it is not the release gate,
   because decision 1 leaves the docs site out of it.
3. **One environment-isolation file, used by every package.** The existing
   `packages/core/test/support/isolate-env.ts` stays where it is and is the only copy. Every
   package under `packages/` that has tests gets a two-line `bunfig.toml` that preloads it by
   relative path, and so does the new root `bunfig.toml`. Examples do not get one: they are
   written as user projects, and they pass under a hostile environment today.
4. **The CLI build test changes its working directory instead of changing the CLI.** How the
   CLI finds the project directory is plan 026's subject. Here the test wraps the build in
   `process.chdir` to the `packages/core` directory, following the existing convention.
5. **CI runs root `bun test` as a second, short step** (about 3 seconds), so a new
   order-dependent or directory-dependent test fails the pull request that adds it.

## Commands you will need

| Purpose             | Command                                                                                                                     | Expected on success |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Single-process run  | `bun test` (repo root)                                                                                                      | exit 0, 0 fail      |
| Same, hostile shell | `VOKE_STAGE=prod STAGE=prod AWS_REGION=eu-west-1 AWS_DEFAULT_REGION=eu-west-1 AWS_ENDPOINT_URL=http://localhost:1 bun test` | exit 0, 0 fail      |
| CI test run         | `bun run test`                                                                                                              | 34 tasks successful |
| One package         | `cd packages/aws && bun test`                                                                                               | 0 fail              |
| Typecheck           | `bun run typecheck`                                                                                                         | exit 0              |
| Lint and format     | `bun run check` (fix with `bun x ultracite fix`)                                                                            | exit 0              |

## Implementation rules relevant to this plan

- This plan changes tests and configuration only. Do not change any file under
  `packages/*/src`. If a failure can only be fixed in source, stop and report (see STOP
  conditions).
- Never assign to `process.env` or `Bun.env` as a whole. Set and restore individual variables,
  and delete a variable that was unset before (assigning `undefined` stores the string
  `"undefined"` in Bun).
- A test that changes the working directory restores it in `finally`.
- Do not add `.skip`, `.only` or `test.todo`, and do not delete a failing test.
- No new dependencies.

## Scope

**In scope** (the only files you should modify or create):

- `bunfig.toml` (create, repo root)
- `packages/aws/bunfig.toml`, `packages/idempotency/bunfig.toml`, `packages/openapi/bunfig.toml`,
  `packages/remote/bunfig.toml`, `packages/schema/bunfig.toml`, `packages/build/bunfig.toml`,
  `packages/testing/bunfig.toml` (create)
- `packages/idempotency/test/dynamodb-store.test.ts`
- `packages/core/test/api.test.ts`
- `packages/core/test/support/isolate-env.ts` (comment only, if its "see packages/core/bunfig.toml"
  note needs to mention the other configs)
- `package.json` (the `release:check` script only)
- `.github/workflows/ci.yml` (one added step)
- `AGENTS.md` (the "Quality Gates" wording only)
- `.factory/plans/README.md` (status only)

**Out of scope**:

- `packages/*/src/**`. In particular `packages/core/src/project.ts` and `cli.ts` read `PWD` to
  find the project; plan 026 fixes that.
- `apps/docs/**`. Its tests are correct when run from `apps/docs`.
- `packages/http`: it has no tests (`bun test --pass-with-no-tests`), so it needs no config.
- Adding tests for untested packages; that belongs to the plans that change them.

## Git workflow

- Branch: `feature/root-test-run`, from the tip this round is stacked on (`feature/docs-revamp`
  at `1c59d39`, or its successor).
- Commit subjects are imperative sentences that state the outcome, for example "Make bun test
  pass from the repository root". Commit only if the task authorizes it. Do not push or open a
  pull request unless told.

## Steps

### Step 1: Record the failing baseline

Run `bun test 2>&1 | grep -E "^\(fail\)| pass$| fail$"` from the root and confirm the five
failures above. If the list differs, reconcile it with "Current state" before changing anything.

### Step 2: Stop replacing `process.env` in the idempotency store tests

In `packages/idempotency/test/dynamodb-store.test.ts`, replace the save-and-reassign pattern
with one that restores only the variable the tests change. The tests touch
`VOKE_RESOURCE_IDEMPOTENCY_TABLE_NAME`; check the file for any other variable they set and treat
it the same way. Target shape:

```ts
const tableNameVariable = "VOKE_RESOURCE_IDEMPOTENCY_TABLE_NAME";
const savedTableName = process.env[tableNameVariable];

beforeEach(() => {
  Reflect.deleteProperty(process.env, tableNameVariable);
});

afterEach(() => {
  if (savedTableName === undefined) {
    Reflect.deleteProperty(process.env, tableNameVariable);
  } else {
    process.env[tableNameVariable] = savedTableName;
  }
});
```

`packages/idempotency` cannot import `packages/core/test/support/env.ts` cleanly (it is another
package's test support), so keep this local to the file.

**Evidence**: `bun test packages/aws/test/provider.test.ts packages/idempotency/test/dynamodb-store.test.ts`
from the root → 0 fail. `grep -rn "process.env = \|Bun.env = " packages examples apps --include="*.ts" -l | grep -v node_modules`
→ no matches.

### Step 3: Make the CLI build test independent of the starting directory

In `packages/core/test/api.test.ts`, test "runs create and build through the CLI parser": change
the working directory to the `packages/core` directory (resolve it from `import.meta.dir`, which
is `packages/core/test`) before `runCli(["build", ...])`, and restore the previous directory in
the existing `finally`, before or after the `rm(".voke", ...)` so that the `rm` still acts on
`packages/core/.voke`. Update the comment to say why the directory matters: the generated entry
is written under the working directory and imports `@voke/aws`, which resolves from a workspace
package and not from the repository root.

**Evidence**: `bun test packages/core/test/api.test.ts` from the root → 0 fail, and no `.voke`
directory is left in the repository root or in `packages/core` (`git status --short --ignored | grep "\.voke"` → nothing).

### Step 4: Add the root `bunfig.toml` and the per-package ones

Root `bunfig.toml`:

```toml
# `bun test` from the repository root: one process for the framework packages and the examples.
# The docs site is left out because its tests must run from apps/docs (Fumadocs resolves its
# content from the working directory); `bun run test` covers it.
[test]
preload = ["./packages/core/test/support/isolate-env.ts"]
pathIgnorePatterns = ["apps/**"]
```

`pathIgnorePatterns` is documented in the Bun docs that ship with `bun-types`
(`node_modules/.bun/bun-types@*/node_modules/bun-types/docs/test/configuration.mdx`, "Exclude
files and directories from test discovery entirely using glob patterns"). **Verify before
coding** that Bun 1.4.4 honors it: after adding the file, `bun test 2>&1 | grep "apps/docs"`
must print nothing. If it is not honored, see STOP conditions.

For each of `aws`, `idempotency`, `openapi`, `remote`, `schema`, `build` and `testing`, create
`packages/<name>/bunfig.toml`:

```toml
[test]
preload = ["../core/test/support/isolate-env.ts"]
```

Then run each package's tests under the hostile environment from the commands table. The one
known failure is `packages/aws/test/provider.test.ts:57`, which must now pass with no change to
the test. If a test fails because it relied on an ambient variable that the preload now removes,
make the test set that variable itself (`process.env[name] = ...` with a restore in `finally`).

**Evidence**: the hostile-shell command from the table → 0 fail at the root, and
`cd packages/aws && VOKE_STAGE=prod bun test` → 0 fail.

### Step 5: Point the documented gates at the right commands

- `package.json`: `"release:check": "bun run check && bun run typecheck && bun run test"`.
- `AGENTS.md`, "Quality Gates": replace the line that begins "At minimum, run `bun test`" with
  wording that names both commands and what each covers. Suggested text: "At minimum, run
  `bun test` (inside the package you changed, or from the repository root for every package and
  example in one process) for behavior changes, and `bun run typecheck` for TypeScript changes.
  Before finishing, run `bun run test`, which also builds and tests the docs site." Do not touch
  the rest of the file.
- `.github/workflows/ci.yml`: after the existing "Test" step, add:
  ```yaml
  - name: Test in one process
    run: bun test
  ```

### Step 6: Full verification

Run every command in the commands table. Then confirm determinism: run root `bun test` three
times and check the pass count is identical each time.

## Test plan

- No new test files. The regression guard is the new CI step: root `bun test` fails the pull
  request if a test depends on file order, the working directory or the shell environment.
- Changed tests: the env restore in `dynamodb-store.test.ts` (step 2) and the working-directory
  wrap in `api.test.ts` (step 3). Both must keep their existing assertions unchanged.
- Verification: the single-process run, the hostile-shell run and `bun run test`, as in the
  commands table.

## Done criteria

- [ ] `bun test` from the repository root exits 0 with 0 failures
- [ ] The hostile-shell command from the commands table exits 0 with 0 failures
- [ ] `bun run test` reports 34 successful tasks (or the current task count, all successful)
- [ ] `bun run typecheck` and `bun run check` exit 0
- [ ] `grep -rn "process.env = " packages examples --include="*.ts"` (excluding `node_modules`) returns no matches
- [ ] `bun test 2>&1 | grep "apps/docs"` prints nothing
- [ ] `package.json` `release:check` and `.github/workflows/ci.yml` match step 5
- [ ] `git status --short` shows no `.voke` directory and no file outside the in-scope list
- [ ] `.factory/plans/README.md` status row updated

## STOP conditions

Pause and report when:

- Bun 1.4.4 ignores `pathIgnorePatterns` in `bunfig.toml`. Do not work around it by moving or
  renaming the docs tests. Report it; the fallback the owner can choose is to drop decision 5
  (no root run in CI) and document `bun run test` as the only whole-repository command.
- A failure can only be fixed by changing `packages/*/src`. Report which test and why; the
  likely owner is plan 026 (project directory resolution).
- After steps 2–4 a test still fails only when run from the root, for a reason not listed in
  "Current state". Report the test and the cause before changing it.

## Maintenance notes

- A new package under `packages/` needs its own `bunfig.toml` with the preload line. The root
  run covers it either way, but `bun run test` runs it in its own directory.
- Plan 026 changes how the CLI finds the project directory. When it lands, the
  `process.chdir` in `api.test.ts` may be replaceable by an explicit directory option; that is
  a cleanup, not a requirement.
- Reviewers: check that `isolate-env.ts` is still the only copy, and that no test regained a
  dependency on an ambient variable.
- Deferred: making the docs tests runnable from any directory (needs Fumadocs to accept an
  explicit content root), and tests for `@voke/http`.
