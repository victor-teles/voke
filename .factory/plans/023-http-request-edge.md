# Plan 023: A route's `query` and `headers` are plain objects, and a client's mistake gets a 4xx in the Error Envelope

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/core/src/invoke.ts packages/core/src/app.ts packages/core/src/http.ts packages/core/test packages/aws/src/lambda.ts packages/aws/src/lambda-handlers.ts packages/aws/test/lambda-handlers.test.ts packages/openapi packages/idempotency/test apps/docs/content/docs docs CONTEXT.md`
> and `git status --short` with the recorded current state. Plan 022 lands first and edits test
> support files only (env handling, working directory). Reconcile that drift; pause only if it
> invalidates a decision listed below.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (changes the type and run-time shape of `request.query` and `request.headers`, and
  several response bodies that tests and docs pin)
- **Depends on**: none hard. (Ordering only: after `.factory/plans/022-*.md`; before 024 and 031,
  which also edit `packages/core/src/invoke.ts`.)
- **Category**: bug
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

A route can declare `query` and `headers` schemas, but on a real request the schema receives a
`URLSearchParams` and a `Headers` instance. `schema.object({ page: schema.string() })` and
`z.object({ page: z.string() })` therefore answer `GET /q?page=2` with 400 "Required": the feature
cannot work. Without a schema, `request.query` is typed `Record<string, string>` but is a
`URLSearchParams`, so `request.query.page` is `undefined`; the docs guide tells users to parse
`request.raw.url` instead.

The error mapping is wrong in both directions. A client that sends malformed JSON gets a 500. A
server bug (a nested `functions.invoke` with a bad payload, an output that fails its schema) is
reported with the internal Function name or the output's field names in the response body.

After this plan, `query` and `headers` are plain objects for schemas and handlers, locally and on
AWS; every client mistake gets a 4xx in the Error Envelope; every server failure gets one generic
500 and a log line.

## Current state

### Architecture rules (binding)

- `AGENTS.md`: test first; small changes; no new dependencies; Ultracite style; "Handle errors
  deliberately. Avoid … leaking internal details through public responses"; "Add … edge-case tests
  for parsing, validation, routing, serialization, and error handling".
- ADR `docs/adr/0007-opinionated-framework.md`: one supported way per layer, one spelling per
  setting, removals without deprecation aliases (the package is unreleased, version `0.0.0`).
- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: `voke` (`packages/core`) is
  provider-neutral and must not import `@voke/*`.
- Vocabulary (`CONTEXT.md`): **Gateway** (the composed HTTP app from `voke(functions, { config })`),
  **Function**, **Function Registry**, **Function Contract**, **Route Auth Context**, **HTTP API**
  (the deployed API Gateway HTTP API), **Plugin**, **Function Wrap**. `CONTEXT.md` has no term for
  the handler's request object or for the error body; this plan adds **Route Request** and
  **Error Envelope**.
- The deployed path and the local path share one code path: `packages/aws/src/lambda.ts:19-21`
  wraps the Gateway's Hono app with `handle` from `hono/aws-lambda`, which builds a `Request` from
  the HTTP API payload v2 event (`rawQueryString`, `headers`, `cookies` joined with `; ` into a
  `cookie` header, `body` base64-decoded when `isBase64Encoded`). `packages/aws/src/lambda-handlers.ts:148-160`
  uses it for every Function with routes. So everything this plan changes in core applies to both;
  the plan adds a parity test and changes no AWS source.

### Code at `1c59d39`

- **Request type**, `packages/core/src/invoke.ts:166-179`:
  ```ts
  export interface RouteRequest<
    TBody = undefined,
    TParams = Record<string, string>,
    TQuery = URLSearchParams,
    THeaders = Headers,
  > {
  ```
  and the handler type the Route Builder uses, `invoke.ts:229-236`:
  ```ts
  RouteSchemaOutput<TQuerySchema, Record<string, string>>,
  RouteSchemaOutput<THeadersSchema, Headers>,
  ```
  So without a schema `query` is typed as a record and `headers` as `Headers`.
- **`functions.route` input**, `invoke.ts:298-313`: `headers` falls back to
  `Headers | Record<string, string>`, `query` to `Record<string, string> | URLSearchParams`.
- **What the schema receives**, `invoke.ts:1178-1195` (`createRouteRequest`): `headers` is
  `headersFromInput(...)` (always a `Headers`, `:1128-1136`); `query` is
  `input.query ?? searchParamsFromUrl(request.url)`. The Gateway passes instances,
  `invoke.ts:1508-1510`:
  ```ts
  headers: contextHeaders(context),
  params: context.req.param(),
  query: searchParamsFromUrl(context.req.url),
  ```
- **Body**, `invoke.ts:1141-1153`:
  ```ts
  if (request.body === null) {
    return undefined;
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await request.clone().json();
  }
  return await request.clone().text();
  ```
  It is called only when the route has a `body` schema (`:1174-1176`), outside `parseRoutePart`.
- **Route validation errors**, `invoke.ts:1096-1126` (`parseRoutePart`): an `InvokeError` with
  code `INVALID_PAYLOAD` (or `INVALID_RESULT` for the output), message
  `Invalid <part> for <METHOD> <path>: …`, `functionName` `<METHOD> <path>`, and `issues` whose
  `path` is prefixed with the part.
- **Run and respond**, `invoke.ts:1225-1295`: `runRoute` builds the request, runs the handler
  (through Plugin Function Wraps), validates the output; `routeResponse` turns the result into a
  `Response`. `functions.route(...)` calls `runRoute` directly (`invoke.ts:2341-2362`).
- **Error mapping**, `packages/core/src/app.ts:116-142` (`handleRouteError`, installed with
  `app.onError` at `:230`): any `InvokeError` with `INVALID_PAYLOAD` becomes a 400 and any with
  `INVALID_RESULT` a 500, both with `issues`; the title comes from a regular expression on the
  message (`:65-99`) and falls back to the full message. Everything else is logged as one JSON
  line and answered with `{ code: "INTERNAL_SERVER_ERROR", message: "Internal server error" }`,
  plus `details.message` only under `voke dev` (`VOKE_DEV_SUMMARY=1`).
- **Status-to-code**, `packages/core/src/http.ts:14-24`: `jsonError` defaults `code` to
  `NOT_FOUND` for 404, `BAD_REQUEST` for other 4xx, `INTERNAL_SERVER_ERROR` otherwise.
- **404**, `app.ts:227-229`: `jsonError("Route not found", { code: "NOT_FOUND", status: 404 })`.
- **Schema object keys**, `invoke.ts:2074-2112`: `schemaObjectKeys(schema)` reads the key list a
  `@voke/schema` object exposes at `schema["~voke"].keys`; `assertRouteParamSchemas` uses it at
  Gateway composition.
- **`@voke/schema` objects are strict**, `packages/schema/src/index.ts:396-401`: every key that is
  not in the shape is an issue, `Unexpected property`. Zod's `z.object` drops unknown keys.
- **OpenAPI plugin**, `packages/openapi/src/document.ts:253-285`: `query` and `headers` schemas
  are already read as object schemas, one parameter per property. `:320-322` documents a 400 for a
  route that validates its request; `:411-426` documents the body as `application/json` only. The
  document already describes the plain-object shape; only the run time disagrees.
- **Tests that hide the bug**: `packages/core/test/route-builder.test.ts:74-84` uses hand-written
  validators (`headers.get("x-request-id")`; a query validator that reads `query.includePosts` from
  a `URLSearchParams`, gets `undefined`, and the test expects `false`).
  `packages/core/test/public-api-redesign.test.ts:168-173` branches on
  `req.query instanceof URLSearchParams`.
- **Docs that work around it**: `apps/docs/content/docs/guides/http-routes.mdx:73-93` ("Read query
  string values and headers from the raw request", `new URL(request.raw.url).searchParams`), and
  `:71` ("passes it as text otherwise").
- Hono is `4.12.18`. `HTTPException` (`hono/http-exception`) has `status`, an optional `res`, and
  `getResponse()`. `c.req.text()` and `c.req.json()` share one cache, so a second read through
  `c.req` works after middleware read the body; `request.clone()` on a used body throws.

### Behaviour measured at `1c59d39`

One Gateway, called with `gateway.request(...)`:

| Request                                                            | Today                                                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /q?page=2`, `query: schema.object({ page: schema.string() })` | 400 `{"error":{"issues":[{"message":"Required","path":["query","page"]}],"message":"Invalid query"}}`                               |
| The same with `z.object`; `headers: z.object({ "x-tenant": … })`   | 400, "expected string, received undefined"                                                                                          |
| No schema: `request.query`, `request.headers`                      | a `URLSearchParams` and a `Headers`; `request.query.page` is `undefined`                                                            |
| `POST`, `content-type: application/json`, body `{oops`             | 500 `INTERNAL_SERVER_ERROR`                                                                                                         |
| `POST`, JSON content type, no body                                 | 400 `Invalid body`, "Expected object"                                                                                               |
| `POST`, JSON content type, body `""` (a zero-length stream)        | 500                                                                                                                                 |
| `POST`, `application/vnd.api+json`, a valid JSON body              | 400 "Expected object" (the schema got a string)                                                                                     |
| `POST`, no content type or `text/plain`, a valid JSON body         | 400 "Expected object"                                                                                                               |
| `POST`, `content-type: text/plain; x=application/json`             | 200 (the `includes` test matched)                                                                                                   |
| Route middleware calls `await c.req.json()` before a `body` schema | 500 ("Body is disturbed or locked")                                                                                                 |
| `DELETE /q` when only `GET /q` exists                              | 404 `NOT_FOUND`                                                                                                                     |
| Handler calls `functions.invoke("inner", { to: 42 })`              | 400 `{"error":{"issues":[{"message":"Expected string","path":["to"]}],"message":"Invalid payload for inner: to: Expected string"}}` |
| Handler result fails `output`                                      | 500 with `issues` such as `["result","passwordHash"]`, message `Invalid result`                                                     |
| Handler throws `new HTTPException(401, { message: "nope" })`       | 500 `INTERNAL_SERVER_ERROR`                                                                                                         |

Also measured: iterating a `Headers` yields lower-case names, repeated values joined with `, `
(`cookie` with `; `).

### Findings checked and dropped

- "An empty body with a JSON content type returns 500": true only for a zero-length body stream;
  a request with no body returns 400. Both are covered by decision 4.
- A 405 for a wrong method is not planned; see decision 7.
- Noted, not planned here: Hono dispatches `HEAD` as `GET`
  (`hono-base.js`: `if (method === "HEAD") … this.#dispatch(…, "GET")`), so the local Gateway
  answers `HEAD` on a `GET` route with 200 while the deployed HTTP API has no `HEAD` route key, and
  a `route.head(...)` handler looks unreachable locally. Not verified beyond reading; it needs its
  own plan.

## Decisions taken in this plan

Each has a default, the reason, and how to reverse it.

1. **`request.query` and `request.headers` are always plain objects**, with or without a schema.
   Without a schema both are typed `Record<string, string | undefined>`. With a schema, the
   schema's input is the plain object and the handler gets the schema's output. The `Request` and
   its `Headers` stay at `request.raw`. _Why_: one shape; adding a schema must not change what kind
   of object the handler holds; it is the shape the OpenAPI plugin already documents and the shape
   of the HTTP API payload v2 event. _Reverse_: restore the `Headers` fallback in the two type
   positions and in the normalizer.
2. **Header names are lower-case.** `request.headers["x-request-id"]`, never `"X-Request-Id"`.
   `functions.route(...)` lower-cases the names it is given, so a test behaves like a request. A
   `@voke/schema` object used as a `headers` schema with a key that is not lower-case fails Gateway
   composition with a `VokeConfigError` (the same mechanism as `assertRouteParamSchemas`). Other
   validators cannot be checked; the guide states the rule. _Why_: `Headers` and the HTTP API both
   deliver lower-case names. _Reverse_: none sensible.
3. **A repeated query key or header is one string, combined with a comma.** `?tag=a&tag=b` gives
   `query.tag === "a,b"` (order of appearance, `,` with no space). Repeated headers arrive already
   combined by `Headers` (per RFC 9110), and `cookie` values are joined with `; `. Values are never
   arrays. _Why_: one value type keeps `Record<string, string>` and `schema.string()` true for
   every request; it is what the HTTP API's own `queryStringParameters` and `headers` fields do; an
   "array only when repeated" shape breaks `z.array(...)` for a single value. The exact request is
   still at `request.raw.url`. _Reverse_: change `queryRecord` to emit arrays and widen the
   fallback type; nothing else depends on it.
   Not verified: the HTTP API combines repeated headers with `,` and the local `Headers` with
   `, `. The guide tells users to split on `,` and trim.
4. **A `body` schema means a JSON body.** Voke reads the body only when the route has a `body`
   schema (unchanged). Then:
   - no body or an empty body: the schema receives `undefined`, whatever the content type;
   - a media type of `application/json` or `application/<anything>+json` (compared on the type
     before `;`, trimmed, lower-cased): parsed as JSON;
   - JSON that does not parse: 400, the same shape as a schema failure, with the single issue
     `{ message: "Malformed JSON", path: ["body"] }`. The parser's message is never used: it
     differs between Bun and Node, so local and deployed answers would differ;
   - any other or missing content type with a non-empty body: 415.
     The "passes it as text otherwise" behaviour is removed. A route that takes text, a form or
     binary data declares no `body` schema and reads `request.raw`. _Why_: one way; the OpenAPI
     document already says `application/json` only; a text body handed to an object schema produced
     a misleading "Expected object". _Reverse_: return the text instead of throwing in `readJsonBody`.
5. **Unknown keys.** `query` is validated as sent, so a strict schema (every `@voke/schema` object)
   rejects an undeclared query parameter with `Unexpected property`. A `headers` schema that
   exposes its keys (`schema["~voke"].keys`) receives only those headers, because clients, proxies
   and API Gateway always add headers the route did not declare; any other validator receives all
   headers, and the guide says a strict object schema (`z.strictObject`) cannot be used for
   headers. Without a schema the handler gets all headers. _Reverse_: delete the projection and add
   a non-strict object to `@voke/schema`.
6. **`functions.route(...)` takes plain objects.** `headers` and `query` no longer accept `Headers`
   or `URLSearchParams` instances (type and run time). _Why_: one spelling, and the argument is
   exactly what the schema receives. _Reverse_: re-add the union and convert instances.
7. **A wrong method stays a 404 `NOT_FOUND`; no 405 and no `Allow` header.** _Why_: the deployed
   HTTP API has one route key per declared method and path, so API Gateway itself answers 404 for
   another method before any Function runs. A local 405 would make `voke dev` and tests disagree
   with production. _Reverse_ (a later plan): add an `ANY <path>` route per path in
   `packages/aws/src/cloudformation-synthesis.ts` and answer 405 with `Allow` in the Gateway, both
   in one change.
8. **Every error the Gateway writes has a `code`.** The cases:

   | Case                                                    | Status  | `code`                   | `message`                                         | Extra                                   |
   | ------------------------------------------------------- | ------- | ------------------------ | ------------------------------------------------- | --------------------------------------- |
   | `body`, `params`, `query` or `headers` fails its schema | 400     | `INVALID_REQUEST`        | `Invalid body` / `params` / `query` / `headers`   | `issues`                                |
   | Malformed JSON body                                     | 400     | `INVALID_REQUEST`        | `Invalid body`                                    | the one issue above                     |
   | Unsupported content type                                | 415     | `UNSUPPORTED_MEDIA_TYPE` | `Unsupported content type: send application/json` | none                                    |
   | No route                                                | 404     | `NOT_FOUND`              | `Route not found`                                 | unchanged                               |
   | `HTTPException` below 500, without `res`                | its own | from the status          | its message, or the status default                | none                                    |
   | `HTTPException` with `res`                              | its own | n/a                      | n/a                                               | `getResponse()` as is                   |
   | Anything else                                           | 500     | `INTERNAL_SERVER_ERROR`  | `Internal server error`                           | `details.message` under `voke dev` only |

   "Anything else" includes an `HTTPException` of 500 or more (its status is kept), an output that
   fails its schema, and every `InvokeError` that comes out of the handler.

9. **What `issues` a client sees.** Input: the validator's issues, `message` as the validator
   wrote it, `path` prefixed with the part. They describe the client's own request. Output: none.
   The output failure is logged with its issues and answered with the generic 500.
10. **A request failure is decided by where it happened, not by the error's class.** Only an error
    thrown while the Gateway builds the Route Request for the route it matched is a client error.
    An `InvokeError` thrown inside the handler (a nested `functions.invoke` or `functions.route`)
    is a server failure, whatever its code. This replaces the message regular expressions in
    `app.ts`.
11. **`HTTPException` status-to-code table** (in `packages/core/src/http.ts`, replacing
    `defaultErrorCode`): 400 `BAD_REQUEST`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`,
    405 `METHOD_NOT_ALLOWED`, 409 `CONFLICT`, 413 `PAYLOAD_TOO_LARGE`, 415
    `UNSUPPORTED_MEDIA_TYPE`, 422 `UNPROCESSABLE_ENTITY`, 429 `TOO_MANY_REQUESTS`; any other 4xx
    `BAD_REQUEST`; 5xx `INTERNAL_SERVER_ERROR`. Default messages: the same names in sentence case
    (`Unauthorized`, `Too many requests`, …), `Bad request` otherwise. A response with `res`
    (for example `hono/bearer-auth`, which sets `WWW-Authenticate`) is returned unchanged, like a
    `Response` a handler returns.
12. **`functions.route(...)` keeps throwing `InvokeError`**: `INVALID_PAYLOAD` for a request part
    (including malformed JSON and an unsupported content type when a `request` is passed) and
    `INVALID_RESULT` for the output, both with full issues. That caller is the developer's test,
    not an HTTP client. `InvokeErrorCode` does not change; no export is added or removed.

## Commands you will need

| Purpose           | Command                                                        | Expected on success |
| ----------------- | -------------------------------------------------------------- | ------------------- |
| New core tests    | `cd packages/core && bun test test/http-request-edge.test.ts`  | 0 fail              |
| Core tests        | `cd packages/core && bun test`                                 | 0 fail              |
| Core typecheck    | `cd packages/core && bun run typecheck`                        | exit 0              |
| AWS parity test   | `cd packages/aws && bun test test/lambda-handlers.test.ts`     | 0 fail              |
| OpenAPI           | `cd packages/openapi && bun test && bun run typecheck`         | 0 fail, exit 0      |
| Idempotency       | `cd packages/idempotency && bun test && bun run typecheck`     | 0 fail, exit 0      |
| Docs samples      | `cd apps/docs && bun run check:samples guides/http-routes.mdx` | exit 0              |
| Docs tests, links | `cd apps/docs && bun run test && bun run lint:links`           | exit 0              |
| Format            | `bun x ultracite fix`                                          | exit 0              |
| Repo gates        | `bun run check && bun run typecheck && bun run test`           | exit 0              |

During planning only one probe ran (a throwaway script in `packages/core`, since deleted); the
gates above ran green at `1c59d39` according to the round's brief.

## Implementation rules relevant to this plan

- Test first: write the tests of Step 1, watch them fail for the reasons in "Behaviour measured",
  then change the source.
- No new dependency. `hono/http-exception` is part of `hono`, which core already depends on.
- Build records with a `Map` and `Object.fromEntries`, never by assigning to `{}` in a loop: a
  query key named `__proto__` must become an ordinary own property.
- Never put the JSON parser's message, an internal Function name or an output field name in a
  response body. Server-side detail goes to the one JSON log line (`logUnhandledRouteError`).
- Keep `packages/core` provider-neutral: no `@voke/*` import in `packages/core/src`.
- Keep the raw request readable: when no middleware has read the body, read a clone, as today.
- No `console.log`, early returns, `for...of`, top-level regular expressions (Ultracite).
- Docs samples: every TypeScript fence is ` ```ts twoslash ` and must compile
  (`apps/docs/test/samples.test.ts`). They compile against the workspace source, so the docs
  change must be in the same change as the type change.

## Scope

**In scope**:

- `packages/core/src/invoke.ts`: `RouteRequest`, `RouteDefinitionInput`, `RouteInvocationInput`,
  `createRouteRequest`, `bodyFromRequest`, `runRoute`, `routeResponse`, `mountRoute`, a header-key
  assertion next to `assertRouteParamSchemas`.
- `packages/core/src/app.ts`: `handleRouteError` and the helpers it no longer needs; the call to
  the new assertion.
- `packages/core/src/http.ts`: the status-to-code table.
- `packages/core/test/http-request-edge.test.ts` (create);
  `packages/core/test/route-builder.test.ts`, `route-builder-typecheck.ts`,
  `public-api-redesign.test.ts`, and any other core test that pins a changed body or passes a
  `Headers` / `URLSearchParams` to `functions.route`.
- `packages/aws/test/lambda-handlers.test.ts` (one parity test; no AWS source change).
- `packages/openapi/src/document.ts` (a 415 response), `packages/openapi/test/document.test.ts`.
- `packages/idempotency/test/plugin.test.ts`, `packages/idempotency/test/idempotent-typecheck.ts`:
  only the lines that read `request.headers.get("idempotency-key")` in a route handler.
- Docs: `apps/docs/content/docs/guides/http-routes.mdx`, `guides/schemas.mdx` ("Over HTTP"),
  `guides/idempotency.mdx` ("Wrap a route"), `guides/openapi.mdx` (the table),
  `guides/testing.mdx` (only if a sample passes an instance to `functions.route`),
  `reference/errors.mdx`.
- `CONTEXT.md`, a new ADR in `docs/adr/` with the next free number.

**Out of scope**:

- `packages/aws/src/**`: nothing changes there. A 405, an `ANY` route and `HEAD` handling
  (decision 7 and the dropped findings).
- `AuthorizerRequest.headers` (`packages/core/src/authorizers.ts:38`) stays a `Headers`, and the
  local authorizer's 500 that echoes `error.message` (`invoke.ts:1447-1451`) stays: plan 033 owns
  local authorizer evaluation.
- The Dev Function Invoke Endpoint and `@voke/remote` error bodies (`packages/core/src/remote.ts`,
  `packages/remote/src/index.ts`): plan 031.
- Type links between a route's `output` schema and its handler, and `functions.route` with
  `@voke/schema` bodies: plan 024.
- `packages/idempotency/src/**`: plan 032.
- Body parsers for forms, multipart and text; cookies as an object; compression; a public error
  class for handlers to throw (`roadmap-v2.md` phase 3).
- A non-strict object in `@voke/schema`.
- `.factory/plans/README.md`.

## Git workflow

- Branch `feature/http-request-edge`, stacked on plan 022's branch (base `feature/docs-revamp`).
- Commit subjects are imperative sentences that state the outcome, for example "Pass query and
  headers to routes as plain objects" and "Answer client mistakes with 4xx in the Error Envelope".
  Commit only if the task authorizes it. Do not push or open a PR unless told.

## Steps

### Step 1: Failing tests

Create `packages/core/test/http-request-edge.test.ts`. Use real validators (`schema` from
`@voke/schema`, `z` from `zod`; `packages/core/test/standard-schema.test.ts` already imports both)
and `gateway.request(...)`. One Gateway with these routes is enough: `GET /q` (`query:
schema.object({ page: schema.string() })`), `GET /zq` (the same with `z.object`), `GET /h`
(`headers: schema.object({ "x-tenant": schema.string() })`), `GET /zh` (the same with `z.object`),
`GET /plain` (no schema, returns `request.query` and `request.headers`), `POST /b` (`body:
schema.object({ name: schema.string() })`), `POST /optional` (a body schema that accepts
`undefined`), `POST /mw` (route middleware that awaits `c.req.json()`, then the same body schema),
`POST /nested` (handler calls `functions.invoke("inner", { to: 42 })` against an invokable Function
whose input is `schema.object({ to: schema.string() })`), `GET /out` (`output:
schema.object({ id: schema.string() })`, handler returns `{ id: 1, passwordHash: "x" }`), and three
routes that throw `HTTPException`.

Cases (each asserts the status and the full JSON body with `toEqual`):

1. `GET /q?page=2` and `GET /zq?page=2` answer 200 with `page: "2"`.
2. `GET /h` and `GET /zh` with the header `X-Tenant: acme` answer 200 with `"acme"`; the request
   also carries `user-agent` and `accept`, and the `@voke/schema` route still answers 200
   (decision 5).
3. `GET /plain?page=2&tag=a&tag=b&flag` with `X-Request-Id: r1`: `query` equals
   `{ page: "2", tag: "a,b", flag: "" }`, `headers["x-request-id"]` is `"r1"`, both are plain
   objects (`Object.getPrototypeOf(value) === Object.prototype`), and `request.raw.headers` is a
   `Headers`.
4. `GET /plain?__proto__=x`: `Object.hasOwn(query, "__proto__")` is true and the prototype is
   unchanged.
5. `GET /q?page=2&debug=1`: 400 `INVALID_REQUEST`, `Invalid query`, issue
   `{ message: "Unexpected property", path: ["query", "debug"] }`.
6. `GET /q`: 400, `{ error: { code: "INVALID_REQUEST", issues: [{ message: "Required", path: ["query", "page"] }], message: "Invalid query" } }`.
7. `POST /b`, JSON content type, body `{oops`: 400, `INVALID_REQUEST`, `Invalid body`, issues
   `[{ message: "Malformed JSON", path: ["body"] }]`. The same for the body `""` sent to
   `/optional`: 200 (an empty body is `undefined`).
8. `POST /b` with `application/vnd.api+json` and with `Application/JSON; charset=utf-8`: 200.
9. `POST /b` with `text/plain`, with `text/plain; x=application/json`, and with no content type
   (send a `Blob` without a type): 415,
   `{ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported content type: send application/json" } }`.
10. `POST /mw` with a valid JSON body: 200.
11. After a `POST /b` handled with a body schema, the handler can still read
    `await request.raw.json()` (add a route for it).
12. `DELETE /q`: 404 `NOT_FOUND` (pins decision 7).
13. `POST /nested`: 500, exactly
    `{ error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" } }`; the body text
    contains neither `inner` nor `Expected string`; `console.error` was called once (spy on it, as
    `packages/core/test/api.test.ts:804-834` does, with `VOKE_DEV_SUMMARY` unset).
14. `GET /out`: the same 500 body; the text contains neither `passwordHash` nor `issues`; the log
    line's JSON has `code: "INVALID_RESULT"` and an `issues` array.
15. `HTTPException(401, { message: "Sign in first" })`: 401
    `{ error: { code: "UNAUTHORIZED", message: "Sign in first" } }`. `HTTPException(429)`: 429,
    `TOO_MANY_REQUESTS`, `Too many requests`. `HTTPException(401, { res })` with a `Response`
    carrying `www-authenticate`: that header and body arrive unchanged. `HTTPException(503, { message: "db down" })`:
    503, `INTERNAL_SERVER_ERROR`, `Internal server error`, and `db down` is not in the body.
16. `functions.route("GET", "/plain", { headers: { "X-Request-Id": "r1" }, query: { page: "2" } })`
    returns `headers["x-request-id"] === "r1"`; `functions.route("GET", "/q", { query: {} })`
    rejects with `InvokeError`, code `INVALID_PAYLOAD`; `functions.route("GET", "/out")` rejects
    with `INVALID_RESULT` and issues that name `passwordHash` (decision 12).
17. `voke(...)` throws a `VokeConfigError` naming the route and the key for
    `headers: schema.object({ "X-Tenant": schema.string() })`.

In `packages/core/test/route-builder-typecheck.ts`, add a route without `query` and `headers`
schemas and assert `req.query.page` and `req.headers["x-request-id"]` are `string | undefined`, and
a `// @ts-expect-error` for `functions.route(..., { headers: new Headers() })`.

**Evidence**: `cd packages/core && bun test test/http-request-edge.test.ts` fails on cases 1–4,
7–11 and 13–17 for the reasons in "Behaviour measured"; cases 6 and 12 fail only on the missing
`code` or pass.

### Step 2: Plain `query` and `headers`

In `packages/core/src/invoke.ts`:

- Add two pure helpers near `createRouteRequest`:
  - `queryRecord(url: string): Record<string, string>`: iterate `new URL(url).searchParams`,
    collect into a `Map`, join a repeated key with `,`, return `Object.fromEntries(map)`.
  - `headerRecord(headers: Headers | Record<string, unknown>): Record<string, string>`: for a
    `Headers`, `Object.fromEntries(headers)` (names are already lower-case and combined); for a
    record, lower-case each name and `String(value)`, skipping `undefined`.
- Types: `RouteRequest` defaults `TQuery` and `THeaders` to `Record<string, string | undefined>`;
  the two fallbacks in `RouteDefinitionInput.handler` become the same type;
  `RouteInvocationInput` falls back to `Record<string, string>` for both `headers` and `query`.
- `createRouteRequest`: `query` is `input.query ?? queryRecord(request.url)`; `headers` is
  `headerRecord(input.headers ?? request.headers)`. Before validating headers, when
  `schemaObjectKeys(route.headers)` returns keys, pass only those keys that are present. The
  synthetic `Request` that `functions.route` builds still gets a `Headers` made from the record.
- `mountRoute` passes `headers: headerRecord(context.req.raw.headers)` and
  `query: queryRecord(context.req.url)`. `contextHeaders` stays for `resolveRouteAuth`.
- Add `assertRouteHeaderSchemas(registry)` beside `assertRouteParamSchemas` (decision 2) and call
  it from `createGatewayApp` in `app.ts`, next to the existing two assertions.
- Update the tests that passed instances or read them: `route-builder.test.ts:70-84,112`,
  `route-builder-typecheck.ts:26,61`, `public-api-redesign.test.ts:168-185`, and the route handlers
  in `packages/idempotency/test/plugin.test.ts:95,135` and `idempotent-typecheck.ts:46`
  (`request.headers["idempotency-key"]`). Find the rest with
  `grep -rnE "headers\.get\(|URLSearchParams|new Headers" packages/*/test examples` and change only
  the ones inside a route handler or a `functions.route` call; Request Authorizer handlers keep
  `request.headers.get(...)`.

**Evidence**: cases 1–6, 16 and 17 pass; `cd packages/core && bun run typecheck` exits 0.

### Step 3: The body

Replace `bodyFromRequest` with a reader that implements decision 4 and takes the text from a
function, so the Gateway can supply Hono's cached body:

```ts
const jsonMediaType = /^application\/(?:[\w.-]+\+)?json$/u;

