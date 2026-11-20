import { expect, test } from "bun:test";

import { VokeConfigError, createFunctions, http, route, voke } from "voke";

import {
  aws,
  createAuthorizers,
  createLambdaHandlers,
  jwtAuthorizer,
  lambdaAuthorizer,
  requestAuthorizer,
} from "../src/index";

const eventWithAuthorizer = (authorizer?: unknown) => ({
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

const createAuthGateway = (calls: { count: number }) =>
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
  gateway: ReturnType<typeof createAuthGateway>,
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
    createAuthGateway(calls),
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
  const body = await call(createAuthGateway({ count: 0 }), event);

  expect(body.data.auth).toEqual({
    context: { sub: "usr_jwt" },
    source: "jwt",
  });
});

test("requests without an authorizer result still evaluate the authorizer locally", async () => {
  const calls = { count: 0 };
  const response = await createAuthGateway(calls).request("/me", {
    headers: { authorization: "Bearer token" },
  });

  expect(await response.json()).toEqual({
    data: { auth: { context: { userId: "local" }, source: "lambda" } },
  });
  expect(calls.count).toBe(1);
});

const encodeSegment = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const unsignedJwt = (claims: Record<string, unknown>): string =>
  `${encodeSegment({ alg: "none", typ: "JWT" })}.${encodeSegment(claims)}.`;

test("deployed JWT routes answer 401 when API Gateway attached no authorizer result", async () => {
  const event = eventWithAuthorizer();
  const token = unsignedJwt({
    aud: "users",
    exp: 32_503_680_000,
    iss: "https://auth.example.com",
    sub: "forged",
  });
  const handler = createLambdaHandlers({
    default: createAuthGateway({ count: 0 }),
  }).http;

  if (handler === undefined) {
    throw new Error("Expected a generated http handler");
  }

  const response = (await handler({
    ...event,
    headers: { authorization: `Bearer ${token}` },
    rawPath: "/profile",
    requestContext: {
      ...event.requestContext,
      http: { ...event.requestContext.http, path: "/profile" },
    },
  })) as { statusCode: number };

  expect(response.statusCode).toBe(401);
});

const buildJwtAuthorizer = (identitySource?: string | readonly string[]) =>
  jwtAuthorizer({ audience: "a", identitySource, issuer: "https://i" });

test("jwtAuthorizer accepts exactly one header or query string identity source", () => {
  expect(buildJwtAuthorizer().identitySource).toEqual([
    "$request.header.Authorization",
  ]);
  expect(
    buildJwtAuthorizer("$request.header.X-Access-Token").identitySource
  ).toEqual(["$request.header.X-Access-Token"]);
  expect(
    buildJwtAuthorizer(["$request.querystring.access_token"]).identitySource
  ).toEqual(["$request.querystring.access_token"]);
  expect(() =>
    buildJwtAuthorizer([
      "$request.header.Authorization",
      "$request.querystring.token",
    ])
  ).toThrow(VokeConfigError);
  expect(() => buildJwtAuthorizer("$context.routeKey")).toThrow(
    VokeConfigError
  );
  expect(() => buildJwtAuthorizer("$request.cookie.token")).toThrow(
    VokeConfigError
  );
});
