# Plan 034: The packages can be versioned, packed and installed into a fresh project, and CI proves it on every pull request

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- package.json tsconfig.json .gitignore .github/workflows packages/*/package.json packages/*/tsconfig.json packages/core/src/scaffold.ts packages/core/src/index.ts packages/aws/src/runtime-variables.ts packages/core/test examples/*/package.json apps/docs/source.config.ts apps/docs/scripts/check-samples.ts apps/docs/content/docs README.md CONTEXT.md docs`
> and `git status --short` with the recorded current state. Plans 022–033 land first and change
> these files on purpose (see "State after the earlier plans"). Reconcile that drift; pause only
> if it invalidates a decision listed below.

## Status

- **Priority**: P1 (for a release)
- **Effort**: M
- **Risk**: MED
- **Depends on**: none hard. Ordering only, this plan runs last in its round:
  (`030-runtime-only-lambda-bundle.md`: it adds the `#provider` `imports` entry that step 3 must
  extend), (`031-single-remote-implementation.md`: it removes `hono` and `@voke/http` from
  `@voke/remote`), (`025-migrator-lossless-reports.md`: it makes the migrator reuse
  `projectPackageJson` from `scaffold.ts`), (`026-cli-argument-and-cwd-correctness.md`: it edits
  `cli.ts` and `cli.mdx`), (`022-root-test-run.md`: root `bun test` passes).
- **Category**: direction / dx
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

Every package is at version `0.0.0`, nothing has been published, and no test installs the
packages outside this monorepo. A Voke Project created by `voke create` depends on `^0.0.0`
packages that do not exist on a registry, on `@types/bun: "latest"` and on a floating TypeScript
nightly. The packages ship raw TypeScript, so a project with stricter compiler flags than the
Project Starter gets dozens of type errors inside Voke's own files (44 with
`exactOptionalPropertyTypes`, 136 with `noPropertyAccessFromIndexSignature`), and `skipLibCheck`
does not help because it only covers `.d.ts` files. There is no release procedure and no
changelog.

After this plan, a pull request cannot merge unless the nine packages pack, install into a fresh
project from the tarballs, type-check under the Project Starter's tsconfig and under a stricter
one, pass the starter test and build a Lambda bundle. A release is one documented procedure that
ends at a verified set of tarballs. Publishing stays the owner's action.

## Current state

### Architecture rules (binding)

- `docs/adr/0007-opinionated-framework.md`: "The supported path is: Bun as the toolchain (pinned
  in `packageManager`), TypeScript, … a single ESM bundle built for the Lambda Node.js runtime".
  "Teams that need a Node-only toolchain … are outside the supported path". "Because the package
  is unreleased, removals happen without deprecation aliases".
  Consequence: the CLI and the packages only have to work under Bun. The Lambda bundle runs on
  Node.
- `docs/adr/0007-specialized-provider-and-helper-packages.md`: `voke` (core) is provider-neutral
  and must not import `@voke/*`; `@voke/aws` "depends on public `voke`".
- `.factory/plans/README.md`, "Defaults the plans adopted": "lockstep package versions". "Still
  open": "Package name and npm scope (`voke` + six `@voke/*` packages; neither was checked)" and
  "Authorize a real-AWS smoke deploy and provide credentials … Not run without explicit
  approval" (plans 004 and 018). There are eight `@voke/*` packages today.
- Vocabulary (`CONTEXT.md`): **Voke Project**, **Project Starter** (the files `voke create`
  writes; _avoid_ "scaffold", "boilerplate", "generated app"), **Provider**, **Plugin**,
  **Function**, **Gateway**. Use these in docs, comments and messages. `scaffold.ts` is a file
  name and stays.

### Code at `1c59d39`

Nine published packages, all `"version": "0.0.0"`: `packages/core` (`voke`), `aws`, `build`,
`http`, `idempotency`, `openapi`, `remote`, `schema`, `testing` (`@voke/<dir>`).

- **Entry points are TypeScript source.** `packages/core/package.json:20-32`:
  ```json
  "bin": { "voke": "./src/cli.ts" },
  "files": ["src", "README.md", "LICENSE"],
  "type": "module",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  ```
  `packages/core/src/cli.ts:1` is `#!/usr/bin/env bun` and git tracks the file as `100755`.
  `@voke/aws` exports `.`, `./cloudformation`, `./local`, `./testing`
  (`packages/aws/package.json:25-30`). The other seven export `.` only.
- **`build` emits a `dist` nothing uses.** Every package has
  `"build": "bun build ./src/index.ts --outdir ./dist --target bun"` (core adds `./src/cli.ts`),
  and `files` does not list `dist`. `prepack` copies `LICENSE` (core also the root `README.md`)
  into the package directory and `postpack` deletes them
  (`packages/core/package.json:38-39`).
- **Dependencies.**
  - `packages/aws/package.json:49,57`: `hono` is in `dependencies` and in `peerDependencies`.
    `packages/remote/package.json:37`: plain dependency. `packages/core/package.json:44,48`:
    peer and dev dependency. Real imports: core (`app.ts:1-3`, `invoke.ts:1`, …), `@voke/aws`
    (`lambda.ts:1`, `hono/aws-lambda`), `@voke/remote` (`index.ts:6`, type only).
  - `voke` is `"workspace:*"` in `dependencies` of `aws`, `build`, `idempotency`, `openapi`,
    `remote`, `schema`, `testing`. `@voke/aws` checks `error instanceof InvokeError`
    (`packages/aws/src/event-payload.ts:61`, `stream-batch.ts:165`) and
    `instanceof VokeDeployError` (`diagnostics.ts:140`), and core keeps module-level state
    (`packages/core/src/invoke.ts:845-849`, two `WeakMap`s of activated registries;
    `plugin.ts:254`). A second installed copy of core breaks both.
  - `"@types/bun": "latest"` is in the root manifest, all nine packages and all seven examples.
    The root also has `"turbo": "latest"` (`package.json:30`). `bun.lock` resolves `turbo` to
    `2.9.14` and `@types/bun` to `1.4.4` for the packages (`1.3.14` for the root).
  - The root `catalog` holds one entry (`package.json:34-36`):
    `"@typescript/native-preview": "^7.0.0-dev.20260516.1"`.
- **The Project Starter**, `packages/core/src/scaffold.ts`:
  ```ts
  // :4
  import packageJson from "../package.json";
  // :28-31
  // Every Voke package moves in lockstep, so the starter pins all of them to the CLI's own version.
  const vokeDependencies = ["@voke/aws", "@voke/testing", "voke"] as const;
  // Matches the root package.json catalog entry.
  const typescriptNativePreviewVersion = "^7.0.0-dev.20260516.1";
  // :135-146
  vokeDependencies.map((dependency) => [dependency, `^${packageJson.version}`])
  …
  hono: "^4.0.0",
  devDependencies: { "@types/bun": "latest", "@typescript/native-preview": typescriptNativePreviewVersion },
  ```
  The starter tsconfig (`scaffold.ts:116-131`) is `module: "Preserve"`,
  `moduleResolution: "bundler"`, `strict`, `skipLibCheck`, `types: ["bun"]`.
- **Tests that hardcode the version**: `packages/core/test/api.test.ts:307-312` (`"^0.0.0"` three
  times), `packages/core/test/cli-contract.test.ts:71` (`"Voke v0.0.0"`), `:202`
  (`"voke 0.0.0"`), `:430` (`["^0.0.0", "^0.0.0", "^0.0.0"]`),
  `packages/core/test/route-builder.test.ts:357` (`v0.0.0` in the dev banner). Docs:
  `apps/docs/content/docs/reference/cli.mdx:13,42`, `reference/packages.mdx:10`.
- **How users are told to start**: `README.md:12` and
  `apps/docs/content/docs/getting-started.mdx:22` both say `voke create my-api`, with no step
  that provides a `voke` binary. `CONTEXT.md:12,656` still says `voke create api`; the real
  usage is `voke create <name> [directory]` (`packages/core/src/cli-spec.ts:78`).
- **CI**, `.github/workflows/ci.yml`: one job (`bun install --frozen-lockfile`, `bun run check`,
  `bun run typecheck`, `bun run test`). No other workflow. No `CHANGELOG.md`. The root script
  `"release:check": "bun run typecheck && bun test"` (`package.json:16`) is the only release
  tooling.
- **`docs/reviews/public-api-release-gate.md`** (dated 2026-05-24) says the root package exports
  six names and that `voke create api` generates the starter. Both are false now: the pinned
  root surface has more than twenty runtime names
  (`packages/core/test/public-surface.test.ts:93-127`) and the command is `voke create <name>`.
  Nothing links to the file.
- **Type resolution inside the repo**: every `tsconfig.json` extends the root one
  (`moduleResolution: "bundler"`, `noEmit`). `packages/core/tsconfig.json` maps `@voke/*` to
  sibling sources with `paths` for its tests. The docs compile their samples with Twoslash,
  with compiler options set in two places: `apps/docs/source.config.ts:26` and
  `apps/docs/scripts/check-samples.ts:16-22`.
- `packages/core/test/public-surface.test.ts:192-194` asserts
  `Object.keys(packageJson.exports)` equals `["."]`. It reads keys only, so changing the value
  to a conditions object keeps it green.

### What the planner measured (Bun 1.4.4, macOS, all in a scratch directory)

- `bun pm pack --destination <dir>` works in each package and leaves `git status` clean. In the
  tarball, `workspace:*` becomes the exact version (`"voke": "0.0.0"`), `catalog:` becomes the
  catalog range, and `"@types/bun": "latest"` stays as written. `src/cli.ts` keeps mode `755`.
  The same rewrite applies to `peerDependencies` (checked in a synthetic workspace). A `dist`
  directory listed in `files` is packed even though the root `.gitignore` ignores `dist`.
- A project made by the packed CLI (`node_modules/.bin/voke create … --no-install`, with only
  the `voke` tarball and its `hono` peer installed) installs from the tarballs when its
  `package.json` gets an `overrides` block that maps each of the nine names to
  `file:<absolute tarball path>`. The starter's own `^0.0.0` ranges stay untouched, one copy of
  `voke` is installed, and `bun install --offline` succeeds, so no registry lookup happens for
  Voke's names.
- With today's tarballs that project type-checks (0 errors), passes `bun test`, and
  `bun run build` writes a 244.5 KB `dist/index.js` that Node 24 imports. So installing works
  today; what is missing is the proof, the strictness and the versions.
- Type errors in that project, by tsconfig (starter tsconfig plus the change shown):

  | Change to the starter tsconfig                  | Source-only tarballs (today) | Tarballs with declarations (this plan)     |
  | ----------------------------------------------- | ---------------------------- | ------------------------------------------ |
  | none                                            | 0                            | 0                                          |
  | `exactOptionalPropertyTypes`                    | 44, all inside Voke          | 0                                          |
  | `noPropertyAccessFromIndexSignature`            | 136, all inside Voke         | 0                                          |
  | `target` and `lib` `ES2022`                     | 27, all inside Voke          | 0                                          |
  | `lib: ["ESNext"]` (no DOM)                      | 2, inside `@voke/testing`    | 0                                          |
  | eight strict flags together (step 6 lists them) | not measured                 | 0                                          |
  | `types: []`                                     | 52 (51 inside Voke)          | 1, the starter's own `bun:test` import     |
  | `module`/`moduleResolution` `nodenext`          | 59 (56 inside Voke)          | 3, the starter's own extensionless imports |

  With declarations, `tsgo --listFiles` showed 47 files under `node_modules/{voke,@voke/*}/dist`
  and none under their `src`.

- `bunx tsgo` (the pinned `@typescript/native-preview`) emits declarations:
  `--declaration --emitDeclarationOnly` over each package's `src` took about one second per
  package and produced 35 files for core and 37 for `@voke/aws`. Two errors, both in
  `packages/aws/src/runtime-variables.ts:66,78`: `TS2883: The inferred type of 'secret'
[and 'parameter'] cannot be named without a reference to 'RuntimeVariableDescriptor' from
'../node_modules/voke/src/variables'`. `RuntimeVariableDescriptor`
  (`packages/core/src/variables.ts:14`) is not exported from `packages/core/src/index.ts`.
  `@voke/idempotency` reported `TS2307` for `@aws-sdk/client-dynamodb`, which looked like the
  install state of the planner's checkout; verify before coding.
- A synthetic workspace confirmed the resolution design of decision 1: with
  `customConditions: ["<name>"]` `tsgo` resolves a package's `exports` and `imports` to source;
  without it, to the `types` target; the Bun runtime takes `default`; and
  `bun build --conditions <runtime condition>` still selects the run-time `imports` target.
- The scaffold's `^7.0.0-dev.20260516.1` resolved to `7.0.0-dev.20260707.2` in the fresh
  project: a caret on a nightly floats.

### State after the earlier plans

- **030** adds to `packages/aws/package.json`
  `"imports": { "#provider": { "voke-runtime": "./src/provider-runtime.ts", "default": "./src/provider.ts" } }`,
  makes `packages/aws/src/index.ts` re-export `aws` from `"#provider"`, and makes `voke build`
  pass `--conditions voke-runtime`. It also adds a bundle test with a list of deploy-time files
  (`packages/aws/test/bundle.test.ts`). Step 3 extends that `imports` entry.
- **031** leaves `@voke/remote` with one runtime export (`createRemoteFunctions`), moves the
  artifact types to root type exports of `voke`, and removes `@voke/http` and `hono` from
  `packages/remote/package.json`.
- **025** exports `projectPackageJson` and `tsconfig` from `scaffold.ts` and makes the migrator
  call them, so the migrator's `workspace:*` and `latest` values
  (`packages/core/src/serverless-migration.ts:2194-2216` at `1c59d39`) disappear with step 4.
- If one of these has not landed, apply this plan's rule to what is there (for example, treat
  `hono` in `@voke/remote` as in decision 5) and do not do the other plan's work.

### Findings checked and dropped

- "`apps/docs/package.json` depends on `latest`": false at `1c59d39`; every range there is a
  caret. `latest` remains only where listed above.
- "135 errors with `bundler` and no Bun types": not reproduced. The planner measured 52 with
  `types: []` against the Project Starter. The 60 (`nodenext`) and 44
  (`exactOptionalPropertyTypes`) figures reproduced as 59 and 44.
- "`import("voke")` fails on Node 24": not run. It follows from the extensionless imports in
  `packages/core/src/index.ts:6` and is a stated non-goal, so nothing here changes it.
- "No pack-and-install test exists": true. "Installing is broken": false, see the measurements.

## Decisions taken in this plan

1. **The packages ship TypeScript source for execution and generated declaration files for
   type checking.** Each `exports` entry becomes
   ```json
   ".": {
     "@voke/source": "./src/index.ts",
     "types": "./dist/index.d.ts",
     "default": "./src/index.ts"
   }
   ```
   with top-level `"types": "./dist/index.d.ts"` and `dist` added to `files`. A project's
   compiler reads only `.d.ts` files, so its flags stop applying to Voke's source. Bun and
   `voke build` keep loading `src`, exactly what the test suite exercises. `bin` stays
   `./src/cli.ts`.
   - _Emitter_: `bunx tsgo --project tsconfig.build.json` (declaration only). `tsgo` is already
     the type checker; no new dependency.
   - _Inside the repo_ the root tsconfig sets `"customConditions": ["@voke/source"]`, so
     packages, examples and docs keep resolving each other's source with no build step.
   - _Rejected: compiled JavaScript._ Bun runs TypeScript and Node-only toolchains are a
     non-goal, so compiled output buys nothing. `bun build` per entry point would also give
     core's `index` and `cli` separate copies of shared modules and their state, and `bin` would
     run code no test covers.
   - _Cost_: a one-second build per package before packing; one custom condition in three
     config files; an exported value whose inferred type names an unexported type is now a
     build error (two today).
   - _Supported project settings_: `moduleResolution: "bundler"`. `nodenext` is the Node
     toolchain and stays unsupported.
   - _Reverse_: restore the string `exports`, drop `dist` from `files` and the build scripts.
     To move to compiled JavaScript later, repoint `default`; the `exports` keys do not change.
2. **`#provider` (plan 030) gets the same two conditions**, in this order:
   `"voke-runtime"`, `"@voke/source"`, `"types": "./dist/provider.d.ts"`, `"default"`. Without
   `types`, a project's compiler would follow `#provider` from `dist/index.d.ts` into
   `src/provider.ts` and type-check Voke's deploy code again. _Reverse_: remove the two keys.
3. **Versions: lockstep, set by a repository script; a hand-written `CHANGELOG.md`; no
   Changesets.** `bun scripts/release.ts version <x.y.z>` writes one version into the nine
   manifests. Internal ranges stay `workspace:*`; `bun pm pack` rewrites them to the exact
   version (measured), so a published `@voke/aws@0.1.0` requires `voke@0.1.0`. Changesets adds
   per-change files and its publish step runs `npm publish`, which does not rewrite
   `workspace:*`. _Cost_: the changelog is written by hand. _Reverse_: add `@changesets/cli`
   with a `fixed` group over the nine packages and delete the `version` command.
4. **The first version is `0.1.0`.** `0.x` says the API can still change, which it does (ADR
   0007 removes names without aliases). A caret on `0.1.0` accepts patch releases only, so the
   Project Starter's `^0.1.0` never picks up a `0.2.0` with breaking changes. This plan commits
   the bump: the tree holds the next version to publish. _Reverse_: run the `version` command
   with another number before the first publish.
5. **One place for each shared dependency.**
   - `hono` is a `peerDependency` (`^4.0.0`) of every package whose `src` imports it (`voke`,
     `@voke/aws`) and a `devDependency` there. It is in no `dependencies` block. The Gateway's
     escape hatch is Hono middleware, so the project and Voke must share one copy.
   - `voke` is a `peerDependency` (`workspace:*`, packed as the exact version) and a
     `devDependency` of every `@voke/*` package that imports it; `@voke/aws` is the same for
     `@voke/idempotency`. Rule: a package the project also imports directly is a peer. Helper
     packages (`@voke/build` and `@voke/http` inside `@voke/aws`) stay `dependencies`. A
     mismatch then produces a peer warning instead of a silent second copy of core.
   - No `latest`: `@types/bun` and `turbo` get caret ranges through the root `catalog`.
   - _Cost_: a project that updates one Voke package and not the others sees peer warnings
     until it updates all of them. _Reverse_: move the entries back to `dependencies`, or relax
     the peer range with `workspace:^`.
6. **`voke create` writes the version of the CLI that runs it** (unchanged: `^${version}` from
   core's `package.json`), plus `"@types/bun": "^1.4.4"` and an exact
   `"@typescript/native-preview"` pin equal to the root catalog entry without its caret. A test
   ties both constants to the root catalog. _Reverse_: edit the two constants.
7. **Users get the binary with `bunx voke create my-api`.** The docs say so. Inside a project
   the scripts use the local `voke`. `bun create voke` needs a tenth package (`create-voke`) and
   another name to reserve; deferred.
8. **The smoke test is a script, `scripts/pack-smoke.ts`, run by a second CI job on every pull
   request** and by `bun run smoke:pack`. It needs the network for third-party packages and
   takes tens of seconds, so it is not a `bun test` file (`AGENTS.md`: tests avoid real network
   calls). Its pure helpers are unit-tested in `scripts/release.test.ts`.
9. **No publish workflow.** The release procedure is `docs/releasing.md`: gates, version,
   checks, `bun scripts/release.ts pack` (the dry run), then the owner's own `bun publish` per
   tarball. No registry token is stored anywhere. _Reverse_: add a tag-triggered workflow with
   npm trusted publishing later.
10. **`docs/reviews/public-api-release-gate.md` is deleted.** It is a dated review whose facts
    are false now; the live inventory is `docs/stable-public-surface.md` with
    `packages/core/test/public-surface.test.ts`, and the release gates move to
    `docs/releasing.md`. _Reverse_: `git revert`.
11. **An ADR records decisions 1, 3, 4 and 5**, because the shape of a published package is
    hard to change after the first release.

## Commands you will need

| Purpose               | Command                                                        | Expected on success                   |
| --------------------- | -------------------------------------------------------------- | ------------------------------------- |
| Install               | `bun install`                                                  | exit 0; `bun.lock` updated            |
| Lint and format       | `bun run check` (fix with `bun x ultracite fix`)               | exit 0                                |
| Typecheck             | `bun run typecheck`                                            | exit 0                                |
| Tests (what CI runs)  | `bun run test`                                                 | all tasks green                       |
| Release tooling tests | `bun test ./scripts`                                           | all pass                              |
| One package           | `cd packages/<pkg> && bun test [file]` / `bun run typecheck`   | pass                                  |
| Declarations          | `cd packages/<pkg> && bun run build`                           | `dist/**/*.d.ts`, exit 0              |
| Pack one package      | `cd packages/<pkg> && bun pm pack --destination <dir> --quiet` | prints the tarball path               |
| Smoke test            | `bun run smoke:pack`                                           | exit 0, last line `pack smoke: ok`    |
| Docs samples          | `cd apps/docs && bun run check:samples`                        | `0 failed`                            |
| Release dry run       | `bun scripts/release.ts pack`                                  | nine verified tarballs in `.release/` |

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`): step 1 writes the failing tests; later steps make them pass.
- Bun APIs in scripts: `Bun.file`, `Bun.write`, `Bun.$`, `Bun.spawn`. No new dependency.
  `apps/docs/scripts/check-samples.ts` is the exemplar for a repository script (top-level await,
  `console.log` for the result line, `process.exitCode`).
