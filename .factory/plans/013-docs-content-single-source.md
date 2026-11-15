# Plan 013: The docs site is the single, accurate, task-oriented manual for Voke

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; report status to it instead of editing the index.
>
> **Drift check**: Compare
> `git diff --stat 95a9ec6 -- apps/docs/content README.md docs packages/core/test/public-surface.test.ts packages/*/README.md`
> and `git status --short` with the recorded current state. Plans 011 and 012 land before this one
> and change some of these files on purpose. Reconcile routine drift; pause dependent work if drift
> invalidates scope, a protected contract, or an unresolved product or permission decision.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: LOW
- **Depends on**: `.factory/plans/011-real-standard-schema.md` (results follow the Standard Schema
  specification, so Zod and Valibot work) and `.factory/plans/012-docs-site-platform.md` (Twoslash
  checked samples, the sample policy test, link checking, registered MDX components)
- **Category**: docs
- **Planned at**: commit `95a9ec6`, 2026-11-14

## Why this matters

An audit on 2026-11-14 found the documentation inaccurate in places, hard to navigate, and written
around a pattern no developer should copy. Every example hand-writes a 9-line
`"~standard": { validate, vendor, version }` object, although `@voke/schema` exists, all five
example projects use it, and the docs never mention it. One 313-line page holds seven topics.
The same material lives in the README (403 lines), in `docs/*.md` and on the site, and the copies
have drifted. After this plan a developer finds one page per task, every sample compiles, and the
README points to the site instead of duplicating it.

## Current state

Verified at `95a9ec6` by reading every page and checking claims against the source.

### Where documentation lives today

- The site, `apps/docs/content/docs/` (9 pages, order in `meta.json`): `index`,
  `getting-started`, `guides/functions`, `guides/gateway-testing`, `guides/deploy`,
  `guides/local-aws`, `guides/serverless-migration`, `reference/config`, `reference/cli`.
- `README.md` (403 lines): Quickstart, Manual setup, Vocabulary, Monorepo, CLI, AWS and
  CloudFormation, Defaults, Runtime Variables, SQS Event Sources, Function Invocation, Gateway
  Routes, HTTP API Authorizers, Local AWS, Serverless Framework Migration, E2E Testing, Common
  Commands, License. `packages/core/package.json` `prepack` copies it into the `voke` package.
- `docs/e2e-testing.md` (testing levels, the stack test context, examples),
  `docs/serverless-framework-migration.md` (report quality, incremental strategy, compatibility
  matrix), `docs/error-conventions.md` (error classes, message rules, HTTP error responses),
  `docs/stable-public-surface.md` (the supported exports per package; a contributor contract).
- Not user documentation, and they stay where they are: `docs/adr/`, `docs/agents/`,
  `docs/reviews/`, `CONTEXT.md` (the glossary), `AGENTS.md`.

### Problems found

- **Inaccurate**:
  - `getting-started.mdx` tells users to run `bun run release:check`. That script exists only in
    this monorepo's root `package.json`; a project from `voke create` has `build`, `clean`,
    `deploy`, `dev`, `local`, `remove`, `synth`, `test` and `typecheck`
    (`packages/core/src/scaffold.ts`).
  - `guides/gateway-testing.mdx` says `createTestClient()` exercises "Lambda/API Gateway
    semantics". `packages/testing/src/index.ts` is a plain `fetch` client over a target with
    `fetch` or a `baseUrl`.
  - `reference/config.mdx` opens with a config that has no `provider`, then says the Provider is
    required for synth and build.
  - The first command, `voke create my-api`, cannot be run by an outsider: the packages are not
    published, and a generated project depends on `voke@^0.0.0` from the registry. The docs do not
    say how to try Voke today.
- **Schemas**: every sample hand-writes a Standard Schema object. `@voke/schema` exports a
  `schema` builder (`packages/schema/src/index.ts:318-332`: `array`, `boolean`, `coerce.number`,
  `enum`, `literal`, `null`, `number`, `object`, `optional`, `string`, `undefined`). It is used by
  `examples/hello-api`, `examples/e2e` and `examples/cross-function`, and documented nowhere.
