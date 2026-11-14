import { expect, test } from "bun:test";

import { createFunctions, http, route, voke } from "voke";

import {
  aws,
  createAuthorizers,
  createLambdaHandlers,
  jwtAuthorizer,
  lambdaAuthorizer,
  requestAuthorizer,
} from "../src/index";

const eventWithAuthorizer = (authorizer: unknown) => ({
  headers: { authorization: "Bearer token" },
  isBase64Encoded: false,
  rawPath: "/me",
  rawQueryString: "",
  requestContext: {
    accountId: "123456789012",
    apiId: "api",
    authorizer,
    domainName: "api.example.com",
    http: {
      method: "GET",
      path: "/me",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "test",
    },
    requestId: "req",
    routeKey: "GET /me",
    stage: "$default",
    time: "",
    timeEpoch: 0,
  },
  routeKey: "GET /me",
  version: "2.0",
});

const createGateway = (calls: { count: number }) =>
  voke(
    createFunctions({
      authorizeSession: requestAuthorizer({
        handler: () => {
          calls.count += 1;

          return { authorized: true, context: { userId: "local" } };
        },
      }),
      http: http({
        authorizers: createAuthorizers({
          session: lambdaAuthorizer({ function: "authorizeSession" }),
          users: jwtAuthorizer({
            audience: "users",
            issuer: "https://auth.example.com",
          }),
        }),
        routes: [
          route.get("/me", {
            authorizer: "session",
            handler: (request) => ({ auth: request.auth }),
          }),
          route.get("/profile", {
            authorizer: "users",
            handler: (request) => ({ auth: request.auth }),
          }),
        ],
      }),
    }),
    { config: { name: "route-auth", provider: aws() } }
  );

const call = async (
  gateway: ReturnType<typeof createGateway>,
  event: object
): Promise<{ data: { auth: unknown } }> => {
  const handler = createLambdaHandlers({ default: gateway }).http;

  if (handler === undefined) {
    throw new Error("Expected a generated http handler");
  }

  const response = (await handler(event)) as { body: string };

  return JSON.parse(response.body) as { data: { auth: unknown } };
};

test("deployed routes use the Lambda authorizer result API Gateway attached", async () => {
  const calls = { count: 0 };
  const body = await call(
    createGateway(calls),
    eventWithAuthorizer({ lambda: { userId: "usr_from_gateway" } })
  );

  expect(body.data.auth).toEqual({
    context: { userId: "usr_from_gateway" },
    source: "lambda",
  });
  // API Gateway already ran the Request Authorizer Function; it does not run twice.
  expect(calls.count).toBe(0);
});

test("deployed routes expose verified JWT claims", async () => {
  const event = {
    ...eventWithAuthorizer({
      jwt: { claims: { sub: "usr_jwt" }, scopes: null },
    }),
    rawPath: "/profile",
  };
  event.requestContext.http.path = "/profile";
  const body = await call(createGateway({ count: 0 }), event);

  expect(body.data.auth).toEqual({
    context: { sub: "usr_jwt" },
    source: "jwt",
  });
});

test("requests without an authorizer result still evaluate the authorizer locally", async () => {
  const calls = { count: 0 };
  const response = await createGateway(calls).request("/me", {
    headers: { authorization: "Bearer token" },
  });

  expect(await response.json()).toEqual({
    data: { auth: { context: { userId: "local" }, source: "lambda" } },
  });
  expect(calls.count).toBe(1);
});
