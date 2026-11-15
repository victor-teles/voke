import { expect, test } from "bun:test";

import { Hono } from "hono";
import { createFunctions, fn, voke } from "voke";
import type { StandardSchemaV1, VokeEnv } from "voke";

import {
  createFunctionContractArtifact,
  mountDevFunctionEndpoints,
} from "../src/index";

const userId: StandardSchemaV1<{ id: string }, { id: string }> = {
  "~standard": {
    validate: (value) =>
      typeof (value as { id?: unknown })?.id === "string"
        ? { value: value as { id: string } }
        : { issues: [{ message: "id is required" }] },
    vendor: "voke-test",
    version: 1,
  },
};

const createEndpoints = () => {
  const functions = createFunctions({
    explode: fn({
      handler: () => {
        throw new Error("database unreachable");
      },
      input: userId,
      output: userId,
    }),
    getUser: fn({
      handler: (payload) => ({ id: payload.id }),
      input: userId,
      output: userId,
    }),
  });
  // voke() activates the registry for local invocation.
  voke(functions, { config: { name: "users" } });
  const app = new Hono<VokeEnv>();
  mountDevFunctionEndpoints(app, { functions, project: "users" });

  return app;
};

const invoke = async (
  app: Hono<VokeEnv>,
  name: string,
  body: Record<string, unknown>
) => {
  const response = await app.request(`/_voke/functions/${name}/invoke`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  return { body: await response.json(), status: response.status };
};

test("dev Function endpoints answer with the standard data envelope", async () => {
  const app = createEndpoints();

  await expect(
    invoke(app, "getUser", { payload: { id: "usr_1" } })
  ).resolves.toEqual({
    body: { data: { id: "usr_1" } },
    status: 200,
  });
  const contractResponse = await app.request("/_voke/contract");
  const contract = (await contractResponse.json()) as {
    data: { project: string };
  };

  expect(contract.data.project).toBe("users");
});

test("the contract artifact reads Standard JSON Schema through the shared reader", () => {
  const withJsonSchema: StandardSchemaV1<{ id: string }, { id: string }> = {
    "~standard": {
      ...userId["~standard"],
      jsonSchema: {
        input: () => ({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          properties: { id: { minLength: 1, type: "string" } },
          required: ["id"],
          type: "object",
        }),
        output: () => ({ oneOf: [{ type: "string" }, { type: "number" }] }),
      },
    },
  };
  const artifact = createFunctionContractArtifact(
    "users",
    createFunctions({
      getUser: fn({
        handler: (payload) => payload,
        input: withJsonSchema,
        output: withJsonSchema,
      }),
    })
  );

  expect(artifact.functions.getUser).toEqual({
    input: {
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    },
    output: true,
  });
});

test("dev Function endpoints keep their error envelopes and codes", async () => {
  const app = createEndpoints();

  expect(
    await invoke(app, "getUser", {
      contractFingerprint: "sha256:stale",
      payload: { id: "usr_1" },
    })
  ).toEqual({
    body: {
      error: {
        code: "CONTRACT_DRIFT",
        message:
          'Remote Function contract drift for "users". Run `voke remote generate users`.',
      },
    },
    status: 409,
  });
  expect(await invoke(app, "missing", { payload: {} })).toEqual({
    body: {
      error: {
        code: "NOT_FOUND",
        message: "Remote Function not found: missing",
      },
    },
    status: 404,
  });
  const invalidPayload = await invoke(app, "getUser", { payload: {} });

  expect(invalidPayload.status).toBe(400);
  expect(invalidPayload.body.error.code).toBe("BAD_REQUEST");
  expect(await invoke(app, "explode", { payload: { id: "usr_1" } })).toEqual({
    body: {
      error: { code: "INTERNAL_SERVER_ERROR", message: "database unreachable" },
    },
    status: 500,
  });
});