- Never run `bun publish` without `--dry-run`, `npm login`, `npm publish`, or any AWS command.
  Never query a registry for the names `voke` or `@voke/*`; that check is the owner's gate.
- `bun pm pack` runs `prepack`/`postpack`, which copy and delete `LICENSE` (and core's
  `README.md`) inside the package directory. After any pack, `git status --short` must not show
  those files; the scripts remove them in a `finally` block as well.
- No runtime export changes. A new **type** export from `voke` is allowed when declaration emit
  needs it; `public-surface.test.ts` pins runtime names only, so it does not change. If a
  runtime export has to change, stop.
- One spelling per thing (ADR 0007): one custom condition name, `@voke/source`, exported as a
  constant from `scripts/release.ts` for the tests.

## Scope

**In scope**:

- `package.json`, `tsconfig.json`, `.gitignore`, `bun.lock`, `.github/workflows/ci.yml`
- `packages/*/package.json`; `packages/*/tsconfig.build.json` (create, nine files)
- `packages/core/src/scaffold.ts`, `packages/core/src/index.ts` (a type export, if needed),
  `packages/aws/src/runtime-variables.ts` (a type annotation, if needed), and any other `src`
  file only to add a type annotation that declaration emit demands
- `packages/core/test/api.test.ts`, `cli-contract.test.ts`, `route-builder.test.ts` (version
  literals and starter dependency assertions only)
