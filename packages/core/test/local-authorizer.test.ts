import { expect, test } from "bun:test";

import {
  createAuthorizers,
  jwtAuthorizer,
  lambdaAuthorizer,
  requestAuthorizer,
} from "@vokejs/aws";
import { createTestClient, createTestJwt } from "@vokejs/testing";

import { voke } from "../src/app";
import { createFunctions, http } from "../src/invoke";
import { route } from "../src/route-builder";

// A date far in the future: a token with this `nbf` is never valid yet.
const YEAR_3000 = 32_503_680_000;

const userJwt = jwtAuthorizer({
  audience: "users-api",
  issuer: "https://auth.example.com",
});
const queryJwt = jwtAuthorizer({
  audience: "users-api",
  identitySource: ["$request.querystring.access_token"],
  issuer: "https://auth.example.com",
});
const headerJwt = jwtAuthorizer({
  audience: "users-api",
  identitySource: "$request.header.X-Access-Token",
  issuer: "https://auth.example.com",
});

const createJwtGateway = (calls: { count: number }) =>
  voke(
    createFunctions({
      users: http({
        authorizer: "userJwt",
        authorizers: createAuthorizers({ headerJwt, queryJwt, userJwt }),
        routes: [
          route.get("/profile", {
            handler: (request) => {
              calls.count += 1;

              return { auth: request.auth };
            },
          }),
          route.get("/query", {
            authorizer: "queryJwt",
            handler: (request) => ({ auth: request.auth }),
          }),
          route.get("/header", {
            authorizer: "headerJwt",
            handler: (request) => ({ auth: request.auth }),
          }),
          route.get("/public", {
            authorizer: "none",
            handler: () => ({ ok: true }),
          }),
        ],
      }),
    }),
    { config: { name: "jwt-api" } }
  );

