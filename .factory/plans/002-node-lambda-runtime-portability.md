# Plan 002: A built Voke bundle starts and serves requests on the AWS Lambda Node.js runtime

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare `git diff --stat a7741eb -- packages/core/src packages/core/test examples`
> and `git status --short` with the recorded current state. Reconcile routine drift;
> pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `.factory/plans/001-deterministic-test-baseline-and-ci.md`
- **Category**: bug
- **Planned at**: commit `a7741eb`, 2026-11-14

## Why this matters

Voke synthesizes Lambda functions with `Runtime: nodejs22.x` or `nodejs24.x`, but the
bundle that `voke build` produces cannot be loaded by Node at all, and the framework's
own runtime code calls `Bun.*` globals that do not exist there. No Voke project can run
on AWS today, whatever the deploy tooling does. This plan makes the bundle portable and
adds a test that loads it under real Node so the property cannot regress. It also cuts
the bundle from about 1.1 MB to about 110 KB, which shortens cold starts.

## Current state

Verified in a scratch copy by building `examples/hello-api` (Bun 1.4.4, Node 24.14).

- `packages/core/src/build.ts:68-76` builds with the Bun target:
  ```ts
  command: ["bun", "build", ...entrypoints, "--outdir", outdir, "--target", config.build.target],
  ```
  `config.build.target` is typed as the literal `"bun"` (`packages/core/src/config.ts:38-42`,
  default at `:119`; mirrored in `packages/core/src/model.ts:48-53`).
- Loading that bundle in Node fails: `TypeError: __require is not a function`.
- Building the same entry with `--target node` loads further and then fails:
  `ReferenceError: Bun is not defined`. Runtime modules that use Bun globals:
  - `packages/core/src/config.ts:189` and `:201` — `Bun.env.VOKE_STAGE`, `Bun.env.STAGE`, `Bun.env.AWS_REGION` inside `defineConfig`, which `voke()` calls at module load
  - `packages/core/src/app.ts:197` (`Bun.env.VOKE_DEV_SUMMARY`), `:210` (`Bun.env.PWD`)
  - `packages/core/src/aws.ts:38,56,57,62,63` — `bindResource(...).value()` and `createAwsClientConfig`
  - `packages/core/src/invoke.ts:876` (`VOKE_INVOKE_RUNTIME`), `:1471` (`Bun.sleep`), `:2078,2095,2098` (dev origin)
  - `packages/core/src/remote.ts:189` (`new Bun.CryptoHasher("sha256")`), `:363` (`Bun.env[...]`)
- Feasibility check: with `Bun.env` → `process.env` and `Bun.sleep` → `setTimeout` in those
  files, building with `bun build ./src/index.ts --target node --format esm --external '@aws-sdk/*'`
  and adding `{"type":"module"}` next to the output, Node imports the bundle and a hand-made
  API Gateway HTTP API v2 event for `GET /health` returns
  `200 {"data":{"ok":true,"service":"hello-api","stage":"local"}}`. The only `Bun.` reference left
  in the bundle was `Bun.CryptoHasher`.
- Bundle size: 1.13 MB today. `@smithy/*` and `@aws-sdk/*` account for about 900 KB. They
  come from one static import, `packages/core/src/invoke.ts:9`
  (`import { createAwsLambdaInvokeTransport } from "./aws-lambda-invoke-transport"`), used only at
  `invoke.ts:1611` when a Function is invoked with the `aws` runtime. With `@aws-sdk/*`
  external the bundle is 109 KB. The Lambda Node.js runtimes ship AWS SDK v3.
- Modules that are CLI-only and may keep Bun APIs: `cli.ts`, `build.ts`, `dev.ts`, `local.ts`,
  `local-provider.ts`, `serverless-migration.ts`, and the functions `loadVokeConfig`
  (`config.ts:208-235`) and `generateRemoteModules` (`remote.ts:542+`). Bun's bundler
  tree-shook these out of the runtime bundle in the feasibility check.
- `packages/core/src/app.ts:209-234` (`loadRuntimeConfig`) loads `voke.config.ts` with a
  synchronous `require` from `PWD` when `voke(functions)` is called without `{ config }`. That
  file is not in a Lambda bundle, so the call throws `Voke config file not found`. Projects that
  pass `{ config }` (the scaffold and all examples do) are unaffected.