- `examples/*/package.json` (`@types/bun` range only)
- `scripts/release.ts`, `scripts/pack-smoke.ts`, `scripts/release.test.ts` (create)
- `apps/docs/source.config.ts`, `apps/docs/scripts/check-samples.ts` (the custom condition)
- `README.md`, `packages/*/README.md` (install line only, if wrong),
  `apps/docs/content/docs/getting-started.mdx`, `reference/packages.mdx`, `reference/cli.mdx`
- `CHANGELOG.md`, `docs/releasing.md`, `docs/adr/00NN-published-package-shape.md` (create)
- `docs/reviews/public-api-release-gate.md` (delete), `docs/stable-public-surface.md` (one
  line), `CONTEXT.md` (lines 12 and 656)

**Out of scope**:

- Publishing, registry accounts, the name check, the real-AWS smoke deploy: owner gates, named
  in `docs/releasing.md` and not performed.
- Renaming packages. If the names turn out to be taken, that is a new plan.
- `turbo.json`: `typecheck` keeps `dependsOn: ["^build"]`; it is no longer needed and harmless.
- `packages/core/tsconfig.json` `paths`, `packages/core/src/cli.ts`, the migrator
  (`serverless-migration.ts`, plan 025), the Lambda bundle contents (plan 030), `@voke/remote`'s
  source (plan 031).
