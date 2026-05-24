# E2E Testing

Voke ships test helpers for Function invocation, Route Builder calls, Gateway HTTP requests, local AWS seed plans, and deployed smoke tests.

## Function Invocation Tests

Use a Function Registry from `createFunctions(...)` when a test should exercise an invokable Function Contract.

```ts
import { expect, test } from "bun:test";
import { createFunctions, fn } from "voke";

const functions = createFunctions({
  sendWelcomeEmail: fn({
    output: emailOutput,
    input: emailInput,
    handler: (payload) => ({ ...payload, queued: true }),
  }),
});

test("queues welcome emails", async () => {
  const result = await functions.invoke("sendWelcomeEmail", {
    userId: "usr_1",
    email: "victor@example.com",
  });

  expect(result.queued).toBe(true);
});
```

`functions.invoke(...)` validates the Function input and output schemas, preserves registry-key inference, and can also target AWS runtime mode when a deployed Lambda transport is configured.

## Route Builder Tests

Use `route` and `http({ routes })` to define route-backed Functions, then call `functions.route(...)` when a test should stay typed and bypass HTTP serialization.

```ts
import { createFunctions, http, route } from "voke";

const functions = createFunctions({
  http: http({
    routes: [
      route.get("/users/:id", {
        params: userParams,
        output: userOutput,
        handler: (req) => ({ id: req.params.id, name: "Victor" }),
      }),
    ],
  }),
});

const user = await functions.route("GET", "/users/:id", {
  params: { id: "usr_1" },
});
```

`functions.route(...)` is the direct Route Builder test helper. It keeps params, query, headers, body, and output types tied to the Function Contract declared on the route.

## Gateway Request Tests

Use `voke(functions, { config })` when a test should exercise the Gateway as HTTP.

```ts
import { voke } from "voke";

const gateway = voke(functions, { config: { name: "users-api" } });
const response = await gateway.request("/users/usr_1");

expect(response.status).toBe(200);
expect(await response.json()).toEqual({
  data: { id: "usr_1", name: "Victor" },
});
```

`gateway.request(...)` follows the same request shape as Hono's local request helper, so tests can pass method, headers, body, and query strings while still using the Function-first Gateway.

## Lambda/API Gateway Tests

Use `createTestClient(app)` or `createTestClient(service)` when a test should run through Lambda HTTP API event conversion.

```ts
import { createTestClient } from "voke/testing";
import service from "../src/index";

const client = createTestClient(service);
const response = await client.get("/health");
```

The same helper can target a deployed stack by passing `baseUrl`:

```ts
const client = createTestClient({ baseUrl: Bun.env.VOKE_E2E_API_URL! });
```

## Stack Test Context

`createStackTestContext()` prepares local AWS environment variables, resource bindings, CloudFormation output helpers, and deterministic seed commands.

```ts
import { synthesizeCloudFormation } from "voke/cloudformation";
import { createStackTestContext } from "voke/testing";
import { dynamodbTable } from "voke/aws";

const template = synthesizeCloudFormation({
  name: "orders-api",
  resources: {
    ordersTable: dynamodbTable({ partitionKey: "id" }),
  },
});

const context = createStackTestContext({ template });
const seedPlan = context.createSeedPlan({
  dynamodb: {
    OrdersTable: [{ id: "ord_1", status: "created" }],
  },
});
```

Run the returned `seedPlan.commands` with `seedPlan.environment` when a test suite needs to seed Floci before requests.

## Compatibility Helper

`createInvokeTestClient()` remains available for worker-heavy suites that want a client object around a Function Registry:

```ts
const client = createInvokeTestClient(functions);
const result = await client.invoke("sendWelcomeEmail", {
  userId: "usr_1",
  email: "victor@example.com",
});
```

Prefer direct `functions.invoke(...)`, `functions.route(...)`, and `gateway.request(...)` in new first-party examples unless the client abstraction makes a deployed or worker suite clearer.

## Examples

The `examples/e2e` package includes:

- `test/api.e2e.test.ts` for Gateway requests through Lambda/API Gateway semantics.
- `test/invoke.e2e.test.ts` for Function invocation flows.
- `test/local-floci.e2e.test.ts` for local AWS context and seed plans.
- `test/deployed-smoke.e2e.test.ts` for deployed stack smoke tests gated by `VOKE_E2E_API_URL`.
