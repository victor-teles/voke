# Plan 024: A Function Contract written with `@voke/schema` types callers and handler results as strictly as one written with Zod

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; report status to it instead of editing the index.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/schema packages/core/src/invoke.ts packages/core/src/route-builder.ts packages/core/src/standard-schema.ts packages/core/test packages/openapi/test apps/docs/content/docs/guides`
> and `git status --short` with the recorded current state. Plan 023 lands first and edits
> `packages/core/src/invoke.ts` on purpose (how `query` and `headers` reach schemas and handlers,
> and the fallback types on `RouteDefinitionInput.handler`). Reconcile that drift: this plan
> changes only the two helper types `RouteSchemaOutput` / `RouteSchemaInput` and the result slot of
> `RouteDefinitionInput.handler`, whatever fallbacks plan 023 chose. Pause only if plan 023 removed
> those helper types or already tied the handler result to `output`.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (type-only changes in core and `@voke/schema`; they turn code that is already
  wrong at run time into compile errors, on purpose)
- **Depends on**: none hard. Ordering only: (`.factory/plans/022-root-test-run.md`),
  (plan 023, the HTTP edge plan, which edits `packages/core/src/invoke.ts` first). Plan 031
  (Remote) edits `packages/core/src/invoke.ts` / `remote.ts` later and does not depend on this.
- **Category**: bug
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

The Voke Schema Helper (`@voke/schema`) is the validator every guide and example uses, and it is
the least type-safe way to write a Function Contract. `functions.invoke("x", 42)` compiles when
the Function declares `input: schema.object({ name: schema.string() })`; a handler that returns
`{ id: 123 }` compiles for `output: schema.object({ id: schema.string() })`; and
`functions.route("POST", "/users", { body })` does not compile at all. With Zod the first two are
compile errors. A route handler that returns the wrong shape for its `output` schema compiles
with every validator and becomes a 500 at run time. Separately, a `@voke/schema` object or array
that holds an asynchronous child schema (for example a Zod schema with an async refinement)
accepts invalid data without a word. After this plan the helper declares its input types, route
handlers are checked against `output`, and asynchronous children are awaited.

## Current state

### Architecture rules (binding)

- `docs/adr/0002-standard-schema-function-contracts.md`: "Voke Functions use explicit input and
  output schemas as their primary runtime contract, and those schemas should accept Standard
  Schema-compatible validators rather than a Voke-only validation DSL. This keeps Function
  invocation type-safe and parsed across local and AWS runtimes". The helper must stay a plain
  Standard Schema validator; no Voke-only typing channel.
- `docs/adr/0007-specialized-provider-and-helper-packages.md`: `voke` (core) must not import
  `@voke/*`. `@voke/schema` imports types from `voke`. Core tests may import `@voke/schema`
  (resolved by `paths` in `packages/core/tsconfig.json`).
- `docs/adr/0007-opinionated-framework.md`: one supported way per layer; removals without
  deprecation aliases (the packages are unreleased, version `0.0.0`).
- Vocabulary (`CONTEXT.md`): **Function Contract** ("The input and output schemas that define
  what a **Function** accepts and returns"), **Voke Schema Helper** ("An optional helper package
  for authoring Standard Schema-compatible **Function Contracts** with Voke metadata"; avoid
  "validation package"), **Function Registry**, **Gateway**. `functions.route(...)` is "typed
  route invocation" of the Function Registry. This plan adds no term.
- No `any` and no `@ts-expect-error` in runtime source (`packages/*/src`). Keep it that way.

### How types are tested in this repository

There is no `expectTypeOf`. Type tests are plain files named `*-typecheck.ts` in a package's
`test/` directory. They are not run by `bun test`; each package's `tsconfig.json` includes
`test/**/*.ts`, so `bun run typecheck` (`bunx tsgo --project tsconfig.json --noEmit`) compiles
them. A positive case is an annotated declaration (`const _x: Promise<{ id: string }> = ...`); a
negative case is a `// @ts-expect-error <reason>` line, which fails the build with `TS2578 Unused
'@ts-expect-error' directive` once the code below it stops being an error. Exemplars:
`packages/core/test/standard-schema-typecheck.ts` (Zod), `packages/core/test/route-builder-typecheck.ts`
and `packages/core/test/invoke-typecheck.ts` (both use a local stub
`schema<TInput, TOutput>()`). `packages/schema/test/` has only `schema.test.ts` today.

Docs samples are `ts twoslash` fences in `apps/docs/content/docs/**`; `apps/docs/scripts/check-samples.ts`
compiles them ("`bun run check:samples [page.mdx ...]` (all pages when none are given)").

### Code at `1c59d39`

**Cause 1: every `@voke/schema` builder declares its input type as `unknown`.**
`packages/schema/src/index.ts`:

```ts
// :23-28
export type VokeSchema<TInput, TOutput = TInput> = StandardSchemaV1<
  TInput,
  TOutput
> & {
  readonly "~voke": VokeSchemaMetadata;
};
// :30
type OptionalSchema<TOutput> = VokeSchema<unknown, TOutput | undefined> & {
// :133
interface StringSchema extends VokeSchema<unknown, string> {
// :196
interface NumberSchema extends VokeSchema<unknown, number> {
// :383-385
const object = <const TShape extends Record<string, StandardSchemaV1>>(
  shape: TShape
): VokeSchema<unknown, InferObjectOutput<TShape>> =>
```

`boolean` (:298), `literal` (:316), `enum` (:328), `array` (:433), `undefined` (:469) and `null`
(:479) are `VokeSchema<unknown, …>` too. Core reads a schema's two sides from its declared `types`
(`packages/core/src/standard-schema.ts:101-108`):

```ts
export type StandardSchemaInput<TSchema> =
  DeclaredTypes<TSchema> extends { readonly input: infer TInput }
    ? TInput
    : TSchema extends {
          readonly "~standard": { validate(value: infer TInput): unknown };
        }
      ? TInput
      : never;
```

so `StandardSchemaInput<typeof helperSchema>` is `unknown`. Two core types use that input:

```ts
// packages/core/src/invoke.ts:734-740 — the payload of functions.invoke
type FunctionInput<TFunction> = TFunction extends {
  readonly input: infer TInputSchema;
}
  ? TInputSchema extends AnyStandardSchema
    ? StandardSchemaInput<TInputSchema>
    : undefined
  : never;

// packages/core/src/invoke.ts:494-508 — what an invokable handler must return
handler: FunctionHandler<
  StandardSchemaOutput<TInputSchema>,
  | StandardSchemaInput<TOutputSchema>
  | Promise<StandardSchemaInput<TOutputSchema>>,
  TVariables
>;
```

With `unknown` both accept anything. The handler's `payload` parameter is typed already, because
it reads the output side. Core needs no change for `fn(...)` and `functions.invoke(...)`.

**Cause 2: a route slot whose schema has an `unknown` side falls back to the "no schema" type.**
`packages/core/src/invoke.ts:193-203`:

```ts
type RouteSchemaOutput<TSchema, TFallback> = TSchema extends AnyStandardSchema
  ? unknown extends StandardSchemaOutput<TSchema>
    ? TFallback
    : StandardSchemaOutput<TSchema>
  : TFallback;

type RouteSchemaInput<TSchema, TFallback> = TSchema extends AnyStandardSchema
  ? unknown extends StandardSchemaInput<TSchema>
    ? TFallback
    : StandardSchemaInput<TSchema>
  : TFallback;
```

`RouteInvocationInput.body` (:300-302) is `RouteSchemaInput<TSchema, undefined>`, so a helper
body schema (input `unknown`) makes `body` `undefined`:
`Type '{ name: string; }' is not assignable to type 'undefined'`. `params`, `query` and `headers`
have permissive fallbacks, which is why only `body` fails to compile.

The `unknown extends` branch is load-bearing and must not simply be deleted. For a route written
inline in `http({ routes: [route.get("/x", { handler })] })`, TypeScript infers the type
arguments of a slot that has no schema from the contextual return type, which is
`AnyStandardSchema` (`StandardSchemaV1<unknown, unknown>`), not from the `= undefined` default.
The branch maps that back to the fallback. Removing it was tried during planning: `request.params`,
`request.headers` and `request.query` became `unknown` in `packages/core/test/api.test.ts:149`,
`packages/core/test/public-api-redesign.test.ts:168-173`, `packages/idempotency/test/plugin.test.ts:95`
and others.

**Cause 3: a route handler's result is not tied to the route's `output` schema.**
`packages/core/src/invoke.ts:216-243`:

```ts
export interface RouteDefinitionInput<
  // ...
  TOutputSchema extends AnyStandardSchema | undefined,
  TResult,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> {
  readonly authorizer?: RouteAuthorizerReference;
  readonly body?: TBodySchema;
  readonly handler: RouteHandler<
    RouteSchemaOutput<TBodySchema, undefined>,
    RouteSchemaOutput<TParamsSchema, Record<string, string>>,
    RouteSchemaOutput<TQuerySchema, Record<string, string>>,
    RouteSchemaOutput<THeadersSchema, Headers>,
    TResult,
    TVariables
  >;
  // ...
  readonly output?: TOutputSchema;
```

`TResult` is inferred from the handler alone, so any shape compiles, with Zod as well. All eight
methods of `Voke` in `packages/core/src/route-builder.ts` (`delete`, `get`, `head`, `options`,
`patch`, `post`, `put`, `route`) take this one interface, so one edit covers them.

**What happens to a `Response` today** (`packages/core/src/invoke.ts:160-164, 1208-1223`):

```ts
export type RouteReturn<TResult> =
  | TResult
  | Promise<TResult>
  | Response
  | Promise<Response>;

const parseRouteOutput = async (route, value) => {
  if (value instanceof Response || route.output === undefined) {
    return value;
  }
  return await parseRoutePart(
    route.output,
    value,
    "result",
    route,
    "INVALID_RESULT"
  );
};
```

A handler may always return a `Response`, and a `Response` skips output validation.
`apps/docs/content/docs/guides/http-routes.mdx` already says: "An `output` schema on a route
validates the handler's return value before Voke serializes it. It does not apply when the
handler returns a `Response`."

**Cause 4: `@voke/schema` casts a child's result as synchronous.**
`packages/schema/src/index.ts`:

```ts
// :346-351 (optional)
      value === undefined
        ? success()
        : (inner["~standard"].validate(value) as Validation<
            InferOutput<TSchema>
          >),
// :410-412 (object)
        const result = child["~standard"].validate(
          input[key]
        ) as Validation<unknown>;
// :445-447 (array)
        const result = item["~standard"].validate(entry) as Validation<
          InferOutput<TItem>
        >;
```

When the child returns a promise, `result.issues` is `undefined`, so the parent treats it as a
success with value `undefined`. Run during planning against `1c59d39` with a child whose
`validate` is `async` and rejects non-strings:
`schema.object({ name: child, tags: schema.array(child), opt: schema.optional(child) })`
validating `{ name: 1, tags: [2, "a"], opt: 3 }` returned, synchronously,
`{ value: { name: undefined, tags: [undefined, undefined], opt: undefined } }`. Every caller in
the repository already awaits the result (`packages/core/src/invoke.ts:1020`,
`packages/core/src/variables.ts:259`, `packages/aws/src/event-payload.ts:47`,
`packages/aws/src/kinesis.ts:226`, `packages/aws/src/dynamodb-stream.ts:266`), so a schema whose
`validate` returns a promise works everywhere Voke runs it.

### Findings checked and corrected

- "The handler received `{}`" (audit): not exact. The handler receives the object with the
  asynchronous fields set to `undefined` (see the run above). Same bug, same fix.
- "Route output is not tied to the handler … becomes a runtime 500": confirmed for Zod and for
  the helper.
- All other leads for this plan were confirmed by a `tsgo` probe on a scratch copy of the
  packages.

### Verified during planning (on a scratch copy; nothing in the repository was changed)

The changes in Steps 2–4 were applied to a copy of `packages/` and compiled together with every
package's `src` and `test`, every `examples/*` source, `apps/docs/snippets`, and all 139 files
extracted from the `ts twoslash` fences of `apps/docs/content/docs/**` and `README.md`. Exactly
two places stopped compiling, both correct findings; Steps 4 and 5 fix them:

1. `packages/openapi/test/document.test.ts:434` — a route with `output: z.object({ id: z.string() })`
   whose handler is `const ok = () => ({ ok: true })`.
2. `apps/docs/content/docs/guides/sqs-events.mdx`, section "Test an SQS Function" — a message
   `{ id: "m2", body: "not json" }` sent to a Function whose message schema is
   `schema.object({ orderId: schema.string() })`.

The type tests in Step 1 were compiled against both states: 10 errors before the change, none
after. `packages/schema/test/schema.test.ts` (11 tests) passed against the changed helper.

## Decisions taken in this plan

1. **Every `@voke/schema` builder declares its input type.** Default: the input type is what a
   caller should pass. `string()`, `number()`, `boolean()`, `literal(v)`, `enum([...])`, `null()`
   and `undefined()` have the same input and output type; `coerce.number()` has input
   `number | string` and output `number`; `optional(inner)` adds `undefined` to both sides;
   `array(item)` and `object(shape)` build each side from their children, and an object key whose
   schema is optional is an optional key on both sides. Reason: Standard Schema carries the input
   type in `~standard.types.input`, core already reads it, and Zod declares it the same way.
   Reverse: put `unknown` back as the first type argument of the builders' return types.

2. **`validate` on a helper schema still accepts `unknown`.** Default: `VokeSchema` declares
   `validate(value: unknown)` and carries the input type only in `types`, exactly as the Standard
   Schema specification and Zod do. Reason: a validator exists to be run against untrusted data;
   with `validate(value: TInput)` a direct call such as
   `payload["~standard"].validate({ kind: "owner" })` in
   `packages/core/test/public-api-redesign.test.ts:333-341` would need a cast. Core's
   `StandardSchemaV1` interface is not changed. Reverse: define `VokeSchema` again as
   `StandardSchemaV1<TInput, TOutput> & { "~voke": … }`.

3. **A route handler returns what its `output` schema accepts, or a `Response`.** Default: when a
   route declares `output`, the handler's result type is `StandardSchemaInput<output>` (the same
   rule `fn(...)` uses), checked at compile time. Returning a `Response` stays legal on every
   route and stays unvalidated at run time: it is the route layer's one escape hatch for status
   codes, headers and error bodies (the guides return `error("Order not found", { status: 404 })`
   next to a plain value), and validating a serialized body is a change to request handling,
   which plan 023 owns. The static type of `functions.route(...)` for such a route stays the
   `output` schema's output type; when the handler returns a `Response`, the call resolves to
   that `Response` at run time. The docs say so (Step 5). Reverse: in `RouteDefinitionInput`,
   put `TResult` back in the handler's result slot.

4. **A declared route schema is read as declared when it types at least one side.** Default: the
   "no schema" fallback applies only when both the input and the output of the slot's schema type
   are `unknown`. A hand-written `StandardSchemaV1<unknown, { sku: string }>` body then gives
   `request.body: { sku: string }` (as today) and lets `functions.route("POST", …, { body })`
   pass any value (today: only `undefined`). A schema with both sides `unknown` (`z.unknown()`)
   keeps today's fallback, because its type cannot be told apart from an empty slot (see
   Cause 2). Reverse: restore the two conditionals quoted under Cause 2.

5. **Asynchronous child schemas are awaited.** Default: `object` and `array` collect their
   children's results; when at least one is a promise they return a promise of the combined
   result, otherwise they stay synchronous (no promise allocated on the common path). `optional`
   returns its child's result untouched. Reason: the specification lets `validate` return a
   promise, every Voke caller awaits, and an "is this child asynchronous" check cannot be made at
   compile time, so rejecting would only be a different run-time surprise. Reverse: replace the
   promise branch with `throw new TypeError(...)` naming the key.

6. **`@voke/aws` is not changed.** `functions.sendEvent("processOrder", { messages })` types each
   `body` from the message schema's input. With the helper typed, a raw string body for an object
   schema is a compile error, as it already is with Zod
   (`packages/core/test/invoke-typecheck.ts:168-169`). The docs sample that sends
   `body: "not json"` gets a cast (`as never`, the idiom of `packages/aws/test/sns.test.ts:176`).
   Reverse / follow-up: widen `SqsEventInvocationMessage.body` to `TBody | string` in
   `packages/aws/src/sqs.ts`.

7. **No ADR, no `CONTEXT.md` entry, no public-surface change.** ADR 0002 already promises
   type-safe invocation; this plan makes the helper honour it. No export is added or removed
   (`packages/core/test/public-surface.test.ts` pins runtime exports and stays untouched).

## Commands you will need

| Purpose                 | Command                                                                                    | Expected on success                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Helper tests            | `cd packages/schema && bun test`                                                           | all pass                                                               |
| Helper types            | `cd packages/schema && bun run typecheck`                                                  | exit 0                                                                 |
| Core types              | `cd packages/core && bun run typecheck`                                                    | exit 0                                                                 |
| Core route tests        | `cd packages/core && bun test test/route-builder.test.ts test/public-api-redesign.test.ts` | all pass                                                               |
| OpenAPI types and tests | `cd packages/openapi && bun run typecheck && bun test`                                     | exit 0, all pass                                                       |
| Everything              | `bun run typecheck` and `bun run test` (repo root)                                         | exit 0                                                                 |
| Docs samples            | `cd apps/docs && bun run check:samples`                                                    | exit 0 (not run during planning; see its header comment for arguments) |
| Lint and format         | `bun run check`; fix with `bun x ultracite fix`                                            | exit 0                                                                 |

## Implementation rules relevant to this plan

- Test first (`AGENTS.md`): add the type tests and the runtime test of Step 1, see them fail,
  then change the source.
- No `any`, no `@ts-expect-error`, no `as unknown as` in `packages/*/src`. The existing
  `as StringSchema` / `as NumberSchema` casts on `makeSchema(...)` stay.
- Ultracite formats files. A `// @ts-expect-error` comment applies to the next line only; after
  `bun x ultracite fix` reflows a test file, run the typecheck again and move the comment to the
  line above the reported error if needed. Keep the handlers under a directive on one line.
