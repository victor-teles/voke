import { expect, mock, test } from "bun:test";

import {
  createFunctions,
  createVariableSource,
  fn,
  http,
  InvokeError,
  route,
  voke,
  VokeConfigError,
} from "voke";
import type { StandardSchemaV1 } from "voke";

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
        ? { data: value as TValue, success: true }
        : { issues: [{ message: "invalid" }], success: false },
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

test("rejects an entrypoint that exports neither a Gateway nor a Function Registry", () => {
  expect(() => createLambdaHandlers({ default: { fetch: () => {} } })).toThrow(
    "The project entrypoint must export a Gateway (export default voke(functions, { config })) or a Function Registry (export const functions = createFunctions({ ... }))."
  );
});
