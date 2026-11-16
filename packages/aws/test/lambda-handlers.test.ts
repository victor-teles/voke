import { expect, mock, test } from "bun:test";

import {
  createFunctions,
  createVariableSource,
  defineConfig,
  fn,
  http,
  InvokeError,
  route,
  voke,
  VokeConfigError,
} from "voke";
import type { StandardSchemaV1, VokePlugin } from "voke";

import { sqsQueue } from "../src/cloudformation";
import {
  aws,
  createAuthorizers,
  createLambdaHandlers,
  lambdaAuthorizer,
  requestAuthorizer,
  sqs,
} from "../src/index";

const schema = <TValue>(
  check: (value: unknown) => boolean = () => true
): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) =>
      check(value)
        ? { value: value as TValue }
        : { issues: [{ message: "invalid" }] },
    vendor: "voke-test",
    version: 1,
  },
});

const httpEvent = (method: string, path: string, extra: object = {}) => ({
  headers: {},
  isBase64Encoded: false,
  rawPath: path,
  rawQueryString: "",
  requestContext: {
    accountId: "123456789012",
    apiId: "api",
    domainName: "api.example.com",
    http: {
      method,
      path,
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "test",
    },
    requestId: "req",
    routeKey: "$default",
    stage: "$default",
    time: "",
    timeEpoch: 0,
  },
  routeKey: "$default",
  version: "2.0",
  ...extra,
});

const authorizerEvent = (authorization?: string) => ({
  cookies: ["session=abc"],
  headers: authorization === undefined ? {} : { authorization },
  rawPath: "/me",
  rawQueryString: "view=full",
  requestContext: { domainName: "api.example.com", http: { method: "GET" } },
  type: "REQUEST",
  version: "2.0",
});

const sqsRecord = (messageId: string, body: string) => ({
  attributes: {},
  awsRegion: "us-east-1",
  body,
  eventSource: "aws:sqs",
  eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:orders",
  md5OfBody: "",
  messageAttributes: {},
  messageId,
  receiptHandle: `receipt-${messageId}`,
});

const createProject = () => {
  const functions = createFunctions({
    authorizeSession: requestAuthorizer({
      context: schema<{ userId: string }>(
        (value) => typeof (value as { userId?: unknown })?.userId === "string"
      ),
      handler: (request) => {
        const token = request.headers.get("authorization");

        if (token === "Bearer crash") {
          throw new Error("token service down");
        }

        if (token === "Bearer bad-context") {
          return { authorized: true, context: { userId: 42 } as never };
        }

        return token === "Bearer valid"
          ? {
              authorized: true,
              context: {
                userId: `${new URL(request.request.url).searchParams.get("view")}:${request.headers.get("cookie")}`,
              },
            }
          : { authorized: false };
      },
    }),
    getUser: fn({
      handler: (payload) => ({ id: payload.id, name: "Ada" }),
      input: schema<{ id: string }>(
        (value) => typeof (value as { id?: unknown })?.id === "string"
      ),
      output: schema<{ id: string; name: string }>(),
      routes: [
        route.get("/users/:id", {
          handler: (request) => ({ id: request.params.id }),
        }),
      ],
    }),
    http: http({
      authorizers: createAuthorizers({
        session: lambdaAuthorizer({ function: "authorizeSession" }),
      }),
      routes: [route.get("/health", { handler: () => ({ ok: true }) })],
    }),
    "process-order": sqs({
      handler: (batch) => batch.ok(),
      message: schema<{ id: string }>(
        (value) => typeof (value as { id?: unknown })?.id === "string"
      ),
      queue: "ordersQueue",
    }),
  });

  return {
    functions,
    gateway: voke(functions, {
      config: { name: "lambda-handlers", provider: aws() },
    }),
  };
};

test("exports one handler per Function, named by its generated export name", () => {
  const { gateway } = createProject();

  expect(
    Object.keys(createLambdaHandlers({ default: gateway })).toSorted()
  ).toEqual(["authorizeSession", "getUser", "http", "processOrder"]);
});

test("serves HTTP API events through the Gateway, including the JSON 404", async () => {
  const { gateway } = createProject();
  const handlers = createLambdaHandlers({ default: gateway });

  const ok = (await handlers.http?.(httpEvent("GET", "/health"))) as {
    body: string;
    statusCode: number;
  };
  const missing = (await handlers.http?.(httpEvent("GET", "/nope"))) as {
    body: string;
    statusCode: number;
  };

  expect(ok.statusCode).toBe(200);
  expect(JSON.parse(ok.body)).toEqual({ data: { ok: true } });
  expect(missing.statusCode).toBe(404);
  expect(JSON.parse(missing.body).error.code).toBe("NOT_FOUND");
});

