# Plan 001: The repository runs on Bun 1.4.4 with a deterministic test suite, and every PR is checked by CI

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare `git diff --stat a7741eb -- packages/core/test packages/core/src/e2e.ts package.json .github`
> and `git status --short` with the recorded current state. Reconcile routine drift;
> pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `a7741eb`, 2026-11-14

## Why this matters

Every other plan in this directory ends with "`bun test` passes". Today that gate is
not trustworthy: the suite depends on the Bun version and on test order, and nothing
runs it automatically because the repository has no CI. A contributor on a current Bun
sees red before changing anything. Fixing the baseline first means later plans can tell
their own regressions from pre-existing noise.

## Current state

Evidence was gathered in a scratch copy of `packages/core` (fresh `bun install` without
the lockfile, Bun 1.4.4, hono 4.13.18). The working tree had no `node_modules`, so
nothing was run in the repository itself. Reproduce first; the numbers may differ with
the lockfile.

- `package.json:27` pins `"packageManager": "bun@1.3.11"`. The local toolchain is Bun 1.4.4.
  **Owner decision (2026-11-14): the repository moves to Bun 1.4.4.** That is the one supported
  version; this plan raises the pin and makes the suite pass on it.
- On Bun 1.4.4, assigning `undefined` to an environment variable stores the string
  `"undefined"` (checked: `Bun.env.X = undefined; Bun.env.X` → `"undefined"`). Several
  test helpers restore variables that way:
  - `packages/core/test/local.test.ts:22-24`
    ```ts
    const restoreEnv = (name: string, value?: string): void => {
      Bun.env[name] = value;
    };
    ```
  - same pattern at `packages/core/test/api.test.ts:30`, `packages/core/test/route-builder.test.ts:42`,
    `packages/core/test/e2e.test.ts:64` and `:71`, `packages/core/test/remote-functions.test.ts:68-69`,
    `packages/core/test/public-api-redesign.test.ts:114` and `:138`.
- Effect: a test that "restores" an unset variable leaves e.g. `AWS_ENDPOINT_URL="undefined"`,
  and later tests read it through `defineConfig` (`packages/core/src/config.ts:189,201`) and
  `createLocalAwsEnvironment`. Observed diff: expected `"endpoint": "http://localhost:4566"`,
  received `"endpoint": "undefined"`.
- Observed results in the scratch copy: `test/local.test.ts` alone → 10 pass, 6 fail.
  `test/dev.test.ts`, `test/build.test.ts`, `test/cloudformation.test.ts` pass alone but
  `dev` and CLI tests fail in the full run (cross-file leakage). Full run: 154 pass, 16 fail;
  4 of the 16 were scratch-copy artifacts (missing `README.md` and example folders) and are
  not real failures.
- Two more failures need a look once the environment leak is fixed:
  - `test/api.test.ts` "wraps a Hono app with a default name and handler" (object diff, cause not established).
  - "generated starter test suite passes with local package links" asserts that `bun test`
    output contains the test name `responds to health checks`; Bun 1.4.4 printed only the
    summary (`1 pass 0 fail`).
- Typecheck (`bunx tsgo --project tsconfig.json --noEmit`) reported one error at
  `packages/core/src/e2e.ts:315`: `responseHeaders(result.headers)` receives
  `Record<string, string | string[]> | undefined` where
  `Record<string, string | number | boolean> | undefined` is expected. This may come from
  the newer hono version; confirm with the lockfile.
- There is no `.github/` directory: no CI workflow. `lefthook.yml` runs only
  `bun x ultracite fix` on pre-commit.
- Root scripts (`package.json`): `test` → `turbo run test`, `typecheck` → `turbo run typecheck`,
  `check` → `ultracite check`, `release:check` → `bun run typecheck && bun test`.

## Commands you will need