- Do not change run-time request handling in `packages/core/src/invoke.ts` (anything below the
  type declarations: `parseRoutePart`, `createRouteRequest`, `parseRouteOutput`, `runRoute`).
  Plan 023 owns it.
- Do not change the exported generic parameter lists of `RouteDefinition`, `RouteDefinitionInput`
  or `VokeSchema` (names, order, count).
- Keep validation issue order and messages in `@voke/schema` exactly as they are:
  "Unexpected property" issues first, then one entry per shape key in shape order
  ("Required" or the child's issues with the key prefixed).

## Scope

**In scope** (the only files you should modify):

- `packages/schema/src/index.ts`
- `packages/schema/test/schema.test.ts`
- `packages/schema/test/schema-typecheck.ts` (create)
- `packages/core/src/invoke.ts` (type declarations only: `RouteSchemaOutput`, `RouteSchemaInput`,
  a new `IsUntypedSchema` and `RouteHandlerResult`, and the result slot of
  `RouteDefinitionInput.handler`)
- `packages/core/test/standard-schema-typecheck.ts`
- `packages/core/test/route-builder-typecheck.ts`
- `packages/openapi/test/document.test.ts` (one handler)
- `apps/docs/content/docs/guides/schemas.mdx`
- `apps/docs/content/docs/guides/http-routes.mdx`
- `apps/docs/content/docs/guides/sqs-events.mdx`
- Any other test, example or docs sample that stops compiling because it passes a value its own
  schema rejects or returns a shape its own `output` rejects: fix the value, not the types.

**Out of scope** (do NOT touch):

- `packages/core/src/standard-schema.ts` — core's reading of Standard Schema is correct.
- `packages/core/src/route-builder.ts` — the eight methods need no edit.
- Run-time request handling, query/headers shapes, 4xx mapping — plan 023.
- `packages/core/src/remote.ts`, `packages/remote` — plan 031.
- `packages/aws/src/sqs.ts` — Decision 6.
- The typing of `functions.route(...)` results (see Maintenance notes) and the wording of the
  `fn(...)` overload error.

## Git workflow

- Branch: `feature/schema-helper-types`, stacked on the previous plan's branch (`origin/main`
  stops at PR #52; newer work is stacked on feature branches).
- Commit subjects are imperative sentences that state the outcome, for example
  "Type callers and handler results from @voke/schema contracts". Commit only if the task
  authorizes it. Do not push or open a PR unless told.

## Steps

### Step 1: Write the failing tests

**1a. Create `packages/schema/test/schema-typecheck.ts`:**

```ts
import { createFunctions, fn, http, route } from "voke";
import type {
  StandardSchemaInput,
  StandardSchemaOutput,
  StandardSchemaV1,
} from "voke";

import { schema } from "../src/index";

const order = schema.object({
  deletedAt: schema.null(),
  id: schema.string().min(1),
  kind: schema.literal("order"),
  note: schema.optional(schema.string()),
  paid: schema.boolean(),
  quantity: schema.coerce.number().int(),
  status: schema.enum(["pending", "paid"]),
  tags: schema.array(schema.string()),
});
const orderId = schema.object({ id: schema.string() });

// The input side is typed: an optional key may be left out, a coercing number accepts a string.
const orderInput: StandardSchemaInput<typeof order> = {
  deletedAt: null,
  id: "ord_1",
  kind: "order",
  paid: false,
  quantity: "2",
  status: "pending",
  tags: ["gift"],
};
// @ts-expect-error The input of a @voke/schema object is typed, not unknown.
const numberAsInput: StandardSchemaInput<typeof order> = 42;
// @ts-expect-error A field of the input is typed.
const wrongField: StandardSchemaInput<typeof orderId> = { id: 1 };
// @ts-expect-error A required key cannot be left out.
const missingKey: StandardSchemaInput<typeof orderId> = {};
// @ts-expect-error An enum input is one of its values.
const wrongStatus: StandardSchemaInput<typeof order>["status"] = "shipped";

// The output side keeps its types: a coercing number always returns a number.
const quantity: StandardSchemaOutput<typeof order>["quantity"] = 2;
// @ts-expect-error The coerced output is a number.
const quantityText: StandardSchemaOutput<typeof order>["quantity"] = "2";

// `validate` accepts any value, as the specification requires.
void order["~standard"].validate("untrusted");
const anySchema: StandardSchemaV1<unknown, unknown> = order;

const functions = createFunctions({
  createOrder: fn({
    handler: (payload) => ({ id: payload.id }),
    input: order,
    output: orderId,
  }),
  orders: http({
    routes: [
      route.post("/orders", {
        body: orderId,
        handler: (request) => ({ id: request.body.id }),
        output: orderId,
      }),
    ],
  }),
});

void functions.invoke("createOrder", orderInput);
// @ts-expect-error The payload is checked against the @voke/schema input schema.
void functions.invoke("createOrder", 42);

const routed: Promise<{ readonly id: string }> = functions.route(
  "POST",
  "/orders",
  { body: { id: "ord_1" } }
);
// @ts-expect-error The route body is checked against the @voke/schema body schema.
void functions.route("POST", "/orders", { body: { id: 1 } });

fn({
  // @ts-expect-error An invokable handler returns what its output schema accepts.
  handler: () => ({ id: 1 }),
  output: orderId,
});

void route.get("/orders/:id", {
  // @ts-expect-error A route handler returns what its output schema accepts.
  handler: () => ({ id: 1 }),
  output: orderId,
});

void [
  orderInput,
  numberAsInput,
  wrongField,
  missingKey,
  wrongStatus,
  quantity,
  quantityText,
  anySchema,
  routed,
];
```

**1b. Append to `packages/core/test/standard-schema-typecheck.ts`** (add
`import { route } from "../src/route-builder";` to its imports; `user` is the Zod schema the file
already defines):

```ts
// A route handler is checked against its `output` schema, whatever the validator.
void route.post("/users", {
  body: user,
  handler: (request) => ({ id: request.body.id }),
  output: user,
});
void route.get("/users/:id", {
  // @ts-expect-error A route handler returns what its Zod output schema accepts.
  handler: () => ({ id: 1 }),
  output: user,
});
// A `Response` is always allowed; the `output` schema does not apply to it.
void route.get("/users/:id/avatar", {
  handler: (request) =>
    request.params.id === "usr_1"
      ? { id: "usr_1" }
      : new Response(null, { status: 404 }),
  output: user,
});

fn({
  // @ts-expect-error An invokable handler returns what its Zod output schema accepts.
  handler: () => ({ id: 1 }),
  output: user,
});
```

**1c. Append to `packages/core/test/route-builder-typecheck.ts`** (`app` and the stub `schema`
exist in the file):

```ts
// With an `output` schema the handler returns what that schema accepts, or a `Response`.
void app.get("/typed-output", {
  handler: async () => ({ id: "usr_1" }),
  output: schema<{ id: string }>(),
});
void app.get("/typed-output/response", {
  handler: () => new Response(null, { status: 404 }),
  output: schema<{ id: string }>(),
});
void app.get("/typed-output/wrong", {
  // @ts-expect-error the handler result is checked against the output schema input.
  handler: () => ({ id: 1 }),
  output: schema<{ id: string }>(),
});

// A schema that accepts `unknown` and returns a typed value is read as declared.
const acceptAnything = createFunctions({
  skus: fn({
    routes: [
      app.post("/skus", {
        body: schema<unknown, { sku: string }>(),
        handler: (req) => ({ sku: req.body.sku }),
      }),
    ],
  }),
});
void acceptAnything.route("POST", "/skus", { body: { anything: 1 } });
```

**1d. Add to `packages/schema/test/schema.test.ts`** (it has a `validate(target, value)` helper):

```ts
// A child from another library may validate asynchronously (a Zod async refinement, for example).
const asyncString = {
  "~standard": {
    validate: async (value: unknown) =>
      typeof value === "string"
        ? { value: value.toUpperCase() }
        : { issues: [{ message: "Expected string (async)" }] },
    vendor: "voke-test",
    version: 1 as const,
  },
};
```

- "awaits a child schema that validates asynchronously": for
  `schema.object({ name: asyncString, nick: schema.optional(asyncString), tags: schema.array(asyncString) })`,
  `await validate(target, { name: 1, nick: 3, tags: [2, "a"] })` equals `{ issues: [...] }` with
  the message `"Expected string (async)"` at paths `["name"]`, `["nick"]`, `["tags", 0]`, in that
  order; `await validate(target, { name: "ada", tags: ["a"] })` equals
  `{ value: { name: "ADA", tags: ["A"] } }`.
- "stays synchronous when every child is synchronous":
  `validate(schema.object({ tags: schema.array(schema.string()) }), { tags: ["a"] })` is not an
  instance of `Promise`.
- "keeps issue order with a missing key before an invalid one": for
  `schema.object({ a: schema.string(), b: schema.string(), c: schema.string() })` and
  `{ c: 1, extra: true }` the issues are, in order, `Unexpected property` at `["extra"]`,
  `Required` at `["a"]`, `Required` at `["b"]`, `Expected string` at `["c"]`. (This passes today;
  it guards the rewrite in Step 3.)
- "a child whose validation rejects makes the parent reject": a child whose `validate` returns
  `Promise.reject(new Error("boom"))` makes `validate(schema.object({ a: child }), { a: 1 })`
  reject with `boom`.

**Evidence**: `cd packages/schema && bun run typecheck` and `cd packages/core && bun run typecheck`
fail with `TS2578 Unused '@ts-expect-error' directive` (and
`Type '{ id: string; }' is not assignable to type 'undefined'` for the two positive
`functions.route` / `acceptAnything.route` calls); `cd packages/schema && bun test` fails the
first new test.

### Step 2: Declare input types in `@voke/schema`

In `packages/schema/src/index.ts`:

1. Import `StandardSchemaInput` and `StandardSchemaOutput` from `"voke"` (both are exported by
   `packages/core/src/index.ts:52,54`) and use them instead of the local `InferOutput`, so the
   helper reads a child schema exactly as core does. Delete `InferOutput`.

2. Replace the `VokeSchema` alias (Decision 2). Keep the name and its two type parameters:

   ```ts
   // `types` declares what a caller should pass; `validate` still accepts any value, as the
   // Standard Schema specification requires, so a schema can be run against untrusted data.
   export interface VokeSchema<TInput, TOutput = TInput> {
     readonly "~standard": Omit<
       StandardSchemaV1<TInput, TOutput>["~standard"],
       "validate"
     > & {
       validate(
         value: unknown
       ): Validation<TOutput> | Promise<Validation<TOutput>>;
     };
     readonly "~voke": VokeSchemaMetadata;
   }
   ```

   `makeSchema<TInput, TOutput>` takes
   `validate: (value: unknown) => Validation<TOutput> | Promise<Validation<TOutput>>`.

3. Type each builder (Decision 1):

   ```ts
   type AnySchema = StandardSchemaV1<unknown, unknown>;

   type OptionalSchema<TInput, TOutput> = VokeSchema<
     TInput | undefined,
     TOutput | undefined
   > & {
     readonly "~voke": VokeSchemaMetadata & { readonly optional: true };
   };

   interface OptionalMarker {
     readonly "~voke": { readonly optional: true };
   }

   // Resolves the intersection so an error message shows `{ id: string }`, not the mapped types.
   type Flatten<TObject> = TObject extends infer TResolved
     ? { [TKey in keyof TResolved]: TResolved[TKey] }
     : never;

   type ObjectInput<TShape extends Record<string, AnySchema>> = Flatten<
     {
       [TKey in keyof TShape as TShape[TKey] extends OptionalMarker
         ? never
         : TKey]: StandardSchemaInput<TShape[TKey]>;
     } & {
       [TKey in keyof TShape as TShape[TKey] extends OptionalMarker
         ? TKey
         : never]?: StandardSchemaInput<TShape[TKey]>;
     }
   >;
   // ObjectOutput: the same with StandardSchemaOutput (replaces InferObjectOutput).
   ```

   | Builder                  | Return type                                                                                                                                                                |
   | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `string()`               | `StringSchema extends VokeSchema<string>`                                                                                                                                  |
   | `number()`               | `NumberSchema` where `interface NumberSchema<TInput = number> extends VokeSchema<TInput, number>` and `int`/`min`/`max` return `NumberSchema<TInput>`                      |
   | `coerce.number()`        | `NumberSchema<number \| string>` (`numberWithRules<number \| string>({ coerce: true })`; make `numberWithRules` generic in `TInput` and pass it through `int`/`min`/`max`) |
   | `boolean()`              | `VokeSchema<boolean>`                                                                                                                                                      |
   | `literal(v)`             | `VokeSchema<TValue>`                                                                                                                                                       |
   | `enum(values)`           | `VokeSchema<TValues[number]>`                                                                                                                                              |
   | `optional(inner)`        | `OptionalSchema<StandardSchemaInput<TSchema>, StandardSchemaOutput<TSchema>>`                                                                                              |
   | `object(shape)`          | `VokeSchema<ObjectInput<TShape>, ObjectOutput<TShape>>`                                                                                                                    |
   | `array(item)`            | `VokeSchema<StandardSchemaInput<TItem>[], StandardSchemaOutput<TItem>[]>`                                                                                                  |
   | `undefined()` / `null()` | `VokeSchema<undefined>` / `VokeSchema<null>`                                                                                                                               |

   The `validate` callbacks keep narrowing an `unknown` value; only the declared types change.

**Evidence**: `cd packages/schema && bun test` passes the 11 existing tests;
`grep -n "VokeSchema<unknown" packages/schema/src/index.ts` returns nothing.

### Step 3: Await asynchronous children in `@voke/schema`

Still in `packages/schema/src/index.ts` (Decision 5). Target shape, verified on the scratch copy
except for the "Required" placeholder, which the order test of Step 1d guards:

```ts
type ChildResult = Validation<unknown> | Promise<Validation<unknown>>;

const isPending = (
  result: ChildResult
): result is Promise<Validation<unknown>> => result instanceof Promise;

// A child from another library may validate asynchronously. Only then is the result a promise.
const settle = <TOutput>(
  results: readonly ChildResult[],
  combine: (settled: readonly Validation<unknown>[]) => Validation<TOutput>
): Validation<TOutput> | Promise<Validation<TOutput>> =>
  results.some(isPending)
    ? Promise.all(results).then(combine)
    : combine(results as readonly Validation<unknown>[]);
```

- `object`: keep the "Unexpected property" loop. Then build one `ChildResult` per shape key, in
  shape order: `failure("Required")` when the key is missing and the child is not optional,
  otherwise `child["~standard"].validate(input[key])`. `combine` walks the settled results in
  the same order, copies a success into `output` under today's rule
  (`result.value !== undefined || key in input`), and prefixes a failure's issues with the key
  (`withPath`). `failure("Required")` has an empty path, so `withPath(key, …)` yields today's
  `{ message: "Required", path: [key] }`.
- `array`: `value.map((entry) => item["~standard"].validate(entry))`, then `combine` builds the
  output array and the index-prefixed issues as today.
- `optional`: return `inner["~standard"].validate(value)` without the cast.
- Remove all three `as Validation<…>` casts on child results. If Ultracite rejects `.then(...)`,
  use a small `async` helper for the pending branch; the synchronous branch must not create a
  promise.

**Evidence**: `cd packages/schema && bun test` passes, including the four tests of Step 1d;
`grep -n "as Validation<" packages/schema/src/index.ts` returns nothing.

### Step 4: Tie the route handler result to `output` and read typed schemas as declared (core)

In `packages/core/src/invoke.ts`, replace `RouteSchemaOutput` and `RouteSchemaInput`
(Decision 4) and add `RouteHandlerResult` (Decision 3):

```ts
// A slot without a schema infers to the wide `StandardSchemaV1<unknown, unknown>`, so a schema
// whose two sides are both `unknown` cannot be told apart from "no schema" and keeps the fallback.
// A schema that types either side is read as declared, even when the other side is `unknown`.
type IsUntypedSchema<TSchema> =
  unknown extends StandardSchemaInput<TSchema>
    ? unknown extends StandardSchemaOutput<TSchema>
      ? true
      : false
    : false;

type RouteSchemaOutput<TSchema, TFallback> = TSchema extends AnyStandardSchema
  ? IsUntypedSchema<TSchema> extends true
    ? TFallback
    : StandardSchemaOutput<TSchema>
  : TFallback;

type RouteSchemaInput<TSchema, TFallback> = TSchema extends AnyStandardSchema
  ? IsUntypedSchema<TSchema> extends true
    ? TFallback
    : StandardSchemaInput<TSchema>
  : TFallback;

// With an `output` schema the handler returns what that schema accepts; without one, anything.
// A `Response` is always allowed (`RouteReturn`) and is not validated.
type RouteHandlerResult<TOutputSchema, TResult> =
  TOutputSchema extends AnyStandardSchema
    ? StandardSchemaInput<TOutputSchema>
    : TResult;
```

In `RouteDefinitionInput.handler`, change the fifth type argument of `RouteHandler` from
`TResult` to `RouteHandlerResult<TOutputSchema, TResult>`. Change nothing else: not
`RouteInvocationOutput`, not `RouteReturn`, not `route-builder.ts`.

Do not make `RouteHandlerResult` fall back to `TResult` for an untyped output schema. That
variant was tried: TypeScript then infers the `const TResult` parameter from the handler through
the conditional, a returned `["x"]` becomes `readonly ["x"]`, and correct handlers stop
compiling against `string[]`.

Then fix the one test that returned the wrong shape:
`packages/openapi/test/document.test.ts:434`, in "removes $schema from embedded schemas", replace
`handler: ok,` with `handler: () => ({ id: "usr_1" }),` (the route's `output` is
`z.object({ id: z.string() })`).

**Evidence**: `cd packages/core && bun run typecheck`, `cd packages/schema && bun run typecheck`
and `cd packages/openapi && bun run typecheck` exit 0; `bun run typecheck` at the root exits 0.

### Step 5: Documentation

- `apps/docs/content/docs/guides/schemas.mdx`
  - After the builders table, add a short paragraph: each builder declares both sides of the
    schema, so `functions.invoke(...)`, `functions.route(...)` and `functions.sendEvent(...)`
    reject a wrong argument at compile time and a handler that returns the wrong shape for its
    `output` schema does not compile; `schema.coerce.number()` accepts `number | string` and
    returns `number`.
  - In the same section, one sentence: a child schema from another library may validate
    asynchronously; `schema.object` and `schema.array` wait for it.
  - The sample under "In functions.invoke" already casts an untrusted value
    (`payload as { id: string }`); leave it.
- `apps/docs/content/docs/guides/http-routes.mdx`
  - Extend the sentence "An `output` schema on a route validates the handler's return value
    before Voke serializes it. It does not apply when the handler returns a `Response`." with:
    the handler's return type is checked against the `output` schema at compile time, and a
    `Response` is always allowed and never validated.
  - In "Call routes from tests", after "It returns the handler's return value (after the
    `output` schema), not an HTTP response.", add: when the handler returns a `Response`,
    `functions.route(...)` resolves to that `Response`, although its static type is the `output`
    type.
