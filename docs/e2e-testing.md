# E2E Testing

Voke ships test helpers for local API execution, invoke flows, local AWS seed plans, and deployed smoke tests.

## Local API Tests

Use `createTestClient(app)` or `createTestClient(service)` to run requests through the Lambda HTTP API adapter.

```ts
import { expect, test } from "bun:test";
import { createTestClient } from "voke";
import service from "../src/index";

test("health", async () => {
  const client = createTestClient(service);
  const response = await client.get("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { ok: true } });
});
```

The same helper can target a deployed stack by passing `baseUrl`:

```ts
const client = createTestClient({ baseUrl: Bun.env.VOKE_E2E_API_URL! });
```

## Stack Test Context

`createStackTestContext()` prepares local AWS environment variables, resource bindings, CloudFormation output helpers, and deterministic seed commands.

```ts
import { createStackTestContext, synthesizeCloudFormation } from "voke";
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

## Invoke Tests

Use `createInvokeTestClient()` for local worker flows. Pass a function registry for typed calls.

```ts
const client = createInvokeTestClient(
  createFunctionRegistry({ sendWelcomeEmail })
);
const result = await client.invoke("sendWelcomeEmail", {
  userId: "usr_1",
  email: "victor@example.com",
});
```

## Examples

The `examples/e2e` package includes:

- `test/api.e2e.test.ts` for API requests.
- `test/invoke.e2e.test.ts` for worker/invoke flows.
- `test/local-floci.e2e.test.ts` for local AWS context and seed plans.
- `test/deployed-smoke.e2e.test.ts` for deployed stack smoke tests gated by `VOKE_E2E_API_URL`.
