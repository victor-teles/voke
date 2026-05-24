import { expect, test } from "bun:test";

import { Hono } from "hono";

import { api } from "../src/api";
import { createGateway } from "../src/app";
import { bindResource } from "../src/aws";
import {
  dynamodbTable,
  sqsQueue,
  synthesizeCloudFormation,
} from "../src/cloudformation";
import { awsContext, awsEvent, requestId } from "../src/context";
import type { VokeEnv } from "../src/context";
import {
  createHttpApiEvent,
  createInvokeTestClient,
  createStackTestContext,
  createTestClient,
} from "../src/e2e";
import {
  defineFunctions,
  defineFunction,
  withInvokeTrace,
} from "../src/invoke";
import type { StandardSchemaV1 } from "../src/invoke";
import { ok as json } from "../src/response";

interface TestHttpApiEvent {
  rawPath: string;
  rawQueryString: string;
  requestContext: {
    http: {
      method: string;
      userAgent: string;
    };
  };
}

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

const userInputSchema: StandardSchemaV1<{ id: string }, { id: string }> = {
  "~standard": {
    validate: (value) =>
      value.id.trim() === ""
        ? { issues: [{ message: "id is required" }], success: false }
        : { data: value, success: true },
    vendor: "voke-test",
    version: 1,
  },
};

const withEnv = async <TResult>(
  values: Record<string, string>,
  operation: () => Promise<TResult>
): Promise<TResult> => {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, Bun.env[name]])
  );

  for (const [name, value] of Object.entries(values)) {
    Bun.env[name] = value;
  }

  try {
    return await operation();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      Bun.env[name] = value;
    }
  }
};