const isRecordWith = (value: unknown, key: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype &&
  typeof (value as Record<string, unknown>)[key] === "string";

test("a request answers the same through the local Gateway and the Lambda handler", async () => {
  const functions = createFunctions({
    http: http({
      routes: [
        route.get("/search", {
          handler: (request) => ({ query: request.query }),
          query: schema<{ page: string }>((value) =>
            isRecordWith(value, "page")
          ),
        }),
        route.get("/tenant", {
          handler: (request) => ({
            cookie: request.headers.cookie,
            tenant: request.headers["x-tenant"],
          }),
          headers: schema<{ cookie?: string; "x-tenant": string }>((value) =>
            isRecordWith(value, "x-tenant")
          ),
        }),
        route.post("/items", {
          body: schema<{ name: string }>((value) =>
            isRecordWith(value, "name")
          ),
          handler: (request) => ({ name: request.body.name }),
        }),
      ],
    }),
  });
  const gateway = voke(functions, {
    config: { name: "lambda-parity", provider: aws() },
  });
  const handlers = createLambdaHandlers({ default: gateway });
  const json = { "content-type": "application/json" };
  const cases = [
    {
      body: { data: { query: { page: "2", tag: "a,b" } } },
      event: httpEvent("GET", "/search", {
        rawQueryString: "page=2&tag=a&tag=b",
      }),
      local: () => gateway.request("/search?page=2&tag=a&tag=b"),
      status: 200,
    },
    {
      body: { data: { cookie: "a=1; b=2", tenant: "acme" } },
      event: httpEvent("GET", "/tenant", {
        cookies: ["a=1", "b=2"],
        headers: { "x-tenant": "acme" },
      }),
      local: () =>
        gateway.request("/tenant", {
          headers: { cookie: "a=1; b=2", "x-tenant": "acme" },
        }),
      status: 200,
    },
    {
      body: { data: { name: "Ada" } },
      event: httpEvent("POST", "/items", {
        body: Buffer.from('{"name":"Ada"}').toString("base64"),
        headers: json,
        isBase64Encoded: true,
      }),
      local: () =>
        gateway.request("/items", {
          body: '{"name":"Ada"}',
          headers: json,
          method: "POST",
        }),
      status: 200,
    },
    {
      body: {
        error: {
          code: "INVALID_REQUEST",
          issues: [{ message: "Malformed JSON", path: ["body"] }],
          message: "Invalid body",
        },
      },
      event: httpEvent("POST", "/items", { body: "{oops", headers: json }),
      local: () =>
        gateway.request("/items", {
          body: "{oops",
          headers: json,
          method: "POST",
        }),
      status: 400,
    },
    {
      body: {
        error: {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Unsupported content type: send application/json",
        },
      },
      event: httpEvent("POST", "/items", {
        body: '{"name":"Ada"}',
        headers: { "content-type": "text/plain" },
      }),
      local: () =>
        gateway.request("/items", {
          body: '{"name":"Ada"}',
          headers: { "content-type": "text/plain" },
          method: "POST",
        }),
      status: 415,
    },
  ];

  for (const { body, event, local, status } of cases) {
    const deployed = (await handlers.http?.(event)) as {
      body: string;
      statusCode: number;
    };
    const response = await local();

    expect(deployed.statusCode).toBe(status);
    expect(response.status).toBe(status);
    expect(JSON.parse(deployed.body)).toEqual(body);
    expect(await response.json()).toEqual(body);
  }
});

test("passes SQS batches through sendEvent and reports only failed messages", async () => {
  const { gateway } = createProject();
  const result = await createLambdaHandlers({
    default: gateway,
  }).processOrder?.({
    Records: [sqsRecord("ok", '{"id":"ord_1"}'), sqsRecord("bad", "{}")],
  });

  expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
});

test("invokes invokable Functions with the Lambda event as the payload", async () => {
  const { gateway } = createProject();
  const handlers = createLambdaHandlers({ default: gateway });

  await expect(handlers.getUser?.({ id: "usr_1" })).resolves.toEqual({
    id: "usr_1",
    name: "Ada",
  });
  await expect(handlers.getUser?.({ id: 7 })).rejects.toBeInstanceOf(
    InvokeError
  );
  await expect(handlers.getUser?.({ id: 7 })).rejects.toMatchObject({
    code: "INVALID_PAYLOAD",
  });
});

test("routes HTTP API events for invokable Functions that also serve routes", async () => {
  const { gateway } = createProject();
  const response = (await createLambdaHandlers({ default: gateway }).getUser?.(
    httpEvent("GET", "/users/usr_9")
  )) as { body: string; statusCode: number };

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ data: { id: "usr_9" } });
});

test("answers API Gateway Lambda authorizer events with simple responses", async () => {
  const { gateway } = createProject();
  const authorize = createLambdaHandlers({ default: gateway }).authorizeSession;
  const errorLog = mock(() => {});
  const originalError = console.error;
  console.error = errorLog;

  try {
    await expect(authorize?.(authorizerEvent("Bearer valid"))).resolves.toEqual(
      {
        context: { userId: "full:session=abc" },
        isAuthorized: true,
      }
    );
    await expect(authorize?.(authorizerEvent("Bearer nope"))).resolves.toEqual({
      isAuthorized: false,
    });
    await expect(
      authorize?.(authorizerEvent("Bearer bad-context"))
    ).resolves.toEqual({
      isAuthorized: false,
    });
    await expect(authorize?.(authorizerEvent("Bearer crash"))).resolves.toEqual(
      {
        isAuthorized: false,
      }
    );
  } finally {
    console.error = originalError;
  }

  // Failures are logged for the operator, never returned to the caller.
  expect(errorLog).toHaveBeenCalledTimes(2);
});