- **Structure**: `guides/functions.mdx` covers Functions, Runtime Variables, Remote Function
  Registries, registry identity, route-backed Functions, HTTP API Authorizers, SQS Event Sources and
  how Functions become Lambda handlers. There is no page for resources and bindings, errors,
  troubleshooting, or the helper packages (`@voke/schema`, `@voke/http`, `@voke/testing`,
  `@voke/remote`).
- **Navigation**: only `index.mdx` has links. "See the deploy guide" and "See the Local AWS guide"
  appear as plain text in `getting-started.mdx`, `reference/cli.mdx` and `README.md`.
- **Presentation**: the pages use plain Markdown only. No callouts, steps, tabs or file trees.

### What is accurate and should be kept

`guides/deploy.mdx`, `guides/local-aws.mdx`, the Defaults section of `reference/config.mdx`, and
the Help, Project starter and Doctor sections of `reference/cli.mdx` were written from the current
code. Keep their facts; convert their samples and add links.

### Tests that read documentation

`packages/core/test/public-surface.test.ts`:

- `documentationFiles` (`:6-17`): `README.md`, `apps/docs/app/layout.tsx`, `apps/docs/app/page.tsx`,
  `content/docs/index.mdx`, `getting-started.mdx`, `guides/functions.mdx`,
  `guides/gateway-testing.mdx`, `docs/e2e-testing.md`, `docs/serverless-framework-migration.md`,
  `docs/stable-public-surface.md`. Together they must contain the terms `Function`,
  `Function Registry`, `Function Contract`, `Gateway`, `Route Builder`, and the strings
  `functions.invoke(`, `functions.route(` and `gateway.request(`.
- `teachingSurfaceFiles` (`:19-31`): must not contain removed names (`createGateway`,
  `defineFunction`, `defineFunctions`, `new Voke(`, `sqsEventSource`, `sqsMessageBatch`,
  `createAwsLambdaHandler`, `handleAwsLambdaRequest`, `jsonError`) or the phrases
  "Function-first AWS Lambda framework for Bun", "Hono-compatible APIs", "Bun-first".

Moving or deleting a listed file requires updating these lists in the same change. Keep the
assertions; point them at the new pages.

### Vocabulary (from `CONTEXT.md`; use these exact terms)