| Purpose        | Command                                           | Expected on success |
| -------------- | ------------------------------------------------- | ------------------- |
| Install        | `bun install`                                     | exit 0              |
| Core tests     | `cd packages/core && bun test`                    | all pass, 0 fail    |
| One test file  | `cd packages/core && bun test test/local.test.ts` | all pass            |
| Core typecheck | `cd packages/core && bun run typecheck`           | exit 0, no errors   |
| Repo gates     | `bun run typecheck && bun run test`               | exit 0              |
| Lint/format    | `bun run check`                                   | exit 0              |
| Autofix        | `bun x ultracite fix`                             | exit 0              |

## Implementation rules relevant to this plan

- Tests must be deterministic: no dependence on ambient environment variables, test
  order, or Bun minor version (AGENTS.md: "Keep tests deterministic and fast... avoid
  shared mutable state unless the test controls them").
- Do not use `.only` or `.skip`. Do not weaken an assertion to make it pass; change an
  assertion only when it was asserting tool output format rather than Voke behavior.
- Prefer `for...of`, `const`, explicit types; avoid barrel files (Ultracite rules).
- No source behavior changes other than the type fix at `src/e2e.ts`.

## Scope

**In scope**:

- `packages/core/test/support/env.ts` (create)
- `packages/core/test/*.test.ts` (only the env save/restore helpers and the two assertions named above)
- `packages/core/src/e2e.ts` (type fix around line 315 only)
- `.github/workflows/ci.yml` (create)
- `package.json` (`packageManager` only) and `bun.lock` (only what `bun install` on 1.4.4 rewrites)
- `.factory/plans/README.md` (status only)

**Out of scope**:

- Any runtime or CLI behavior change. Plans 002–006 own those.
- `apps/docs` build in CI beyond typecheck (it uses `latest` dependency ranges and is not part of this plan).
- Publishing or release automation (plan 006).

## Git workflow

- Branch: `feature/deterministic-test-baseline` (the repository merges `feature/<slug>` branches through PRs, e.g. `feature/authorizers`).
- Commit only if authorized by the task; messages are short imperative sentences in sentence case (e.g. "Fix transaction normalization runtime error").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Move to Bun 1.4.4, then reproduce and record the baseline

Confirm `bun --version` prints `1.4.4`. Set `"packageManager": "bun@1.4.4"` in the root
`package.json`. Run `bun install`; keep whatever it rewrites in `bun.lock` and nothing else.
Then run `cd packages/core && bun test` and `bun run typecheck` and record the failing test
names. Expect the env-related failures described above.

### Step 2: One env helper that really unsets

Create `packages/core/test/support/env.ts`:

```ts
export const setEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
};

export const withEnv = async <TResult>(
  values: Record<string, string | undefined>,
  run: () => TResult | Promise<TResult>
): Promise<TResult> => {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]])
  );

  for (const [name, value] of Object.entries(values)) {
    setEnv(name, value);
  }

  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      setEnv(name, value);
    }
  }
};
```

Replace each local `restoreEnv`/direct `Bun.env[name] = previous` restore listed in
"Current state" with `setEnv` (or wrap the test body in `withEnv`). Direct assignments of
real string values (e.g. `Bun.env.AWS_REGION = "us-west-2"`) may stay, provided their
restore goes through `setEnv`. `Bun.env` and `process.env` are the same object in Bun.

**Evidence**: `bun test test/local.test.ts` → 0 fail; `grep -rn "Bun.env\[name\] = value" packages/core/test` → no matches.

### Step 3: Fix the two remaining assertions and the type error

- "generated starter test suite passes with local package links": assert on the child
  process exit code and the pass/fail summary instead of the presence of a test name in
  `bun test` output.
- "wraps a Hono app with a default name and handler": find the cause after step 2. If it
  is env leakage it is already fixed; otherwise fix the test or the code so the public
  `api(app)` shape (`app`, `config`, `fetch`, `handler`, `name`) is asserted exactly.
- `src/e2e.ts:315`: make `responseHeaders` accept `Record<string, string | string[] | number | boolean> | undefined`
  and join array values with `, ` so multi-value headers survive.

### Step 4: CI workflow

Create `.github/workflows/ci.yml`: triggers `pull_request` and `push` to `main`; one job on
`ubuntu-latest`; a single Bun version taken from the `packageManager` field
(`oven-sh/setup-bun` with `bun-version-file: package.json`), so the pin is the only place the
version lives; steps `actions/checkout`, `oven-sh/setup-bun`,
`bun install --frozen-lockfile`, `bun run check`, `bun run typecheck`, `bun run test`.
No secrets, no deploy steps, `permissions: contents: read`.

If the docs app makes `bun run typecheck` or `bun run test` fail for reasons unrelated to
this plan, scope the CI commands to the core package and examples with turbo filters and
note it in the workflow as a comment.

## Test plan

- No new product tests. The proof is the existing suite passing in three orders:
  full run, each file alone (`for f in test/*.test.ts; do bun test "$f"; done`), and with
  a hostile environment: `AWS_REGION=eu-west-9 STAGE=zzz AWS_ENDPOINT_URL=http://x bun test`.
- Tests that assert default region, stage, or endpoint must pin or clear those variables
  with `withEnv` so the hostile run passes.

## Done criteria

- [ ] `grep '"packageManager"' package.json` → `bun@1.4.4`
- [ ] `cd packages/core && bun test` → 0 fail on Bun 1.4.4
- [ ] Every `test/*.test.ts` file passes when run alone
- [ ] `AWS_REGION=eu-west-9 STAGE=zzz AWS_ENDPOINT_URL=http://x bun test` → 0 fail
- [ ] `cd packages/core && bun run typecheck` exits 0
- [ ] `bun run check` exits 0
- [ ] `.github/workflows/ci.yml` exists and runs check, typecheck, and test
- [ ] No files outside the in-scope list are modified (`git status`)

## STOP conditions

- A failing test reveals a real defect in `packages/core/src` beyond the `e2e.ts` type
  fix. Report it with the failing assertion; do not patch product behavior here.
- The suite cannot pass on Bun 1.4.4 without changing product behavior. Report the failing
  test and the Bun behavior involved.
- `bun install` on 1.4.4 changes dependency versions in `bun.lock` beyond a format rewrite and
  that breaks typecheck or tests for reasons unrelated to this plan. Report the packages involved.

## Maintenance notes

- New tests that touch environment variables should use `test/support/env.ts`.
- Reviewers should check that no assertion was loosened beyond the two named cases.
- Deferred: a real-AWS smoke job in CI. It needs OIDC credentials and belongs with plan 004.

## Execution notes (2026-11-14)

Done. Deviations from the steps above:

- With the repository lockfile (`bun install` on 1.4.4 left `bun.lock` unchanged), the baseline was
  158 pass / 12 fail and `bun run typecheck` already passed. The `src/e2e.ts` type error only
  appears with a newer hono, so no source file was changed.
- The env leak caused 11 of the 12 failures, including "wraps a Hono app with a default name and
  handler". Only the starter-suite assertion needed a change.
- Hostile-environment isolation uses a test preload instead of per-test `withEnv` wrappers:
  `packages/core/bunfig.toml` preloads `test/support/isolate-env.ts`, which removes `AWS_*`,
  `VOKE_*`, `STAGE`, `PORT`, and `HOST` before any test file runs. It applies when tests run from
  `packages/core` (as turbo does), not to a bare `bun test` from the repository root.
- `Reflect.deleteProperty(process.env, name)` replaces `delete process.env[name]` to satisfy the
  `no-dynamic-delete` lint rule; it unsets the variable in Bun (checked).
- `bun run check` failed on `main` because `roadmap-v2.md` had one extra trailing blank line; it
  was formatted so the CI gate can pass.
- CI uses `actions/checkout@v7` and `oven-sh/setup-bun@v2` with no `bun-version` input; setup-bun
  then reads `packageManager` from `package.json`.