- `apps/docs/content/docs/guides/sqs-events.mdx`, section "Test an SQS Function": change the
  second message to `{ id: "m2", body: "not json" as never },` and extend the sentence "a string
  body is used as it is, so you can test bodies that are not valid JSON" with: the body is typed
  from the message schema, so cast a deliberately invalid body with `as never`.
- No change to `CONTEXT.md`, `docs/adr/*`, `README.md` or `docs/stable-public-surface.md`.

**Evidence**: `cd apps/docs && bun run check:samples` exits 0; `cd apps/docs && bun run test`
passes (`apps/docs/test/samples.test.ts` requires every `ts` fence to be `twoslash`).

### Step 6: Full verification

Run `bun x ultracite fix`, then `bun run check`, `bun run typecheck` and `bun run test` at the
root. If the formatter moved a `// @ts-expect-error` line, fix it and rerun the typecheck.

## Test plan

- New type tests (compiled by `bun run typecheck`):
  - `packages/schema/test/schema-typecheck.ts` — helper input and output types; `validate`
    accepts `unknown`; `functions.invoke` rejects a wrong payload; `functions.route` with a
    helper `body` compiles and rejects a wrong body; wrong handler result for `fn(...)` and
    `route.get(...)`.
  - `packages/core/test/standard-schema-typecheck.ts` — the same route and `fn` result checks
    with Zod; a handler that returns a value or a `Response` compiles with `output`.
  - `packages/core/test/route-builder-typecheck.ts` — result check with the stub schema; async
    handler; `Response`; a body schema with `unknown` input and typed output.