- Node support for `import "voke"`, `bun create voke`, npm provenance, a hosted docs URL.
- Removing `@aws/durable-execution-sdk-js-testing` from `@voke/aws`'s `dependencies` (an owner
  decision in plan 018).

## Git workflow

- Branch `feature/publishable-packages`, stacked on the tip that holds plans 022–033.
- Commit subjects are imperative sentences that state the outcome, for example "Ship declaration
  files so a project's compiler flags stop applying to Voke's source".
- Do not push or open a pull request unless the operator asks.

## Steps

### Step 1: Write the failing tests

Create `scripts/release.test.ts` (`bun:test`). It imports helpers from `scripts/release.ts`;
create that file with the signatures below and bodies that throw, so the tests fail for the
right reason. Helpers are pure: they take parsed manifests or text and return a value.

```ts
export const sourceCondition = "@voke/source";
/** Publish order: a package comes after everything it needs. */
export const publishedPackages: readonly { directory: string; name: string }[];
export const manifestProblems: (
  manifest: PackageManifest,
  version: string
) => string[];
export const packedProblems: (
  manifest: PackageManifest,
  files: readonly string[],
  version: string
) => string[];
export const withVersion: (manifestText: string, version: string) => string;
export const changelogHasVersion: (
  changelog: string,
  version: string
) => boolean;
export const withTarballOverrides: (
  manifest: PackageManifest,
  tarballs: Readonly<Record<string, string>>
) => PackageManifest;
```