test("activates a Function Registry export so Runtime Variables load", async () => {
  const functions = createFunctions({
    readSetting: fn({
      handler: async (_payload, context) =>
        await context.variables.setting.text(),
      output: schema<string>(),
      variables: {
        setting: createVariableSource("aws", {
          kind: "ssmParameter",
          name: "/app/setting",
        }),
      },
    }),
  });
  const previous = process.env.VOKE_VARIABLE_SETTING;
  process.env.VOKE_VARIABLE_SETTING = "from-env";

  try {
    await expect(
      createLambdaHandlers({ functions }).readSetting?.({})
    ).resolves.toBe("from-env");
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "VOKE_VARIABLE_SETTING");
    } else {
      process.env.VOKE_VARIABLE_SETTING = previous;
    }
  }
});

test("requires a Gateway export for route-backed Functions", () => {
  const functions = createFunctions({
    http: http({ routes: [route.get("/", { handler: () => "ok" })] }),
  });

  expect(() => createLambdaHandlers({ functions })).toThrow(VokeConfigError);
  expect(() => createLambdaHandlers({ functions })).toThrow(
    'Function "http" serves HTTP routes, so the project entrypoint must export a Gateway'
  );
});

const timingPlugin = (calls: string[]): VokePlugin => ({
  contributions: {
    functions: {
      ping: http({
        routes: [
          route.get("/plugin-ping", { handler: () => ({ pong: true }) }),
        ],
      }),
    },
  },
  name: "timing",
  runtime: {
    setup: () => ({
      wrap: async (execution, next) => {
        calls.push(`${execution.kind}:${execution.functionKey}`);

        return await next();
      },
    }),
  },
});

const createRegistryOnlyProject = () =>
  createFunctions({
    "process-order": sqs({
      handler: (batch) => batch.ok(),
      message: schema<{ id: string }>(),
      queue: "ordersQueue",
    }),
  });

test("a registry-only project with a config runs Plugin wraps and serves Plugin routes", async () => {
  const calls: string[] = [];
  const handlers = createLambdaHandlers(
    { functions: createRegistryOnlyProject() },
    {
      config: {
        name: "registry-plugins",
        plugins: [timingPlugin(calls)],
        provider: aws(),
        resources: { ordersQueue: sqsQueue() },
      },
    }
  );

  expect(Object.keys(handlers).toSorted()).toEqual([
    "processOrder",
    "timingPing",
  ]);
  await expect(
    handlers.processOrder?.({ Records: [sqsRecord("ok", '{"id":"ord_1"}')] })
  ).resolves.toEqual({ batchItemFailures: [] });

  const response = (await handlers.timingPing?.(
    httpEvent("GET", "/plugin-ping")
  )) as { body: string; statusCode: number };

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ data: { pong: true } });
  expect(calls).toEqual(["event:process-order", "route:timing-ping"]);
});

test("a Gateway project serves Plugin routes from its own Gateway", async () => {
  const calls: string[] = [];
  const config = defineConfig({
    name: "gateway-plugins",
    plugins: [timingPlugin(calls)],
    provider: aws(),
  });
  const gateway = voke(
    createFunctions({
      http: http({ routes: [route.get("/", { handler: () => "home" })] }),
    }),
    { config }
  );
  const handlers = createLambdaHandlers({ default: gateway }, { config });

  const response = (await handlers.timingPing?.(
    httpEvent("GET", "/plugin-ping")
  )) as { statusCode: number };

  expect(response.statusCode).toBe(200);
  expect(calls).toEqual(["route:timing-ping"]);
});

test("a Gateway whose Plugins differ from the passed config is rejected", () => {
  const gateway = voke(
    createFunctions({
      http: http({ routes: [route.get("/", { handler: () => "home" })] }),
    }),
    { config: { name: "stale-gateway", provider: aws() } }
  );

  expect(() =>
    createLambdaHandlers(
      { default: gateway },
      {
        config: {
          name: "stale-gateway",
          plugins: [timingPlugin([])],
          provider: aws(),
        },
      }
    )
  ).toThrow(
    "The Gateway was created with a different config than voke.config.ts; pass it: voke(functions, { config })"
  );
});

test("rejects an entrypoint that exports neither a Gateway nor a Function Registry", () => {
  expect(() => createLambdaHandlers({ default: { fetch: () => {} } })).toThrow(
    "The project entrypoint must export a Gateway (export default voke(functions, { config })) or a Function Registry (export const functions = createFunctions({ ... }))."
  );
});