const readJsonBody = async (
  route: AnyRouteDefinition,
  request: Request,
  readText: () => Promise<string>
): Promise<unknown> => {
  if (request.body === null) {
    return undefined;
  }

  const text = await readText();

  if (text === "") {
    return undefined;
  }
  // media type check → RouteRequestError (415); JSON.parse in try/catch → RouteRequestError (400)
};
```

- The media type is `(request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()`.
- `createRouteRequest` gets an optional `readText`; its default is
  `() => request.clone().text()`. `mountRoute` passes
  `() => (context.req.raw.bodyUsed ? context.req.text() : context.req.raw.clone().text())`.
  Do not add a field to the exported `RouteInvocationInput`.
- `input.body` given to `functions.route` still goes to the schema as is.

Add the internal error (not exported from `packages/core/src/index.ts`):

```ts
/** The request does not fit the route: the client's mistake. Callers outside the Gateway see an InvokeError. */
class RouteRequestError extends InvokeError {
  readonly part: "body" | "headers" | "params" | "query";
  readonly status: 400 | 415;
}
```

`parseRoutePart` throws it (status 400) for the four request parts and keeps a plain `InvokeError`
for the output. Messages keep today's form (`Invalid body for POST /b: Malformed JSON`), code
`INVALID_PAYLOAD`, `functionName` `<METHOD> <path>`.

Search the tests for requests that send a body to a route with a `body` schema without a JSON
content type; they now answer 415. Add the header to those requests.

**Evidence**: cases 7–11 pass, except that 7 and 9 may still lack `code` until Step 4.

### Step 4: Error mapping

- `invoke.ts`: split `runRoute` into building the Route Request and running the handler plus
  output validation; `functions.route` runs both and lets errors propagate (decision 12).
  `routeResponse` catches only around the build:

  ```ts
  let request;
  try {
    request = await createRouteRequest(route, input, readText);
  } catch (error) {
    if (error instanceof RouteRequestError) {
      return routeRequestErrorResponse(error);
    }
    throw error;
  }
  ```

  `routeRequestErrorResponse` uses `error` from `./response`: status 400 gives
  `{ code: "INVALID_REQUEST", issues: error.issues, message: "Invalid <part>" }`; status 415 gives
  the 415 body of decision 8 and no issues.

- `app.ts`: delete `publicRouteErrorMessage` and `publicRouteErrorTitle`. `handleRouteError`
  becomes: an `HTTPException` (import from `hono/http-exception`) with `res` returns
  `error.getResponse()`; one with a status below 500 returns the envelope with the code and
  message of decision 11; everything else is logged and answered with the generic body, using the
  exception's status when it is an `HTTPException` of 500 or more, else 500. Keep the
  `VOKE_DEV_SUMMARY` branch as it is. `logUnhandledRouteError` adds `issues` to its JSON line when
  the error has a non-empty `issues` array.
- `http.ts`: replace `defaultErrorCode` with the table of decision 11 and export the code and
  default-message lookups for `app.ts`. `jsonError` keeps its signature.
- Update the bodies pinned in `packages/core/test/route-builder.test.ts` (`:399-502`, `:561-569`),
  `public-api-redesign.test.ts:262-267` and any other test the run reports: validation bodies gain
  `code: "INVALID_REQUEST"`; the output-failure test (`:477-502`) expects the generic 500.

**Evidence**: `cd packages/core && bun test` → 0 fail, including all 17 cases;
`grep -n "Invalid (body\|publicRouteError" packages/core/src/app.ts` returns no matches.

### Step 5: Local and deployed parity, OpenAPI

- `packages/aws/test/lambda-handlers.test.ts`: one test that builds a Gateway with a `query`
  schema, a `headers` schema and a `body` schema (real `@voke/schema` objects), and for each of
  these compares `gateway.request(...)` with `createLambdaHandlers({ default: gateway }).http(event)`
  (use the file's `httpEvent(method, path, extra)` helper; `extra` overrides `rawQueryString`,
  `headers`, `cookies`, `body`, `isBase64Encoded`): `rawQueryString: "page=2&tag=a&tag=b"`; a
  header given as `{ "x-tenant": "acme" }`; `cookies: ["a=1", "b=2"]` read as
  `request.headers.cookie === "a=1; b=2"`; a base64 JSON body; the body `{oops`; a `text/plain`
  body. Status codes and parsed bodies must be equal in both paths.
- `packages/openapi/src/document.ts`, `routeResponses`: when `route.body !== undefined`, add
  `responses["415"] = errorResponse("Unsupported content type")`. Add the assertion to an existing
  body-route case in `packages/openapi/test/document.test.ts`, written before the change. The
  `Error` schema keeps `required: ["message"]`: a handler's own `error(...)` may omit `code`.

**Evidence**: `cd packages/aws && bun test test/lambda-handlers.test.ts` and
`cd packages/openapi && bun test` → 0 fail.

### Step 6: Docs, vocabulary, ADR

- `guides/http-routes.mdx`:
  - "Read the request" table: add `query` ("Query string values as a plain object. The output of
    the `query` schema when you declare one.") and change `headers` to "Request headers as a plain
    object with lower-case names. The output of the `headers` schema when you declare one."
  - Replace the "Read query string values and headers from the raw request" sample with one route
    that reads `request.query.page` and `request.headers["x-request-id"]` without schemas, and one
    that declares `query: z.object({ page: z.coerce.number().default(1) })` and
    `headers: schema.object({ "x-tenant": schema.string() })`.
  - State the rules in short sentences: values are strings (convert in the schema or the handler);
    a repeated key or header is one string combined with a comma, so split on `,` and trim; header
    names are lower-case; a `@voke/schema` object rejects a query parameter it does not declare; a
    `headers` schema checks the headers it names, and a strict object schema from another
    validator cannot be used for headers; `request.raw` is the original `Request`.
  - Replace the body paragraph (`:71`) with decision 4, including how to accept a non-JSON body.
  - "Errors" table: the rows of decision 8, the wrong-method 404, and a sentence that on AWS a
    request that matches no route is answered by API Gateway with its own body. Add a short
    "Throw an HTTP error" paragraph for `HTTPException` with a sample.
  - "Add middleware": middleware that reads the body must use `c.req.json()` or `c.req.text()`.
- `reference/errors.mdx`, "HTTP error responses": the table and the `txt` examples of decision 8;
  the `INVALID_PAYLOAD` and `INVALID_RESULT` rows stay true for `functions.route(...)`; say that
  an `InvokeError` thrown inside a route handler is a 500.
- `guides/schemas.mdx` "Over HTTP": add `code`, mention `query` and `headers`, and replace the
  `Invalid result` sentence with the generic 500.
- `guides/idempotency.mdx` "Wrap a route": `readonly headers: Record<string, string | undefined>`
  and `request.headers["idempotency-key"]`.
- `guides/openapi.mdx` table: a `body` also documents a `415`.
- `CONTEXT.md`: add **Route Request** ("The object a route handler receives: the validated
  `params`, `query`, `headers` and `body`, the Route Auth Context, and the original `Request` as
  `raw`. `query` and `headers` are plain objects." _Avoid_: Hono context, event, req object) and
  **Error Envelope** ("The JSON body `{ error: { code, message, issues?, details? } }` the Gateway
  writes for a failed HTTP request." _Avoid_: error payload, problem details). Check first that
  neither exists.
- ADR `docs/adr/00NN-http-request-edge.md` with the next free number (three ADRs share 0007; the
  highest at planning time is 0017): decisions 1–5 and 7–10, each with its reason, in the format of
  `docs/adr/0006-http-api-authorizers.md`.

**Evidence**: `cd apps/docs && bun run check:samples guides/http-routes.mdx`, `bun run test` and
`bun run lint:links` exit 0;
`grep -n "raw.url).searchParams\|as text otherwise" apps/docs/content/docs/guides/http-routes.mdx`
returns no matches.

## Test plan

- New: `packages/core/test/http-request-edge.test.ts` (17 cases, Step 1), modelled on
  `packages/core/test/api.test.ts` for Gateway composition and the `console.error` spy.
- Extended: `route-builder-typecheck.ts` (type cases), `packages/aws/test/lambda-handlers.test.ts`
  (parity), `packages/openapi/test/document.test.ts` (415).
- Updated to the new contract: `route-builder.test.ts`, `public-api-redesign.test.ts`, the two
  idempotency test files.
- All tests are in-process: no network, timers or AWS.
- Final verification: `bun run check && bun run typecheck && bun run test` exit 0.

## Done criteria

- [ ] `bun run check`, `bun run typecheck` and `bun run test` exit 0
- [ ] `GET /q?page=2` answers 200 for `schema.object` and for `z.object` query schemas, and a
      `headers` schema of each kind answers 200 on a request with extra headers (cases 1–2)
- [ ] Without schemas, `request.query` and `request.headers` are plain objects with the shapes of
      case 3, and their types are `Record<string, string | undefined>`
- [ ] Malformed JSON answers 400 and a non-JSON content type answers 415, both with a `code`
- [ ] A nested `functions.invoke` failure and an output failure answer the generic 500; the bodies
      contain no Function name, field name or `issues` (cases 13–14)
- [ ] `HTTPException` answers with its own status (case 15)
- [ ] The parity test shows equal status and body for `gateway.request` and the Lambda handler
- [ ] `git diff --stat <base> -- packages/aws/src` is empty
- [ ] `packages/core/test/public-surface.test.ts` is unchanged and passes
- [ ] `grep -rn "URLSearchParams" packages/core/src/invoke.ts` returns no matches
- [ ] The guide no longer parses `request.raw.url`; the ADR exists; `CONTEXT.md` defines
      **Route Request** and **Error Envelope**

## STOP conditions

- A Plugin or package in the repository reads `request.headers` or `request.query` as an instance
  through the Function Wrap's `input` and cannot be changed within the in-scope paths (for example
  code under `packages/idempotency/src`). Report it; do not keep both shapes.
- `context.req.text()` does not return the body after middleware called `c.req.json()` under the
  installed Hono version (case 10 would show it). Report it before changing how the body is read.
- The parity test shows a difference that comes from `hono/aws-lambda` and cannot be removed in
  core (for example query decoding). Report the difference; do not edit `packages/aws/src`.
- Making a `@voke/schema` headers object work needs a change in `packages/schema/src`. That is a
  Function Contract change; report it instead of making the object non-strict.
- More than a handful of existing tests or docs rely on a text body reaching a `body` schema.
  That would mean decision 4 removes a used feature; report the list.

## Maintenance notes

- Plan 024 edits the same type helpers (`RouteSchemaInput`, `RouteSchemaOutput`, the handler
  generics in `RouteDefinitionInput`). The fallbacks this plan sets are `Record<string, string |
undefined>` for the handler and `Record<string, string>` for `functions.route`.
- Plan 033 changes local authorizer evaluation; `AuthorizerRequest.headers` is still a `Headers`,
  and the local authorizer still echoes an error message in a 500. Both should follow this plan's
  rules when 033 lands.
- Plan 031 owns the Dev Function Invoke Endpoint; its error bodies use the same envelope but are
  not changed here.
- `error instanceof HTTPException` needs one copy of `hono`. `hono` is listed as both a dependency
  and a peer dependency of `voke`; if plan 034 changes that, recheck case 15.
- A 405 with `Allow`, and a correct `HEAD`, need a change in the Gateway and in HTTP API synthesis
  together (decision 7).
- A repeated query key cannot be told apart from a value that contains a comma; a route that needs
  the difference reads `request.raw.url`. If arrays are ever wanted, change `queryRecord` and the
  fallback type together and update the ADR.
- Reviewers should check: no response body is built from a thrown message except an
  `HTTPException` below 500; the only place that turns an `InvokeError` into a 4xx is the catch
  around `createRouteRequest`; records are built with `Object.fromEntries`.
- Deferred: form, multipart and text body parsers, a cookie object, a public error class for
  handlers, and a non-strict `@voke/schema` object (`roadmap-v2.md` phase 3).