const statusOf = async (
  pending: Promise<Response> | Response
): Promise<number> => {
  const response = await pending;

  return response.status;
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("a JWT Authorizer route answers 401 without a token and does not run the handler", async () => {
  const calls = { count: 0 };
  const response = await createJwtGateway(calls).request("/profile");

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe("Bearer");
  expect(await response.json()).toEqual({
    error: { code: "UNAUTHORIZED", message: "Unauthorized" },
  });
  expect(calls.count).toBe(0);
});

test("a JWT Authorizer route passes the token claims as strings with source jwt", async () => {
  const calls = { count: 0 };
  const response = await createJwtGateway(calls).request("/profile", {
    headers: bearer(createTestJwt(userJwt, { sub: "usr_1" })),
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { auth: { context: Record<string, unknown>; source: string } };
  };

  expect(body.data.auth.source).toBe("jwt");
  expect(body.data.auth.context).toMatchObject({
    aud: "users-api",
    iss: "https://auth.example.com",
    sub: "usr_1",
  });
  expect(typeof body.data.auth.context.exp).toBe("string");
  expect(calls.count).toBe(1);
});

test("a JWT Authorizer route explains each rejection in www-authenticate", async () => {
  const gateway = createJwtGateway({ count: 0 });
  const cases: readonly [string, string][] = [
    [createTestJwt(userJwt, { exp: 1, iat: undefined }), "token has expired"],
    [createTestJwt(userJwt, { nbf: YEAR_3000 }), "token is not valid yet"],
    [createTestJwt(userJwt, { iss: "https://other" }), "issuer does not match"],
    [createTestJwt(userJwt, { aud: "other" }), "audience does not match"],
    ["abc", "token is not a JWT"],
  ];

  for (const [token, reason] of cases) {
    const response = await gateway.request("/profile", {
      headers: bearer(token),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="${reason}"`
    );
  }
});

test("a JWT Authorizer reads the token from its query string or custom header identity source", async () => {
  const gateway = createJwtGateway({ count: 0 });
  const token = createTestJwt(userJwt);

  expect(await statusOf(gateway.request(`/query?access_token=${token}`))).toBe(
    200
  );
  expect(
    await statusOf(gateway.request("/query", { headers: bearer(token) }))
  ).toBe(401);
  expect(
    await statusOf(
      gateway.request("/header", {
        headers: { "x-access-token": token },
      })
    )
  ).toBe(200);
});

test("a route that opts out of the Default HTTP Authorizer needs no token", async () => {
  const response = await createJwtGateway({ count: 0 }).request("/public");

  expect(response.status).toBe(200);
});

test("a route naming an unknown HTTP Authorizer answers 500 instead of running open", async () => {
  const gateway = voke(
    createFunctions({
      users: http({
        authorizers: createAuthorizers({ userJwt }),
        routes: [
          route.get("/me", {
            authorizer: "missing",
            handler: () => ({ ok: true }),
          }),
        ],
      }),
    }),
    { config: { name: "unknown-authorizer" } }
  );

  const response = await gateway.request("/me");

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: 'Route GET /me references unknown HTTP Authorizer "missing"',
    },
  });
});

const createLambdaGateway = (
  identitySource: string | readonly string[],
  calls: { count: number }
) =>
  voke(
    createFunctions({
      authorizeKey: requestAuthorizer({
        handler: () => {
          calls.count += 1;

          return { authorized: true, context: { userId: "usr_key" } };
        },
      }),
      users: http({
        authorizer: "key",
        authorizers: createAuthorizers({
          key: lambdaAuthorizer({ function: "authorizeKey", identitySource }),
        }),
        routes: [route.get("/me", { handler: (request) => request.auth })],
      }),
    }),
    { config: { name: "lambda-api" } }
  );

test("a Lambda Request Authorizer reads a query string identity source", async () => {
  const calls = { count: 0 };
  const gateway = createLambdaGateway("$request.querystring.key", calls);

  expect(await statusOf(gateway.request("/me"))).toBe(401);
  expect(calls.count).toBe(0);
  expect(await statusOf(gateway.request("/me?key=abc"))).toBe(200);
  expect(calls.count).toBe(1);
});

test("a Lambda Request Authorizer requires every identity source", async () => {
  const calls = { count: 0 };
  const gateway = createLambdaGateway(
    ["$request.header.Authorization", "$request.querystring.key"],
    calls
  );

  expect(
    await statusOf(gateway.request("/me", { headers: { authorization: "x" } }))
  ).toBe(401);
  expect(await statusOf(gateway.request("/me?key=abc"))).toBe(401);
  expect(
    await statusOf(
      gateway.request("/me?key=abc", {
        headers: { authorization: "x" },
      })
    )
  ).toBe(200);
  expect(calls.count).toBe(1);
});

test("a Lambda Request Authorizer treats context variables as present and stage variables as missing", async () => {
  const contextCalls = { count: 0 };
  const stageCalls = { count: 0 };

  expect(
    await statusOf(
      createLambdaGateway("$context.routeKey", contextCalls).request("/me")
    )
  ).toBe(200);
  expect(contextCalls.count).toBe(1);
  expect(
    await statusOf(
      createLambdaGateway("$stageVariables.x", stageCalls).request("/me")
    )
  ).toBe(401);
  expect(stageCalls.count).toBe(0);
});

test("a Lambda Request Authorizer answers 500 for an identity source local evaluation cannot read", async () => {
  const response = await createLambdaGateway("$request.cookie.session", {
    count: 0,
  }).request("/me");

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message:
        'Identity source "$request.cookie.session" is not available in Local Authorizer Evaluation',
    },
  });
});

test("createTestClient reaches a JWT Authorizer route with and without a token", async () => {
  const client = createTestClient(createJwtGateway({ count: 0 }));

  expect(
    await statusOf(
      client.get("/profile", {
        headers: bearer(createTestJwt(userJwt)),
      })
    )
  ).toBe(200);
  expect(await statusOf(client.get("/profile"))).toBe(401);
});