test("creates a local API test client with API Gateway semantics", async () => {
  const app = new Hono<VokeEnv>();

  app.post("/users/:id", async (c) => {
    const body = await c.req.json();
    const event = awsEvent(c) as TestHttpApiEvent | undefined;
    const context = awsContext(c);

    return json({
      body,
      id: c.req.param("id"),
      lambdaRequestId: requestId(c),
      method: event?.requestContext.http.method,
      query: c.req.query("debug"),
      rawPath: event?.rawPath,
      rawQueryString: event?.rawQueryString,
      requestId: context?.awsRequestId,
      sourceIp: c.req.header("x-forwarded-for"),
      userAgent: event?.requestContext.http.userAgent,
    });
  });

  const client = createTestClient(app);
  const response = await client.post("/users/usr_1?debug=true", {
    context: { awsRequestId: "lambda_req_1" },
    headers: {
      "user-agent": "voke-parity-test",
      "x-forwarded-for": "127.0.0.1",
      "x-request-id": "api_req_1",
    },
    json: { name: "Victor" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: {
      body: { name: "Victor" },
      id: "usr_1",
      lambdaRequestId: "lambda_req_1",
      method: "POST",
      query: "true",
      rawPath: "/users/usr_1",
      rawQueryString: "debug=true",
      requestId: "lambda_req_1",
      sourceIp: "127.0.0.1",
      userAgent: "voke-parity-test",
    },
  });
});

test("creates explicit HTTP API events for local harness assertions", () => {
  const event = createHttpApiEvent("PATCH", "/users/usr_1?debug=true", {
    headers: {
      "user-agent": "custom-agent",
      "x-forwarded-for": "10.0.0.1",
      "x-request-id": "req_event",
    },
    json: { name: "Victor" },
  }) as TestHttpApiEvent & {
    body: string;
    headers: Record<string, string>;
    requestContext: TestHttpApiEvent["requestContext"] & {
      requestId: string;
    };
    routeKey: string;
    version: string;
  };

  expect(event).toMatchObject({
    body: '{"name":"Victor"}',
    headers: {
      "content-type": "application/json",
      "user-agent": "custom-agent",
      "x-forwarded-for": "10.0.0.1",
      "x-forwarded-proto": "https",
      "x-request-id": "req_event",
    },
    rawPath: "/users/usr_1",
    rawQueryString: "debug=true",
    requestContext: {
      http: {
        method: "PATCH",
        userAgent: "custom-agent",
      },
      requestId: "req_event",
    },
    routeKey: "$default",
    version: "2.0",
  });
});

test("supports Voke API targets in the local test client", async () => {
  const app = new Hono();

  app.put("/health", () => json({ ok: true }));

  const client = createTestClient(api(app, { name: "health-api" }));
  const response = await client.put("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { ok: true } });
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

test("keeps remote test client verb helpers deterministic", async () => {
  const requests: Request[] = [];
  const client = createTestClient({
    baseUrl: "https://api.example.com/prod/",
    fetch: (request: Request) => {
      requests.push(request);

      return Response.json({ data: { method: request.method } });
    },
  });

  await client.request("HEAD", "status");
  await client.get("users");
  await client.post("/users", { json: { id: "usr_1" } });
  await client.put("/users/usr_1", { body: "raw" });
  await client.patch("/users/usr_1");
  await client.delete("/users/usr_1");

  expect(await Promise.all(requests.map((request) => request.text()))).toEqual([
    "",
    "",
    '{"id":"usr_1"}',
    "raw",
    "",
    "",
  ]);
  expect(requests.map((request) => [request.method, request.url])).toEqual([
    ["HEAD", "https://api.example.com/prod/status"],
    ["GET", "https://api.example.com/prod/users"],
    ["POST", "https://api.example.com/prod/users"],
    ["PUT", "https://api.example.com/prod/users/usr_1"],
    ["PATCH", "https://api.example.com/prod/users/usr_1"],
    ["DELETE", "https://api.example.com/prod/users/usr_1"],
  ]);
  expect(requests[2]?.headers.get("content-type")).toBe("application/json");
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
  expect(() => context.output("MissingOutput")).toThrow(
    "Missing stack test output: MissingOutput"
  );
  expect(() => context.resource("ordersQueue", "arn")).toThrow(
    "Missing stack test resource binding: VOKE_RESOURCE_ORDERS_QUEUE_ARN"
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

test("creates stack contexts with endpoint, account, and region overrides", () => {
  const template = synthesizeCloudFormation({
    name: "orders-api",
    resources: {
      ordersQueue: sqsQueue(),
    },
    stage: "local",
  });
  const context = createStackTestContext({
    accountId: "123456789012",
    endpoint: "http://localhost:4567",
    region: "us-west-2",
    template,
  });

  expect(context.environment).toMatchObject({
    AWS_ENDPOINT_URL: "http://localhost:4567",
    AWS_REGION: "us-west-2",
    VOKE_AWS_ENDPOINT_URL: "http://localhost:4567",
  });
  expect(context.resource("ordersQueue", "url")).toBe(
    "http://localhost:4567/123456789012/OrdersQueue"
  );
  expect(
    context.createSeedPlan({ sqs: { OrdersQueue: [{ id: "evt_1" }] } }).commands
  ).toEqual([
    [
      "aws",
      "sqs",
      "send-message",
      "--queue-url",
      "http://localhost:4567/123456789012/OrdersQueue",
      "--message-body",
      '{"id":"evt_1"}',
      "--region",
      "us-west-2",
    ],
  ]);
});

test("creates invoke test helpers for worker flows", async () => {
  const getUser = defineFunction({
    handler: (payload, context) => ({
      id: payload.id,
      name: "Victor",
      requestId: context.trace.requestId,
    }),
    input: userInputSchema,
    output: schema<{
      id: string;
      name: string;
      requestId: string | number | boolean | undefined;
    }>(),
  });
  const registry = defineFunctions({ getUser });
  const client = createInvokeTestClient(registry);

  const user = await client.invoke(
    "getUser",
    { id: "usr_1" },
    {
      trace: { requestId: "req_1" },
    }
  );

  expect(user as unknown).toEqual({
    id: "usr_1",
    name: "Victor",
    requestId: "req_1",
  });
  await expect(client.invokeAsync("getUser", { id: "usr_1" })).resolves.toEqual(
    {
      accepted: true,
    }
  );
  await expect(client.invoke("getUser", { id: "" })).rejects.toMatchObject({
    code: "INVALID_PAYLOAD",
    functionName: "getUser",
    message: "Invalid payload for getUser: id is required",
  });
  await expect(
    createInvokeTestClient(registry).invoke(
      "missingUser" as "getUser",
      { id: "usr_1" },
      {}
    )
  ).rejects.toMatchObject({
    code: "MISSING_FUNCTION",
    message: "Cannot invoke an undefined function definition",
  });
});

test("creates invoke test helpers for registry functions", async () => {
  const registry = defineFunctions({
    pingWorker: defineFunction({
      handler: (_payload, context) => ({
        ok: true,
        requestId: context.trace.requestId,
      }),
      input: schema<{ id: string }>(),
      output: schema<{
        ok: boolean;
        requestId: string | number | boolean | undefined;
      }>(),
    }),
  });
  const client = createInvokeTestClient(registry);

  const ping = await client.invoke(
    "pingWorker",
    { id: "ping_1" },
    {
      trace: { requestId: "req_ping" },
    }
  );

  expect(ping as unknown).toEqual({
    ok: true,
    requestId: "req_ping",
  });
  await expect(
    client.invokeAsync("pingWorker", { id: "ping_1" })
  ).resolves.toEqual({
    accepted: true,
  });
});

test("propagates invoke trace through local API to function calls", async () => {
  const functions = defineFunctions({
    getApiUser: defineFunction({
      handler: (payload, context) => ({
        id: payload.id,
        requestId: context.trace.requestId,
      }),
      input: schema<{ id: string }>(),
      output: schema<{
        id: string;
        requestId: string | number | boolean | undefined;
      }>(),
    }),
  });
  createGateway({ functions });

  const app = new Hono();

  app.get("/users/:id", async (c) => {
    const user = await withInvokeTrace(
      { requestId: c.req.header("x-request-id") },
      () => functions.invoke("getApiUser", { id: c.req.param("id") })
    );

    return json(user);
  });

  const client = createTestClient(app);
  const response = await client.get("/users/usr_1", {
    headers: { "x-request-id": "req_api_trace" },
  });

  expect(await response.json()).toEqual({
    data: {
      id: "usr_1",
      requestId: "req_api_trace",
    },
  });
});

test("merges nested invoke traces with explicit invoke options winning", async () => {
  const audit = defineFunction({
    handler: (_payload, context) => context.trace,
    output: schema<Record<string, string | number | boolean | undefined>>(),
  });
  const client = createInvokeTestClient(defineFunctions({ auditTrace: audit }));

  const auditTrace = await withInvokeTrace(
    { requestId: "outer", tenant: "acme" },
    () =>
      client.invoke("auditTrace", undefined, { trace: { requestId: "inner" } })
  );

  expect(auditTrace as unknown).toEqual({
    requestId: "inner",
    tenant: "acme",
  });
});

test("exposes local resource bindings to API and function code", async () => {
  const template = synthesizeCloudFormation({
    name: "orders-api",
    resources: {
      ordersQueue: sqsQueue(),
    },
    stage: "local",
  });
  const stack = createStackTestContext({
    endpoint: "http://localhost:4566",
    template,
  });
  const ordersQueue = bindResource("ordersQueue", "url");
  const functions = defineFunctions({
    readQueue: defineFunction({
      handler: () => ({
        queueUrl: ordersQueue.value(),
      }),
      output: schema<{ queueUrl: string }>(),
    }),
  });
  createGateway({ functions });

  const app = new Hono();

  app.get("/bindings", async () =>
    json({
      apiQueueUrl: ordersQueue.value(),
      worker: await functions.invoke("readQueue"),
    })
  );

  await withEnv(stack.bindings, async () => {
    const response = await createTestClient(app).get("/bindings");

    expect(await response.json()).toEqual({
      data: {
        apiQueueUrl: "http://localhost:4566/000000000000/OrdersQueue",
        worker: {
          queueUrl: "http://localhost:4566/000000000000/OrdersQueue",
        },
      },
    });
  });
});
