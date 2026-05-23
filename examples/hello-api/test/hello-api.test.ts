import { expect, test } from "bun:test";

import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";

import helloApi from "../src/index";

const { handler } = helloApi;

const lambdaEvent = (overrides: Record<string, unknown>): LambdaEvent => {
  const requestContext = {
    accountId: "local",
    apiId: "local",
    authentication: null,
    authorizer: {},
    domainName: "localhost",
    domainPrefix: "localhost",
    http: {
      method: "GET",
      path: "/",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "bun:test",
    },
    requestId: "req_local",
    routeKey: "$default",
    stage: "$default",
    time: "01/Jan/2026:00:00:00 +0000",
    timeEpoch: 1_767_225_600_000,
  };
  const { requestContext: overrideRequestContext, ...rest } = overrides as {
    requestContext?: { http?: Record<string, unknown> };
  } & Record<string, unknown>;

  return {
    body: null,
    headers: {
      host: "localhost",
    },
    isBase64Encoded: false,
    rawPath: "/",
    rawQueryString: "",
    requestContext: {
      ...requestContext,
      ...overrideRequestContext,
      http: {
        ...requestContext.http,
        ...overrideRequestContext?.http,
      },
    },
    routeKey: "$default",
    version: "2.0",
    ...rest,
  } as LambdaEvent;
};

test("exports a named Voke API", () => {
  const defaultHandler = Object.getOwnPropertyDescriptor(
    helloApi,
    "handler"
  )?.value;

  expect(helloApi.name).toBe("hello-api");
  expect(handler).toBe(defaultHandler);
});

test("responds through the Lambda handler", async () => {
  const response = await handler(
    lambdaEvent({
      rawPath: "/",
      requestContext: {
        http: {
          method: "GET",
          path: "/",
        },
      },
    })
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    data: {
      message: "Hello from Voke",
    },
  });
});

test("responds from composed health routes with config", async () => {
  const response = await handler(
    lambdaEvent({
      rawPath: "/health",
      requestContext: {
        http: {
          method: "GET",
          path: "/health",
        },
      },
    }),
    {
      awsRequestId: "req_health",
    } as LambdaContext
  );

  expect(response.statusCode).toBe(200);
  expect(response.headers?.["x-request-id"]).toBe("req_health");
  expect(JSON.parse(response.body)).toEqual({
    data: {
      ok: true,
      service: "hello-api",
      stage: "local",
    },
  });
});

test("lists users from a route module", async () => {
  const response = await handler(
    lambdaEvent({
      rawPath: "/users",
      requestContext: {
        http: {
          method: "GET",
          path: "/users",
        },
      },
    })
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    data: [{ id: "usr_1", name: "Victor" }],
  });
});

test("validates user creation", async () => {
  const response = await handler(
    lambdaEvent({
      body: JSON.stringify({ name: "" }),
      headers: {
        "content-type": "application/json",
        host: "localhost",
      },
      rawPath: "/users",
      requestContext: {
        http: {
          method: "POST",
          path: "/users",
        },
      },
    })
  );

  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body)).toEqual({
    error: {
      code: "USER_NAME_REQUIRED",
      message: "User name is required",
    },
  });
});

test("creates users from a typed route module", async () => {
  const response = await handler(
    lambdaEvent({
      body: JSON.stringify({ name: "Ada" }),
      headers: {
        "content-type": "application/json",
        host: "localhost",
      },
      rawPath: "/users",
      requestContext: {
        http: {
          method: "POST",
          path: "/users",
        },
      },
    })
  );

  expect(response.statusCode).toBe(201);
  expect(JSON.parse(response.body)).toEqual({
    data: {
      id: "usr_2",
      name: "Ada",
    },
  });
});