- New runtime tests in `packages/schema/test/schema.test.ts` — asynchronous children are
  awaited, the synchronous path stays synchronous, issue order is unchanged, a rejected child
  rejects the parent.
- Pattern to follow: `packages/core/test/standard-schema-typecheck.ts` for type tests,
  the existing tests of `packages/schema/test/schema.test.ts` for runtime tests.
- Regression net: every existing `*-typecheck.ts` and test file compiles unchanged except
  `packages/openapi/test/document.test.ts:434`.

## Done criteria

- [ ] `packages/schema/test/schema-typecheck.ts` exists; `cd packages/schema && bun run typecheck` exits 0
- [ ] Reverting only `packages/schema/src/index.ts` makes that typecheck fail with `TS2578` (spot check, then restore)
- [ ] `cd packages/schema && bun test` passes, with the four new tests
- [ ] `grep -n "VokeSchema<unknown" packages/schema/src/index.ts` and `grep -n "as Validation<" packages/schema/src/index.ts` return nothing
- [ ] `grep -n "RouteHandlerResult<TOutputSchema, TResult>" packages/core/src/invoke.ts` shows the handler slot of `RouteDefinitionInput`
- [ ] `git diff 1c59d39 -- packages/core/src/route-builder.ts packages/core/src/standard-schema.ts` shows no change made by this plan
- [ ] `bun run typecheck`, `bun run test` and `bun run check` exit 0 at the root
- [ ] `cd apps/docs && bun run check:samples` exits 0
- [ ] The three guides state the compile-time check, the `Response` rule and the `as never` cast
- [ ] No file outside the Scope list is modified (`git status --short`)