Order of `publishedPackages`: `voke`, `@voke/build`, `@voke/http`, `@voke/schema`,
`@voke/testing`, `@voke/remote`, `@voke/openapi`, `@voke/aws`, `@voke/idempotency`.

Tests, reading the real files from the repository root:

1. `publishedPackages` equals the set of `packages/*/package.json` without `"private": true`.
2. For each package, `manifestProblems(manifest, coreVersion)` is `[]`. The function reports:
   - a version that differs from core's (lockstep) or is not `x.y.z` with an optional
     prerelease suffix;
   - any dependency range equal to `latest` or `*`, in any block;
   - `hono` or `voke` in `dependencies`; a package that lists `voke` or `hono` as a peer without
     the same entry in `devDependencies`;
   - an internal peer or dependency that is not `workspace:*`;
   - an `exports` or `imports` entry that is not an object whose keys include `@voke/source`,
     `types`, `default` in that relative order, with `@voke/source === default`, both under
     `./src/`, and `types` equal to the same path under `./dist/` ending in `.d.ts`;
   - top-level `types` different from `exports["."].types`;
   - `files` other than `["src", "dist", "README.md", "LICENSE"]`;
   - missing `publishConfig.access === "public"`, `license`, `engines.bun`,
     `repository.directory`;
   - a `build` script that does not start with `rm -rf dist` or a `prepack` that does not run
     `bun run build`;
   - for `voke` only: `bin.voke !== "./src/cli.ts"`.
3. Dependency placement, asserted directly: `voke` and `@voke/aws` list `hono` as a peer; every
   package whose `src` contains `from "voke"` lists `voke` as a peer (grep the files in the
   test); `@voke/idempotency` lists `@voke/aws` as a peer.
4. No workspace manifest (root, `apps/*`, `examples/*`, `packages/*`) contains the range
   `latest`.
5. `packedProblems` with fixtures: accepts a correct packed manifest and file list; reports a
   `workspace:` or `catalog:` range, a `latest` range, an internal range that is not the exact
   version, a missing `package/LICENSE`, `package/README.md`, `package/src/index.ts` or
   `types` target, any path under `package/test/`, and any file under `package/dist/` that
   does not end in `.d.ts` or `.d.ts.map`.
6. `withVersion` changes only the `version` line (the rest is byte-identical) and throws on
   `"1.0"`, `"v1.0.0"` and `""`.
7. `changelogHasVersion("## 0.1.0\n…", "0.1.0")` is true; false for `"## 0.1.00"` and for a
   version that appears only in body text.
8. `withTarballOverrides` adds an `overrides` entry `file:<path>` for every name it is given and
   leaves `dependencies` untouched.
9. Version references in docs: `apps/docs/content/docs/reference/cli.mdx` contains
   `` `Voke v${version}` `` and `` `voke ${version}` ``, and `reference/packages.mdx` contains
   the version.
10. The Project Starter's pins: `createApiProject` into a temporary directory, then
    `devDependencies["@types/bun"]` equals the root catalog's `@types/bun` and
    `devDependencies["@typescript/native-preview"]` equals the catalog entry with a leading `^`
    removed.

Then make the existing tests version-agnostic and stricter:

- `packages/core/test/api.test.ts:307-312` and `cli-contract.test.ts:430`: build the expected
  range from `packages/core/package.json` (`` `^${version}` ``).
- `cli-contract.test.ts:71,202` and `route-builder.test.ts:357`: interpolate the same version.

**Evidence**: `bun test ./scripts` fails: the helpers throw, and tests 2–4 and 10 name the
real manifest problems once the helpers exist;
`cd packages/core && bun test test/api.test.ts test/cli-contract.test.ts test/route-builder.test.ts`
still passes.

### Step 2: Fix the dependency declarations

- Root `package.json`: add `"@types/bun": "^1.4.4"` and `"turbo": "^2.9.14"` to `catalog`
  (use the versions `bun.lock` resolves at execution time); set root `@types/bun` and `turbo`
  to `catalog:`.
- Every `packages/*/package.json` and `examples/*/package.json`: `"@types/bun": "catalog:"`.
- Apply decision 5:

  | Package             | `peerDependencies`                            | Also in `devDependencies` | Leaves `dependencies`                                                                               |
  | ------------------- | --------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
  | `voke`              | `hono: ^4.0.0` (already)                      | `hono` (already)          | —                                                                                                   |
  | `@voke/aws`         | `voke: workspace:*`, `hono: ^4.0.0`           | `voke`, `hono`            | `voke`, `hono`                                                                                      |
  | `@voke/build`       | `voke: workspace:*`                           | `voke`                    | `voke`                                                                                              |
  | `@voke/schema`      | `voke: workspace:*`                           | `voke`                    | `voke`                                                                                              |
  | `@voke/testing`     | `voke: workspace:*`                           | `voke`                    | `voke`                                                                                              |
  | `@voke/openapi`     | `voke: workspace:*`                           | `voke`                    | `voke`                                                                                              |
  | `@voke/remote`      | `voke: workspace:*`                           | `voke`                    | `voke` (and `hono`, `@voke/http` if plan 031 has not removed them and `src` no longer imports them) |
  | `@voke/idempotency` | `voke: workspace:*`, `@voke/aws: workspace:*` | `voke`, `@voke/aws`       | `voke`, `@voke/aws`                                                                                 |
  | `@voke/http`        | none                                          | —                         | —                                                                                                   |

  If `@voke/remote` still imports `hono` at execution time, it gets the `hono` peer too.

