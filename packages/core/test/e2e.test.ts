import { expect, test } from "bun:test";

import { Hono } from "hono";

import { dynamodbTable, sqsQueue } from "../src/aws";
import {
  createFunctionRegistry,
  createInvokeTestClient,
  createStackTestContext,
  createTestClient,
  defineFunction,
  json,
  synthesizeCloudFormation,
} from "../src/index";

test("creates a local API test client with API Gateway semantics", async () => {
  const app = new Hono();

  app.post("/users/:id", async (c) => {
    const body = await c.req.json();

    return json({
      body,
      id: c.req.param("id"),
      sourceIp: c.req.header("x-forwarded-for"),
    });
  });

  const client = createTestClient(app);
  const response = await client.post("/users/usr_1", {
    headers: { "x-forwarded-for": "127.0.0.1" },
    json: { name: "Victor" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: {
      body: { name: "Victor" },
      id: "usr_1",
      sourceIp: "127.0.0.1",
    },
  });
});

test("can run the same API test client against a deployed base URL", async () => {
  const requests: Request[] = [];
  const client = createTestClient({
    baseUrl: "https://api.example.com/prod",
    fetch: (request: Request) => {
      requests.push(request);

      return Response.json({ data: { ok: true } });
    },
  });

  const response = await client.get("/health?deep=true");

  expect(requests[0]?.url).toBe(
    "https://api.example.com/prod/health?deep=true"
  );
  expect(requests[0]?.method).toBe("GET");
  expect(await response.json()).toEqual({ data: { ok: true } });
});

test("creates stack test context with local environment, outputs, and seed commands", () => {
  const template = synthesizeCloudFormation({
    name: "orders-api",
    resources: {
      ordersQueue: sqsQueue(),
      ordersTable: dynamodbTable({ partitionKey: "id" }),
    },
    stage: "local",
  });
  const context = createStackTestContext({
    endpoint: "http://localhost:4566",
    outputs: {
      ApiUrl: "https://example.execute-api.sa-east-1.amazonaws.com/local",
    },
    region: "sa-east-1",
    template,
  });
  const seedPlan = context.createSeedPlan({
    dynamodb: {
      OrdersTable: [{ id: "ord_1", status: "created" }],
    },
    sqs: {
      OrdersQueue: [{ id: "evt_1" }],
    },
  });

  expect(context.environment.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
  expect(context.resource("ordersTable", "name")).toBe("OrdersTable");
  expect(context.output("ApiUrl")).toBe(
    "https://example.execute-api.sa-east-1.amazonaws.com/local"
  );
  expect(seedPlan.environment).toEqual(context.environment);
  expect(seedPlan.commands).toEqual([
    [
      "aws",
      "dynamodb",
      "put-item",
      "--table-name",
      "OrdersTable",
      "--item",
      '{"id":{"S":"ord_1"},"status":{"S":"created"}}',
      "--region",
      "sa-east-1",
    ],
    [
      "aws",
      "sqs",
      "send-message",
      "--queue-url",
      "http://localhost:4566/000000000000/OrdersQueue",
      "--message-body",
      '{"id":"evt_1"}',
      "--region",
      "sa-east-1",
    ],
  ]);
});

test("creates invoke test helpers for worker flows", async () => {
  const getUser = defineFunction({
    handler: (payload: { id: string }) => ({
      id: payload.id,
      name: "Victor",
    }),
    name: "getUser",
  });
  const registry = createFunctionRegistry({ getUser });
  const client = createInvokeTestClient(registry);

  await expect(client.invoke("getUser", { id: "usr_1" })).resolves.toEqual({
    id: "usr_1",
    name: "Victor",
  });
  await expect(client.invokeAsync("getUser", { id: "usr_1" })).resolves.toEqual(
    {
      accepted: true,
    }
  );
});
