# Plan 033: A route behind a JWT Authorizer answers 401 without a valid-looking token under `voke dev` and in tests, and its handler receives the claims the deployed adapter provides

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. The coordinator owns
> `.factory/plans/README.md`; do not edit it.
>
> **Drift check**: Compare
> `git diff --stat 1c59d39 -- packages/core/src/invoke.ts packages/core/src/provider.ts packages/core/src/authorizers.ts packages/core/test packages/aws/src/lambda.ts packages/aws/src/index.ts packages/aws/src/authorizers.ts packages/aws/test packages/testing apps/docs/content/docs/guides/authorizers.mdx apps/docs/content/docs/guides/testing.mdx apps/docs/content/docs/reference/packages.mdx CONTEXT.md docs/adr`
> and `git status --short` with the recorded current state. Plans 023, 024 and 031 land first
> and edit `packages/core/src/invoke.ts` on purpose (023 changes `mountRoute` and
> `createRouteRequest`, right next to the code this plan edits). Reconcile that drift by
> locating the symbols named below instead of the line numbers; pause only if
> `evaluateLocalAuthorizer`, `resolveRouteAuth` or `ProviderRuntimeCapability.routeAuth` no
> longer exist or a decision listed below is invalidated.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (hard). Ordering only: after `.factory/plans/023-http-request-edge.md`,
  `.factory/plans/024-schema-helper-types.md` and
  `.factory/plans/031-single-remote-implementation.md` (all three edit
  `packages/core/src/invoke.ts`); after `.factory/plans/022-root-test-run.md` if the root
  `bun test` is used as a check.
- **Category**: bug / security
- **Planned at**: commit `1c59d39`, 2026-11-15

## Why this matters

A route protected by a **JWT Authorizer** is open in the local **Gateway**. Under `voke dev`,
`gateway.request(...)` and `createTestClient(...)`, a request with no token reaches the
handler, and the handler sees `request.auth` as `{ context: {}, source: "lambda" }`: no
claims, and the wrong source. Two failures follow. A developer can believe a route is
protected because the Default HTTP Authorizer is set, when a typo or a stray
`authorizer: "none"` left it public: nothing local ever answers 401, so no test can catch it.
And a handler that reads `request.auth.context.sub` cannot be exercised through HTTP locally,
so its first real run is on a deployed stage.

After this plan the local Gateway requires a token from the authorizer's **Authorizer Identity
Source**, checks what a local process can check (shape, `iss`, `aud` or `client_id`, `exp`,
`nbf`, `iat`), answers 401 otherwise, and passes the claims as the **Route Auth Context** with
`source: "jwt"`. It does not verify the signature, and the docs say so. Lambda Request
Authorizers also stop answering 401 for every identity source that is not a header.

## Current state

### Architecture rules (binding)

- ADR `docs/adr/0006-http-api-authorizers.md`, the only sentence on this topic: "Local
  Authorizer Evaluation runs Request Authorizer Functions, allows injected Route Auth Context
  for tests, and does not fully validate JWTs by default." It does **not** decide to skip JWT
  Authorizers. `CONTEXT.md:430-431` adds: "**Local Authorizer Evaluation** does not fully
  validate **JWT Authorizers** by default." and "**Local Authorizer Evaluation** returns
  Unauthorized when an authorizer identity value is missing." The code skips JWT completely,
  which already contradicts line 431. This plan does not reverse ADR 0006; it writes a new ADR
  that states what "not fully" means (step 7).
- ADR `docs/adr/0007-specialized-provider-and-helper-packages.md`: `voke` (core) is
  provider-neutral and must not import `@voke/*`; "`@voke/aws` depends on public `voke` and
  owns the full AWS workflow, including AWS runtime adapters ... and authorizer entrypoints".
  Provider-neutral test helpers live in `@voke/testing`.
- ADR `docs/adr/0007-opinionated-framework.md`: one supported way per layer, one spelling per
  setting, no deprecation aliases (the packages are unreleased, version `0.0.0`).
- `AGENTS.md`: test-first (a failing test before the change), small changes, no new
  dependencies without clear value, Ultracite lint (`bun x ultracite fix`), no `console.log`.