- Add `"publishConfig": { "access": "public" }` to all nine.
- Run `bun install`. The workspace must still link (`packages/aws/node_modules/voke` resolves).

**Evidence**: `bun run typecheck` and `bun run test` exit 0; tests 3 and 4 of step 1 pass.

### Step 3: Emit declarations and switch `exports` to conditions

1. Root `tsconfig.json`: add `"customConditions": ["@voke/source"]` under "Bundler mode".
2. Each package gets `tsconfig.build.json`:
   ```json
   {
     "extends": "./tsconfig.json",
     "include": ["src/**/*.ts"],
     "compilerOptions": {
       "noEmit": false,
       "declaration": true,
       "declarationMap": true,
       "emitDeclarationOnly": true,
       "rootDir": "./src",
       "outDir": "./dist"
     }
   }
   ```
   `declarationMap` lets an editor jump from a declaration to the shipped `src` file. If `tsgo`
   rejects the option, drop it and the `.d.ts.map` allowance in `packedProblems`.
3. Each package's scripts: `"build": "rm -rf dist && bunx tsgo --project tsconfig.build.json"`
   and `"prepack": "bun run build && cp ../../LICENSE ."` (core keeps copying `../../README.md`
   too). `rm -rf dist` matters: an old `dist/index.js` from the previous build script would
   otherwise be packed.
4. Each package's manifest: `files` becomes `["src", "dist", "README.md", "LICENSE"]`,
   top-level `types` becomes `./dist/index.d.ts`, and every `exports` entry takes the shape of
   decision 1. `@voke/aws` has four: `.` → `index`, `./cloudformation`, `./local`, `./testing`.
   Its `#provider` entry (plan 030) takes the shape of decision 2.
5. Fix what declaration emit reports. Known: `secret` and `parameter` in
   `packages/aws/src/runtime-variables.ts`. Preferred fix: add `type RuntimeVariableDescriptor`
   to the `./variables` export list in `packages/core/src/index.ts`, because it is the return
   type of the public `createVariableSource`. If the error remains, annotate the two constants
   with an explicit type built from exported names. Treat any other `TS2883`/`TS4023` the same
   way: export the named type from the package that owns it, or annotate.
6. `apps/docs/source.config.ts:26` and `apps/docs/scripts/check-samples.ts:16-22`: add
   `customConditions: ["@voke/source"]` to the Twoslash `compilerOptions`, so samples keep
   compiling against workspace source without a build.

**Verify before coding** (one command each, after the edits):
`cd packages/aws && bun run typecheck` and `bun run build`;
`cd apps/docs && bun run check:samples`;
`cd packages/core && bun test test/public-surface.test.ts test/node-runtime.test.ts`;
plan 030's bundle test (`cd packages/aws && bun test test/bundle.test.ts`, if present).
If Twoslash ignores `customConditions`, remove the option from the two docs files and rely on
built declarations: Turbo already builds dependencies before the docs `build` and `test` tasks;
say so in a comment next to the compiler options.

**Evidence**: `bun run build` writes `packages/*/dist/index.d.ts` with no `.js` file;
`bun run check`, `bun run typecheck`, `bun run test` exit 0; test 2 of step 1 passes;
`git status --short` shows no `dist`.

### Step 4: Pin what the Project Starter writes

In `packages/core/src/scaffold.ts`:

- `"@types/bun": "latest"` → a constant `bunTypesVersion = "^1.4.4"` (the catalog value).
- `typescriptNativePreviewVersion` → the catalog value without the caret
  (`"7.0.0-dev.20260516.1"` at planning time). Update the comment: the pin is exact because a
  caret on a nightly floats to newer nightlies.
- Leave `` `^${packageJson.version}` `` and the lockstep comment as they are.

If plan 025 has not landed, the migrator still has its own copy of these values
(`serverless-migration.ts:2194-2216`); leave it to plan 025.

**Evidence**: test 10 of step 1 passes; `cd packages/core && bun test test/api.test.ts
test/cli-contract.test.ts` passes.

### Step 5: Add the release script, the changelog and the first version

`scripts/release.ts` implements the helpers of step 1 and, under `if (import.meta.main)`, two
commands:

- `version <x.y.z>`: validate the version; require `changelogHasVersion(CHANGELOG.md, version)`
  (otherwise exit 1 with `Add a "## <version>" section to CHANGELOG.md first.`); rewrite the
  nine manifests with `withVersion`; replace the previous version with the new one in the three
  doc lines of test 9; run `bun install` so `bun.lock` records the new workspace versions
  (CI installs with `--frozen-lockfile`); print the files changed.
- `pack [--out <dir>]` (default `.release/<version>`): empty the directory; for each entry of
  `publishedPackages` run `manifestProblems` and then
  `bun pm pack --destination <dir> --quiet` in the package directory; list each tarball
  (`tar -tzf`) and read its `package/package.json` (`tar -xzOf`); run `packedProblems`; in a
  `finally` block remove `packages/*/LICENSE` and `packages/core/README.md`; exit 1 on any
  problem. On success print one line per tarball with its size, then the publish commands for
  the owner, in order, without running them:
  `bun publish <tarball> --access public`.

Create `CHANGELOG.md` at the root: a two-line preamble (one section per version, newest first;
every package has the same version) and `## 0.1.0` with the first release notes: the nine
packages by name, one line each, taken from their `description` fields.

Add to the root `package.json`: `"smoke:pack": "bun scripts/pack-smoke.ts"` and replace
`release:check` with
`"bun run check && bun run typecheck && bun run test && bun test ./scripts && bun run smoke:pack"`.
Add `.release` to `.gitignore`.

Then run `bun scripts/release.ts version 0.1.0` and keep the result.

**Evidence**: `bun test ./scripts` passes; `bun install --frozen-lockfile` exits 0;
`grep -c '"version": "0.1.0"' packages/*/package.json` prints `1` nine times;
`bun run test` exits 0 with no test edited for the bump.

### Step 6: Add the pack-and-install smoke test and run it in CI