## STOP conditions

- Plan 023 removed `RouteSchemaOutput` / `RouteSchemaInput`, changed the generic parameter list
  of `RouteDefinitionInput`, or changed whether a `Response` is validated: the excerpts and
  Decision 3 no longer describe the code. Report before editing `invoke.ts`.
- After Steps 2–4, more than a handful of existing tests, examples or docs samples stop
  compiling, or any of them fails for a reason other than "passes a value its own schema rejects"
  or "returns a shape its own `output` rejects". Planning found exactly two. A larger number
  means inference changed (most likely `request.params` / `request.headers` turning `unknown`):
  stop and report rather than adding casts.
- Making a test pass would need `any`, `@ts-expect-error` or `as unknown as` in `packages/*/src`.
- The fix appears to need a change in `packages/core/src/standard-schema.ts`,
  `packages/core/src/route-builder.ts` or `packages/aws/src`.

## Maintenance notes

- **Reviewer focus**: the three conditional types in `invoke.ts` and the comment on
  `IsUntypedSchema`; that the helper's issue order is unchanged; that the synchronous path of
  `object` / `array` creates no promise.
- **Known limit kept**: a route slot whose schema has both sides `unknown` (`z.unknown()`) is
  still typed as if it had no schema (`request.body: undefined`, `body?: undefined` in
  `functions.route`). TypeScript infers an empty slot to the same type, so the two cannot be
  separated without restructuring the Route Builder's generics.
