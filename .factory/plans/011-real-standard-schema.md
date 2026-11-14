# Plan 011: Function Contracts accept real Standard Schema validators such as Zod and Valibot

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; report status to it instead of editing the index.
>
> **Drift check**: Compare
> `git diff --stat 95a9ec6 -- packages/core/src packages/schema/src packages/aws/src/sqs.ts packages/*/test examples`
> and `git status --short` with the recorded current state. Reconcile routine drift;
> pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none. Stacks on plan 007 (branch `feature/aws-emulator-local-provider`, PR #59). Plan 013 (docs content) depends on this plan.
- **Category**: dx
- **Planned at**: commit `95a9ec6`, 2026-11-14

## Why this matters

ADR `docs/adr/0002-standard-schema-function-contracts.md` promises that Function Contracts
"accept Standard Schema-compatible validators rather than a Voke-only validation DSL ... letting
projects use their existing schema library". Today that is false. Voke names its type
`StandardSchemaV1`, but its result shape is `{ success, data }`, while the real Standard Schema
specification (implemented by Zod 4, Valibot, ArkType) returns `{ value }` or `{ issues }`. A Zod
schema passed to `fn({ input })` fails at runtime. Developers expect to bring their schema library;
after this plan they can, and the documentation (plan 013) can say so truthfully.

## Current state

Verified at `95a9ec6` by reading the source.

- Voke's contract type, `packages/core/src/invoke.ts:113-134`:

  ```ts
  export interface StandardSchemaIssue {
    message: string;
    path?: readonly PropertyKey[];
  }

  export type StandardSchemaResult<TOutput> =
    | { data: TOutput; success: true }
    | { issues: readonly StandardSchemaIssue[]; success: false };

  export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
    readonly "~standard": {
      readonly vendor: string;
      readonly version: 1;
      validate(
        value: TInput
      ): StandardSchemaResult<TOutput> | Promise<StandardSchemaResult<TOutput>>;
      readonly types?: { readonly input: TInput; readonly output: TOutput };
    };
  }
  ```

- The real specification (`https://standardschema.dev`, package `@standard-schema/spec` 1.x):

  ```ts
  interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": {
      readonly version: 1;
      readonly vendor: string;
      readonly validate: (
        value: unknown
      ) => Result<Output> | Promise<Result<Output>>;
      readonly types?:
        | { readonly input: Input; readonly output: Output }
        | undefined;
    };
  }
  type Result<Output> = SuccessResult<Output> | FailureResult;
  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  interface PathSegment {
    readonly key: PropertyKey;
  }
  ```

  The differences are the result shape (`value`/`issues` instead of `data`/`success`) and that a
  path item may be a `{ key }` segment.

- Places that read a validation result (all in `src`):
  - `packages/core/src/invoke.ts:1111-1135` `parseWithSchema`: `if (result.success) return result.data;`
    then `result.issues.map(formatIssue)`. `formatIssue` (`invoke.ts:1101-1107`) joins `issue.path`
    with `String`.
  - `packages/core/src/variables.ts:55-56` declares the same result type again, and `:302-303`
    reads `result.success` / `result.data` for `context.variables.<key>.json(schema)`.
  - `packages/aws/src/sqs.ts:256-257` reads `result.success` / `result.data` for SQS message
    bodies, and `:364` builds a `{ success: true }` result.
- Places that produce a validation result:
  - `packages/schema/src/index.ts` (`@voke/schema`, the first-party builder): the result type at
    `:9-10`, helpers `success(...)`/`failure(...)` at `:46-61`, and every validator below them.
  - `packages/core/src/serverless-migration.ts:1987` and `:2026`: generated skeletons contain
    `validate: (value: unknown) => ({ data: value, success: true })`.
  - Hand-written test schemas: 27 test files contain `success: true` (15 in `packages/core/test`,
    8 in `packages/aws/test`, 1 each in `packages/build/test`, `packages/remote/test`,
    `packages/core/test/fixtures/node-runtime`), plus `README.md` and
    `apps/docs/content/docs/guides/functions.mdx`.
- `packages/core/src/schema.ts` is a byte-identical copy of `packages/schema/src/index.ts` (apart
  from its import path). Nothing imports it and `packages/core/src/index.ts` does not export it. It
  is a leftover of the package split.
- Issues reach HTTP clients through `InvokeError.issues` and the error body
  `{ error: { issues?: { message, path?: PropertyKey[] }[] } }` (`packages/http/src/index.ts:1-4`,
  `packages/core/src/app.ts` `handleRouteError`).
- ADR `docs/adr/0007-opinionated-framework.md`: "Each setting has one spelling and each API has
  one name." The packages are unreleased, so removals happen without deprecation aliases.

## Decisions taken in this plan

- **Adopt the specification's shape and drop Voke's.** A validation result is `{ value }` on
  success and `{ issues }` on failure. `{ success, data }` is removed with no alias and no
  dual-shape detection (ADR 0007, opinionated framework). Owner decision on 2026-11-14: fix the code
  so third-party validators work.
- **No runtime dependency.** Keep Voke's own type declarations, made structurally identical to the
  specification, as the specification itself recommends. Do not add `@standard-schema/spec` to
  `dependencies`.
- **Issue paths are normalized at the boundary.** A `{ key }` segment becomes its `key`, so
  `InvokeError.issues`, error messages and HTTP error bodies keep `path?: PropertyKey[]`.
- **Prove interop with one real library.** Add `zod` (version 4) as a `devDependency` of
  `packages/core` for one interop test. It never enters `dependencies`.

## Commands you will need

| Purpose       | Command                                                     | Expected on success |
| ------------- | ----------------------------------------------------------- | ------------------- |
| Install       | `bun install`                                               | exit 0              |
| Core tests    | `cd packages/core && bun test`                              | 0 fail              |
| One test file | `cd packages/core && bun test test/standard-schema.test.ts` | 0 fail              |
| Schema tests  | `cd packages/schema && bun test`                            | 0 fail              |
| AWS tests     | `cd packages/aws && bun test`                               | 0 fail              |
| Repo gates    | `bun run typecheck && bun run test`                         | exit 0              |
| Lint/format   | `bun run check`                                             | exit 0              |
| Format fix    | `bun x ultracite fix`                                       | exit 0              |

## Implementation rules relevant to this plan

- Test first: write the Zod interop test and watch it fail before changing `parseWithSchema`.
- Core `src` must not import any `@voke/*` package (turbo rejects the workspace cycle). Core tests
  reach `@voke/*` through `paths` in `packages/core/tsconfig.json`.
- One result reader. `invoke.ts`, `variables.ts` and `sqs.ts` each read results today; give core one
  exported helper (for example `readStandardResult(result)` returning
  `{ ok: true; value } | { ok: false; issues: StandardSchemaIssue[] }` with normalized paths) and use
  it in all three. `variables.ts` drops its duplicate result type.
- Type inference must keep working for both kinds of schema: a real library declares `types`, and a
  hand-written schema is inferred from the `validate` parameter (`StandardSchemaInput` /
  `StandardSchemaOutput` in `invoke.ts:138-160`). Do not weaken handler payload types.
- Validation errors keep their message format: `Invalid payload for <fn>: <path>: <message>`
  (see `packages/core/test/e2e.test.ts` "Invalid payload for getUser: id is required").
- Public error body shape `{ error: { code?, message, issues?, details? } }` stays as is.
- Runtime code must not use the `Bun` global (plan 002).
- Code style: Ultracite (Oxlint + Oxfmt). No `any`; prefer `unknown` and narrowing.

## Scope

**In scope**:

- `packages/core/src/invoke.ts` (types, `parseWithSchema`, `formatIssue`), `packages/core/src/variables.ts`,
  `packages/core/src/index.ts` (export the helper and any renamed type)
- `packages/core/src/schema.ts` (delete)
- `packages/core/src/serverless-migration.ts` (the two generated `validate` lines only)
- `packages/aws/src/sqs.ts` (result reading and construction)
- `packages/schema/src/index.ts`
- `packages/core/package.json` (`devDependencies.zod` only), `bun.lock`
- Test files that hand-write schemas or assert results, in `packages/*/test` and
  `packages/core/test/fixtures/node-runtime`; `packages/core/test/standard-schema.test.ts` (create)
- `examples/*/src` and `examples/*/test`, only where a hand-written schema or a result is used
- `README.md` and `apps/docs/content/docs/guides/functions.mdx`: only the `validate: ...` lines in
  existing samples (plan 013 rewrites the surrounding documentation)
- `docs/adr/0002-standard-schema-function-contracts.md`: one added sentence recording that results
  follow the specification's `{ value } | { issues }` shape

**Out of scope**:

- Documentation restructuring and new schema guides (plan 013).
- JSON Schema or OpenAPI generation from schemas.
- Changing `@voke/schema`'s builder API (`schema.object`, `schema.string`, ...). Only its result
  shape changes.
- Async-validation behavior changes: `validate` may already return a promise, and that stays.

## Git workflow

- Branch: `feature/real-standard-schema`, created from `feature/aws-emulator-local-provider`.
- Commit only if authorized by the task; short imperative sentence-case messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Interop test first

Add `zod` 4 to `packages/core` `devDependencies` and create
`packages/core/test/standard-schema.test.ts`:

- `fn({ input: z.object({ id: z.string() }), output: z.object({ id: z.string() }), handler })` in a
  registry: `functions.invoke("getUser", { id: "usr_1" })` resolves, and
  `functions.invoke("getUser", { id: 1 })` rejects with `InvokeError` code `INVALID_PAYLOAD` whose
  `issues[0].path` is `["id"]`.
- A type-level check (a `*-typecheck.ts` file, like `packages/core/test/invoke-typecheck.ts`): the
  handler's `payload` is `{ id: string }` and a wrong payload is a `@ts-expect-error`.
- A route with a Zod `body` schema returns 400 with `issues` through `gateway.request(...)`.

**Evidence**: the runtime cases fail before Step 2 and pass after it.

### Step 2: Core reads specification results

- Replace `StandardSchemaResult` with the specification's success/failure types, and let
  `StandardSchemaIssue.path` accept `PropertyKey | { key: PropertyKey }` on input.
- Add the single result reader (see "Implementation rules") and use it in `parseWithSchema`
  (`invoke.ts`), `variables.ts` and `packages/aws/src/sqs.ts`.
- `validate` is typed so that both `(value: unknown) => ...` (real libraries) and a hand-written
  typed parameter are accepted.

### Step 3: Producers return specification results

- `packages/schema/src/index.ts`: `success(value)` returns `{ value }`, failures return
  `{ issues }`. No `success` flag anywhere.
- `packages/aws/src/sqs.ts:364` and the migrator templates (`serverless-migration.ts:1987`, `:2026`)
  produce `{ value }`.
- Delete `packages/core/src/schema.ts`.

### Step 4: Update hand-written schemas

Rewrite every hand-written `validate` in tests, fixtures, examples, `README.md` and
`functions.mdx` from `({ data: value, success: true })` to `({ value })`, and failures from
`{ issues, success: false }` to `{ issues }`. Do not change what those tests assert.

**Evidence**: `grep -rnE "success: (true|false)" packages examples README.md apps/docs/content docs --include=*.ts --include=*.tsx --include=*.md --include=*.mdx | grep -v node_modules | grep -v /dist/`
returns nothing related to schema results (deploy/test code may use an unrelated `success` field;
list any remaining match and confirm it is unrelated).

## Test plan

- `packages/core/test/standard-schema.test.ts` (new): the Step 1 cases, plus a hand-written
  specification-shaped schema, an async `validate`, and an issue whose path uses `{ key }` segments
  (normalized to keys in `InvokeError.issues` and in the HTTP error body).
- `packages/schema` tests: every builder returns `{ value }` or `{ issues }`.
- `packages/aws/test`: SQS message validation with a Zod-shaped fake (no new dependency in
  `packages/aws`) accepts valid bodies and reports invalid ones as batch item failures.
- Runtime Variables: `context.variables.<key>.json(schema)` with a specification-shaped schema.
- All existing tests pass with updated hand-written schemas.
- Structural pattern: `packages/core/test/e2e.test.ts` (invoke helpers) and
  `packages/core/test/invoke-typecheck.ts` (type-level checks).

## Done criteria

- [ ] A Zod 4 schema works as `input`, `output` and route `body` at runtime and in types (new tests)
- [ ] `grep -rn "success: true" packages/*/src` returns nothing related to schema results
- [ ] `ls packages/core/src/schema.ts` → "No such file"
- [ ] `grep -rn "from \"@voke/" packages/core/src` shows no import (generated-code template text is fine)
- [ ] `zod` appears only under `devDependencies` of `packages/core/package.json`
- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] Validation error messages and the HTTP error body shape are unchanged (existing assertions pass)
- [ ] No files outside the in-scope list are modified (`git status --short`)

