import { expect, test } from "bun:test";

import {
  createAuthorizers,
  lambdaAuthorizer,
  requestAuthorizer,
} from "@voke/aws";

import { voke } from "../src/app";
import { createFunctions, fn, http } from "../src/invoke";
import type { StandardSchemaV1 } from "../src/invoke";
import type { VokeProvider } from "../src/provider";
import { route } from "../src/route-builder";
import { createVariableProvider, createVariableSource } from "../src/variables";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value }),
    vendor: "voke-test",
    version: 1,
  },
});

test("a Provider set in config supplies Runtime Variable providers to the Gateway", async () => {
  const provider: VokeProvider = {
    name: "test-provider",
    runtime: {
      variables: () => [
        createVariableProvider({
          id: "platform",
          load: () => ({ status: "found", value: "from-provider" }),
        }),
      ],
    },
  };
  const functions = createFunctions({
    readSetting: fn({
      handler: async (_payload, context) =>
        await context.variables.setting.text(),
      output: schema<string>(),
      variables: {
        setting: createVariableSource("platform", {
          id: "setting",
          kind: "parameter",
        }),
      },
    }),
  });

  voke(functions, { config: { name: "orders", provider } });

  await expect(functions.invoke("readSetting")).resolves.toBe("from-provider");
});

const createProtectedRegistry = (calls: { count: number }) =>
  createFunctions({
    authorizeSession: requestAuthorizer({
      handler: () => {
        calls.count += 1;

        return { authorized: true, context: { userId: "local-user" } };
      },
    }),
    users: http({
      authorizer: "session",
      authorizers: createAuthorizers({
        session: lambdaAuthorizer({ function: "authorizeSession" }),
      }),
      routes: [
        route.get("/me", {
          handler: (request) => ({ auth: request.auth }),
        }),
      ],
    }),
  });

test("routes trust the authorization result the Provider reports for a request", async () => {
  const calls = { count: 0 };
  const provider: VokeProvider = {
    name: "platform",
    runtime: {
      routeAuth: ({ env }) =>
        (env as { platformUser?: string } | undefined)?.platformUser ===
        undefined
          ? undefined
          : { context: { userId: "platform-user" }, source: "lambda" },
    },
  };
  const gateway = voke(createProtectedRegistry(calls), {
    config: { name: "users", provider },
  });

  const response = await gateway.request(
    "/me",
    { headers: { authorization: "Bearer token" } },
    { platformUser: "yes" }
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: {
      auth: { context: { userId: "platform-user" }, source: "lambda" },
    },
  });
  expect(calls.count).toBe(0);
});

test("routes evaluate the authorizer locally when the Provider reports nothing", async () => {
  const calls = { count: 0 };
  const provider: VokeProvider = {
    name: "platform",
    runtime: { routeAuth: () => {} },
  };
  const gateway = voke(createProtectedRegistry(calls), {
    config: { name: "users-local", provider },
  });

  const response = await gateway.request("/me", {
    headers: { authorization: "Bearer token" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { auth: { context: { userId: "local-user" }, source: "lambda" } },
  });
  expect(calls.count).toBe(1);
});
