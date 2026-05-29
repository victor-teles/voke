import { afterEach, expect, test } from "bun:test";

import { createGateway } from "../src/app";
import { secret } from "../src/aws";
import { defineConfig } from "../src/config";
import type { StandardSchemaV1 } from "../src/invoke";
import { defineFunction, defineFunctions } from "../src/invoke";
import type {
  FunctionContractArtifact,
  FunctionContractMetadata,
  JsonSchema,
} from "../src/remote";
import { createRemoteFunctions, generateRemoteModules } from "../src/remote";

const schema = <TValue>(
  jsonSchema: JsonSchema
): StandardSchemaV1<TValue, TValue> & { jsonSchema: JsonSchema } => ({
  jsonSchema,
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

const previousEnv = {
  VOKE_DEV_SUMMARY: Bun.env.VOKE_DEV_SUMMARY,
  VOKE_REMOTE_USERS_ORIGIN: Bun.env.VOKE_REMOTE_USERS_ORIGIN,
};
const previousInfo = console.info;

interface FetchTarget {
  fetch(request: Request): Response | Promise<Response>;
}

const withGatewayFetch = async <TResult>(
  origin: string,
  gateway: FetchTarget,
  operation: () => Promise<TResult>
): Promise<TResult> => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const request = new Request(input, init);

      if (new URL(request.url).origin === origin) {
        return gateway.fetch(request);
      }

      return previousFetch(input, init);
    },
    { preconnect: previousFetch.preconnect }
  ) as typeof fetch;

  try {
    return await operation();
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const usersOrigin = "http://users.local";

afterEach(() => {
  Bun.env.VOKE_DEV_SUMMARY = previousEnv.VOKE_DEV_SUMMARY;
  Bun.env.VOKE_REMOTE_USERS_ORIGIN = previousEnv.VOKE_REMOTE_USERS_ORIGIN;
  console.info = previousInfo;
});

test("invokes a remote Function through another voke dev server", async () => {
  Bun.env.VOKE_DEV_SUMMARY = "1";
  console.info = () => {};

  const functions = defineFunctions({
    getUser: defineFunction({
      handler: (payload, context) => ({
        id: payload.id,
        name: "Victor",
        requestId: String(context.trace.requestId ?? ""),
      }),
      input: schema<{ id: string }>({
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      }),
      output: schema<{
        id: string;
        name: string;
        requestId: string;
      }>({
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          requestId: { type: "string" },
        },
        required: ["id", "name"],
        type: "object",
      }),
    }),
  });
  const gateway = createGateway({
    config: { name: "users" },
    functions,
  });
  const origin = usersOrigin;

  await withGatewayFetch(origin, gateway, async () => {
    const contractResponse = await fetch(`${origin}/_voke/contract`);
    const contractBody = await contractResponse.json();
    const users = createRemoteFunctions(
      "users",
      contractBody.data as FunctionContractArtifact<{
        getUser: FunctionContractMetadata & { input: JsonSchema };
      }>
    );

    Bun.env.VOKE_REMOTE_USERS_ORIGIN = origin;

    const user = await users.invoke(
      "getUser",
      { id: "usr_1" },
      { trace: { requestId: "req_remote" } }
    );

    expect(contractResponse.status).toBe(200);
    expect(contractBody.data).toMatchObject({
      functions: {
        getUser: {
          input: {
            properties: { id: { type: "string" } },
            required: ["id"],
            type: "object",
          },
        },
      },
      project: "users",
      version: 1,
    });
    expect(contractBody.data.fingerprint).toMatch(/^sha256:[a-f0-9]+$/u);
    expect(user).toEqual({
      id: "usr_1",
      name: "Victor",
      requestId: "req_remote",
    });
  });
});