`scripts/pack-smoke.ts`, in order, each failure printing the step name and exiting 1:

1. Create a temporary directory with `mkdtemp` under `os.tmpdir()`; remove it at the end unless
   `--keep` is passed.
2. Pack the nine packages into `<tmp>/tarballs` with the same code path as
   `release.ts pack` (including `packedProblems`).
3. **Launcher**: write `<tmp>/launcher/package.json` with one dependency, `voke`, as
   `file:<tarball>`; `bun install`; run `./node_modules/.bin/voke create smoke-api --no-install`
   there. This is what `bunx voke create` does, and it proves the packed CLI starts with only
   `voke` and its peers installed.
4. In `<tmp>/launcher/smoke-api`: apply `withTarballOverrides` for all nine names and add the
   six packages the starter does not list (`@voke/build`, `@voke/http`, `@voke/idempotency`,
   `@voke/openapi`, `@voke/remote`, `@voke/schema`) to `dependencies` at `` `^${version}` ``.
   `bun install`.
5. Assert one copy of core: exactly one `package.json` with `"name": "voke"` under
   `node_modules` (search to depth 4).
6. Write `src/all-packages.ts` that imports one name from every entry point and uses each once
   (`voke`, `@voke/aws`, `@voke/aws/cloudformation`, `@voke/aws/local`, `@voke/aws/testing`,
   `@voke/build`, `@voke/http`, `@voke/idempotency`, `@voke/openapi`, `@voke/remote`,
   `@voke/schema`, `@voke/testing`). Pick names from `packages/core/test/public-surface.test.ts`.
   Run `bun src/all-packages.ts` so every entry point loads under Bun.
7. `bun run typecheck` (the starter tsconfig) → exit 0.
8. Write `tsconfig.strict.json`: `extends` the starter tsconfig and adds
   `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`,
   `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals`,
   `noUnusedParameters`, `noFallthroughCasesInSwitch`. `bunx tsgo --project tsconfig.strict.json
--noEmit` → exit 0.
9. `bunx tsgo --project tsconfig.json --noEmit --listFiles`: no line matches
   `node_modules/(voke|@voke/[a-z]+)/src/`, and at least one matches the same prefix with
   `/dist/`. This is the structural guarantee behind step 8.
10. `bun test` → exit 0.
11. `bun run build` → `dist/index.js` exists. If plan 030's bundle test defines a deploy-only
    marker (a string that must not appear in a Lambda bundle), assert the same marker is absent
    here, which proves `#provider` resolves through `voke-runtime` from an installed package.
    When `Bun.which("node")` is not null, run
    `node --input-type=module -e "const m = await import('./dist/index.js'); if (typeof m.http !== 'function') process.exit(1)"`
    (`packages/core/test/node-runtime.test.ts:76` skips the same way without Node).
12. Print `pack smoke: ok`.

The script never runs `voke deploy`, `voke doctor`, `voke local` or `voke remove`: `doctor`
calls AWS to check credentials.

`.github/workflows/ci.yml`: add a second job next to `check`:

```yaml
pack-smoke:
  name: Pack, install and build a fresh project
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v7
    - uses: oven-sh/setup-bun@v2
    - name: Install dependencies
      run: bun install --frozen-lockfile
    - name: Release tooling tests
      run: bun test ./scripts
    - name: Pack and install smoke test
      run: bun run smoke:pack
```

**Evidence**: `bun run smoke:pack` prints `pack smoke: ok` and `git status --short` is
unchanged by it. To see it fail for the right reason, temporarily remove the `types` condition
from `packages/core/package.json` and rerun: step 8 or 9 must fail. Restore the file.

### Step 7: Documentation, the ADR and the stale review

- `README.md:5-15` and `apps/docs/content/docs/getting-started.mdx:8-25`: the create command is
  `bunx voke create my-api`. Keep the "not published yet" callouts and the "Try it from the
  repository" sections; they stay true until the owner publishes. `getting-started.mdx:119`
  ("Strict TypeScript settings for Bun"): add that stricter flags are fine because Voke ships
  declaration files.
- `apps/docs/content/docs/reference/packages.mdx:8-11`: the callout says the packages are not
  published yet, share one version (`0.1.0`) and are released together. Below it add a short
  "Install and versions" section: `bunx voke create my-api` for a new project;
  `bun add @voke/<name>` for another package; every `@voke/*` package needs the same version of
  `voke`, so update them together (`bun update voke @voke/aws @voke/testing`, plus any other `@voke/*`
  package the project lists); a project's tsconfig must use
  `moduleResolution: "bundler"`; the CLI and the packages run on Bun, the Lambda bundle on Node.
- `apps/docs/content/docs/reference/cli.mdx:13,42`: already rewritten by the `version` command;
  check them.