- Runtimes allowed by config: `"nodejs22.x" | "nodejs24.x"` (`config.ts:66`). This plan keeps that.
- Vocabulary (from `CONTEXT.md` and `README.md`): **Function**, **Function Registry**
  (`createFunctions`), **Gateway** (`voke(functions)`), **Voke Project**. Use these terms in names,
  comments, and docs.
- `docs/stable-public-surface.md` lists `voke/build` and `voke/config` as stable subpaths.
  `build.target` is part of `VokeConfigInput`. The package version is `0.0.0` and nothing is
  published.
- ADR `docs/adr/0007-opinionated-framework.md` (decided 2026-11-14): Voke offers one supported
  way per layer and removes alternatives without deprecation aliases. For this plan: "a single
  ESM bundle built for the Lambda Node.js runtime" is the only build; the `bun` build target is
  removed, not kept as an option. `build.external` is the build layer's one escape hatch.

## Commands you will need

| Purpose             | Command                                                             | Expected on success    |
| ------------------- | ------------------------------------------------------------------- | ---------------------- |
| Install             | `bun install`                                                       | exit 0                 |
| Core tests          | `cd packages/core && bun test`                                      | all pass               |
| One test file       | `cd packages/core && bun test test/build.test.ts`                   | all pass               |
| Core typecheck      | `cd packages/core && bun run typecheck`                             | exit 0                 |
| Repo gates          | `bun run typecheck && bun run test`                                 | exit 0                 |
| Lint/format         | `bun run check`                                                     | exit 0                 |
| Manual bundle check | `cd examples/hello-api && bun ../../packages/core/src/cli.ts build` | writes `dist/index.js` |

## Implementation rules relevant to this plan

- Test first: write the failing Node-load test (step 1) before changing source.
- Runtime modules (anything reachable from `packages/core/src/index.ts`, `aws.ts`, `invoke.ts`,
  `response.ts`, `schema.ts`, `context.ts`, `remote.ts` runtime paths) must not reference the
  `Bun` global. Use `process.env`, Web APIs, and `node:` built-ins, which work in both Bun and Node.
- Keep dependencies minimal: no new packages.
- Preserve public names and signatures of `defineConfig`, `voke`, `bindResource`,
  `createAwsClientConfig`, `createBuildPlan`, and `functions.invoke`.
- Errors thrown for user-fixable problems must be `VokeError` subclasses with a message that
  says what to do next (`docs/error-conventions.md`).
- Ultracite style: explicit types where they help, `const`, `for...of`, no `console.log` in
  production code, no barrel files.

## Scope

**In scope**:

- `packages/core/src/runtime-env.ts` (create)
- `packages/core/src/config.ts`, `app.ts`, `aws.ts`, `invoke.ts`, `remote.ts`, `aws-lambda-invoke-transport.ts`
- `packages/core/src/build.ts`, `packages/core/src/model.ts` (build target type only), `packages/core/src/cli.ts` (`build` function only)
- `packages/core/test/node-runtime.test.ts` (create), `packages/core/test/fixtures/node-runtime/` (create), `packages/core/test/build.test.ts` and other tests that assert the build command
- `examples/*/package.json` build scripts
- `README.md`, `apps/docs/content/docs/reference/cli.mdx`, `apps/docs/content/docs/reference/config.mdx` (build target wording only)
- `.factory/plans/README.md` (status only)

**Out of scope**:

- A named `handler` export for the Gateway and per-Function Lambda entries (plan 003).
- Packaging, upload, and `voke deploy` (plan 004).
- A Bun custom runtime or Lambda layer. Considered and deferred; see the plans index.
- Replacing `Bun.*` in CLI-only modules.

## Git workflow

- Branch: `feature/node-lambda-runtime`
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Failing test that loads a built bundle under Node

Create `packages/core/test/fixtures/node-runtime/index.ts`: a small Gateway with one
`route.get("/health", ...)`, a `fn(...)` invokable Function, a `bindResource` read behind a
route, and `export const handler = gateway.handler;` plus `export default gateway;`. Pass an
inline `config` to `voke(functions, { config: { name: "node-runtime" } })`.

Create `packages/core/test/node-runtime.test.ts`:

1. Build the fixture into a temporary directory through `createBuildPlan` (so the test follows
   whatever command the build plan produces) and run the command with `Bun.spawn`.
2. Assert the output text contains no `Bun.` reference (regex `/\bBun\./u`).
3. Spawn `node` with a small inline ESM script that imports the bundle, calls `handler` with an
   HTTP API v2 event for `GET /health`, and prints the JSON result. Assert `statusCode` 200 and
   the body.