test("excludes Runtime Variables from contracts and generated remotes", async () => {
  Bun.env.VOKE_DEV_SUMMARY = "1";
  console.info = () => {};
  const getUserBase = defineFunction({
    handler: (payload: { id: string }) => ({ id: payload.id }),
    input: schema<{ id: string }>({
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    }),
    output: schema<{ id: string }>({
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    }),
  });
  const getUserWithVariables = defineFunction({
    handler: (payload: { id: string }) => ({ id: payload.id }),
    input: schema<{ id: string }>({
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    }),
    output: schema<{ id: string }>({
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    }),
    variables: {
      stripeKey: secret("/prod/stripe/key"),
    },
  });
  const baseGateway = createGateway({
    config: { name: "users" },
    functions: defineFunctions({ getUser: getUserBase }),
  });
  const variableGateway = createGateway({
    config: { name: "users" },
    functions: defineFunctions({ getUser: getUserWithVariables }),
  });
  const baseResponse = await baseGateway.request("/_voke/contract");
  const variableResponse = await variableGateway.request("/_voke/contract");
  const baseArtifact = await baseResponse.json();
  const variableArtifact = await variableResponse.json();
  const artifact = variableArtifact.data as FunctionContractArtifact<{
    getUser: FunctionContractMetadata;
  }>;
  const generated: Record<string, string> = {};

  await generateRemoteModules(
    defineConfig({
      name: "wallet",
      remotes: {
        users: {
          targets: { local: "http://users.local" },
        },
      },
    }),
    {
      fetch: Object.assign(
        () => Promise.resolve(Response.json({ data: artifact })),
        { preconnect: fetch.preconnect }
      ) as typeof fetch,
      write: (path, text) => {
        generated[path] = text;

        return Promise.resolve();
      },
    }
  );

  expect(variableArtifact.data).toEqual(baseArtifact.data);
  expect(JSON.stringify(variableArtifact.data)).not.toContain("stripeKey");
  expect(JSON.stringify(variableArtifact.data)).not.toContain(
    "/prod/stripe/key"
  );
  expect(JSON.stringify(variableArtifact.data)).not.toContain("aws");
  expect(generated["src/voke/remotes/users.ts"]).not.toContain("stripeKey");
  expect(generated["src/voke/remotes/users.ts"]).not.toContain(
    "/prod/stripe/key"
  );
});

test("fails remote invocation clearly when the generated contract fingerprint is stale", async () => {
  Bun.env.VOKE_DEV_SUMMARY = "1";
  console.info = () => {};

  const functions = defineFunctions({
    getUser: defineFunction({
      handler: (payload) => ({ id: payload.id }),
      input: schema<{ id: string }>({
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      }),
      output: schema<{ id: string }>({
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      }),
    }),
  });
  const gateway = createGateway({
    config: { name: "users" },
    functions,
  });
  const origin = usersOrigin;

  await withGatewayFetch(origin, gateway, async () => {
    const response = await fetch(`${origin}/_voke/contract`);
    const body = await response.json();
    const users = createRemoteFunctions("users", {
      ...body.data,
      fingerprint: "sha256:stale",
    } as FunctionContractArtifact<{
      getUser: FunctionContractMetadata & { input: JsonSchema };
    }>);

    Bun.env.VOKE_REMOTE_USERS_ORIGIN = origin;

    await expect(users.invoke("getUser", { id: "usr_1" })).rejects.toThrow(
      'Remote Function contract drift for "users". Run `voke remote generate users`.'
    );
  });
});

test("generates checked-in Remote Function Registry modules from configured remotes", async () => {
  const artifact = {
    fingerprint: "sha256:abc123",
    functions: {
      getUser: {
        input: {
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        output: {
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
      },
    },
    project: "users",
    version: 1,
  } as const;
  const writes: Record<string, string> = {};
  const fetches: string[] = [];
  const config = defineConfig({
    name: "wallet",
    remotes: {
      users: {
        targets: {
          local: "http://localhost:3001",
        },
      },
      walletAudit: {
        out: "src/generated/wallet-audit.ts",
        targets: {
          local: {
            contract: "http://contracts.local/audit",
            origin: "http://localhost:3002",
          },
        },
      },
    },
  });

  const outputs = await generateRemoteModules(config, {
    fetch: Object.assign(
      (url: Parameters<typeof fetch>[0]) => {
        fetches.push(String(url));

        return Promise.resolve(Response.json({ data: artifact }));
      },
      { preconnect: fetch.preconnect }
    ) as typeof fetch,
    write: (path, text) => {
      writes[path] = text;

      return Promise.resolve();
    },
  });

  expect(outputs).toEqual([
    "src/voke/remotes/users.ts",
    "src/generated/wallet-audit.ts",
  ]);
  expect(fetches).toEqual([
    "http://localhost:3001/_voke/contract",
    "http://contracts.local/audit",
  ]);
  expect(writes["src/voke/remotes/users.ts"]).toContain(
    'import { createRemoteFunctions } from "@voke/remote";'
  );
  expect(writes["src/voke/remotes/users.ts"]).toContain(
    "export const users = createRemoteFunctions"
  );
  expect(writes["src/voke/remotes/users.ts"]).toContain(
    "// @generated by Voke. Do not edit manually."
  );
});