- Vocabulary from `CONTEXT.md` (use these words in names, comments and docs): **HTTP
  Authorizer**, **JWT Authorizer** ("lets the HTTP API validate bearer tokens from a trusted
  issuer and audience"; avoid "handler token validation", "middleware auth"), **Lambda Request
  Authorizer**, **Request Authorizer Function**, **Authorizer Identity Source** ("the request
  location an HTTP Authorizer reads to identify the caller"), **Route Auth Context** ("the
  normalized authorizer data available to a route-backed Function after an HTTP Authorizer
  allows the request"), **Local Authorizer Evaluation** ("the local testing behavior where Voke
  evaluates authorizer behavior before a route-backed Function runs"; avoid "production
  identity provider emulation"), **Default HTTP Authorizer**, **Route Authorizer Override**,
  **Gateway**, **Provider**, **Provider Capability**.

### Code at `1c59d39`

- **The skip**, `packages/core/src/invoke.ts:1395-1399`, inside `evaluateLocalAuthorizer`
  (`:1382-1453`):

  ```ts
  const authorizer = definition.authorizers?.[authorizerName];

  if (authorizer?.kind !== "lambda") {
    return undefined;
  }
  ```

  `undefined` means "no auth result, run the route". It is returned for a JWT Authorizer and
  also for a name that is not in the route's Authorizer Registry (`authorizer === undefined`).

- **What the handler then sees**, `invoke.ts:1198` in `createRouteRequest`:
  `auth: input.auth ?? { context: {}, source: "lambda" },`.
- **Header-only identity**, `invoke.ts:1300-1304` and `:1401-1415`:

  ```ts
  const identityHeaderName = (identitySource: string): string | undefined => {
    const match = /^\$request\.header\.([^.\s]+)$/iu.exec(identitySource);

    return match?.[1];
  };
  ```

  ```ts
  const hasIdentity = authorizer.identitySource.every((source) => {
    const header = identityHeaderName(source);

    if (header === undefined) {
      return false;
    }
    const value = headers.get(header);

    return value !== null && value.trim() !== "";
  });

  if (!hasIdentity) {
    return jsonError("Unauthorized", { code: "UNAUTHORIZED", status: 401 });
  }
  ```

  A Lambda Request Authorizer with `$request.querystring.key` therefore always answers 401
  locally. The JWT path never reaches this code.

- **Who calls it**, `invoke.ts:1458-1482`, `resolveRouteAuth`: a public route returns
  `undefined`; otherwise `provider?.runtime?.routeAuth?.({ env: context.env })` is asked, and
  if it reports nothing, `evaluateLocalAuthorizer(route, definition, registry, context.req.raw,
contextHeaders(context))` runs. `mountRoute` (`:1484-1516`) returns the `Response` or passes
  the `RouteAuthContext` to the route as `auth`.
- **The Provider hook**, `packages/core/src/provider.ts:18-27`:
  ```ts
  export interface ProviderRuntimeCapability {
    /**
     * Returns the authorization result the platform already established for this request (for
     * example an API Gateway authorizer), or undefined to evaluate the route's authorizer locally.
     * `env` is the Gateway request's Hono env, set by the Provider's own runtime adapter.
     */
    routeAuth?: (input: { env: unknown }) => RouteAuthContext | undefined;
  ```
- **The deployed adapter**, `packages/aws/src/lambda.ts:38-61` (`awsRouteAuth`, wired at
  `packages/aws/src/index.ts:314-317` as `runtime: { routeAuth: awsRouteAuth, ... }`): it reads
  `env.event.requestContext.authorizer`; `authorizer.lambda` becomes
  `{ context: authorizer.lambda, source: "lambda" }`, and `authorizer.jwt.claims` becomes
  `{ context: authorizer.jwt.claims, source: "jwt" }`. `authorizer.jwt.scopes` is dropped.
  `env.event` is set only by `createAwsLambdaHandler` (hono/aws-lambda). When a deployed
  Function receives an HTTP API event with no `authorizer` block on a JWT route, `awsRouteAuth`
  returns `undefined`, local evaluation runs, and today the route is served open.
- **Types**, `packages/core/src/authorizers.ts:10-15` (`JwtAuthorizerDefinition`:
  `audience: readonly string[]`, `identitySource: readonly string[]`, `issuer: string`,
  `kind: "jwt"`) and `invoke.ts:145-149` (`RouteAuthContext`:
  `context: Record<string, unknown>`, `source: "jwt" | "lambda"`).
- **The builder**, `packages/aws/src/authorizers.ts:31-57`: `jwtAuthorizer(input)` freezes
  `{ audience: [...], identitySource: toIdentitySources(input.identitySource), issuer, kind: "jwt" }`.
  The default identity source is `"$request.header.Authorization"`. It accepts any number of
  identity sources of any form and validates nothing.
- **Synthesis**, `packages/aws/src/cloudformation-synthesis.ts:607-619`: `AuthorizerType: "JWT"`,
  `IdentitySource: [...authorizer.identitySource]`,
  `JwtConfiguration: { Audience: [...], Issuer }`. Routes get `AuthorizationType: "JWT"` and an
  `AuthorizerId` (`:692-697`). There is no `AuthorizationScopes` anywhere
  (`grep -rn "AuthorizationScopes" packages/*/src` finds nothing): **Voke has no route scopes.**
  There are no stage variables either (`grep -rn "StageVariables" packages/*/src`: nothing).
- **Error responses**: `jsonError(message, { code, status, ...init })` from
  `packages/core/src/http.ts:29` builds `{ error: { code, message } }`; the rest of `init`
  (including `headers`) reaches `Response.json` (`packages/core/src/response.ts:43-63`).
- **How requests arrive locally**: `voke dev` runs `bun --hot <entrypoint>`
  (`packages/core/src/dev.ts:125`); the entrypoint's default export is the Gateway, so Bun
  calls `gateway.fetch(request, server)`. `gateway.request(...)` and
  `createTestClient(gateway)` (`packages/testing/src/index.ts:83-107`) call the same Hono app.
  None of them sets `env.event`. Local evaluation also runs with **no Provider** at all:
  `packages/core/test/route-builder.test.ts:185` creates `voke(functions, { config: { name: "api" } })`.
- **`@voke/testing`**, `packages/testing/src/index.ts`: exports `createTestClient` and
  `createInvokeTestClient`; depends only on `voke`. The export list is pinned in
  `packages/core/test/public-surface.test.ts:196-204`.
- **Existing tests to keep green**: `packages/core/test/route-builder.test.ts:150-295` (Lambda
  authorizer locally: 200, 401, 403, 500), `packages/core/test/provider-runtime.test.ts:77-126`
  (`routeAuth` trusted; local evaluation when it reports nothing),
  `packages/aws/test/route-auth.test.ts` (deployed `lambda` and `jwt` results; local Lambda
  evaluation through `gateway.request`).
- **Docs that state today's behaviour**: `apps/docs/content/docs/guides/authorizers.mdx`,
  section "Run authorizers locally": the table row "JWT authorizer | Not checked. The route
  runs, and `request.auth.context` is empty." and the Callout "JWTs are not validated
  locally"; section "Protect routes": "The local Gateway does not check the name, and a route
  with an unknown name runs without authorization under `voke dev`."
  `apps/docs/content/docs/guides/testing.mdx`, section "Send HTTP requests to the Gateway":
  the Callout "JWT authorizers are not checked in process".
- **Docs samples**: every `ts` fence on a docs page must be ` ```ts twoslash ` and compile
  (`apps/docs/test/samples.test.ts`). `apps/docs/package.json` already has `@voke/testing` and
  `@voke/aws` as workspace dev dependencies.
- No example under `examples/*/src` uses an authorizer; examples need no change.

### What API Gateway does (read from the AWS docs on 2026-11-15)

From "Control access to HTTP APIs with JWT authorizers"
(`https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html`):

1. "Check the `identitySource` for a token. The `identitySource` can include only the token,
   or the token prefixed with `Bearer`."
2. Decode the token.
3. Check the algorithm and signature with the public key from the issuer's `jwks_uri`. "Only
   RSA-based algorithms are supported."
4. Validate claims: `kid` (matches the signing key); `iss` "must match the `issuer` that is
   configured for the authorizer"; "`aud` or `client_id` – Must match one of the `audience`
   entries that is configured for the authorizer. API Gateway validates `client_id` only if
   `aud` is not present. When both `aud` and `client_id` are present, API Gateway evaluates
   `aud`."; `exp` "must be after the current time in UTC"; `nbf` and `iat` "must be before the
   current time in UTC"; `scope` or `scp` against the route's `authorizationScopes`.

"If any of these steps fail, API Gateway denies the API request." The claims then reach the
Function in `event.requestContext.authorizer.jwt.claims`.

From the `AWS::ApiGatewayV2::Authorizer` reference, `IdentitySource`: "For `JWT`, a single
entry that specifies where to extract the JSON Web Token (JWT) from inbound requests.
Currently only header-based and query parameter-based selections are supported". For a
`REQUEST` (Lambda) authorizer: one or more of `$request.header.name` (case-insensitive),
`$request.querystring.name` (case-sensitive), `$context.variableName` and
`$stageVariables.variableName`; all must be "present in the request, not null, and non-empty",
"Otherwise, it returns a 401 Unauthorized response without calling the Lambda function."

Not in the AWS docs (see "Could not verify"): the event example shows claim values as strings;
community reports show numbers as decimal strings (`"exp": "1596044031"`) and arrays as
`"[Group2 Group1]"`.

### Findings checked and dropped

- "JWT Authorizers are not enforced locally, `invoke.ts:1397-1399`": **confirmed**. Two more
  facts in the same line: a route whose authorizer name is missing from its registry is also
  served open, and the handler gets `source: "lambda"`.
- "Non-header identity sources always return 401 locally, `invoke.ts:1300-1304`":
  **confirmed, for Lambda Request Authorizers only** (the JWT path returns before it).
- "ADR 0006 deliberately skips JWT locally": **not what it says** (see Architecture rules). No
  ADR is superseded; a new one pins the meaning.
- "Scope checks if the JWT Authorizer supports route scopes": **dropped**. Voke has no route
  scopes and the deployed adapter drops `jwt.scopes`. Out of scope below.

### Could not verify (no AWS call was made)

- How API Gateway renders non-string claims in `jwt.claims`. Decision 4 follows the reported
  behaviour and keeps the rule in one function.
- Whether API Gateway rejects a token with no `exp`. Decision 3 picks the strict reading.
- Whether CloudFormation rejects a JWT authorizer with two identity sources. The reference
  says "a single entry"; decision 6 relies on that sentence.

## Decisions taken in this plan

1. **Local Authorizer Evaluation enforces a JWT Authorizer without verifying the signature.**
   The token is read from the identity source, an optional `Bearer ` prefix is removed, the
   token must have three dot-separated segments whose first two are base64url JSON objects,
   and the claim checks of decision 3 run. The JOSE header (`alg`, `kid`) and the signature
   segment are ignored: no network, no JWKS, no key material. _Why_: this is everything a
   local process can know, it makes "no token" and "wrong token" fail locally, and a real
   token from the real issuer also passes. _Reverse_: restore the early `return undefined` for
   `kind === "jwt"`; the pure module and the helper can stay.
2. **The code lives in core, in a new internal module `packages/core/src/jwt-authorizer.ts`.**
   _Why_: Local Authorizer Evaluation for Lambda Request Authorizers already lives in core
   (`evaluateLocalAuthorizer`), `JwtAuthorizerDefinition` and `RouteAuthContext.source: "jwt"`
   are core types, and the Gateway evaluates authorizers with no Provider configured, so code
   in `@voke/aws` would leave those Gateways open or broken. The module uses only Web-standard
   globals (`atob`, `TextDecoder`, `JSON`, `URL`), imports no `@voke/*` package and no AWS SDK,
   so ADR 0007's rule holds. It is not exported from `packages/core/src/index.ts`. _Reverse_:
   the module is pure functions; move it behind a Provider Capability and change the one call
   site.
3. **Claim checks, strict where AWS is silent.** With `now = Date.now() / 1000` (not floored):
   `iss` must be a string equal to `authorizer.issuer` (exact comparison, a trailing slash
   counts); `aud` (a string or an array of strings) must contain one of
   `authorizer.audience`; `client_id` is checked instead only when `aud` is absent; `exp` must
   be a number greater than `now` and is **required**; `nbf` and `iat`, when present, must be
   numbers less than or equal to `now`. No clock leeway. _Why strict_: being stricter than API
   Gateway costs a local 401 the developer sees at once; being looser hides a deployed 401.
   _Reverse_: each check is one branch in one function.
4. **The Route Auth Context holds the claims as API Gateway delivers them: every value a
   string.** A string stays; a number or boolean becomes `String(value)`; an array becomes
   `[` + its rendered elements joined by one space + `]` (`["admin","editor"]` →
   `"[admin editor]"`); `null` and nested objects become `JSON.stringify(value)` (unverified
   form). The result is `{ context: claims, source: "jwt" }`, the same shape `awsRouteAuth`
   returns. _Why_: a handler that does `claims["cognito:groups"].includes("admin")` on an
   array locally and on a string when deployed is the exact drift this plan removes.
   _Reverse_: `toGatewayClaims` is one function; make it return the payload unchanged.
5. **Failures answer 401 with Voke's envelope and say why in a header, never in the body.**
   Body: `{ "error": { "code": "UNAUTHORIZED", "message": "Unauthorized" } }`, as the Lambda
   path already answers. Header: `www-authenticate: Bearer` for a missing token, otherwise
   `www-authenticate: Bearer error="invalid_token", error_description="<reason>"` (RFC 6750)
   with one of the fixed reasons in step 2. Reasons never contain the token or a claim value.
   There is no 403 on this path (no scopes). API Gateway's own body is
   `{"message":"Unauthorized"}`; matching it is out of scope. _Why_: a bare 401 leaves a
   developer guessing between issuer, audience and expiry. _Reverse_: drop the header.
6. **Identity sources.** JWT Authorizer: exactly one, `$request.header.<name>` or
   `$request.querystring.<name>`. `jwtAuthorizer()` throws `VokeConfigError` for anything else
   (the input type is unchanged, so a one-element array still works); local evaluation answers
   500 if a hand-built definition slips through. Lambda Request Authorizer: every source must
   resolve; `$request.header.<name>` (case-insensitive), `$request.querystring.<name>`
   (case-sensitive, from the request URL), `$context.<name>` counts as present (API Gateway
   always has context variables; the local Gateway has none), `$stageVariables.<name>` counts
   as missing (Voke's stage defines no stage variables, so the deployed stage answers 401 too),
   and any other expression answers 500 naming the expression. _Reverse_: delete the builder
   check; the reader is one function.
7. **A route whose authorizer name is not in its Authorizer Registry answers 500 locally**
   with `Route GET /me references unknown HTTP Authorizer "x"` (the message
   `packages/core/src/model.ts:292` uses at synth time) instead of running open. _Reverse_:
   return `undefined` for that case again.
8. **Unverified evaluation never runs for a request the platform delivered.** A new optional
   Provider Capability member, `ProviderRuntimeCapability.isPlatformRequest`, lets a Provider
   say "the platform invoked this deployed Function". When it is true, `routeAuth` reported
   nothing and the route uses a JWT Authorizer, the Gateway answers 401. `@voke/aws` implements
   it as "`env.event` exists". Lambda Request Authorizers keep today's behaviour (the Request
   Authorizer Function runs in process, which is a real check). _Why_: otherwise a deployed
   Function reached without API Gateway's authorizer result would accept an unsigned token.
   _Reverse_: remove the member and the branch.
9. **Tests mint tokens with `createTestJwt(authorizer, claims?)`, exported by
   `@voke/testing`.** It is synchronous, takes the `jwtAuthorizer(...)` value so issuer and
   audience cannot be mistyped, and returns an RFC 7519 unsecured JWT (header
   `{"alg":"none","typ":"JWT"}`, empty signature). _Why `@voke/testing`_: the helper has no
   AWS dependency, it is used next to `createTestClient`, and `@voke/aws/testing` is for
   deployed-stack and durable helpers. _Why unsigned_: nothing local verifies a signature, a
   fake signature would only look genuine, and API Gateway rejects the token in every case.
   _Reverse_: move the export to `@voke/aws/testing` and update the pinned list.
10. **No clock option on the Gateway.** The call site reads `Date.now()`; the pure function
    takes `nowSeconds`. Unit tests pass a constant. Gateway tests use tokens whose validity
    does not depend on the date: the helper's defaults (`iat = now`, `exp = now + 3600`, both
    from the same `Date.now()` the Gateway reads), `exp: 1` for expired and `nbf: 32503680000`
    for not yet valid. _Why_: a `now` option on `voke(...)` would be public surface for one
    test need that fixed claims already meet. _Reverse_: add the option later; the pure
    function already accepts the time.

## Commands you will need

| Purpose                  | Command (from the repository root unless noted)            | Expected on success |
| ------------------------ | ---------------------------------------------------------- | ------------------- |
| One core test file       | `cd packages/core && bun test test/jwt-authorizer.test.ts` | all pass            |
| Core tests               | `cd packages/core && bun test`                             | all pass            |
| AWS tests                | `cd packages/aws && bun test test/route-auth.test.ts`      | all pass            |
| Testing package          | `cd packages/testing && bun test`                          | all pass            |
| Docs samples             | `cd apps/docs && bun run test`                             | all pass            |
| All tests (what CI runs) | `bun run test`                                             | every task green    |
| Typecheck                | `bun run typecheck`                                        | exit 0              |
| Lint and format          | `bun x ultracite fix`, then `bun run check`                | exit 0              |

## Implementation rules relevant to this plan

- Write each test before the code it covers and see it fail for the stated reason.
- `packages/core/src/jwt-authorizer.ts` must not use `Bun.*` or `Buffer`: core is bundled into
  the Lambda (Node.js) bundle, and `packages/core/test/node-runtime.test.ts` asserts the
  bundle runs with no `Bun` global.
- Keep functions small; Ultracite enforces a cognitive-complexity limit. One function per
  check is the intended shape. Regex literals go at module top level.
- No `any`, no type assertions where narrowing works (`typeof`, `Array.isArray`).
- Never put a token or a claim value in an error message, a header or a log.
- Do not add a dependency. Do not export the new core module from `packages/core/src/index.ts`.

## Scope

**In scope**:

- `packages/core/src/jwt-authorizer.ts` (create)
- `packages/core/src/invoke.ts` (`identityHeaderName`, `evaluateLocalAuthorizer`,
  `resolveRouteAuth`, the comment on `RouteAuthContext.source`)
- `packages/core/src/provider.ts` (`ProviderRuntimeCapability.isPlatformRequest`)
- `packages/core/test/jwt-authorizer.test.ts`, `packages/core/test/local-authorizer.test.ts`
  (create); `packages/core/test/provider-runtime.test.ts`;
  `packages/core/test/public-surface.test.ts`
- `packages/aws/src/lambda.ts`, `packages/aws/src/index.ts`, `packages/aws/src/authorizers.ts`
- `packages/aws/test/route-auth.test.ts`
- `packages/testing/src/index.ts`, `packages/testing/test/jwt.test.ts` (create),
  `packages/testing/README.md` (one line, optional)
- `apps/docs/content/docs/guides/authorizers.mdx`, `apps/docs/content/docs/guides/testing.mdx`,
  `apps/docs/content/docs/reference/packages.mdx`
- `CONTEXT.md` (relationship lines only), `docs/adr/00NN-local-jwt-authorizer-evaluation.md`
  (create; next free number, `0018` at planning time)

**Out of scope**:

- Signature verification, JWKS fetching, any option to supply keys locally.
- Route scopes (`AuthorizationScopes`, `jwt.scopes` in the Route Auth Context): a feature.
- Typing JWT claims (`CONTEXT.md:420`: "keeps JWT claims loose in v1").
- The default `auth` of `functions.route(...)` (`{ context: {}, source: "lambda" }`): it
  skips authorizers by design and is documented.
- External Lambda Authorizer Targets locally (still 500), authorizer caching.
- `packages/core/src/model.ts`, `packages/aws/src/cloudformation-synthesis.ts`,
  `packages/openapi/**`: no change.
- Plan 023's work in `invoke.ts` (query and headers as plain objects, 4xx mapping) and plans
  024 and 031. Plan 025 (the migrator converting `httpApi` authorizers) may point at this
  behaviour but is separate.
- `.factory/plans/README.md`.

## Git workflow

- Branch: `feature/local-jwt-authorizer-evaluation`.
- Commit only if the operator authorized it. Subjects are imperative and state the outcome,
  for example "Make the local Gateway enforce JWT Authorizers".
- Do not push or open a pull request unless instructed.

## Steps

### Step 1: Pin the pure behaviour with failing unit tests

Create `packages/core/test/jwt-authorizer.test.ts`. Import from `../src/jwt-authorizer` (it
does not exist yet, so the file fails). Build tokens in the test with a local three-line
helper (`btoa(JSON.stringify(x))` made URL-safe, padding removed) so this file does not depend
on step 5. Use `nowSeconds = 1_800_000_000` and an authorizer
`{ audience: ["users-api", "admin-api"], identitySource: ["$request.header.Authorization"], issuer: "https://auth.example.com", kind: "jwt" }`.
Cases are listed in the test plan.

### Step 2: Write `packages/core/src/jwt-authorizer.ts`

Target shape (names are part of the plan; bodies are yours):

```ts
import type { JwtAuthorizerDefinition } from "./authorizers";

export type JwtRejection =
  | "missing token"
  | "token is not a JWT"
  | "issuer does not match"
  | "audience does not match"
  | "exp claim is missing"
  | "token has expired"
  | "token is not valid yet";

export type JwtEvaluation =
  | { readonly ok: true; readonly claims: Record<string, string> }
  | { readonly ok: false; readonly reason: JwtRejection };

export type IdentityValue =
  | { readonly kind: "value"; readonly value: string | undefined }
  | { readonly kind: "context" } // $context.<name>: API Gateway always has it
  | { readonly kind: "unsupported" };

/** Reads one Authorizer Identity Source expression from a local request. */
export const readIdentityValue = (
  source: string,
  request: Request,
  headers: Headers
): IdentityValue => {
  /* ... */
};

/** Renders decoded claims the way API Gateway passes them to a Function: all strings. */
export const toGatewayClaims = (
  payload: Record<string, unknown>
): Record<string, string> => {
  /* ... */
};

/**
 * Local Authorizer Evaluation of a JWT Authorizer. It checks the token's shape and its iss,
 * aud or client_id, exp, nbf and iat claims. It does NOT verify the signature, so it never
 * proves that a token is genuine.
 */
export const evaluateJwt = (
  authorizer: JwtAuthorizerDefinition,
  token: string | undefined,
  nowSeconds: number
): JwtEvaluation => {
  /* ... */
};
```

Rules:

- `readIdentityValue`: `^\$request\.header\.([^.\s]+)$` (case-insensitive) → `headers.get(name)`;
  `^\$request\.querystring\.([^.\s]+)$` → `new URL(request.url).searchParams.get(name)` (the
  parameter name is case-sensitive); `^\$context\.\S+$` → `{ kind: "context" }`;
  `^\$stageVariables\.\S+$` → `{ kind: "value", value: undefined }`; anything else →
  `{ kind: "unsupported" }`. A `null`, empty or whitespace-only value is `undefined`.
- `evaluateJwt`: `undefined` or blank → `"missing token"`. Remove one leading `Bearer` plus
  whitespace (case-insensitive). Split on `.`: exactly three segments, or `"token is not a
JWT"`. Decode segments one and two: base64url → bytes (`atob` after replacing `-`→`+`,
  `_`→`/`) → `new TextDecoder().decode(...)` → `JSON.parse`; any throw, or a value that is not
  a non-array object, is `"token is not a JWT"`. Then the checks of decision 3 in this order:
  issuer, audience, `exp` missing, expired, `nbf`, `iat`. A claim of the wrong type fails its
  own check (`iss: 7` → `"issuer does not match"`, `exp: "soon"` → `"exp claim is missing"`,
  `nbf: "x"` → `"token is not valid yet"`). On success return `toGatewayClaims(payload)`.
- `toGatewayClaims`: decision 4.

**Evidence**: `cd packages/core && bun test test/jwt-authorizer.test.ts` → all pass.

### Step 3: Failing Gateway tests, then wire local evaluation

Create `packages/core/test/local-authorizer.test.ts` (cases in the test plan; structure after
`packages/core/test/route-builder.test.ts:150-295`: `createFunctions`, `http({ authorizers,
authorizer, routes })`, `voke(functions, { config: { name: "..." } })`, `gateway.request`).
Import `jwtAuthorizer`, `lambdaAuthorizer`, `createAuthorizers`, `requestAuthorizer` from
`@voke/aws`. Until step 5 exists, mint tokens with the same local helper as step 1; switch to
`createTestJwt` in step 5. Confirm the JWT cases fail: today a tokenless request gets 200.

Then edit `packages/core/src/invoke.ts`:

- Delete `identityHeaderName`; use `readIdentityValue`.
- In `evaluateLocalAuthorizer`, replace the `authorizer?.kind !== "lambda"` early return:
  - `authorizer === undefined` → `jsonError(`Route ${route.method} ${route.path} references
    unknown HTTP Authorizer "${authorizerName}"`, { code: "INTERNAL_SERVER_ERROR", status: 500 })`.
  - `authorizer.kind === "jwt"` → a new helper `evaluateLocalJwtAuthorizer(...)`:
    1. if `platformRequest` is true → 401 with `www-authenticate: Bearer` (decision 8);
    2. the identity source must be exactly one entry that reads as `kind: "value"` from a
       header or query string expression, otherwise 500 with
       `JWT Authorizer "<name>" needs exactly one identity source: $request.header.<name> or $request.querystring.<name>`;
    3. `evaluateJwt(authorizer, value, Date.now() / 1000)`;
    4. `ok` → `{ context: claims, source: "jwt" }`; otherwise 401 as in decision 5.
  - `kind === "lambda"`: compute `hasIdentity` with `readIdentityValue` per decision 6; an
    `unsupported` expression answers 500 with
    `Identity source "<expression>" is not available in Local Authorizer Evaluation`. The rest
    of the Lambda path is unchanged.
- Give `evaluateLocalAuthorizer` one more parameter, `platformRequest: boolean`, and pass it
  from `resolveRouteAuth` (step 4 fills it; pass `false` for now).
- Update the comment at `invoke.ts:147`: `"jwt"` claims are verified by the platform when
  deployed and are unverified in Local Authorizer Evaluation.

The 401 builder, shared by the JWT branches:

```ts
const unauthorizedJwt = (reason?: JwtRejection): Response =>
  jsonError("Unauthorized", {
    code: "UNAUTHORIZED",
    headers: {
      "www-authenticate":
        reason === undefined || reason === "missing token"
          ? "Bearer"
          : `Bearer error="invalid_token", error_description="${reason}"`,
    },
    status: 401,
  });
```

**Evidence**: `cd packages/core && bun test test/local-authorizer.test.ts test/route-builder.test.ts test/provider-runtime.test.ts`
→ all pass except the platform-request case, which step 4 completes.

### Step 4: Refuse unverified evaluation for platform-delivered requests

Tests first:

- `packages/core/test/provider-runtime.test.ts`: a Provider with
  `runtime: { isPlatformRequest: () => true, routeAuth: () => undefined }` and a JWT route: a
  request carrying an otherwise valid token gets 401; with `isPlatformRequest: () => false`
  the same request gets 200.
- `packages/aws/test/route-auth.test.ts`: an HTTP API event for `/profile` (the JWT route of
  `createAuthGateway`) with **no** `authorizer` in `requestContext` and a well-formed unsigned
  token in `headers.authorization` → `statusCode` 401. Today it is 200. Build the event with
  `eventWithAuthorizer(undefined)`, set `rawPath` and `requestContext.http.path` as the
  existing JWT test does, and mint the token inline with `btoa`.

Then:

- `packages/core/src/provider.ts`, in `ProviderRuntimeCapability`:
  ```ts
  /**
   * True when the platform delivered this request to a deployed Function (for example API
   * Gateway invoking the Lambda). Local Authorizer Evaluation never verifies a JWT signature,
   * so for such a request the Gateway answers 401 for a JWT Authorizer route that `routeAuth`
   * reported nothing for, instead of evaluating the token itself.
   */
  isPlatformRequest?: (input: { env: unknown }) => boolean;
  ```
- `invoke.ts`, `resolveRouteAuth`: pass
  `provider?.runtime?.isPlatformRequest?.({ env: context.env }) === true`.
- `packages/aws/src/lambda.ts`: `export const isAwsPlatformRequest = ({ env }: { env: unknown }): boolean => isRecord(env) && isRecord(env.event);`
  and wire `isPlatformRequest: isAwsPlatformRequest` next to `routeAuth: awsRouteAuth` in
  `packages/aws/src/index.ts`. Do not add it to the package's exports.

**Evidence**: both new tests pass; `packages/aws/test/route-auth.test.ts` keeps its three
existing tests green (the third, a Lambda authorizer through `gateway.request`, has no
`env.event`).

### Step 5: `createTestJwt` in `@voke/testing`

Tests first, `packages/testing/test/jwt.test.ts` (cases in the test plan), and add
`"createTestJwt"` to the sorted list in `packages/core/test/public-surface.test.ts:199-202`.

Then add to `packages/testing/src/index.ts`:

```ts
import type { JwtAuthorizerDefinition } from "voke";

/**
 * Mints an unsigned JWT that Local Authorizer Evaluation accepts for the given JWT Authorizer.
 * Defaults: iss and aud from the authorizer, sub "test-user", iat now, exp one hour later.
 * `claims` override or add claims; a claim set to undefined is left out. API Gateway rejects
 * this token: it has no signature.
 */
export const createTestJwt = (
  authorizer: Pick<JwtAuthorizerDefinition, "audience" | "issuer">,
  claims: Record<string, unknown> = {}
): string => {
  /* base64url(header) + "." + base64url(payload) + "." */
};
```

Encode with `TextEncoder` + `btoa`, URL-safe, no padding. `aud` defaults to
`authorizer.audience[0]`. Replace the local token helper in
`packages/core/test/local-authorizer.test.ts` with `createTestJwt` from `@voke/testing`
(core tests already import that package, for example `packages/core/test/api.test.ts`). Keep
the local helper in `jwt-authorizer.test.ts`, which needs malformed tokens.

**Evidence**: `cd packages/testing && bun test` and
`cd packages/core && bun test test/public-surface.test.ts test/local-authorizer.test.ts` pass.

### Step 6: Reject an invalid JWT identity source in the builder

Test first in `packages/aws/test/route-auth.test.ts`: `jwtAuthorizer({ audience: "a", issuer:
"https://i", identitySource: [...] })` throws `VokeConfigError` for two entries, for
`$context.routeKey` and for `$request.cookie.token`; it accepts the default,
`"$request.header.X-Access-Token"`, `["$request.querystring.access_token"]`.

Then in `packages/aws/src/authorizers.ts`, `jwtAuthorizer` validates the resolved sources and
throws
`new VokeConfigError('A JWT Authorizer needs exactly one identity source: $request.header.<name> or $request.querystring.<name>')`
(`VokeConfigError` is exported by `voke`). The input type stays `AuthorizerIdentitySource`.

**Evidence**: `cd packages/aws && bun test test/route-auth.test.ts`;
`cd packages/core && bun test test/model.test.ts test/cloudformation.test.ts` stay green (they
use the default and `$request.header.X-Access-Token`).

### Step 7: ADR, CONTEXT.md and docs

- **ADR** `docs/adr/00NN-local-jwt-authorizer-evaluation.md` (next free number; three files
  already share `0007`, do not reuse a number). Prose like the other ADRs, title "Local
  Authorizer Evaluation enforces JWT Authorizers without verifying signatures". It must say:
  ADR 0006 left "does not fully validate JWTs" undefined and the code skipped JWT Authorizers,
  so a protected route was open locally; what is checked (decisions 1 and 3) and what is not
  (signature, `kid`, algorithm, scopes); claims are passed as strings (decision 4, with the
  note that AWS does not document the rendering); unverified evaluation never runs for a
  platform-delivered request (decision 8); it lives in core and why (decision 2); tests use
  `createTestJwt` from `@voke/testing` (decision 9); a passing local test does not prove a
  token is genuine or that the issuer's keys are reachable.
- **`CONTEXT.md`**, "Relationships": replace line 430 with
  - "**Local Authorizer Evaluation** requires a token from the **Authorizer Identity Source**
    of a **JWT Authorizer** and checks its issuer, audience and time claims."
  - "**Local Authorizer Evaluation** never verifies a token signature."
  - "**Local Authorizer Evaluation** gives a route-backed **Function** the same **Route Auth
    Context** shape the **HTTP API** provides."
  - "**Local Authorizer Evaluation** of a **JWT Authorizer** does not run for a request the
    platform delivered to a deployed **Function**."

  No new term is introduced; do not add a glossary entry.

- **`apps/docs/content/docs/guides/authorizers.mdx`**:
  - `jwtAuthorizer` option table: `identitySource` is "One `$request.header.<name>` or
    `$request.querystring.<name>` expression." Below it: claim values in
    `request.auth.context` are strings (a number arrives as `"1700000000"`, a list as
    `"[admin editor]"`).
  - "Protect routes": replace the sentence about unknown names with: the local Gateway
    answers 500 with the same message.
  - "Run authorizers locally": new JWT row ("Requires a token from the identity source.
    Checks `iss`, `aud` or `client_id`, `exp`, `nbf`, `iat`. Missing or failing: `401`
    `UNAUTHORIZED`, with the reason in `www-authenticate`. The signature is not checked.");
    the Lambda row says header, query string and `$context` identity sources work. Replace the
    Callout with a `warn` Callout "Local evaluation does not prove a token is genuine": any
    well-formed token with the right issuer and audience passes locally; only API Gateway
    checks the signature.
  - A new twoslash sample: a JWT-protected `/profile`, `createTestJwt(authorizers.userJwt, {
sub: "usr_1" })`, `gateway.request("/profile", { headers: { authorization: `Bearer
    ${token}` } })`, and the tokenless 401. Add how to call `voke dev` by hand: send a real
    token from the issuer, or print a test token with
    `bun -e 'import { createTestJwt } from "@voke/testing"; ...'`.
  - "Inject auth context in tests": keep; add that a test that passes a Lambda event to
    `createLambdaHandlers(...)` must include `requestContext.authorizer.jwt.claims`, as API
    Gateway does, or a JWT route answers 401.
- **`apps/docs/content/docs/guides/testing.mdx`**, "Send HTTP requests to the Gateway":
  replace the Callout "JWT authorizers are not checked in process" with one paragraph and a
  short twoslash sample using `createTestJwt`; link to the authorizers guide.
- **`apps/docs/content/docs/reference/packages.mdx`**, `@voke/testing` table: add
  `createTestJwt` ("An unsigned JWT for a route behind a JWT authorizer, accepted by the local
  Gateway only.").

**Evidence**: `cd apps/docs && bun run test` → pass (samples compile, no untagged `ts` fence).
`grep -rn "not validated locally\|not checked in process\|runs without authorization" apps/docs/content`
→ no matches.

### Step 8: Full checks

`bun x ultracite fix`, then `bun run check`, `bun run typecheck`, `bun run test`.

## Test plan

`packages/core/test/jwt-authorizer.test.ts` (pure, fixed `nowSeconds`):

- accepts a token with matching `iss`, `aud` and a future `exp`; with and without `Bearer `;
  `bearer` in lower case.
- `"missing token"`: `undefined`, `""`, `"Bearer "`.
- `"token is not a JWT"`: `"abc"`, two segments, four segments, invalid base64, a payload that
  is a JSON array or a JSON string.
- issuer: different value, missing, a trailing slash, a number.
- audience: `aud` string match; `aud` array with one match; no match; `aud` absent and
  `client_id` matches; `aud` present and wrong while `client_id` matches (rejected); neither.
- time: `exp` equal to `now` rejected, `now + 1` accepted, missing, a string; `nbf` equal to
  `now` accepted, `now + 1` rejected; `iat` in the future rejected.
- the header is ignored: `alg: "none"` with an empty signature and `alg: "RS256"` with a
  garbage signature both pass.
- `toGatewayClaims`: number, boolean, array of strings, nested object, `null`, a non-ASCII
  string.
- `readIdentityValue`: header (any case), query string (exact case only), `$context.routeKey`,
  `$stageVariables.x`, `$request.cookie.x` (unsupported), blank value.

`packages/core/test/local-authorizer.test.ts` (Gateway, no Provider unless stated):

- JWT route, no token → 401 `UNAUTHORIZED`, `www-authenticate: Bearer`, handler not called.
- JWT route, `createTestJwt(...)` token → 200; `request.auth` has `source: "jwt"`, `sub`,
  `iss`, `aud`, and `exp` as a string.
- expired (`exp: 1`), not yet valid (`nbf: 32503680000`), wrong issuer, wrong audience,
  `Bearer abc` → 401, each with its reason in `www-authenticate`.
- identity source `$request.querystring.access_token`: token in the query → 200; token only
  in `authorization` → 401. Identity source `$request.header.X-Access-Token` → 200.
- Default HTTP Authorizer is the JWT Authorizer and one route sets `authorizer: "none"` → 200
  with no token.
- unknown authorizer name → 500 `INTERNAL_SERVER_ERROR` with the route and name in the
  message.
- Lambda Request Authorizer with `$request.querystring.key`: missing → 401 and the Request
  Authorizer Function did not run; present → it runs, 200. Two sources (header and query
  string): both required. `$context.routeKey` → the Function runs. `$stageVariables.x` → 401.
- through `createTestClient(gateway).get("/profile", { headers })` → 200 with a token, 401
  without.

`packages/core/test/provider-runtime.test.ts`: the two `isPlatformRequest` cases of step 4.

`packages/aws/test/route-auth.test.ts`: the event without an authorizer result → 401; the
builder cases of step 6.

`packages/testing/test/jwt.test.ts`: three segments, header `{ alg: "none", typ: "JWT" }`,
empty third segment; defaults from the authorizer (first audience); overrides win; a claim set
to `undefined` is absent; with `setSystemTime(new Date("2026-01-01T00:00:00Z"))` from
`bun:test`, `iat` is `1767225600` and `exp` is `1767229200` (call `setSystemTime()` afterwards
to restore the clock).

No test reads the real date for an expectation, sleeps, or opens a socket.

## Done criteria

- [ ] `bun run test`, `bun run typecheck` and `bun run check` exit 0.
- [ ] A tokenless `gateway.request` to a JWT Authorizer route returns 401; with a
      `createTestJwt` token it returns 200 and the handler sees `source: "jwt"` and string
      claims (`packages/core/test/local-authorizer.test.ts`).
- [ ] An HTTP API event without `requestContext.authorizer` on a JWT route returns
      `statusCode` 401 from `createLambdaHandlers` (`packages/aws/test/route-auth.test.ts`).
- [ ] A Lambda Request Authorizer with a query string identity source runs locally.
- [ ] `grep -n "kind !== \"lambda\"" packages/core/src/invoke.ts` → no match;
      `grep -n "identityHeaderName" packages/core/src` → no match.
- [ ] `grep -rn "jwt-authorizer" packages/core/src/index.ts` → no match (module stays internal);
      `grep -n "Bun\.\|Buffer" packages/core/src/jwt-authorizer.ts` → no match.
- [ ] `@voke/testing` exports exactly `createInvokeTestClient`, `createTestClient`,
      `createTestJwt` (public-surface test).
- [ ] The ADR exists; `CONTEXT.md` no longer says "does not fully validate"; the two guides no
      longer say JWTs are unchecked locally, and both state that the signature is not verified.
- [ ] `git status --short` shows only in-scope paths.

## STOP conditions

- `evaluateLocalAuthorizer`, `resolveRouteAuth` or `ProviderRuntimeCapability.routeAuth` was
  removed or reshaped by an earlier plan so that "the Provider reports nothing, then core
  evaluates locally" is no longer the flow.
- An earlier plan added route scopes or a signature-verification option: decisions 1, 3 and 5
  then need the coordinator.
- An existing test or example depends on a JWT Authorizer route being reachable without a
  token through the Gateway (none was found at `1c59d39`). Report it; do not weaken the check.
- Closing the gap needs a change to `packages/core/src/model.ts`, synthesis, or the type of
  `JwtAuthorizerInput` / `RouteAuthContext`.
- `packages/core/test/node-runtime.test.ts` fails because of the new module and removing
  `Bun`/`Buffer` usage does not fix it.

A moved line, a renamed local variable in `invoke.ts`, or a taken ADR number is routine drift:
adapt and continue.

## Maintenance notes

- **Verify against AWS when a real stage exists** (the index lists a real-AWS smoke deploy as
  never run): log `event.requestContext.authorizer.jwt.claims` for a token with a number, a
  list and a nested object, and correct `toGatewayClaims` if the rendering differs. Also check
  whether API Gateway accepts a token without `exp`.
- **If route scopes are added** (`AuthorizationScopes`): local evaluation must check `scope`
  or `scp` and answer 403, `awsRouteAuth` should stop dropping `jwt.scopes`, and
  `createTestJwt` users pass `scope` as a claim.
- **If a second Provider appears**: it must implement `isPlatformRequest`, or its deployed
  Functions would evaluate JWTs without a signature when its `routeAuth` reports nothing.
- **Plan 030** (runtime-only bundle) sets a size budget; this module adds about 150 lines to
  core, which is in every bundle.
- **Reviewer focus**: no token or claim value in any message or header; `exp` comparison
  direction; `aud` wins over `client_id`; the `platformRequest` branch runs before any token
  parsing; the unknown-authorizer branch returns 500, not `undefined`.
- **Deferred**: validating Lambda Request Authorizer identity-source expressions in
  `lambdaAuthorizer()` (today only local evaluation reports an unsupported one); narrowing
  `JwtAuthorizerInput.identitySource` to `string`; matching API Gateway's 401 body; a
  `voke dev` command that prints a test token.