4. `@aws-sdk/*` is external, so place the temporary output directory under `packages/core/`
   (for example `packages/core/.tmp-node-runtime/`, removed in `afterAll`, and add the folder to
   `.gitignore` if needed) so Node resolves the SDK from `packages/core/node_modules`.
5. Skip with a clear message only when `node` is not on `PATH` (`Bun.which("node") === null`),
   using a conditional `test`/`test.skipIf`-style guard that CI does not hit; CI runners have Node.

Run it: it must fail for the right reason (`__require is not a function` or `Bun is not defined`).

### Step 2: Runtime environment module

Create `packages/core/src/runtime-env.ts` (internal, not added to `package.json` exports):

```ts
export const readEnv = (name: string): string | undefined => process.env[name];

export const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex"); // from "node:crypto"
```

Replace every runtime `Bun.env.X` / `Bun.env[name]` listed in "Current state" with
`readEnv(...)`, `Bun.sleep` with `sleep`, and the `Bun.CryptoHasher` use at `remote.ts:189`
with `sha256Hex` (keep the digest encoding identical so Function Contract Artifact fingerprints
do not change; `test/remote-functions.test.ts` covers fingerprints).

Leave `Bun.file`, `Bun.write`, `Bun.$` inside `loadVokeConfig` and `generateRemoteModules`:
they are CLI-time code.

### Step 3: Lazy AWS SDK load

Make the Lambda client load only when the `aws` invoke runtime is actually used:

- In `aws-lambda-invoke-transport.ts`, keep the exported `createAwsLambdaInvokeTransport`
  signature and the `AwsLambdaInvokeClient` seam (`:13`), but obtain `LambdaClient`/`InvokeCommand`
  through `await import("@aws-sdk/client-lambda")` inside `invoke` when no `options.client` was
  injected. Cache the created client.
- Keep `invoke.ts:1611` caching (`cachedAwsLambdaInvokeTransport ??= ...`).
- `test/aws-lambda-invoke-transport.test.ts` injects a client; it must keep passing unchanged
  or with minimal edits.

### Step 4: One build: Node-target ESM

Remove the `target` field from `VokeBuildConfig` and `VokeConfigInput["build"]` (`config.ts`),
from `VokeModelBuild` (`model.ts`), and from `BuildPlan` (`build.ts`). There is no build-target
option. A config that still passes `build.target` is a TypeScript error; at runtime
`defineConfig` rejects it with `VokeConfigError.validation` at path `build.target`:
`"build.target" was removed; Voke always builds an ESM bundle for the Lambda Node.js runtime`.

In `build.ts`:

- The command is always
  `["bun", "build", ...entrypoints, "--outdir", outdir, "--target", "node", "--format", "esm", "--external", "@aws-sdk/*"]`.
- Add `external?: string[]` to `VokeBuildConfig` (default `["@aws-sdk/*"]`), each entry emitted as
  `--external <pattern>`. `external: []` bundles the SDK for projects that need a pinned version.
- Add to `BuildPlan` a `files: Record<string, string>` map of extra files to write after the
  build; it contains `<outdir>/package.json` → `{"type":"module"}\n`, which makes Lambda load
  `index.js` as an ES module. In `cli.ts`, the `build` function writes these files after the
  command succeeds.

Update `test/build.test.ts`, `test/cli-contract.test.ts`, and any other test asserting the old
command array. Update example `package.json` build scripts that hardcode `--target bun`
(`examples/sqs-events`, `examples/cross-function`) to `voke build` or the new flags.

### Step 5: Clear error when config is missing at runtime

In `app.ts` `loadRuntimeConfig`, when the config file cannot be loaded, throw `VokeConfigError`
with: `Voke config file not found: <path>. In a deployed bundle voke.config.ts is not on disk; pass it explicitly: voke(functions, { config }).`
Add a test for the message.

### Step 6: Docs

- `README.md`: fix the sentence at line 51 ("The default export has an constant `handler` accepts...")
  to state accurately what the Gateway exposes (`fetch`, `request`, `handler`), and say the build
  targets the Lambda Node.js runtime.
- `apps/docs/content/docs/reference/cli.mdx`: "Builds the Voke project entrypoint for Bun." →
  describe the Node ESM build and the `build.external` option. Remove any mention of a build target.

## Test plan

