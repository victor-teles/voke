import { expect, test } from "bun:test";

import type { LambdaEvent } from "hono/aws-lambda";

import { handler } from "../src/index";

test("routes API requests through a local function invoke", async () => {
  const response = await handler({
    body: null,
    headers: {
      host: "localhost",
      "x-request-id": "req_cross",
    },
    isBase64Encoded: false,
    rawPath: "/users/usr_1",
    rawQueryString: "",
    requestContext: {
      http: {
        method: "GET",
        path: "/users/usr_1",
      },
    },
    routeKey: "$default",
    version: "2.0",
  } as unknown as LambdaEvent);

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    data: {
      id: "usr_1",
      name: "Victor",
      requestId: "req_cross",
    },
  });
});
