# Plan 030: A Lambda bundle holds only run-time code, is minified with function names intact, and a test with a size budget keeps it that way

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/aws/src packages/aws/package.json packages/aws/test packages/build packages/core/test examples/hello-api apps/docs/content/docs CONTEXT.md docs/adr`
> and `git status --short` with the recorded current state. Plans 022–029 are meant to land
> first; 027, 028 and 029 change `packages/aws/src/cloudformation-synthesis.ts` and may add
> methods to the Event Source adapters, and 023/024 change `packages/core/src/invoke.ts`.
> Reconcile that drift (Step 4 splits whatever adapter methods exist by then). Pause only if it
> invalidates a decision listed below.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none. Ordering only: (`022` … `029`), which this plan follows in the round.
  Plan `034` comes after and must keep the `imports` entry this plan adds.
- **Category**: perf
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

`voke build` writes one `index.js` that every Function of a Voke Project loads at cold start.
Today that file also carries the AWS Provider's deploy-time half: CloudFormation synthesis,
deploy, the zip writer, the `voke local` workflow, the AWS Emulator client and the build planner.
For `examples/hello-api` that is about 78 KB of 279 KB, parsed and evaluated on every cold start
and uploaded on every deploy, and it grows with every deploy feature (plans 027–029 add more).
The bundle is also not minified.

After this plan the bundle holds the run-time half only, is minified without renaming
identifiers, and a test fails when a deploy-time module comes back or the size passes a budget.

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0007-opinionated-framework.md`: one supported way per layer, one spelling per
  setting, removals without deprecation aliases (the packages are unreleased).
- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: `voke` (core) is
  provider-neutral and must not import `@voke/*`; `@voke/aws` owns all AWS code.
