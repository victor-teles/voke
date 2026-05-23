# Function-first Gateway API Ergonomics Review

Issue: <https://github.com/victor-teles/voke/issues/9>

Scope: HITL review support for the final Function-first Gateway API shape. This is not a broad implementation rewrite and intentionally avoids model/synthesis work.

## Reviewed Surface

- `new Voke().get/post/put/patch/delete/head/options/route(...)`
- Route handler request object names: `req.body`, `req.params`, `req.query`, `req.headers`, `req.request`
- Route middleware shape: Hono `MiddlewareHandler<VokeEnv>`
- `functions.route(method, path, request?)`
- `gateway.request(pathOrRequest, init?)`
- README, examples, and stable public surface notes that explain the author mental model

## Findings

### Pass: route handler object is clear and predictable

Handlers receive one request object and all parsed parts are accessed through explicit names:

```ts
handler: (req) => ({
  id: req.params.id,
  includePosts: req.query.includePosts,
  requestId: req.headers["x-request-id"],
});
```

This keeps the mental model close to HTTP while still making Standard Schema parsing visible.

### Pass: middleware boundary stays Hono-compatible

`new Voke().use(...)` accepts Hono `MiddlewareHandler<VokeEnv>` and route mounting passes that middleware directly into Hono. This is the right compatibility boundary: Voke owns typed route definitions, while Hono owns context and middleware execution.

### Pass with small fix: `functions.route(...)` should not require an empty request object

For routes that do not need body, params, query, or headers, this should be valid:

```ts
await functions.route("GET", "/health");
```

The runtime already handled `request ?? {}`. The public type now matches that behavior, and `packages/core/test/route-builder-typecheck.ts` protects the call shape.

### Pass: `gateway.request(...)` feels like normal HTTP testing

The route builder works with Hono's existing `request(...)` testing helper:

```ts
const response = await gateway.request("/users/usr_1?includePosts=true", {
  headers: { "x-request-id": "req_1" },
});
```

That keeps gateway tests familiar and avoids inventing a second test client for simple HTTP assertions.

### Follow-up for #8: docs needed a Function-first pass

The review note that fed issue #8 was that the README still opened with Hono app wiring. First-party docs should lead with the Function-first Gateway mental model:

- `new Voke()` should introduce the Route Builder.
- `createGateway({ functions })` should show how route-backed Functions become HTTP routes.
- `functions.route(...)` should be documented as the direct typed route-call helper.
- `gateway.request(...)` should be documented as the HTTP-like test helper for Gateway routes.

Recommendation: issue #8 should update README/examples so Function-first Gateway apps are the primary authoring path.

## Follow-up Comments

- Consider whether GET/HEAD route definitions should accept `body` schemas. The current type permits it, and the tests avoid changing that behavior in this review pass.
- Consider whether public route method generics can be simplified later. The overloads are type-safe but visually heavy for users inspecting declarations.