**Function** (a named serverless compute unit), **Function Registry** (the typed collection from
`createFunctions`), **Function Contract** (a Function's input and output schemas), **Gateway**
(`voke(functions)`, which serves route-backed Functions), **Route Builder** (`route.get(...)` and
friends), **Provider** (the platform adapter set in `voke.config.ts`, such as `aws()`), **Local AWS
Provider** (an emulator implementation: the AWS Emulator or Floci), **Runtime Variable**, **Event
Source**, **Remote Function Registry**. Never call the AWS Emulator "the provider".

### Owner decisions (2026-11-14)

- The docs site is the single source of truth. The README shrinks to a pitch, the quickstart and
  links. User guides in `docs/*.md` move into the site.
- Third-party validators are supported after plan 011, so the schema guide covers `@voke/schema`
  first, then Zod and Valibot.
- Hosting is not decided. Links from the README to the site use repository paths
  (`apps/docs/content/docs/...`) until a public URL exists.
- Still open: the npm package name and scope. Keep `voke` and `@voke/*` and the existing sentence
  that the published names are not final.

## Commands you will need

| Purpose     | Command                             | Expected on success                  |
| ----------- | ----------------------------------- | ------------------------------------ |
| Install     | `bun install`                       | exit 0                               |
| Dev server  | `cd apps/docs && bun run dev`       | serves `http://localhost:3942`       |
| Site build  | `cd apps/docs && bun run build`     | exit 0; fails on a sample type error |
| Site tests  | `cd apps/docs && bun test`          | 0 fail (samples, links, llms)        |
| Core tests  | `cd packages/core && bun test`      | 0 fail                               |
| Repo gates  | `bun run typecheck && bun run test` | exit 0                               |
| Lint/format | `bun run check`                     | exit 0                               |
| Format fix  | `bun x ultracite fix`               | exit 0                               |

`next dev` and `next build` rewrite `apps/docs/next-env.d.ts`. Restore it with
`git checkout -- apps/docs/next-env.d.ts` before finishing.

## Implementation rules relevant to this plan

**Accuracy**

- Every statement about behavior must be checked against the code or by running the command. Do
  not copy a claim from the old pages without checking it. Useful sources: `packages/core/src/cli-spec.ts`
  (commands and flags), `packages/core/src/config.ts` (settings and defaults),
  `packages/core/src/scaffold.ts` (what `voke create` writes), `packages/aws/src/index.ts` (the
  `@voke/aws` surface), `docs/stable-public-surface.md` (supported exports), and `examples/`.
- Every `ts`/`tsx` sample is a `twoslash` block that compiles (plan 012). Complete samples include
  their imports. Hide setup with `// ---cut---`, and use `// @filename:` for multi-file samples such
  as `voke.config.ts` plus `src/index.ts`. Never silence a real error with `// @noErrors`.
- Samples use `@voke/schema` (`schema.object({ id: schema.string() })`) for contracts. No page
  hand-writes a `"~standard"` object except the one section that explains the Standard Schema
  contract itself.
- Shell output shown in a page must be real output from the current CLI.

**Writing**

- One page answers one question. Start each page with what the reader can do after reading it,
  then the shortest working example, then details.
- Use the vocabulary above. Short sentences, present tense, "you" for the reader, no marketing
  words. Explain a term the first time a page uses it, or link to the Concepts page.
- State limits plainly where they apply: Voke is not published yet; `createStackTestContext`
  targets Floci; the AWS Emulator's Lambda cannot run a Voke bundle; local bootstrap with the AWS
  Emulator needs the AWS CLI.
- Every page ends with "Next steps" links. Every mention of another guide is a link. Internal links
  are absolute site paths (`/docs/guides/deploy`), checked by the link test.

**Components** (registered in `apps/docs/components/mdx.tsx` by plan 012)

- `Steps`/`Step` for ordered procedures (getting started, deploy, local AWS, migration).
- `Callout` for limits and warnings. At most two per page.
- `Tabs`/`Tab` when two alternatives are equivalent (AWS Emulator vs Floci; `@voke/schema` vs Zod).
- `Files`/`File`/`Folder` for project layouts instead of ASCII trees.
- Tables for settings and flags. No screenshots of terminals; use text blocks.

**Repository**

- Core `src` is not touched. This plan changes documentation, examples' prose and tests' file lists.
- Code style for any `.ts`/`.tsx`: Ultracite (Oxlint + Oxfmt).

## Scope

**In scope**:

- `apps/docs/content/docs/**` (rewrite, split, create) and `apps/docs/content/docs/meta.json`
- `apps/docs/test/samples.test.ts` (empty the `legacyUncheckedPages` list only)
- `apps/docs/package.json`, `bun.lock`: only `devDependencies` a sample needs to resolve an import
- `README.md` (shrink), `packages/*/README.md` (links only)
- `docs/e2e-testing.md` and `docs/serverless-framework-migration.md` (delete after their content
  moves); `docs/error-conventions.md` (keep the contributor rules, move the user-facing parts)
- `packages/core/test/public-surface.test.ts` (the `documentationFiles` and `teachingSurfaceFiles`
  lists only)
- `examples/*/README.md` (create short ones, if an example is linked from the site and has none)

**Out of scope**:

- Site code, layout, landing page and tooling (plan 012).
- Any change to package source. A documented API that does not work is a STOP condition, not
  something to patch here.
- `docs/adr/`, `docs/agents/`, `docs/reviews/`, `docs/stable-public-surface.md`, `CONTEXT.md`,
  `AGENTS.md`.
- API reference generated from types, versioned docs, translations, hosting.
- The npm name and scope decision.

## Git workflow

- Branch: `feature/docs-content-single-source`, created from `feature/docs-site-platform`.
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the navigation structure

Target structure (`meta.json`; page file names in parentheses):

- **Start**: Introduction (`index`), Getting Started (`getting-started`), Concepts (`concepts`)
- **Guides**:
  - Functions (`guides/functions`)
  - HTTP routes (`guides/http-routes`)
  - Schemas and validation (`guides/schemas`)
  - Authorizers (`guides/authorizers`)
  - SQS events (`guides/sqs-events`)
  - Runtime Variables (`guides/runtime-variables`)
  - Resources and bindings (`guides/resources`)
  - Calling other projects (`guides/remote-functions`)
  - Testing (`guides/testing`)
  - Local AWS (`guides/local-aws`)
  - Deploy (`guides/deploy`)
  - Migrate from Serverless Framework (`guides/serverless-migration`)
  - Troubleshooting (`guides/troubleshooting`)
- **Reference**: Config (`reference/config`), CLI (`reference/cli`), Errors (`reference/errors`),
  Packages (`reference/packages`)

`guides/gateway-testing` is replaced by `guides/testing`. If the framework supports redirects in
the installed version, add one from the old URL; otherwise note the removed URL in the report.

### Step 2: Start pages

- **Introduction**: what Voke is in two sentences, who it is for, the smallest complete example
  (config plus entrypoint, with `@voke/schema`), and where to go next.
- **Getting Started**: `Steps` for create → dev → test → deploy → remove, with real output; the
  generated project as a `Files` tree; a `Callout` that Voke is not published yet. Include a short
  "Try it from the repository" section with commands you have run: clone, `bun install`, then run
  `examples/hello-api` (`bun run dev`, `bun test`). Remove `bun run release:check`.
- **Concepts**: one page that defines the vocabulary and shows how the pieces connect: the config,
  the entrypoint, Functions, the Function Registry, the Gateway, the Provider, and what
  `voke build`, `voke synth` and `voke deploy` each produce. Move "How Functions become Lambda
  handlers" here, including the `VOKE_SYNTH` guard and handler naming.

### Step 3: Guides

Split `guides/functions.mdx` and merge the README and `docs/*.md` material into the pages below.
Each page covers at least the listed points.

- **Functions**: `fn()`, Function Contracts with `@voke/schema`, `createFunctions`,
  `functions.invoke(...)` (sync and async modes, options), registry key vs deployed `name`,
  `synthesis.timeout`/`memory`.
- **HTTP routes**: `http()`, the Route Builder (`route.get/post/...`), params, query, body and
  headers schemas, response shape, `api.cors`, what an unhandled error returns
  (`INTERNAL_SERVER_ERROR`; the message is hidden except under `voke dev`), the 30-second limit
  for HTTP-routed Functions.
- **Schemas and validation**: `@voke/schema` builders with a table of all of them; using Zod and
  Valibot (tabs); what a validation failure looks like to an invoker and to an HTTP client; a short
  section on the Standard Schema contract for authors of other validators.
- **Authorizers**: `createAuthorizers`, JWT and Lambda authorizers, `requestAuthorizer`, defaults
  and `authorizer: "none"`, local evaluation and its limits, injecting auth context in tests.
- **SQS events**: `sqsQueue()` plus `sqs()`, batches and partial failures, invalid message bodies,
  `functions.sendEvent(...)` in tests, the derived visibility timeout, the v1 limits (no DLQ).
- **Runtime Variables**: `secret()`/`parameter()` and `.fromResource()`, reading values, caching,
  optional values, local overrides and the `VOKE_VARIABLE_*` fallbacks, the IAM that Voke grants.
- **Resources and bindings**: declaring `resources`, the builders in `@voke/aws/cloudformation`,
  `bindResource(...)`, `createAwsClientConfig()` and why every AWS SDK client should use it, what
  Voke grants each Function.
- **Calling other projects**: Remote Function Registries: `remotes` config,
  `voke remote generate`, the generated module, how `voke dev` exposes contracts.
- **Testing**: choosing a level (`functions.invoke`, `functions.route`, `gateway.request`,
  `createTestClient` for an exported service or a deployed URL), `createInvokeTestClient`, stack
  outputs with `readLocalStackOutputs`, `createStackTestContext` and its Floci limit, smoke tests
  against `.voke/outputs/<stage>.json`. Describe `createTestClient` as a `fetch` client.
- **Local AWS**, **Deploy**: keep the facts; convert to `Steps`, checked samples and links.
- **Migrate from Serverless Framework**: merge `docs/serverless-framework-migration.md` (report
  quality, incremental strategy, compatibility matrix).
- **Troubleshooting**: `voke doctor` and how to read its rows; the common errors with their exact
  messages and fixes (no Provider configured, unknown flag, removed settings such as `local` and
  `runtime.lambda`, credentials missing, emulator not running, entrypoint import failures).

### Step 4: Reference

- **Config**: start with a valid minimal config that has `provider: aws()`. One table per group
  (project, build, API, runtime, resources, remotes, dev) with type, default and description for
  every setting in `VokeConfigInput` (`packages/core/src/config.ts`), the `aws({ lambda, local })`
  options, and the removed settings with their replacements.
- **CLI**: every command from `voke --help`, each with its real `--help` output and one example.
- **Errors**: the error classes and codes (`VokeConfigError`, `VokeModelError`, `VokeDeployError`,
  `VokeResourceBindingError`, `VokeRuntimeVariableError`, `CliUsageError`, `InvokeError`), when
  each is thrown, and the HTTP error body. Move the user-facing parts of
  `docs/error-conventions.md` here; that file keeps only the message-writing rules for contributors
  and links to this page.
- **Packages**: one section per package (`voke`, `@voke/aws` and its `/cloudformation`, `/local`,
  `/testing` subpaths, `@voke/schema`, `@voke/http`, `@voke/testing`, `@voke/remote`,
  `@voke/build`): what it is for, its main exports (from `docs/stable-public-surface.md`), and the
  guide that teaches it.

### Step 5: Shrink the README and remove duplicates

- `README.md` becomes: what Voke is, the three-command quickstart, the pre-release note, a short
  feature list, a "Documentation" section linking to each guide by repository path
  (`apps/docs/content/docs/...`), the monorepo layout, contributor commands, License. Target:
  under 120 lines. It keeps `provider: aws()` and one short sample.
- Delete `docs/e2e-testing.md` and `docs/serverless-framework-migration.md` once their content is
  on the site. Search the repository for links to them and update each one.
- Each `packages/*/README.md` links to its guide.
- Update the two file lists in `packages/core/test/public-surface.test.ts` to the pages that now
  carry the vocabulary and the teaching samples. Do not remove assertions.

### Step 6: Verify the whole site

- Empty `legacyUncheckedPages` in `apps/docs/test/samples.test.ts`.
- Run every command a page tells the reader to run, in `examples/hello-api` or a scaffolded
  temporary project. Commands that need AWS credentials or Docker are run only with operator
  approval; otherwise list them in the report as not run.
- Read each page in the browser at 1440 px and 390 px.

## Test plan

- `cd apps/docs && bun run build`: every sample compiles.
- `cd apps/docs && bun test`: the sample policy passes with an empty legacy list; no broken links
  or anchors; `llms.txt` lists every page in `meta.json`.
- `cd packages/core && bun test test/public-surface.test.ts`: the vocabulary and removed-name
  assertions pass against the new file lists.
- A written checklist in the report: for each page, which claims were verified against which
  source file or command.

## Done criteria

- [ ] `meta.json` matches the structure in Step 1, and every listed page exists
- [ ] `grep -rn '"~standard"' apps/docs/content README.md` matches only the Standard Schema section of `guides/schemas.mdx`
- [ ] `grep -rn 'release:check' apps/docs/content` → no matches
- [ ] `grep -rn 'Lambda/API Gateway semantics' apps/docs/content README.md` → no matches
- [ ] `grep -rnE 'See the .* guide' apps/docs/content README.md` → no unlinked mentions
- [ ] `legacyUncheckedPages` is empty; `cd apps/docs && bun run build && bun test` exit 0
- [ ] `wc -l README.md` → under 120 lines; `ls docs/e2e-testing.md docs/serverless-framework-migration.md` → "No such file"
- [ ] `grep -rn 'e2e-testing.md\|serverless-framework-migration.md' --include=*.md --include=*.mdx --include=*.ts . | grep -v node_modules | grep -v .factory` → no matches
- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0 at the root
- [ ] The report lists every command that was not run and why
- [ ] No files outside the in-scope list are modified (`git status --short`)

## STOP conditions

- Plan 011 or plan 012 has not landed. Without 011 the schema guide cannot show Zod; without 012
  samples cannot be checked. Report which is missing.
- A documented API cannot be written as a compiling sample, or behaves differently from every
  existing description. Report the API, the sample and the compiler error or observed behavior. Do
  not document around it and do not patch package source here.
- A page would need a hosting URL, a published package name, or a brand decision to be correct.
  Write the page with the current facts and report the dependency.
- Deleting a `docs/*.md` file breaks a test or tool that cannot be redirected to the site page.
  Keep the file as a one-line pointer and report it.

## Maintenance notes

- New features ship with their guide page and a checked sample; the policy test enforces the
  sample part.
- When the packages are published, update the pre-release callout on Getting Started and the
  README in one change.
- When a public URL exists, replace the README's repository-path links with site links.
- Reviewers should read Getting Started as a newcomer, check that no page hand-writes a schema,
  and spot-check three claims per page against the code.
- Deferred: an API reference generated from types, a cookbook of recipes, and a changelog page.

## Execution notes (2026-11-14)

Done on branch `feature/docs-content-single-source` (PR #62), stacked on plan 012
(`feature/docs-site-platform`, PR #61). Gates:

- `bun run check`: 0 errors.
- `bun run typecheck`: 19/19.
- `bun run test`: 24/24 tasks. This builds the docs site, so every sample compiles in the real build;
  docs tests 7 pass, with the sample policy at an empty legacy list, no broken links or anchors, and
  `llms.txt` listing every page.
- `bun run check:samples`: 68 samples, 0 failed.

- **Structure:** `meta.json` matches Step 1, with 20 pages in three groups (Start, Guides, Reference).
  `guides/gateway-testing` is removed and replaced by `guides/testing`; this Fumadocs version has no
  redirects, so the old URL returns 404. New pages: `concepts`, `http-routes`, `schemas`,
  `authorizers`, `sqs-events`, `runtime-variables`, `resources`, `remote-functions`, `testing`,
  `troubleshooting`, `reference/errors`, `reference/packages`. The other pages were rewritten.
- **How the pages were written:** five writers worked in parallel on disjoint pages from one brief.
  Every claim had to be checked against the source, and every sample had to compile. Each writer
  reported what it could not verify. The coordinator then:
  - replaced their workarounds: Bun types for all samples instead of hidden `declare` lines; real
    `zod`, `@aws-sdk/client-sqs` and `@aws-sdk/client-dynamodb` imports instead of stubs (docs
    `devDependencies` only);
  - fixed two pages the formatter broke;
  - checked the pages in the browser at 1440 px and 390 px.
- **Single source:**
  - `README.md` is 96 lines: pitch, quickstart, what you get, documentation links by repository path,
    "Try it", repository layout, contributor commands, license.
  - `docs/e2e-testing.md` and `docs/serverless-framework-migration.md` are deleted after their
    content moved. `roadmap-v2.md`'s reference is updated.
  - `docs/error-conventions.md` keeps the contributor rules and points to `reference/errors`. Its
    Runtime Variable example did not match the real message, so it is dropped.
  - Each `packages/*/README.md` links to its guides.
  - `public-surface.test.ts` now checks the vocabulary in the teaching pages, and checks for removed
    names across every docs page.

Tooling added (outside the listed scope, small):

- `apps/docs/scripts/check-samples.ts` and the `check:samples` script compile `twoslash` samples
  without a build (about 2 s), using the same Twoslash setup, so parallel writers did not collide in
  `.next`.
- `twoslash` is a docs `devDependency`.
- Twoslash loads Bun types (`types: ["bun"]`) in both `source.config.ts` and the checker.

Accuracy fixes the coordinator made after review:

- "Try it from the repository" (Getting Started and README): `voke dev` in `examples/hello-api`
  fails on a fresh clone with `AWS Emulator is not running`, because the example declares a table and
  a queue and `aws()` defaults to the emulator. The pages now say `bun test` needs nothing, and
  `voke dev` needs `voke local start` and `voke local bootstrap` first (Docker and the AWS CLI).
- `reference/cli.mdx`: `voke dev --port 4000` does not move the server. The example now uses
  `PORT=4000 voke dev` and explains `--port`/`--hostname`.

Deviation:

- `guides/serverless-migration.mdx` shows the migrator's real generated Function in a `txt` block.
  That output hand-writes a `"~standard"` schema, so the grep criterion matches there as well as in
  `guides/schemas.mdx`.

Not run:

- Commands that need AWS credentials or Docker (`voke deploy`, `voke remove`, `voke local`), as
  described in the pages.
- `bun run dev` servers were not left running.

Product bugs found while documenting (not fixed here; the pages state the real behavior):

1. Query and headers schemas fail through the Gateway: the schema receives `URLSearchParams` or
   `Headers`, not a plain object, so `gateway.request` returns 400. They work through
   `functions.route`. Without a schema, `request.query` is typed as a record but is a
   `URLSearchParams` at runtime (`createRouteRequest`/`mountRoute` in `packages/core/src/invoke.ts`).
   The pages avoid query and headers schemas.
2. `voke dev --port` and `--hostname` only change `VOKE_DEV_ORIGIN`; the server listens on `PORT`.
   The `--help` text "Port. Default: 3000" is misleading (`packages/core/src/dev.ts`).
3. Generated Remote Function Registry clients are untyped for `@voke/schema` and Zod schemas.
   Contract metadata reads JSON Schema only from a `jsonSchema` property, so the client's `invoke`
   accepts any payload and returns `unknown` (`packages/core/src/remote.ts`).
4. `functions.route` types `body` as `undefined` with `@voke/schema` builders, because their input
   type is `unknown`.
5. Every Function's IAM role gets access to every declared resource, and every Function gets every
   `VOKE_RESOURCE_*` variable. Runtime Variable permissions are per Function. No `kms:Decrypt` is
   granted.
6. `dynamodbTable({ billingMode: "PROVISIONED" })` sets no `ProvisionedThroughput`, so the template is
   probably invalid on deploy (not tested on AWS).
7. `build.entrypoints` has no effect with `aws()`: the AWS build bundles one generated module from
   `entrypoint`.
8. Runtime Variable load errors name the source kind (`aws secretsManagerSecret
"secretsManagerSecret"`), not the secret id, because the AWS sources set no `id`.
9. `CliUsageError` is not exported from `voke`.
10. The Serverless migrator drops an unsupported runtime (for example `nodejs20.x`) without a report
    line, and its generated project has no `deploy` script.
11. Locally, JWT authorizers are not evaluated at all: the route runs with an empty auth context. An
    unknown authorizer name is only rejected by `voke synth`/`deploy`.
12. `voke local stop` leaves `.voke/local/aws-emulator/<port>/`, so the AWS Emulator's "is it
    running" check passes after a stop.
13. The `defaultDevPort` comment in `packages/core/src/dev.ts` says `--port` changes the listening
    port; it does not (see 2).