## STOP conditions

- A real library's schema type is not assignable to Voke's `StandardSchemaV1` without `any` or a
  cast at the call site. Report the TypeScript error; do not ship a cast-based workaround.
- Keeping handler payload inference for hand-written schemas conflicts with accepting
  `validate(value: unknown)`. Report both options with their type errors.
- The generated Remote Function Registry or the contract artifact (`packages/remote`,
  `packages/core/src/remote.ts`) turns out to depend on the old result shape in a published format.
  Report it before changing the format.
- The owner objects to adding `zod` as a `devDependency`. Use a specification-shaped fake instead
  and say so in the report.

## Maintenance notes

- New code that validates with a schema must go through the single result reader.
- Reviewers should check that no `{ success, data }` handling survives, that issue paths are
  normalized, and that `zod` is a `devDependency` only.
- Deferred: a Valibot/ArkType interop test, and JSON Schema export for contracts.

## Execution notes (2026-11-14)

Done on branch `feature/real-standard-schema`, stacked on plan 007 (`feature/aws-emulator-local-provider`,
PR #59). Uncommitted. Gates: `bun run check` 0 errors, `bun run typecheck` 18/18, `bun run test`
23/23 tasks (core 247, `@voke/aws` 99, `@voke/schema` 2).

- **One module:** `packages/core/src/standard-schema.ts` holds the specification-shaped types
  (`StandardSchemaV1`, `StandardSchemaResult` = `{ value } | { issues }`, `StandardSchemaIssue` with
  `{ key }` path segments, `ValidationIssue` with plain keys), the inference helpers
  `StandardSchemaInput`/`StandardSchemaOutput`, the single reader `readStandardResult`, and
  `formatValidationIssue`.
  - `invoke.ts`, `variables.ts` and `packages/aws/src/sqs.ts` use them. Their duplicate types and
    formatters are gone.
  - `InvokeError.issues` is `ValidationIssue[]` (plain-key paths), so messages and HTTP error bodies
    are unchanged.
- **Producers:** `@voke/schema` returns `{ value }`/`{ issues }`. `sqs()`'s batch schema and the
  Serverless migrator templates return `{ value }`. `packages/core/src/schema.ts` (an unused copy of
  `@voke/schema`) is deleted. 26 test files, the node-runtime fixture, `README.md` and
  `guides/functions.mdx` were converted, with only the result lines changed.
- **Tests:**
  - `packages/core/test/standard-schema.test.ts`: Zod 4 as `input`/`output` and as a route `body`
    through `gateway.request`; Zod issue paths; an async specification-shaped schema with `{ key }`
    segments.
  - `packages/core/test/standard-schema-typecheck.ts`: the payload of `functions.invoke` is checked
    against a Zod schema, the handler payload is `{ id: string }`, and hand-written and annotated
    schemas infer.
  - `packages/schema/test/schema.test.ts` (new; the package had no tests).
- **Type inference fix found while building:** Zod declares `types?: ... | undefined`. A
  `types: { input: infer }` pattern does not match it, which made a Zod input `unknown`, and a
  `types?: infer` pattern does not match a schema that omits `types`. `types` is now read by key, with
  `undefined` (not `never`) when absent so the `validate` fallback still runs.

Deviations:

- `voke` exports two new values, `readStandardResult` and `formatValidationIssue`, so `@voke/aws`
  reads SQS bodies through the same helper. They are listed in `public-surface.test.ts` and in one
  line of `docs/stable-public-surface.md`, which was outside the listed scope.
- `voke` also exports the types `StandardSchemaInput`, `StandardSchemaOutput`,
  `StandardSchemaSuccessResult`, `StandardSchemaFailureResult`, `StandardSchemaPathSegment` and
  `ValidationIssue`.
- No SQS-specific Zod test in `packages/aws` (it would need `zod` there too). The SQS tests now use
  specification-shaped validators for valid and invalid bodies.
- `schema.object(...)`/`schema.array(...)` still read child results synchronously, as before. A Zod
  child inside a `@voke/schema` object works when it validates synchronously.