- `packages/*/README.md`: check each `bun add` line still names the right packages.
- `docs/releasing.md` (create), the single release procedure:
  1. **Gates only the owner can clear** (the procedure names them and does not perform them):
     the npm name `voke` and the scope `@voke` are available and owned by the publishing
     account (never checked; if either is taken, stop and plan a rename); the real-AWS smoke
     deploy of plan 004 (step 8) and the durable Function deploy of plan 018 (step 8) have run
     with the owner's credentials; the S3 key encoding of plan 017 / ADR 0013 is confirmed; the
     release commit is on `main` (package READMEs link to `blob/main/apps/docs/...`, and
     `origin/main` stopped at PR #52 when this was written).
  2. Write the `## <version>` section in `CHANGELOG.md`.
  3. `bun scripts/release.ts version <version>`; commit.
  4. `bun run release:check`.
  5. `bun scripts/release.ts pack`: the dry run. It ends with verified tarballs in
     `.release/<version>/` and the list of publish commands.
  6. Owner only: run the printed `bun publish <tarball> --access public` commands in order, tag
     `v<version>`, push the tag.
  7. After the first publish: remove the "not published yet" callouts (`README.md:5,9`,
     `getting-started.mdx:8-12,125-127`, `packages.mdx:8-11`).
     Also state how to recover from a partial publish: rerun the remaining commands; a published
     version cannot be replaced, so a bad release is fixed by the next patch version.
- `docs/adr/00NN-published-package-shape.md` (next free number at execution time; three files
  share `0007`): decisions 1, 3, 4 and 5 with their reasons and costs, in the style of the
  existing ADRs (a title that states the decision, three or four paragraphs).
- Delete `docs/reviews/public-api-release-gate.md`.
- `docs/stable-public-surface.md:102`: replace the guardrail line with "Releases follow
  `docs/releasing.md`; `bun run release:check` is the gate."
- `CONTEXT.md:12` and `:656`: `voke create api` → `voke create <name>`.

**Evidence**: `cd apps/docs && bun run test` passes (links and samples);
`cd packages/core && bun test test/public-surface.test.ts` passes;
`grep -rn "public-api-release-gate" --exclude-dir=node_modules --exclude-dir=.factory .`
prints nothing.

### Step 8: Rehearse the release up to the dry run

Run `bun run release:check`, then `bun scripts/release.ts pack`. Inspect one tarball by hand
(`tar -tzf .release/0.1.0/voke-0.1.0.tgz`): `package/src/cli.ts`, `package/dist/index.d.ts`,
`package/LICENSE`, `package/README.md`, no `test/`.

**Verify before coding**: whether `bun publish --dry-run <tarball>` works without registry
credentials. Try it once on `voke-http-0.1.0.tgz`. If it completes offline or anonymously, add
it to step 5 of `docs/releasing.md` as an extra check. If it asks for a login or a token, do
not provide one; leave `release.ts pack` as the dry run and say so in the document.

Report the four owner gates as open in the hand-off message.

## Test plan

- New `scripts/release.test.ts`: the ten cases of step 1. Pattern for file discovery:
  `apps/docs/test/samples.test.ts` (reads the tree with `readdir`).
- Changed: `packages/core/test/api.test.ts`, `cli-contract.test.ts`, `route-builder.test.ts`
  read the version from `packages/core/package.json`.
- Unchanged and must stay green: `packages/core/test/public-surface.test.ts` (the `exports`
  keys are still `["."]`), `packages/core/test/node-runtime.test.ts`, `apps/docs/test/*`, plan
  030's bundle test.
- Integration: `bun run smoke:pack` locally and the `pack-smoke` CI job.
- Verification: `bun run check`, `bun run typecheck`, `bun run test`, `bun test ./scripts`,
  `bun run smoke:pack` all exit 0.

## Done criteria

- [ ] `bun run release:check` exits 0 on a clean checkout after `bun install --frozen-lockfile`
- [ ] `bun run smoke:pack` prints `pack smoke: ok`; it covers create, install from tarballs,
      type-check under the starter tsconfig and the strict one, `bun test`, and `voke build`
- [ ] `.github/workflows/ci.yml` has the `pack-smoke` job and it runs on `pull_request`
- [ ] `grep -rn '"latest"' package.json packages/*/package.json examples/*/package.json apps/*/package.json packages/core/src/scaffold.ts`
      prints nothing
- [ ] No `packages/*/package.json` has `hono` or `voke` under `dependencies`
- [ ] All nine manifests are at `0.1.0`; `CHANGELOG.md` has `## 0.1.0`
- [ ] `bun scripts/release.ts pack` leaves nine tarballs in `.release/0.1.0/` and prints the
      publish commands; nothing was published
- [ ] `docs/releasing.md` exists and names the four owner gates; the ADR exists;
      `docs/reviews/public-api-release-gate.md` is gone
- [ ] `README.md` and `getting-started.mdx` create a project with `bunx voke create my-api`
- [ ] `git status --short` shows no `dist`, `.release`, `*.tgz`, `packages/*/LICENSE` or
      `packages/core/README.md`

## STOP conditions

- Anything asks for an npm login, a registry token, a publish without `--dry-run`, or AWS
  credentials. Those are the owner's actions.
- You learn that `voke` or the `@voke` scope is taken. Do not rename anything; report it.
- `tsgo` cannot emit declarations for a package for a reason other than a missing type export
  or annotation (a crash, wrong output). One fallback is allowed: add `typescript` to the root
  catalog and devDependencies and use `bunx tsc --project tsconfig.build.json`. Stop if that
  fails too.
- The `@voke/source` condition is ignored by a tool the repository needs (`tsgo`, Ultracite,
  the Next build of `apps/docs`) and the built-declarations fallback of step 3 does not fix it.
- With the conditions of decision 2 in place, the smoke test's bundle contains plan 030's
  deploy-only marker, or `packages/aws` no longer type-checks. The `imports` entry is plan
  030's contract; do not restructure it beyond adding the two keys.
- Declaration emit can only be fixed by adding, removing or renaming a **runtime** export.
- `bun install` cannot link a workspace package that is both a peer and a dev dependency
  (the planner's synthetic workspace linked fine on Bun 1.4.4).

Continue independent in-scope work when one of these blocks a step.

## Maintenance notes

- **A new package** needs: an entry in `publishedPackages` (in dependency order), a
  `tsconfig.build.json`, the manifest shape of step 3, and an import in the smoke test's
  `all-packages.ts`. `scripts/release.test.ts` fails until the first three exist.
- **A new entry point or `imports` entry** needs the three conditions; test 2 enforces it.
- **An exported value with an inferred type** can break `bun run build` with `TS2883`. Export
  the type it names or annotate the value.
- **Reviewers should check**: the conditions order in every manifest (a `types` key before
  `@voke/source` would make the repository read stale `dist` files); that `bun.lock` changed
  only for the catalog entries, the peer moves and the versions; and that the smoke script
  contains no command that reaches AWS or a registry write.
- **Seen and left alone**: with `skipLibCheck: false`, a project gets errors from
  `@aws/durable-execution-sdk-js`'s own declarations (they import `aws-lambda` types that are
  not installed). Every project also installs `@aws/durable-execution-sdk-js-testing` and its
  test-time dependencies through `@voke/aws`. Both belong to a follow-up on `@voke/aws`'s
  dependencies.
- **Deferred**: a tag-triggered publish workflow with npm trusted publishing and provenance;
  `bun create voke`; switching the Project Starter from the TypeScript nightly to a stable
  TypeScript 7 release when one exists; compiled JavaScript output (decision 1 says how).
- **Pre-release versions** (`0.2.0-rc.1`) work with the `version` command; publish them with
  `--tag next` so `bunx voke` keeps resolving the stable release.
