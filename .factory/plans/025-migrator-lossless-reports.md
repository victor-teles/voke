# Plan 025: `voke migrate serverless` never reports a lossy conversion as supported

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/core/src/serverless-migration.ts packages/core/src/scaffold.ts packages/core/src/cli.ts packages/core/test examples/serverless-migration apps/docs/content/docs/guides/serverless-migration.mdx apps/docs/content/docs/reference/cli.mdx CONTEXT.md`
> and `git status --short` with the recorded current state. Plans 022–024 land first and do not
> touch the migrator; if `serverless-migration.ts` changed, re-verify the excerpts below before
> coding. Pause only if drift invalidates a decision listed in this plan.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none. (Ordering only: after `.factory/plans/022-*.md`, `023-*.md`, `024-*.md`;
  before `026-*.md`, which edits `packages/core/src/cli.ts`, and before `034-*.md`, which owns
  the dependency versions in `packages/core/src/scaffold.ts`.)
- **Category**: security, migration
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

`voke migrate serverless` reads a `serverless.yml` and writes a Voke project plus a report. Today
it turns a route that had a JWT, Lambda or IAM authorizer into a public route and reports it as
"Supported, high confidence". It copies `${opt:stage, 'dev'}`, `${ssm:...}` and `!Ref X` into
`stage`, `region` and `environment` as if they were values. Its hand-written YAML parser loses
merge keys and block scalars without an error. Its `package.json` and `tsconfig.json` only work
inside this monorepo. A user who trusts the report deploys an API that is open to the internet.

After this plan, every route that had an authorizer is either generated with the equivalent
Voke HTTP Authorizer or generated closed (it denies every request) with a blocking task in the
report; values the migrator cannot resolve are left out and reported; the file is read by
`Bun.YAML`, and anything that cannot be read faithfully stops the command; and the generated
project uses the same `package.json` and `tsconfig.json` as `voke create`.

## Current state

### Architecture rules (binding)

- `AGENTS.md`: test first; "Keep dependencies minimal. Use platform and Bun APIs first, then
  existing project dependencies, and add new packages only when the value is clear."
- `packages/core/package.json` has **no runtime dependencies** (only `hono` as a peer). This plan
  must not add one.
- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: `voke` (core) must not import
  `@voke/*`. The migrator lives in core and only writes **text** that imports `@voke/aws`; keep
  it that way.
- ADR `docs/adr/0007-opinionated-framework.md`: one supported way per layer; "REST APIs ... are
  outside the supported path"; removals without deprecation aliases.
- ADR `docs/adr/0006-http-api-authorizers.md`:
  - "A route with no authorizer setting inherits the default when one exists, while
    `authorizer: "none"` is the explicit public-route override; merely registering an authorizer
    does not protect any route."
  - "Lambda Authorizers expose an explicit `cacheTtlSeconds` option that defaults to `0`."
  - "Deployed Lambda name or ARN targets are external to the stack's Function Registry and must
    already allow API Gateway invocation in v1."
  - "Lambda Authorizers use HTTP API authorizer payload format version `2.0` with simple
    responses enabled. Voke does not support v1 policy-document authorizer responses."
- Vocabulary from `CONTEXT.md` (use these words): **HTTP Authorizer**, **JWT Authorizer**,
  **Lambda Request Authorizer**, **Request Authorizer Function**, **Authorizer Registry**,
  **Authorizer Identity Source**, **Lambda Authorizer Cache TTL**, **Function Registry**,
  **Gateway**, **Runtime Variable**. `CONTEXT.md` has no migration terms today.

### Voke's authorizer authoring API (what the generated code must use)

`packages/aws/src/authorizers.ts:47-90` and `apps/docs/content/docs/guides/authorizers.mdx`:

```ts
import {
  createAuthorizers,
  jwtAuthorizer,
  lambdaAuthorizer,
  requestAuthorizer,
} from "@voke/aws";

const authorizers = createAuthorizers({
  userJwt: jwtAuthorizer({
    issuer: "https://auth.example.com",
    audience: "users-api",
  }),
  session: lambdaAuthorizer({ function: "authorizeSession" }), // registry key, or { arn }, or { deployedName }
});

createFunctions({
  authorizeSession: requestAuthorizer({
    handler: (request) => ({ authorized: false }),
  }),
  users: http({
    authorizers,
    routes: [route.get("/me", { authorizer: "session", handler })],
  }),
});
```

- `jwtAuthorizer({ issuer, audience, identitySource? })`; `lambdaAuthorizer({ function, identitySource?, cacheTtlSeconds? })`;
  the identity source defaults to `$request.header.Authorization`.
- A route names an authorizer with `authorizer: "<name>"`; `"none"` is reserved
  (`packages/core/src/invoke.ts:143`).
- Voke has **no** JWT scopes, **no** IAM (`aws_iam`) authorization and **no** REST API
  authorizers. Synthesis only emits `AuthorizationType` `JWT` or `CUSTOM`
  (`packages/aws/src/cloudformation-synthesis.ts:692-698`).
- The local Gateway evaluates Lambda Request Authorizers (`packages/core/src/invoke.ts:1397`
  returns early only when `authorizer?.kind !== "lambda"`), so a Request Authorizer Function that
  returns `{ authorized: false }` closes its routes under `voke dev`, in tests and when deployed.

### Code at `1c59d39`

All in `packages/core/src/serverless-migration.ts` (2,856 lines) unless noted. It is used only by
`packages/core/src/cli.ts:35` and its test; nothing in it is exported from `packages/core/src/index.ts`.

- **Hand-written YAML parser**, `:357-663` (`splitInlineItems` … `parseYaml`). `parseObject`
  skips any line indented deeper than the current block:
  ```ts
  // :608-611
  if (line.indent > indent) {
    cursor += 1;
    continue;
  }
  ```
  so the body of a `|` or `>` block scalar is dropped and the value becomes `"|"` or `">"`.
  `<<: *common` becomes a key `"<<"` with the string `"*common"`. `!Ref X` stays the string
  `"!Ref X"`.
- **Environment is stringified**, `:335-338`: `stringRecord` maps every entry through
  `String(entry)`, so `TOPIC_ARN: { Ref: PaymentsTopic }` becomes `"[object Object]"`. The test
  pins this: `packages/core/test/serverless-migration.test.ts:358-361` expects
  `INLINE_LIST: "alpha,beta"` and `SHARED_TABLE: "[object Object]"`.
- **Authorizer and CORS are read and never used**, `:699-712`:
  ```ts
  return {
    authorizer: config.authorizer,
    cors: config.cors,
    method: (asOptionalString(config.method) ?? "GET").toUpperCase(),
    path: asOptionalString(config.path) ?? "/",
    ...
    unknownFields: collectUnknownFields(config, ["authorizer", "cors", "method", "path"], ...
  ```
  No other line reads `event.authorizer` or `event.cors`. `provider.httpApi` is not a known
  provider key (`:2739-2748`), so its `authorizers` and `cors` show up only as one medium-risk
  "unknown field".
- **Routes are always public and "high confidence"**: `createRouteTemplate` (`:2072-2097`) emits
  `route.<method>(path, { handler })`; `createConvertedItems` (`:1419-1426`) and `addEventReport`
  (`:2592-2603`) list every `httpApi` and `http` event as converted or supported; the
  compatibility rows (`:1758-1771`) say `Supported`, `high`, manual work `-`.
- **Stage, region and environment are copied verbatim**, `:2134-2137`:
  ```ts
  stage: ${tsString(service.provider.stage ?? "local")},
  region: ${tsString(service.provider.region ?? "us-east-1")},
  entrypoint: "./src/index.ts",
  environment: ${stringifyObject(environment, 2).replaceAll("\n", "\n  ")},${resourceBlock}
  ```
  and reported as converted (`:1386-1406`), as supported (`:2274-2288`) and as `Supported`
  (`:1723-1741`). `defineConfig` accepts any string
  (`packages/core/src/config.ts:339`: `input.stage ?? readEnv("VOKE_STAGE") ?? "local"`;
  `:357`: `input.region ?? readEnv("AWS_REGION") ?? "us-east-1"`).
- **Function-level environment is renamed without a report**, `:2100-2110`: `TABLE_NAME` of
  function `listOrders` becomes the top-level key `LISTORDERS_TABLE_NAME`.
- **Settings that are parsed and then dropped without a report**: function `timeout`,
  `memorySize`, `layers` and an unsupported `runtime` (known keys at `:2749-2758`; only
  `nodejs22.x`/`nodejs24.x` survive, `:1935-1938`); `provider.deploymentBucket` (listed as
  supported at `:2294-2298`, used nowhere).
- **DynamoDB tables drop properties**, `:1014-1052`: only `KeySchema` and `BillingMode` are
  read; `TableName`, indexes, streams and non-string key types are ignored and the table is
  reported as generated. (`dynamodbTable` types every key as `"S"`,
  `packages/aws/src/cloudformation-synthesis.ts:124-129`.) Other resource types already refuse
  any `Properties` (`:1104-1108`).
- **Generated project files**, `:2189-2216`: `tsconfig.json` is
  `{ extends: "../../tsconfig.json", ... }`; `package.json` uses `"@voke/aws": "workspace:*"`,
  `voke: "workspace:*"` and the name `` `@voke/${name}` ``.
- **The scaffold already has the right files**, `packages/core/src/scaffold.ts`: a standalone
  `tsconfig` (`:116-131`) and `projectPackageJson(name)` (`:133-162`) that pins
  `@voke/aws`, `@voke/testing` and `voke` to `` `^${packageJson.version}` `` ("Every Voke package
  moves in lockstep", `:28-29`). Neither is exported.
- **Report risk levels**, `:30`: `ServerlessMigrationRisk = "high" | "low" | "medium"`; rendered
  by `markdownManualTasksByRisk` (`:1595-1623`) in the order high, medium, low.
- **CLI**, `packages/core/src/cli.ts:165-179` (`migrateServerless` reads the file and calls
  `writeServerlessMigration`) and `:740-752` (prints `Wrote migration skeleton to <directory>`).
- **Tests**: `packages/core/test/serverless-migration.test.ts` (10 tests) with two report
  snapshots, `packages/core/test/fixtures/serverless-migration-report.md` and
  `serverless-compatibility-report.md`, and four YAML fixtures in `examples/serverless-migration/`.

### What a run showed (planner, 2026-11-15)

A `serverless.yml` with `provider.httpApi.authorizers` (one JWT, one `type: request` with
`functionName`, one with `functionArn`), routes using them, a route with
`authorizer: { type: aws_iam }`, an `http` event with `private: true`, `<<: *common`, `!Ref`,
`!GetAtt`, `${opt:...}`, `${env:...}`, `${ssm:...}` and block scalars produced:

```ts
stage: "${opt:stage, 'dev'}",
region: "${env:AWS_REGION, 'us-east-1'}",
environment: {
  "DB_PASSWORD": "${ssm:/payments/${self:custom.stage}/db-password}",
  "QUEUE_URL": "!Ref PaymentsQueue",
  "TOPIC_ARN": "[object Object]",
  "DESCRIPTION": ">",
  "SCRIPT": "|"
},
```

six public routes, `Unsupported features: No unsupported features detected.`, and a report whose
only high-risk task was the IAM statements. The function `listPayments` lost the `runtime`,
`memorySize` and `timeout` that `<<: *common` merged in.

### `Bun.YAML` in Bun 1.4.4 (probed)

`Bun.YAML.parse(text)` exists (`engines.bun` is `>=1.4.4`). Observed behaviour:

| Input                                                | Result                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| `<<: *anchor`, `<<: [*a, *b]`, anchors, aliases      | merged and resolved correctly                                    |
| `>` and `                                            | `block scalars, with`-`/`+` chomping                             | correct |
| `!Ref X`, `!GetAtt A.B`, `!Sub '...'`, `!Join [...]` | **the tag is dropped without an error**: `"X"`, `"A.B"`, `[...]` |
| `${opt:stage, 'dev'}`                                | kept as a string                                                 |
| `yes`, `no`, `on`, `off`                             | strings (same as Serverless Framework's parser)                  |
| duplicate keys                                       | last one wins, no error                                          |
| two documents (`---`)                                | an array of documents                                            |
| empty file                                           | `null`                                                           |
| tabs as indentation, bad indentation, unknown alias  | throws `SyntaxError: YAML Parse error: ...`                      |
| alias of a collection                                | the **same object** twice; a self-reference gives a cyclic value |

The `line`/`column` on the thrown error did not match the YAML position in the probe; do not
print them. A string that starts with the private-use character `U+E000` survives parsing as a
plain scalar, inside quotes, inside a flow sequence and as a flow-map key (probed).

## Decisions taken in this plan

1. **Replace the hand-written parser with `Bun.YAML.parse`.** Reason: it reads merge keys,
   anchors and block scalars correctly, needs no dependency, and core already requires Bun
   1.4.4. Keeping the parser would mean writing most of a YAML parser. A package (`yaml`) would
   be core's first runtime dependency. _Reverse_: swap the one `readServerlessYaml` function.
2. **Tags are marked before parsing, because `Bun.YAML` drops them.** A small scanner replaces
   each tag with a marker the parser preserves; a pass after parsing turns markers into the
   CloudFormation long form (`{ Ref: "X" }`, `{ "Fn::GetAtt": ["A", "B"] }`,
   `{ "Fn::Join": [...] }`). Supported positions: a tag before a scalar, before `[` and before
   `{` on the same line. A tag followed by a block value (end of line, `|`, `>`) cannot be
   marked safely: **the command stops** and lists every such line with the remedy "write it in
   the long form". Reason: a stopped command is honest; a silently untagged value is the bug
   this plan fixes. _Reverse_: extend the scanner to block values later.
3. **A file that cannot be read faithfully stops the command** with a `CliUsageError`: YAML
   syntax errors, a root that is not a mapping (empty file, list, several documents), a cyclic
   alias, and the tags of decision 2. No files are written.
4. **Only literals are copied.** A literal is a string, number or boolean with no `${` in it.
   Everything else (a Serverless variable, a CloudFormation intrinsic, a list, a map, `null`) is
   left out of the generated code and reported. No variable resolver is added, not even for
   `${self:...}`: `voke.config.ts` is TypeScript, and the manual task tells the user to compute
   the value there. _Reverse_: add a resolver for `${self:...}` as a separate change.
   - `stage` not a literal (or not matching `/^[A-Za-z0-9-]+$/`): `stage` is omitted from the
     config; task, risk `medium`: Voke takes the stage from `voke deploy --stage <name>` or
     `VOKE_STAGE`.
   - `region` not a literal: `region` is omitted; task, risk `high`: without it Voke uses
     `AWS_REGION`, then `us-east-1`.
   - an `environment` value that is not a literal: the key is omitted; one task per key, risk
     `high`, naming the original expression. The reason text points at the Runtime Variables
     guide for `${ssm:...}`/secrets and at resource bindings (Resources guide) for
     `Ref`/`Fn::GetAtt` of a generated resource.
5. **A fourth risk level, `blocking`, above `high`.** It extends `ServerlessMigrationRisk`; no
   second mechanism. Meaning: the generated project differs from the Serverless service in who
   can call a route, and traffic must not move until the task is done. The report renders a
   `### Blocking` section first, the summary gains a `Blocking tasks` row, and the CLI prints
   the blocking tasks after its usual line. The exit code stays `0`: the skeleton is written and
   the affected routes are closed (decision 6). _Reverse_: throw after writing when the count is
   not zero.
6. **A route whose authorizer does not convert is generated closed.** It gets
   `authorizer: "migrationBlocked"`, a Lambda Request Authorizer backed by a generated Request
   Authorizer Function that returns `{ authorized: false }`. Reason: it uses Voke's own
   mechanism, it is visible in the code and in the synthesized template
   (`AuthorizationType: CUSTOM`), it survives the user replacing the placeholder handler, and it
   is enforced locally and when deployed. The alternative, omitting the route, hides the
   skeleton the user needs; a public route with a warning is what this plan removes.
   _Reverse_: change the one function that picks the route's authorizer name.
7. **Authorizer conversion table.** Anything not matched by a "converts" row is blocked.

   | Serverless shape                                                                                                                                                              | Generated                                                                                                                                                            | Report                                                                                                                                      |
   | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
   | `httpApi` event without `authorizer`                                                                                                                                          | public route (as today)                                                                                                                                              | as today                                                                                                                                    |
   | `authorizer: <name>` or `{ name }`, and `provider.httpApi.authorizers.<name>` has `type: jwt` (or no `type`), a literal `issuerUrl` and a literal `audience` (string or list) | `jwtAuthorizer({ issuer, audience, identitySource })`, route `authorizer: "<name>"`                                                                                  | converted, `high` confidence                                                                                                                |
   | the same, with `scopes` on the event                                                                                                                                          | the JWT Authorizer above                                                                                                                                             | **blocking**: Voke does not enforce scopes; any valid token passes. Check the `scope` claim in the handler                                  |
   | `type: request` with `functionName` of a function in this file that has no events                                                                                             | `lambdaAuthorizer({ function: "<functionName>", identitySource, cacheTtlSeconds })` plus a Request Authorizer Function skeleton that returns `{ authorized: false }` | **blocking**: port the authorizer logic; it denies every request until then, and it must return a Voke Authorizer Result, not an IAM policy |
   | `type: request` with a literal `functionArn`, `enableSimpleResponses: true` and `payloadVersion` absent or `"2.0"`                                                            | `lambdaAuthorizer({ function: { arn }, identitySource, cacheTtlSeconds })`                                                                                           | `high` task: the external function must allow invocation by the new API (ADR 0006)                                                          |
   | `type: request` otherwise (policy responses, payload `1.0`, non-literal ARN, `functionName` of a function that also has events or does not exist)                             | `migrationBlocked`                                                                                                                                                   | **blocking**                                                                                                                                |
   | JWT with a non-literal `issuerUrl` or `audience`                                                                                                                              | `migrationBlocked`                                                                                                                                                   | **blocking**, quoting the original values                                                                                                   |
   | `authorizer: { type: aws_iam }`, `authorizer: { id }`, an unknown name, the name `none` or `migrationBlocked`, any other shape                                                | `migrationBlocked`                                                                                                                                                   | **blocking**; for `aws_iam`: Voke has no IAM authorization for routes                                                                       |
   | `http` (REST API) event with any `authorizer`, or with `private: true`                                                                                                        | `migrationBlocked`                                                                                                                                                   | **blocking**: REST API authorizers and API keys are not converted                                                                           |

   `cacheTtlSeconds` is the literal number in `resultTtlInSeconds`, otherwise omitted (Voke's
   default `0`, no caching, is the stricter choice). `identitySource` is copied when it is a
   literal string or a list of literal strings, otherwise the authorizer does not convert.
   Authorizers declared in `provider.httpApi.authorizers` that no route uses are not generated;
   one `low` task lists them. No default authorizer is set on `http(...)`: every protected route
   names its authorizer, so a reviewer sees it at the route.

8. **CORS.** `provider.httpApi.cors: true` becomes `api: { cors: true }` in `voke.config.ts`
   (`packages/core/src/config.ts:56-59`: "`true` allows any origin, method and header without
   credentials"), reported as converted with `medium` confidence. An object form, and `cors` on
   an `http` event, are not converted: one `medium` task each. CORS left out fails closed for
   browsers, so it is not blocking.
9. **Settings that are read but not generated are reported, not converted.** One `medium` task
   per function lists its dropped `timeout`, `memorySize`, `layers` and unsupported `runtime`,
   and the renamed environment keys (`TABLE_NAME` → `LISTORDERS_TABLE_NAME`).
   `provider.deploymentBucket` gets a `low` task. Reason: all `httpApi` routes share one
   `http(...)` Function in the generated project, so per-function settings have no single
   target; converting them is a feature for later.
10. **A DynamoDB table is generated only when nothing is lost**: its `Properties` hold only
    `KeySchema`, `BillingMode` and `AttributeDefinitions` in which every key attribute has type
    `S`. Otherwise it takes the existing "requires manual migration" path (risk `high`), like
    every other resource type with properties.
11. **`supported` means "reached the generated code".** `provider IAM statements`,
    `provider deployment bucket`, `package patterns` and `package individually flag` leave the
    `supported` list (each already has, or gains, a manual task). `provider stage`,
    `provider region` and `provider environment` are listed only when a literal was emitted.
    A route is listed as supported only when it is public in both systems or has a converted
    authorizer with no blocking task; otherwise it goes to `unsupported` with the reason. The
    labels that say "inventory" stay.
12. **The generated project reuses the scaffold's files.** `scaffold.ts` exports its
    `projectPackageJson` and `tsconfig`; the migrator calls them. The package name is
    `kebabCase(service.service)`, without the `@voke/` scope, falling back to `voke-migration`
    when the result is empty. Dependency versions stay whatever the scaffold uses (plan 034 owns
    them). The package cannot be installed from a registry until Voke is published; this plan
    only removes the monorepo-only references.
13. **No ADR.** Every decision above is local to one module and reversible in one change. The
    guide and this plan record them.

## Commands you will need

| Purpose                | Command                                                                                                                                                                                             | Expected on success                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Migrator tests         | `cd packages/core && bun test test/serverless-migration.test.ts`                                                                                                                                    | 0 fail                                         |
| Scaffold and CLI tests | `cd packages/core && bun test test/api.test.ts test/cli-contract.test.ts` (confirm which files cover `createApiProject` and the CLI with `grep -rln "createApiProject\|runCli" packages/core/test`) | 0 fail                                         |
| Core typecheck         | `cd packages/core && bun run typecheck`                                                                                                                                                             | exit 0                                         |
| Docs                   | `cd apps/docs && bun run test && bun run lint:links`                                                                                                                                                | exit 0                                         |
| Run the migrator       | `cd examples/hello-api && bunx voke migrate serverless <file> --out <tmp dir>`                                                                                                                      | prints `Wrote migration skeleton to <tmp dir>` |
| Repo gates             | `bun run check && bun run typecheck && bun run test`                                                                                                                                                | exit 0                                         |
| Format                 | `bun x ultracite fix`                                                                                                                                                                               | exit 0                                         |

The first, third and fifth commands ran at `1c59d39` during planning (the fifth with the current
behaviour). `bun test` from the repository root has known failures until plan 022 lands; use
`bun run test`.

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`): each step starts with failing tests in
  `packages/core/test/serverless-migration.test.ts`.
- No new dependency. `Bun.YAML` is fine here: the module is reached only from the CLI, which
  runs on Bun. Do not import the migrator from `packages/core/src/index.ts`.
- The migrator is a pure function of the source text: `createServerlessMigration` stays
  synchronous and does no I/O; only `writeServerlessMigration` writes.
- Never treat a parsed value as text with `String(value)`. Go through one classifier (Step 2).
- Parsed values may share objects (aliases). The revive pass of Step 1 returns fresh objects;
  nothing after it may mutate the tree.
- Do not print secrets: a manual task quotes the original **expression** (`${ssm:/path}`), which
  is a reference, never a resolved value. The migrator resolves nothing.
- Generated TypeScript must compile against the public API shown under "Voke's authorizer
  authoring API". Authorizer and function names go through `tsString`/quoted keys as today.
- Ultracite style; no `console.log`; early returns; top-level regex literals.
- Keep `ServerlessMigrationReport`'s existing fields. Adding `blocking` to the risk union is the
  only type change that existing callers can observe.

## Scope

**In scope**:

- `packages/core/src/serverless-migration.ts`
- `packages/core/src/scaffold.ts` (export `projectPackageJson` and `tsconfig`, nothing else)
- `packages/core/src/cli.ts` (`migrateServerless` and the `migrate` handler only)
- `packages/core/test/serverless-migration.test.ts`,
  `packages/core/test/fixtures/serverless-migration-report.md`,
  `packages/core/test/fixtures/serverless-compatibility-report.md`
- `examples/serverless-migration/http-api-authorizers/serverless.yml` (create)
- `apps/docs/content/docs/guides/serverless-migration.mdx`,
  `apps/docs/content/docs/reference/cli.mdx` (the `migrate` section)
- `CONTEXT.md` (one term)
- `.factory/plans/README.md` (status only, unless the coordinator owns it)

**Out of scope**:

- Validating `stage` in `defineConfig` (`packages/core/src/config.ts:339`); the migrator simply
  stops emitting bad stages.
- Rejecting unused CLI arguments, `PWD`, exit codes: plan 026 (it edits `cli.ts` after this plan).
- Dependency versions written by the scaffold (`^0.0.0`, `@types/bun: "latest"`): plan 034.
- Enforcing JWT Authorizers under `voke dev`: plan 033.
- A Serverless variable resolver; JWT scopes, IAM authorization or REST API support in Voke;
  converting function `timeout`/`memorySize`/`layers`; new event conversions (`sns`, `s3`,
  `schedule`, `stream` stay "inventory only").
- Any change under `packages/aws`.

## Git workflow

- Branch: `feature/migrator-lossless-reports`, stacked on the previous plan's branch (the round
  is planned against `feature/docs-revamp`; `origin/main` stops at PR #52).
- Commit subjects are imperative sentences that state the outcome, for example "Generate
  migrated routes closed when their authorizer does not convert". Commit only if the task
  authorizes it. Do not push or open a PR unless told.

## Steps

### Step 1: Read the file with `Bun.YAML`, and never lose a tag

Tests first (a new group "reads YAML"), each through `parseServerlessYaml`:

- `<<: *common` on a function: `runtime`, `memorySize`, `timeout` are present and there is no
  unknown field named `<<`; `<<: [*a, *b]` merges both.
- `DESCRIPTION: >` and `SCRIPT: |` in `provider.environment` hold their text.
- `!Ref PaymentsQueue` parses to `{ Ref: "PaymentsQueue" }`; `!GetAtt PaymentsTable.Arn` to
  `{ "Fn::GetAtt": ["PaymentsTable", "Arn"] }`; `!Sub "arn:${AWS::Region}: x"` to
  `{ "Fn::Sub": "arn:${AWS::Region}: x" }`; `!Join ['-', [a, !Ref B]]` to
  `{ "Fn::Join": ["-", ["a", { Ref: "B" }]] }`; `- !Ref X` in a list; `!Equals []`.
- A `!` inside a quoted string, a comment or a block scalar body is left alone (for example
  `patterns: ["!test/**"]`, which the existing fixtures use, and `SCRIPT: |` containing `- !Ref x`).
- These throw a `CliUsageError` whose message names what is wrong: a tag at the end of a line
  (`Value: !Join` followed by a block list) and `!Sub |` — the message lists **every** such line
  number and says to use the long form (`Fn::Join:`); a syntax error (tab indentation); an empty
  file; a root list; two documents; a self-referencing alias.
- The existing ten tests still pass, except the pins listed in Step 2.

Implementation:

1. Delete `splitInlineItems`, `isKeyValue`, `splitKeyValue`, `parseScalar`, `parseInlineArray`,
   `parseInlineObject`, `stripComment`, `parseLine`, `parseBlock`, `parseObject`, `parseArray`,
   `parseYaml` and the `ParsedLine` type (`:181-184`, `:357-663`).
2. Add `markYamlTags(source)`. Marker `M = ""`. Walk the lines with this state: inside a
   single- or double-quoted string (carried across lines), flow depth (`[`/`{` minus `]`/`}`
   outside quotes), and "inside a block scalar" (a line whose value ends with `|` or `>` plus
   optional chomping/indent indicators starts one; it ends at the first non-blank line indented
   no deeper than that line). Outside quotes a ` #` or a line-leading `#` starts a comment.
   A tag is `!` followed by `[A-Za-z][A-Za-z0-9:]*`, outside quotes, comments and block scalars,
   where the previous non-space character on the line is absent or is one of `:` `-` `[` `,` `{`.
   Look at the first character after the tag and its spaces:
   - a quote: remove the tag and insert `M<name>M` right after the opening quote;
   - `[`: replace with `[ "M<name>", `; `{`: replace with `{ "M<name>": true, `;
   - end of line, `#`, `|`, `>`, `*` or `&`: record the line number as unreadable;
   - anything else (a plain scalar): replace the tag and its spaces with `M<name>M`.
     A `!!name` tag (`!!str`, `!!int`, ...) is left for the parser. If any line was recorded,
     throw one `CliUsageError` listing them. If the source already contains `M`, throw.
3. Add `reviveYaml(value)`: a recursive copy that returns fresh arrays and objects, throws on a
   cycle (keep a stack of ancestors), and converts a string `M<name>M<rest>` to
   `{ [long(name)]: rest }`, an array whose first item is `M<name>` to
   `{ [long(name)]: <rest of the array, revived> }`, and an object with a key `M<name>` to
   `{ [long(name)]: <the other entries, revived> }`. `long("Ref")` is `"Ref"`,
   `long("Condition")` is `"Condition"`, every other name is `Fn::<name>`. A scalar `GetAtt`
   value is split at its first `.` into a two-item list. A string that still contains `M` after
   this pass throws (scanner guard).
4. `readServerlessYaml(source)` = mark, `Bun.YAML.parse` (wrap a thrown error as
   `CliUsageError("Cannot read serverless.yml: <message>")`), revive, then require a plain object
   root. `parseServerlessYaml` calls it.

**Verify before coding**: `Bun.YAML.parse('q: [ "x", ]')` accepts the trailing comma that the
`!Equals []` case produces; if not, emit `[ "M<name>"` and add the comma only when the next
non-space character is not `]`.

**Evidence**: the new tests pass; `grep -n "parseScalar\|parseBlock" packages/core/src/serverless-migration.ts`
returns nothing.

### Step 2: Copy only literals into `stage`, `region` and `environment`

Tests first:

- `stage: ${opt:stage, 'dev'}`: the generated `voke.config.ts` has no `stage:` line and contains
  no `${`; a `medium` task names the expression; `supported` lacks `provider stage`.
- `region: ${env:AWS_REGION, 'us-east-1'}`: no `region:` line; a `high` task.
- Environment with `${self:...}`, `${ssm:...}`, `!Ref X`, `{ Ref: X }`, `{ Fn::GetAtt: [T, Arn] }`,
  a list and a literal: only the literal key is in the config; one `high` task per omitted key;
  the config never contains `[object Object]`, `${` or `!Ref`.
- All-literal input (the existing `serverlessYaml` fixture) still emits `stage: "prod"`,
  `region: "sa-east-1"` and `LOG_LEVEL`.
- The compatibility rows "Provider stage and region" and "Provider environment" read
  `Manual work` when something was omitted and list the task messages.

Implementation:

1. Add one classifier, for example
   `classifyValue(value): { kind: "literal"; text: string } | { kind: "variable" } | { kind: "intrinsic" } | { kind: "structure" }`
   (literal: string/number/boolean without `${`; intrinsic: an object with exactly one key that
   is `Ref`, `Condition` or starts with `Fn::`), and `describeValue(value)` that renders the
   original expression for a task (`JSON.stringify` for non-strings).
2. Change `ServerlessService.provider.environment` and `ServerlessFunction.environment` to
   `Record<string, YamlValue>`; delete `stringRecord`. Update the two pins at
   `test/serverless-migration.test.ts:358-361` to the raw values
   (`INLINE_LIST: ["alpha", "beta"]`, `SHARED_TABLE: { Ref: "UsersTable" }`).
3. `createConfigTemplate`: emit `stage`/`region` only for accepted literals (decision 4), emit
   only literal environment entries, and drop the `?? "local"` and `?? "us-east-1"` fallbacks
   (`defineConfig` already has them).
4. `createManualTasks`, `createConvertedItems`, `createBaseSupportedFeatures` and the
   compatibility rows follow decisions 4 and 11. Use `literalString` (already at `:996-1006`)
   plus the `${` check wherever a resource property is copied (`createDynamoDbResourceExpression`,
   `createSsmParameterResourceExpression`), so `Value: ${ssm:...}` is not emitted either.

### Step 3: The `blocking` risk level

Tests first: a migration with no blocking task renders `### Blocking` followed by
`- No blocking manual work.` before `### High risk`; the summary table has `Blocking tasks | 0`.

Implementation: add `"blocking"` to `ServerlessMigrationRisk` and to `riskLabels`; render order
`blocking, high, medium, low` in `markdownManualTasksByRisk` (the heading for `blocking` is
`### Blocking`, the others keep `### <Label> risk`); add the summary row in `reportSummary`.
Regenerate both snapshot fixtures and read the diff: only the new section and row may change in
this step.

### Step 4: Authorizers

Add `examples/serverless-migration/http-api-authorizers/serverless.yml` with: a JWT authorizer
(`cognitoJwt`), a `type: request` authorizer with `functionName: authorizerFn` (a function with
no events, `identitySource` a one-item list, `resultTtlInSeconds: 300`), one with a literal
`functionArn` and `enableSimpleResponses: true`, one with `functionArn` only, and routes that use
each of them, plus a route with `scopes`, one with `authorizer: { type: aws_iam }`, one with an
unknown name, one public route, and an `http` event with `private: true` and
`authorizer: aws_iam`.

Tests first, against that fixture:

- `src/authorizers.ts` exists and contains `createAuthorizers(`, the `jwtAuthorizer` with the
  issuer and audience, `lambdaAuthorizer({ function: "authorizerFn"`, `cacheTtlSeconds: 300`,
  `lambdaAuthorizer({ function: { arn:`, `migrationBlocked`, and two `requestAuthorizer(`
  skeletons that return `{ authorized: false }`.
- Each route file carries the expected `authorizer: "<name>"`; the public route has none; the
  `aws_iam`, unknown-name, policy-response and REST routes have `authorizer: "migrationBlocked"`.
- `src/index.ts` passes `authorizers` to `http({` and registers `authorizerFn` and
  `migrationBlocked` in `createFunctions`.
- **No route of an event that had an `authorizer` or `private: true` is generated without an
  `authorizer:` line** (loop over the parsed service and assert it for every such event; this is
  the regression test for the security bug).
- `report.manualTasks` has a `blocking` task for: scopes, the `authorizerFn` skeleton, the
  policy-response ARN, `aws_iam`, the unknown name, and the REST route; a `high` task for the
  converted external ARN. `report.supported` holds only the public route and the plain JWT
  route; the others are in `report.unsupported`.
- `provider.httpApi.authorizers` is not reported as an unknown field; `provider.httpApi.payload`
  (add it to the fixture) still is, at path `provider.httpApi.payload`.
- A service without any authorizer generates no `src/authorizers.ts` and an unchanged
  `src/index.ts` (the existing tests cover this once they pass).

Implementation:

1. Parsing: add `httpApi` to the provider's known keys; parse `provider.httpApi.authorizers`
   into the service model (raw per-name objects) and `provider.httpApi.cors`; report the other
   `httpApi` keys as unknown fields under `provider.httpApi.<key>`. Add `private` to the `http`
   event's known keys and to the event model.
2. Add `resolveRouteAuthorizer(service, fn, event)` returning
   `{ kind: "public" } | { kind: "converted"; name: string; tasks } | { kind: "blocked"; reason: string }`
   by the table in decision 7, and `createAuthorizerPlan(service)` returning the registry entries
   to generate, the Request Authorizer Function skeletons, and whether `migrationBlocked` is
   needed. Every caller (route template, index template, generated-file list, converted items,
   manual tasks, `supported`/`unsupported`, compatibility rows) uses these two functions; none
   re-reads `event.authorizer`.
3. `src/authorizers.ts` template, target shape:

   ```ts
   import {
     createAuthorizers,
     jwtAuthorizer,
     lambdaAuthorizer,
     requestAuthorizer,
   } from "@voke/aws";

   export const authorizers = createAuthorizers({
     cognitoJwt: jwtAuthorizer({
       issuer: "https://...",
       audience: ["..."],
       identitySource: ["$request.header.Authorization"],
     }),
     customLambda: lambdaAuthorizer({
       function: "authorizerFn",
       identitySource: ["$request.header.X-Api-Token"],
       cacheTtlSeconds: 300,
     }),
     migrationBlocked: lambdaAuthorizer({ function: "migrationBlocked" }),
   });

   // Original Serverless handler: src/auth.handler
   // Denies every request until the original authorizer logic is ported.
   export const authorizerFn = requestAuthorizer({
     name: "authorizerFn",
     handler: () => ({ authorized: false }),
   });

   // Routes whose authorizer could not be migrated use this. See MIGRATION_REPORT.md.
   export const migrationBlocked = requestAuthorizer({
     handler: () => ({ authorized: false }),
   });
   ```

   Export names go through `toIdentifier`; registry keys stay the Serverless names.

4. `createRouteTemplate` adds `authorizer: "<name>",` before `handler`; `createIndexTemplate`
   imports from `./authorizers`, adds `authorizers,` to `http({`, and spreads the Request
   Authorizer Functions into `createFunctions`.
5. Report: converted items say which authorizer protects a route (`high` confidence when
   converted, `low` with "generated behind migrationBlocked" when blocked); add a compatibility
   row "HTTP authorizers" (`Supported`, `Manual work` or `Not present`); the "HTTP API event" and
   "REST API event" rows read `Manual work` when any of their routes is blocked.
6. CORS per decision 8 (`api: { cors: true }` in the config template; tasks otherwise).

**Verify before coding** (planner's knowledge of Serverless Framework, not checked against its
source): the `httpApi` event accepts `authorizer` as a name string, `{ name, scopes }`, `{ id }`
and `{ type: aws_iam }`; `provider.httpApi.authorizers.<name>` accepts `type` (`jwt` | `request`),
`identitySource`, `issuerUrl`, `audience`, `functionName`, `functionArn`, `resultTtlInSeconds`,
`enableSimpleResponses`, `payloadVersion`. Check
`https://www.serverless.com/framework/docs/providers/aws/events/http-api`. A shape the table does
not name is blocked by its last row, so a wrong guess fails closed.

### Step 5: Report what is read and dropped

Tests first, then implement decisions 9, 10 and 11: the per-function task (dropped `timeout`,
`memorySize`, `layers`, unsupported `runtime`, renamed environment keys), the
`provider.deploymentBucket` task, the DynamoDB rule (a table with `TableName`, a
`GlobalSecondaryIndexes` list or a key of type `N` is not in the config and has the existing
"requires manual migration" task; the existing `OrdersTable` and `UsersTable` test cases still
generate), and the `supported` list. Update the `supported` pins at
`test/serverless-migration.test.ts:656-668` and `:705-727` accordingly.

### Step 6: `package.json` and `tsconfig.json` from the scaffold

Tests first: the generated `package.json` has no `workspace:` value, its `name` is the kebab-case
service name with no scope, and it deep-equals what `createApiProject` writes for the same name;
the generated `tsconfig.json` has no `extends`.

Implementation: export `projectPackageJson` and `tsconfig` from `packages/core/src/scaffold.ts`;
delete `createTsconfig` and `createPackageJson` in the migrator and call the scaffold's. Mention
the extra scripts (`deploy`, `local`, `remove`) in the guide.

### Step 7: CLI output

Test first (extend "runs serverless migration through the CLI parser" with a captured `output`):
for a file with blocking tasks the output is the existing line followed by
`<n> blocking task(s) in <directory>/MIGRATION_REPORT.md:` and one line per task; without
blocking tasks the output is unchanged. A file with an unreadable tag makes `runCli` reject with
a `CliUsageError` and writes nothing.

Implementation: `migrateServerless` returns the directory and the blocking tasks (check its
callers with `grep -rn migrateServerless packages`; at planning time only `cli.ts:747`); the
`migrate` handler prints them. Keep the edit inside those two places: plan 026 changes the rest
of `cli.ts`.

### Step 8: Docs, vocabulary, fixtures

- `apps/docs/content/docs/guides/serverless-migration.mdx`: replace the "Limits of the YAML
  parser" callout (anchors, merge keys and block scalars are read; block-form tags stop the
  command, with the long-form remedy); add "Authorizers" (the table of decision 7, what
  `migrationBlocked` is and how to remove it), "Values the migrator does not copy" (decision 4),
  the `Blocking` level under "Read the reports", the changed rows of the compatibility matrix,
  the DynamoDB rule, CORS, and the new `package.json`/`tsconfig.json` description. Any TypeScript
  fence must be ` ```ts twoslash ` and compile (`apps/docs/test/samples.test.ts`); use
  ` ```txt ` for generated-file excerpts, as the page already does.
- `apps/docs/content/docs/reference/cli.mdx`, `## migrate`: the blocking lines and the "stops on
  an unreadable file" behaviour.
- `CONTEXT.md`: add **Blocking Migration Task** ("A manual task in a Serverless migration report
  that must be done before traffic moves, because the generated project differs from the
  Serverless service in who can call a route." _Avoid_: warning, unsupported feature).
- Regenerate the two snapshot fixtures a final time and review the full diff.

**Manual check, reported as run or skipped**: run the migrator on the new example fixture into a
temporary directory, open `MIGRATION_REPORT.md` and confirm the `### Blocking` section lists the
six cases. If the generated project can resolve `voke` and `@voke/aws` from where you wrote it
(inside the monorepo, with `workspace:*` substituted by hand in a throwaway copy), run
`voke synth` there and confirm every protected route has an `AuthorizationType`; delete the copy
afterwards. If the modules do not resolve, say so; it is not a blocker.

## Test plan

- All new tests go in `packages/core/test/serverless-migration.test.ts`, modelled on its
  existing tests (inline YAML strings, `createServerlessMigration`, assertions on
  `migration.files[...]` and `migration.report`). Fixture-file tests follow
  "generates skeletons from example Serverless migration fixtures" (`:878`).
- New cases: the YAML group of Step 1 (about 12), literals (5), the blocking level (1),
  authorizers (8, including the "no protected event without an `authorizer:` line" loop),
  dropped settings (4), project files (2), CLI (3).
- Updated: the environment pins, the two `supported` pins, both report snapshots.
- No test touches the network or AWS. `cd packages/core && bun test test/serverless-migration.test.ts`
  → 0 fail.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] For the new example fixture, no generated route of an event that had `authorizer` or
      `private: true` lacks an `authorizer:` line (test), and the report has a `blocking` task
      for each non-equivalent case
- [ ] No generated `voke.config.ts` in the test suite contains `${`, `!Ref`, `[object Object]`,
      or the strings `">"` / `"|"` as an environment value (add this as one assertion helper
      used by the tests that generate a config)
- [ ] `<<: *anchor` and block scalars parse to their real values; a block-form tag, a syntax
      error and an empty file each reject with a `CliUsageError` and write no file
- [ ] `grep -n "workspace:\|\.\./\.\./tsconfig" packages/core/src/serverless-migration.ts`
      returns no matches; `packages/core/package.json` has no `dependencies` key
- [ ] `grep -n "String(entry)\|parseScalar" packages/core/src/serverless-migration.ts` returns
      no matches
- [ ] `MIGRATION_REPORT.md` renders `### Blocking` first and the summary has `Blocking tasks`
- [ ] The guide documents authorizers, uncopied values and the blocking level; `cd apps/docs && bun run test`
      exits 0; `CONTEXT.md` defines **Blocking Migration Task**
- [ ] `git status --short` shows only in-scope paths (plus the three entries that were dirty at
      planning time: `apps/docs/next-env.d.ts`, `apps/docs/.gitignore`, `apps/docs/.impeccable/`)
- [ ] The manual check is reported as run or skipped with the reason
- [ ] `.factory/plans/README.md` row updated by its owner

## STOP conditions

- `Bun.YAML.parse` in the installed Bun does not preserve the `U+E000` marker in one of the four
  positions (plain scalar, quoted scalar, flow-sequence item, flow-map key), or mis-parses merge
  keys or block scalars. Report the failing input; do not fall back to the old parser and do not
  add a YAML package without a decision.
- Generating closed routes needs a change outside core's migrator, for example
  `requestAuthorizer` or `lambdaAuthorizer` in `@voke/aws` cannot express a deny-all authorizer,
  or `http({ authorizers })` rejects a registry with an authorizer that only blocked routes use.
- The Serverless Framework documentation contradicts decision 7 in a way that would make a
  "converts" row accept a shape that is **not** equivalent (the blocked rows are safe by
  construction). Report the shape; do not widen a "converts" row on your own.
- Exporting from `scaffold.ts` conflicts with a change plan 034 has already landed there.

## Maintenance notes

- Until plan 033 lands, a JWT Authorizer is not enforced by `voke dev` or in tests; it is
  enforced by API Gateway once deployed. `migrationBlocked` and the Request Authorizer skeletons
  are enforced everywhere. The guide should say this in one sentence and drop it when 033 lands.
- When Voke gains JWT scopes or IAM authorization, move the matching row of decision 7 from
  blocked to converted and delete its blocking task.
- A reviewer should check three things: `resolveRouteAuthorizer` is the only reader of
  `event.authorizer`; its fall-through branch returns `blocked`; and no code path builds
  generated text from a value that did not pass `classifyValue`/`literalString`.
- The tag scanner is deliberately small. Block-form tags (`Value: !Join` followed by a list)
  stop the command; if users hit that often, extend the scanner rather than loosening the stop.
- Duplicate YAML keys are accepted by `Bun.YAML` (last one wins); Serverless Framework rejects
  such files, so a valid input does not have them.
- Deferred: a `${self:...}` resolver; converting per-function `timeout`/`memorySize` to
  `synthesis`; converting DynamoDB tables with a `TableName` or indexes; a non-zero exit code
  when blocking tasks exist; the idea of migrating the output of `serverless print` (it resolves
  variables, but may print decrypted secrets; not verified).

## Findings checked and dropped

- None of the audit leads was wrong. Two were refined: the generated `tsconfig.json`
  (`extends: "../../tsconfig.json"`) is monorepo-only as well as the `package.json`; and a
  protected route is not entirely silent today, because `provider.httpApi` appears once as a
  medium-risk "unknown field", which does not say that routes became public.
- New finding that changes the parser decision: `Bun.YAML` drops custom tags without an error,
  so replacing the parser alone would turn `!Ref X` into the literal `"X"`.