- **Deferred, found during planning (existing behaviour, any validator)**: for a route written
  inline in `http({ routes: [...] })` without an `output` schema, `functions.route(...)`
  resolves to `Promise<unknown>`, although `apps/docs/content/docs/guides/testing.mdx` says the
  result keeps the route's types. The cause is the same contextual inference as in Cause 2
  (`TOutputSchema` infers to `AnyStandardSchema`, and `RouteInvocationOutput` reads that first).
  A first attempt broke `const TResult` inference (see Step 4), so it needs its own plan.
- **Deferred**: `functions.route(...)` is typed with the `output` type even when the handler
  returns a `Response` (Decision 3). Making the type honest needs the handler's full return type
  in `RouteDefinition`, which changes its exported parameter list.
- **Deferred**: a wrong result in `fn({ handler, output })` is reported as "No overload matches
  this call … 'handler' does not exist in type …", because `fn` is overloaded and TypeScript
  reports the last overload. It is the same with Zod today. Route errors are precise
  (`Type 'number' is not assignable to type 'string'` on the property).
- **Deferred**: accept a raw `string` body in `functions.sendEvent` for SQS regardless of the
  message schema (Decision 6).
- **Interaction**: plan 023 changes the fallback types of `query` and `headers`; the helper types
  here take the fallback as a parameter and need no follow-up. If plan 031 moves Function
  Contract types out of `invoke.ts`, `IsUntypedSchema` and `RouteHandlerResult` move with the
  route types.
- A new `@voke/schema` builder must declare its input type; `packages/schema/test/schema-typecheck.ts`
  is where its type test goes.