- `test/node-runtime.test.ts` (new): bundle has no `Bun.` reference; Node loads it; `GET /health`
  returns 200; an unknown path returns the 404 JSON error.
- `test/build.test.ts`: the Node ESM command; `external: []` omits `--external`; `plan.files`
  contains the module-type `package.json`; `build.target` in config input is rejected with the
  removal message.
- `test/public-api-redesign.test.ts` or `test/error-design.test.ts`: the new missing-config message.
- Existing suites (`invoke`, `remote-functions`, `bindings`, `api`) must pass unchanged in
  behavior: these cover env reads, timeouts, and fingerprints after the `runtime-env` swap.
- Structural pattern: model new tests after `packages/core/test/build.test.ts`.

## Done criteria

- [ ] `cd packages/core && bun test test/node-runtime.test.ts` passes and actually spawns `node`
- [ ] `grep -nE "\bBun\." packages/core/src/{app,aws,invoke,context,response,schema,route-builder,authorizers,runtime-env}.ts` returns no matches; in `config.ts` and `remote.ts` matches remain only inside `loadVokeConfig` and `generateRemoteModules`
- [ ] `cd examples/hello-api && bun ../../packages/core/src/cli.ts build` writes `dist/index.js` under 200 KB and `dist/package.json` with `"type":"module"`
- [ ] `cd packages/core && bun test` → 0 fail; `bun run typecheck` exits 0; `bun run check` exits 0
- [ ] `grep -rnE "target: \"bun\"|\"--target\", *\"bun\"|--target bun" packages/core/src examples/*/package.json` returns no matches (the framework's own `packages/core/package.json` build script keeps `--target bun`: it builds the CLI, which runs on Bun)
- [ ] README and CLI reference no longer say the build is "for Bun"
- [ ] No files outside the in-scope list are modified

## STOP conditions

- Node cannot load the bundle for a reason other than the three recorded (`__require`, `Bun`
  global, external SDK resolution) and the fix would need a new dependency or a change to hono usage.
- Replacing `Bun.CryptoHasher` changes existing Function Contract Artifact fingerprints. Report
  before changing fingerprint expectations.
- Making the SDK import lazy would change the public signature of `createAwsLambdaInvokeTransport`.

## Maintenance notes

- Any new runtime module must import from `runtime-env.ts` instead of using `Bun.*`; the
  Node-load test is the guard.
- Externalizing `@aws-sdk/*` relies on the SDK that ships in the Lambda Node.js runtime. If a
  project needs a newer client than the runtime provides, `build.external: []` bundles it.
- Reviewers should scrutinize the lazy import path for the `aws` invoke runtime (first-call
  latency, error wrapping) and that dev-mode behavior (`VOKE_DEV_SUMMARY`, dev origin) is unchanged.
- Deferred: source maps for bundles, minification, and per-Function bundles (roadmap v2 phase 6).

## Execution notes (2026-11-14)

Done. Deviations and findings:

- The Node test runs `node --no-experimental-detect-module`. Without that flag, current Node
  versions detect ES module syntax and load the bundle even with no `package.json`, which hid a
  path bug during development. With it, the bundle loads only because of the generated
  `{"type":"module"}` file (checked: the same bundle without it fails with `ERR_REQUIRE_CYCLE_MODULE`).
- The test fails instead of skipping when `node` is missing: proving the Lambda runtime path is
  the point of the test, and CI runners have Node.
- The Lambda SDK is loaded on first invoke even when a client is injected, because constructing
  `InvokeCommand` also needs the SDK. The exported signature of `createAwsLambdaInvokeTransport` is unchanged.
- `sha256Hex` (`node:crypto`) produces the same digests as `Bun.CryptoHasher` (checked on empty,
  ASCII, non-ASCII, and lone-surrogate inputs), so Function Contract fingerprints are unchanged.
- The CLI `build` command writes `plan.files` after the bundler succeeds; the CLI build test now
  asserts those files and removes them.
- Example builds now use `voke build`. Measured bundles: hello-api 109 KB, cross-function 107 KB,
  e2e 107 KB, sqs-events 36 KB (was 1.13 MB for hello-api). The built hello-api bundle served
  `/health`, `/users/usr_1`, and a 404 app error under `node --no-experimental-detect-module`.
- Added `.tmp-node-runtime` to the root `.gitignore` in case the Node test is interrupted before cleanup.
- `apps/docs/content/docs/reference/config.mdx` gained a `build` row; it did not list `build` before.