- `AGENTS.md`: test first; small changes; no barrel `export *` files; Bun APIs; Ultracite.
- Vocabulary from `CONTEXT.md`: **Voke Project**, **Function**, **Gateway**, **Provider**,
  **Provider Capability** ("A focused part of a **Provider** contract, such as runtime,
  invocation, build, synthesis, or local workflow behavior"), **AWS Provider**, **Plugin**,
  **Event Source**, **Local AWS Provider**, **AWS Emulator**. `CONTEXT.md` has no term for the
  bundle; this plan adds **Lambda Bundle**.
- Existing convention for run-time files, e.g. `packages/core/src/plugin.ts:1`:
  `// Run-time module: bundled into deployed Functions, so it must not import CLI code.`
  Use the same first-line comment on the run-time files this plan creates.

### Code at `1c59d39`

- **Generated entry**, `packages/aws/src/build.ts:27-50`. For `examples/hello-api` it writes
  `.voke/build/index.ts`:

  ```ts
  import * as project from "../../src/index.ts";
  import config from "../../voke.config.ts";
  import { createLambdaHandlers } from "@voke/aws";

  const handlers = createLambdaHandlers(project, { config });
  ```

  The config is imported because a deployed Function needs it: `config.plugins` (Function
  Wraps, middleware, Plugin Functions), `config.api.cors`, `config.remotes`, and from
  `config.provider` exactly three members, all read in core's run-time modules:
  `provider.runtime.variables` (`packages/core/src/app.ts:163`), `provider.invoke`
  (`app.ts:235`) and `provider.runtime.routeAuth` (`packages/core/src/invoke.ts:1469`). The
  other capabilities are read only by CLI modules (`cli.ts:252,286,428,492,594`, `dev.ts:39`,
  `doctor.ts:155`, `model.ts:700`), none of which is in the bundle.

- **The user's config is the import that drags deploy code in.** `examples/hello-api/voke.config.ts`
  has `import { aws } from "@voke/aws";` and `provider: aws({ ... })`, and the project entrypoint
  imports the config too (`examples/hello-api/src/index.ts:5`). So changing only what the
  generated entry imports cannot help.
- **`aws()`**, `packages/aws/src/index.ts:256-324`, with static imports at `index.ts:4-30`:
  ```ts
  return {
    build: { plan: createAwsBuildPlan },
    deploy: { deploy: async (input) => await deployAwsStack(input, { ... }), remove: ... },
    diagnostics: createAwsDiagnostics(localProvider),
    invoke: createAwsInvokeCapability(),
    local: { devEnvironment: ..., workflow: createLocalWorkflow(localProvider) },
    name: "aws",
    runtime: {
      routeAuth: awsRouteAuth,
      variables: () => [createAwsRuntimeVariableProvider()],
    },
    synthesis: { synthesize: ({ model }) => synthesizeCloudFormationFromModel(model, { lambda }) },
    validate: validateAwsModel,
  };
  ```
  The returned object references every capability, so tree-shaking keeps all of them.
  `build.plan`, `synthesis.synthesize` and `validate` are synchronous in the Provider contract
  (`packages/core/src/provider.ts`).
- **Event Source adapters mix both halves**, `packages/aws/src/event-sources.ts:34-70`:
  `AwsEventSourceAdapter` has `toInvocation` and `toResponse` (run time) next to `validate`,
  `synthesize`, `synthesizeStack?`, `roleStatements?` and `resourceProperties?` (deploy time).
  One table (`event-sources.ts:72-83`) holds all seven adapters (`sqs`, `sns`, `eventBridge`,
  `schedule`, `kinesis`, `dynamodbStream`, `s3`). `packages/aws/src/lambda-handlers.ts:244-255`
  uses only `toInvocation` and `toResponse`; `index.ts:201` and
  `cloudformation-synthesis.ts:503,1123` use the deploy methods. Each adapter object lives in
  its source file, e.g. `sqsEventSourceAdapter` at `packages/aws/src/sqs.ts:472-514`.
- **Build command**, `packages/build/src/index.ts:102-113`:
  ```ts
  command: [
    "bun", "build", ...entrypoints, "--outdir", outdir,
    "--target", "node", "--format", "esm",
    ...input.build.external.flatMap((pattern) => ["--external", pattern]),
  ],
  ```
  No minification, no source map, no custom condition. The command is pinned in
  `packages/build/test/build.test.ts:30-41` and `packages/core/test/build-cli.test.ts:57-72`.
- **What gets uploaded**: `packages/core/src/cli.ts:341-362` (`artifactFilesOf`) lists only the
  plan's `outputs` and `files`, so a file the bundler writes beside them (a `.map`, a chunk) is
  not in the zip unless the plan names it.
- **Package maps**, `packages/aws/package.json:25-30`: `exports` has `.`, `./cloudformation`,
  `./local`, `./testing`, all pointing at `.ts` files. There is no `imports` field anywhere.
- **Core tests reach `@voke/aws` through tsconfig `paths`**, `packages/core/tsconfig.json`:
  `"@voke/aws": ["../aws/src/index.ts"]`. Bun's bundler honours `paths`, so
  `packages/core/test/node-runtime.test.ts` (which runs the plan's `command` with
  `cwd: packages/core`) never consults `@voke/aws`'s `exports` map. A condition on `exports`
  would not apply there; a `#` subpath import inside `packages/aws/src` does, because it is
  resolved from `packages/aws/package.json`.
- **Docs that describe the bundle**: `apps/docs/content/docs/reference/cli.mdx:90`,
  `reference/config.mdx:73`, `concepts.mdx:165`, and the callout at
  `guides/plugins.mdx:197-201`:
  "The config is imported by the deployed Functions too, so a command's dependencies end up in
  the Lambda bundle. Load command-only dependencies with `await import(...)` inside `run`."

### Measurements (planner's, 2026-11-15, Bun 1.4.4, Node 24.14, macOS)

`cd examples/hello-api && bunx voke build --outdir <tmp>` at `1c59d39`: one `index.js`,
279,246 bytes, 102 modules. Deploy-time modules in it, by bytes: `cloudformation-synthesis.ts`
21,779; `deploy.ts` 12,862; `local.ts` 10,616; `local-aws-emulator.ts` 6,396; `deploy-clients.ts`
5,404; `zip.ts` 4,460; `diagnostics.ts` 3,394; `build.ts` 2,758; `durable-synthesis.ts` 2,473;
`packages/build/src/index.ts` 2,138; `local-provider.ts` 1,694.

A simulation (a resolver plugin that swaps `@voke/aws` for a module whose `aws()` returns only
`invoke`, `name` and `runtime`; the adapter split of Step 4 was not simulated):

| Variant                                 | Bytes   | gzip   | Cold `import()` (median of 9) |
| --------------------------------------- | ------- | ------ | ----------------------------- |
| Today                                   | 279,246 | 66,288 | 11.0 ms                       |
| Run-time `aws()`                        | 194,736 | 45,988 | 7.4 ms                        |
| + `--minify-syntax`                     | ~180 K  | ~44 K  | not measured                  |
| + `--minify-whitespace --minify-syntax` | 145,971 | 39,893 | 7.2 ms                        |
| + `--minify-identifiers` (rejected)     | 95,957  | 32,509 | not measured                  |

After the swap, `cloudformation-synthesis.ts` contributed 2,135 bytes: the two resource builders
the config calls (`dynamodbTable`, `sqsQueue`). The seven Event Source modules, `stream-batch.ts`
and `event-source-resources.ts` still contributed about 23 KB, part of it `synthesize` and
`validate` code. Numbers will differ after plans 022–029; measure again in Step 5.

### Findings checked and dropped

- **"Load the capabilities with dynamic `import()`"** (the index's "Opportunities" entry). It
  does not remove anything. Probed on Bun 1.4.4: `bun build --target node --format esm` inlines a
  dynamically imported local module into the same file (`await Promise.resolve().then(() => exports_heavy)`);
  with `--splitting` it writes the module as a chunk in the outdir. Only an `--external` module
  stays out. It would also force `build.plan`, `synthesis.synthesize` and `validate` to become
  asynchronous in the core Provider contract. Dropped.
- **"A run-time subpath (`@voke/aws/runtime`) for the generated entry"**. Not enough on its
  own: the import that pulls deploy code is the user's `import { aws } from "@voke/aws"` in
  `voke.config.ts`, not the generated entry.
- **`--minify --keep-names`**. Probed under Node 24: stack frames show the renamed identifiers
  (`at e (t.js:1:49)`), so `--keep-names` does not keep frames readable. Dropped.
- **The Plugin guide's advice** (`plugins.mdx:197-201`) that `await import(...)` keeps a
  command's dependency out of the bundle holds only for `node:` built-ins and `build.external`
  modules, for the reason in the first bullet. Step 6 corrects the wording.
- Confirmed and left alone: every Lambda gets the same `S3Key`
  (`cloudformation-synthesis.ts:1084`); every durable version is retained
  (`durable-synthesis.ts:136-141`). Both belong to later work (see Maintenance notes).

## Decisions taken in this plan

1. **Mechanism: a package `imports` entry with a custom condition.** `@voke/aws` gets
   ```json
   "imports": {
     "#provider": {
       "voke-runtime": "./src/provider-runtime.ts",
       "default": "./src/provider.ts"
     }
   }
   ```
   `packages/aws/src/index.ts` keeps its whole export list and gets `aws` with
   `export { aws, type AwsProviderOptions } from "#provider";`. `voke build` passes
   `--conditions voke-runtime`. Everything else (the CLI, `voke dev`, tests, type checking)
   resolves `default` and sees today's `aws()`.
   _Why_: the user keeps writing `import { aws } from "@voke/aws"`; no second export list to keep
   in sync; it also applies when `@voke/aws` is reached through tsconfig `paths`. Probed on Bun
   1.4.4: `bun build --conditions` selects the conditional `imports` target, the Bun runtime
   selects `default`, the bundler's metafile no longer lists the deploy modules, and `tsgo`
   resolves the types through `default`.
   _Reverse_: delete the `imports` entry, import `./provider` directly, drop the flag.
   _Fallback if `#provider` fails in a tool_ (see STOP conditions): a conditional `exports`
   entry for `.` (`{ "voke-runtime": "./src/runtime.ts", "default": "./src/index.ts" }`) with a
   second file that repeats the export list, plus a test that both files export the same names.
   It does not cover resolution through tsconfig `paths`.
2. **The run-time `aws()` returns `invoke`, `name` and `runtime` and nothing else.** It accepts
   the same options and ignores them: it does not validate `lambda` and does not create a Local
   AWS Provider. Validation already ran in `voke build` and `voke deploy`, which use the full
   `aws()`. The full `aws()` spreads the same run-time object, so the run-time half has one
   definition. _Reverse_: add members to the run-time object.
3. **The condition is named `voke-runtime` and `@voke/build` sets it for every Provider's
   bundle.** It is a public contract: a Plugin package may use it in its own `exports` or
   `imports` to keep command-only code out of the Lambda bundle. Recorded in an ADR.
   _Reverse_: hard once Plugin authors rely on it; that is why it gets an ADR.
4. **Event Source adapters split in two.** A run-time adapter (`source`, `toInvocation`,
   `toResponse`) and a deploy adapter (everything else). `lambda-handlers.ts` reads the run-time
   table only. Both halves stay in the Event Source's own file; the bundler drops the unused
   object. _Reverse_: merge the two interfaces again.
5. **Minification: `--minify-whitespace --minify-syntax`, never `--minify-identifiers`, no
   setting.** Function and class names stay as written, so a CloudWatch stack frame still reads
   `at chargeCard (file:///var/task/index.js:1:51234)`. The cost: the file has about 25 lines, so
   the position is a column, not a useful line. _Why_: about 25% fewer bytes on disk and 13%
   fewer zipped than the unminified run-time bundle, with names intact. _Reverse_: remove
   `--minify-whitespace` in `packages/build/src/index.ts` (about +34 KB on disk, +4 KB zipped for
   `hello-api`; frames get line numbers back). No `build.minify` option: one way per layer.
6. **No source maps, and no setting for them.** Node applies a map only with
   `--enable-source-maps`, which slows every error path; the map for `hello-api` is 611 KB, four
   times the bundle; and it would have to be added to the uploaded files. Kept identifiers cover
   the common need. _Reverse_: add `--sourcemap=linked`, add the `.map` to the plan's `files`
   so it is zipped, and set `NODE_OPTIONS=--enable-source-maps` on the Functions.
7. **Resource builders stay where they are.** `dynamodbTable()`, `sqsQueue()` and the other
   builders in `cloudformation-synthesis.ts` run when the config module is evaluated, so the ones
   a project calls remain in its bundle (about 1 KB each). Tree-shaking already drops the rest of
   that file once `aws()` stops referencing synthesis. The same holds for `floci()` from
   `@voke/aws/local`. Accepted. _Reverse_: move the builders to their own module.
8. **The regression test lives in `examples/hello-api`.** An example resolves `@voke/aws`
   through `node_modules` as a user's project does, has Plugins, a resource-bearing config and a
   Gateway, and already has a test directory.

## Commands you will need

| Purpose           | Command                                                                                                     | Expected on success             |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Build an example  | `cd examples/hello-api && bunx voke build --outdir <tmp dir>`                                               | exit 0, `<tmp dir>/index.js`    |
| Bundle test       | `cd examples/hello-api && bun test test/bundle.test.ts`                                                     | 0 fail                          |
| Build package     | `cd packages/build && bun test`                                                                             | 0 fail                          |
| AWS package       | `cd packages/aws && bun test`                                                                               | 0 fail                          |
| Node runtime      | `cd packages/core && bun test test/node-runtime.test.ts test/build-cli.test.ts test/public-surface.test.ts` | 0 fail (needs `node` on `PATH`) |
| Package typecheck | `bun run typecheck` in `packages/aws`, `packages/build`, `examples/hello-api`                               | exit 0                          |
| Docs              | `cd apps/docs && bun run check:samples && bun run test && bun run lint:links`                               | exit 0                          |
| Repo gates        | `bun run check && bun run typecheck && bun run test`                                                        | exit 0                          |

The first command ran during planning (279,246 bytes, 102 modules). The others are the repo's
standard scripts; `bun run check`, `bun run typecheck` and `bun run test` were green at `1c59d39`.

## Implementation rules relevant to this plan

- Test first: Step 1's test must fail before Step 2 starts.
- `packages/core/src` is not edited by this plan.
- Run-time files must not use the `Bun` global (`node-runtime.test.ts` checks the bundle) and
  must not import, even transitively, a deploy-time module. First line of each new run-time
  file: `// Run-time module: ...` as in `packages/core/src/plugin.ts:1`.
- No `export *`. `index.ts` keeps explicit export lists.
- No new dependency; `bun.lock` does not change.
- The new test must not depend on the working directory (plan 022): derive every path from
  `import.meta.dir`, and pass `cwd` to every spawned process.
- Ultracite style; run `bun x ultracite fix` before finishing.

## Scope

**In scope**:

- `packages/aws/package.json` (`imports`).
- `packages/aws/src/index.ts`, `packages/aws/src/provider.ts` (create),
  `packages/aws/src/provider-runtime.ts` (create), `packages/aws/src/event-sources.ts`,
  `packages/aws/src/event-source-runtime.ts` (create), `packages/aws/src/lambda-handlers.ts`,
  the seven Event Source files (`sqs.ts`, `sns.ts`, `eventbridge.ts`, `schedule.ts`,
  `kinesis.ts`, `dynamodb-stream.ts`, `s3.ts`) for the adapter split only.
- `packages/aws/test/provider-runtime.test.ts` (create) and existing tests in
  `packages/aws/test` that use the adapter shape.
- `packages/build/src/index.ts`, `packages/build/test/build.test.ts`, `packages/build/README.md`
  if it shows the command.
- `packages/core/test/build-cli.test.ts` and any other test that pins the build command
  (`grep -rn '"--format"' packages/*/test`).
- `examples/hello-api/test/bundle.test.ts` (create).
- Docs: `apps/docs/content/docs/reference/cli.mdx`, `reference/config.mdx`, `concepts.mdx`,
  `guides/plugins.mdx`. `CONTEXT.md`. One new ADR in `docs/adr/`.
- `.factory/plans/README.md` (status only, unless the coordinator owns it).

**Out of scope**:

- Per-Function bundles (`roadmap-v2.md` phase 6). See Maintenance notes for what is left.
- `packages/core/src/**`. Core's own run-time surplus (the dev banner and `package.json` import
  at `invoke.ts:3`, `remote.ts`, `loadVokeConfig`) is small and plans 023, 024 and 031 are
  editing those files.
- `@voke/openapi`'s command code in the bundle; `@voke/idempotency`.
- Moving the resource builders out of `cloudformation-synthesis.ts` (plans 027–029 edit it).
- `build.minify`, `build.sourcemap` or any new config or CLI flag.
- The package `exports` maps and what the packages ship (plan 034).
- Durable version retention (`durable-synthesis.ts:136-141`).

## Git workflow

- Branch: `feature/runtime-only-lambda-bundle`, stacked on the previous plan's branch
  (`origin/main` stops at PR #52; this round is planned against `feature/docs-revamp`).
- Commit subjects are imperative sentences that state the outcome, for example
  "Keep deploy-time code out of the Lambda bundle". Commit only if the task authorizes it. Do
  not push or open a PR unless told.

## Steps

### Step 1: Write the failing bundle test

Create `examples/hello-api/test/bundle.test.ts`. Model the build on
`packages/core/test/node-runtime.test.ts:86-117` (it runs the AWS Provider's plan exactly as
`voke build` does):

- `beforeAll`: `const directory = join(import.meta.dir, "..")`; `outdir` from
  `mkdtemp(join(tmpdir(), "voke-bundle-"))`; import the config (`../voke.config`) and the
  Gateway (`../src/index`, default export); call
  `config.provider.build.plan({ build: { ...config.build, outdir }, config, configPath: "voke.config.ts", entrypoint: config.entrypoint, functions: gateway.functions })`;
  write `plan.sources` relative to `directory`; spawn
  `[...plan.command, `--metafile=${join(outdir, "meta.json")}`]` with `cwd: directory` and
  fail with the bundler's stderr on a non-zero exit. `afterAll` removes `outdir` only (leave
  `.voke/`: it is git-ignored and may hold `voke local` outputs).
- Test "holds no deploy-time module": read the metafile (`outputs[<file>].inputs[<path>].bytesInOutput`,
  the esbuild shape). For each suffix below, every input whose path ends with it must be absent
  or have `bytesInOutput === 0`:
  `packages/aws/src/` + `provider.ts`, `build.ts`, `deploy.ts`, `deploy-clients.ts`, `zip.ts`,
  `local.ts`, `local-aws-emulator.ts`, `local-provider.ts`, `diagnostics.ts`,
  `durable-synthesis.ts`, `event-sources.ts`, `testing.ts`; `packages/build/src/index.ts`;
  `packages/core/src/` + `cli.ts`, `cli-spec.ts`, `dev.ts`, `doctor.ts`, `model.ts`,
  `project.ts`, `scaffold.ts`, `serverless-migration.ts`.
  Also assert the metafile lists at least one input ending in
  `packages/aws/src/lambda-handlers.ts` with bytes, so a changed path format cannot make the
  test pass vacuously.
- Test "holds no deploy-time code": the text of `index.js` contains none of
  `AWSTemplateFormatVersion`, `AWS::Lambda::Function`, `AWS::IAM::Role`,
  `AWS::Lambda::EventSourceMapping`, `@aws-sdk/client-cloudformation`, `@aws-sdk/client-s3`,
  `node:zlib`, `node:child_process`, `voke-manifest.json`.
- Test "keeps function names": the text contains `createLambdaHandlers`.
- Test "stays within the size budget": `const maxBundleBytes = 170_000;` and
  `expect(size).toBeLessThanOrEqual(maxBundleBytes)`. Step 5 tightens the number.

**Evidence**: `cd examples/hello-api && bun test test/bundle.test.ts` fails on the module test,
the text test and the budget (279 KB), and passes "keeps function names".

### Step 2: Give `aws()` a run-time definition behind `#provider`

- `packages/aws/src/provider-runtime.ts` (create, run-time module): the `AwsProviderOptions`
  interface moved from `index.ts:246-254` (its imports are type-only);
  `awsRuntimeCapabilities()` returning `{ invoke: createAwsInvokeCapability(), name: "aws", runtime: { routeAuth: awsRouteAuth, variables: () => [createAwsRuntimeVariableProvider()] } }`;
  and `export const aws = (_options: AwsProviderOptions = {}): VokeProvider => awsRuntimeCapabilities();`
  with a doc comment saying it is `aws()` as a deployed Function sees it.
- `packages/aws/src/provider.ts` (create): `validateAwsModel`, `localStackBindings` and the full
  `aws()` moved from `index.ts:193-324` unchanged, except that the returned object starts with
  `...awsRuntimeCapabilities()` instead of repeating `invoke`, `name` and `runtime`. Re-export
  the type: `export type { AwsProviderOptions } from "./provider-runtime";`.
- `packages/aws/src/index.ts`: remove the moved code and the imports only it used; add
  `export { aws, type AwsProviderOptions } from "#provider";`. The file is now export lists only.
- `packages/aws/package.json`: add the `imports` block of decision 1.
- `packages/aws/test/provider-runtime.test.ts` (create): the run-time `aws()` has exactly the
  keys `invoke`, `name`, `runtime`; it accepts `{ lambda, local }` options without reading them
  (an invalid `lambda.runtime` does not throw); the full `aws()` (imported from `../src/index`)
  has the same `name` and the same `runtime.routeAuth` function, plus `build`, `deploy`,
  `diagnostics`, `local`, `synthesis` and `validate`.

**Verify before coding** (each takes one command): after adding the `imports` block and the two
files, `cd packages/aws && bun run typecheck` resolves `#provider`; `cd packages/core && bun test test/public-surface.test.ts`
still finds `aws` in `@voke/aws` (it resolves through tsconfig `paths`); `bun run check` accepts
the `#provider` specifier; `cd apps/docs && bun run check:samples` still compiles samples that
call `aws()`. If one of them cannot resolve `#provider`, see the STOP conditions.

**Evidence**: `cd packages/aws && bun test` passes. The bundle test does not pass yet (the
build does not set the condition).

### Step 3: Build with the condition and minification

In `packages/build/src/index.ts`, extend the command after `"--format", "esm"`:
`"--conditions", "voke-runtime", "--minify-whitespace", "--minify-syntax"`. Name the condition
in an exported constant (`runtimeCondition = "voke-runtime"`) with a doc comment that points at
the ADR. Update the doc comment of `createBuildPlan`.

Test first: change the expected command in `packages/build/test/build.test.ts:30-41` and
`packages/core/test/build-cli.test.ts:57-72`, and any other pin
`grep -rn '"--format"' packages/*/test` finds, then make them pass.

**Evidence**: `cd packages/build && bun test`; `cd packages/core && bun test test/build-cli.test.ts test/node-runtime.test.ts`
(the fixture bundle still serves routes and the SQS handler under real Node, now minified and
built with the condition). In `examples/hello-api`, the bundle test's module assertions pass
except `event-sources.ts`, and the text assertions still fail on `AWS::IAM::Role` and
`AWS::Lambda::EventSourceMapping`.

### Step 4: Split the Event Source adapters

- `packages/aws/src/event-source-runtime.ts` (create, run-time module):
  ```ts
  export interface AwsEventSourceRuntimeAdapter {
    readonly source: string;
    /** AWS Lambda event → the Function's Event Invocation input. */
    toInvocation(event: unknown): unknown;
    /** The handler's result → the value the Lambda handler returns. */
    toResponse(result: unknown): unknown;
  }
  ```
  plus the table of the seven run-time adapters and `requireAwsEventSourceRuntimeAdapter(source, functionKey)`,
  which throws the same `VokeConfigError` as today. Move `unsupportedEventSourceMessage` here
  and import it from `event-sources.ts`, so the message has one definition.
- In each of the seven Event Source files, export a second object, for example
  `sqsEventRuntimeAdapter: AwsEventSourceRuntimeAdapter`, holding `source`, `toInvocation` and
  `toResponse`, and remove those two methods from the existing `...EventSourceAdapter` object.
- `packages/aws/src/event-sources.ts`: remove `toInvocation` and `toResponse` from
  `AwsEventSourceAdapter`; the table and the two lookup functions stay for synthesis and
  validation. This file is now deploy-time only (it is on Step 1's list).
- `packages/aws/src/lambda-handlers.ts:244`: use `requireAwsEventSourceRuntimeAdapter`.
- Add one test in `packages/aws/test/event-sources.test.ts`: the run-time table and the deploy
  table have the same `source` keys, so a new Event Source cannot be added to one only.
- If plans 027–029 added adapter methods, each is deploy-time unless `lambda-handlers.ts` calls it.

**Evidence**: `cd packages/aws && bun test`; `cd examples/hello-api && bun test test/bundle.test.ts`
passes all four tests. If a marker is still present, build once without the two minify flags
(run the plan's command by hand with them removed) and read the `// <module path>` comment above
the match to find the module that keeps it.

### Step 5: Set the budget and record the numbers

Read the bundle size the test measures. Set `maxBundleBytes` to that size rounded up to the next
5,000, plus 5,000, and say in a comment next to it what it guards and how to raise it ("raise
only after checking the metafile for a deploy-time module"). The planner's estimate is 135–146 KB.
If the measured size is above 165,000 bytes, list the ten largest `bytesInOutput` entries of the
metafile and confirm each is run-time code before setting the budget; report what you found.

Run `cd packages/core && bun test test/node-runtime.test.ts` once more, then the repo gates.

**Evidence**: the size before and after for `examples/hello-api`, and for one Event Source
example (`cd examples/sqs-events && bunx voke build --outdir <tmp dir>`), in the report.

### Step 6: Docs, vocabulary and the ADR

- `reference/cli.mdx:90` and `reference/config.mdx:73`: the bundle holds run-time code only; it
  is minified without renaming, so stack traces keep function names; there is no source map.
  `concepts.mdx:165`: one clause, "run-time code only".
- `guides/plugins.mdx:197-201`: rewrite the callout. A module the config imports is bundled,
  and so is a local module loaded with `await import(...)`; only `node:` built-ins and
  `build.external` modules stay out. A Plugin package keeps command-only code out by resolving
  it through the `voke-runtime` condition in its `package.json` `exports` or `imports`, as
  `@voke/aws` does for `aws()`. Show the six-line `imports` example in a `json` fence. Every
  TypeScript fence on a docs page must be ` ```ts twoslash ` (`apps/docs/test/samples.test.ts`).
- `CONTEXT.md`: add **Lambda Bundle**: "The file `voke build` writes for deployed
  **Functions**. It holds run-time code only: a package's deploy-time code is left out through
  the `voke-runtime` condition." _Avoid_: artifact, dist, deployment package. Add one
  relationship line: the **AWS Provider** gives a **Lambda Bundle** only its runtime and
  invocation **Provider Capabilities**.
- ADR with the next free number at execution time (`0018` at `1c59d39`; plans 027–029 may take
  numbers first): the `voke-runtime` condition is how a package separates run-time from
  deploy-time code; why not dynamic `import()` (the probe result above); why not a second
  package entry; minification keeps identifiers; no source maps; what a Plugin author may rely on.

## Test plan

- New: `examples/hello-api/test/bundle.test.ts` (four tests, Step 1);
  `packages/aws/test/provider-runtime.test.ts` (Step 2); one table-parity test in
  `packages/aws/test/event-sources.test.ts` (Step 4).
- Changed: the command pins in `packages/build/test/build.test.ts` and
  `packages/core/test/build-cli.test.ts`.
- Must stay green unchanged: `packages/core/test/node-runtime.test.ts` (real Node, no `Bun`
  global, routes and SQS handler), `packages/core/test/public-surface.test.ts` (the `@voke/aws`
  export list does not change), `packages/aws/test/provider.test.ts`,
  `packages/aws/test/lambda-handlers.test.ts`, `examples/hello-api/test/hello-api.test.ts`.
- The bundle test builds once in `beforeAll` (about 25 ms of bundling) and uses no network.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] `cd examples/hello-api && bun test test/bundle.test.ts` passes: no bytes from the listed
      deploy-time modules, none of the nine markers, `createLambdaHandlers` present, size within
      `maxBundleBytes`
- [ ] `maxBundleBytes` is at most 170,000, or the report explains which run-time code needs more
- [ ] `cd packages/core && bun test test/node-runtime.test.ts` passes against the minified bundle
- [ ] `grep -n "voke-runtime" packages/build/src/index.ts packages/aws/package.json` shows the
      flag and the `imports` entry
- [ ] `grep -rn "minify-identifiers\|sourcemap" packages/build/src` returns no matches
- [ ] `git diff --stat <base> -- packages/core/src` is empty
- [ ] The docs callout, the **Lambda Bundle** entry and the ADR exist;
      `cd apps/docs && bun run check:samples && bun run test && bun run lint:links` exit 0
- [ ] The report gives the bundle size before and after for `hello-api` and `sqs-events`
- [ ] `.factory/plans/README.md` row updated by its owner

## STOP conditions

- `#provider` cannot be resolved by one of: `tsgo`, the docs' Twoslash check, Ultracite, the Bun
  runtime through core's tsconfig `paths`, or `bun build --conditions` inside this workspace.
  First try the fallback in decision 1. Stop and report only if the fallback also fails, or if
  it leaves `packages/core/test/node-runtime.test.ts` building the full `aws()` and you cannot
  keep that test meaningful.
- A run-time module (anything the bundle test shows in the bundle) reads a `config.provider`
  member other than `invoke`, `name` and `runtime`. At `1c59d39` none does; plans 023–029 may
  have added one. If the member is run-time behaviour, add it to `awsRuntimeCapabilities()`; if
  it needs synthesis or the model inside a deployed Function, stop and report.
- A listed deploy-time module still contributes bytes and the only way to remove it is an edit
  in `packages/core/src` or a move of the resource builders. Report the module and the import
  chain; do not widen the scope.
- The minified bundle fails under Node in `node-runtime.test.ts` while the unminified one
  passes. Report the failing flag; do not ship one flag silently.

## Maintenance notes

- **Left for per-Function bundles** (`roadmap-v2.md` phase 6): there is still one `index.js`
  for all Functions and one `S3Key` (`cloudformation-synthesis.ts:1084`), so every Function
  loads every other Function's handlers and dependencies, the run-time adapters of all seven
  Event Sources, and every Plugin, and a change to one Function updates every Lambda. That work
  can reuse this plan's test (a budget per Function) and its condition.
- **Other surplus, not removed here**: core's dev banner and `package.json` import
  (`packages/core/src/invoke.ts:3`), `remote.ts` and `loadVokeConfig`; `@voke/openapi`'s command
  code; the resource builders and `floci()` a config calls. `voke` and the Plugin packages can
  adopt the same `voke-runtime` condition.
- **Plan 034** changes what the packages ship. If it compiles to `dist`, the `imports` entry
  must point both conditions at the compiled files, and the bundle test must still pass against
  an installed package.
- **A new Provider Capability or a new `@voke/aws` source file**: decide whether it is run time
  or deploy time. Deploy-time files go on the list in `bundle.test.ts`; run-time members go in
  `awsRuntimeCapabilities()`.
- **Debugging a production stack trace**: frames carry function names and a column. If line
  numbers are needed more than the bytes, apply the reversal of decision 5.
- **The index's "Opportunities" entry** "Lazy `aws()` capabilities (bundle size)" is closed by
  this plan, with a different mechanism; the coordinator should update it.
- Reviewers should check: `provider-runtime.ts` and `event-source-runtime.ts` import no
  deploy-time module; the full `aws()` spreads the run-time object instead of repeating it; the
  budget was set from a measurement, not copied from this plan.
