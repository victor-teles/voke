import { afterEach, expect, test } from "bun:test";

import { secret } from "@vokejs/aws";
import { createRemoteFunctions } from "@vokejs/remote";
import { schema as vokeSchema } from "@vokejs/schema";
import { z } from "zod";

import { voke } from "../src/app";
import { defineConfig } from "../src/config";
import type { StandardSchemaV1 } from "../src/invoke";
import { fn, createFunctions } from "../src/invoke";
import type {
  FunctionContractArtifact,
  FunctionContractMetadata,
  JsonSchema,
} from "../src/remote";
import {
  createFunctionContractArtifact,
  generateRemoteModules,
  remoteEnvironment,
} from "../src/remote";
import { setEnv, withEnv } from "./support/env";

const schema = <TValue>(
  jsonSchema: JsonSchema
): StandardSchemaV1<TValue, TValue> & { jsonSchema: JsonSchema } => ({
  jsonSchema,
  "~standard": {
    validate: (value) => ({ value }),
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

afterEach(() => {
  setEnv("VOKE_DEV_SUMMARY", previousEnv.VOKE_DEV_SUMMARY);
  setEnv("VOKE_REMOTE_USERS_ORIGIN", previousEnv.VOKE_REMOTE_USERS_ORIGIN);
  console.info = previousInfo;
});

test("a Zod contract becomes a JSON Schema entry in the Function Contract Artifact", () => {
  const artifact = createFunctionContractArtifact(
    "users",
    createFunctions({
      getUser: fn({
        handler: (payload) => ({ id: payload.id, name: "Ada" }),
        input: z.object({ id: z.string().min(1) }),
        output: z.object({
          id: z.string(),
          name: z.union([z.string(), z.null()]),
        }),
      }),
    })
  );

  expect(artifact.functions.getUser).toEqual({
    input: {
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    },
    output: {
      additionalProperties: false,
      // The union cannot be expressed by the artifact's JSON Schema subset.
      properties: { id: { type: "string" }, name: true },
      required: ["id", "name"],
      type: "object",
    },
  });
});

test("a @vokejs/schema contract becomes a JSON Schema entry in the Function Contract Artifact", () => {
  const artifact = createFunctionContractArtifact(
    "users",
    createFunctions({
      getUser: fn({
        handler: (payload) => payload,
        input: vokeSchema.object({ id: vokeSchema.string() }),
        output: vokeSchema.object({ id: vokeSchema.string() }),
      }),
    })
  );

  expect(artifact.functions.getUser?.input).toEqual({
    additionalProperties: false,
    properties: { id: { type: "string" } },
    required: ["id"],
    type: "object",
  });
});

test("excludes Runtime Variables from contracts and generated remotes", async () => {
  Bun.env.VOKE_DEV_SUMMARY = "1";
  console.info = () => {};
  const getUserBase = fn({
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
  const getUserWithVariables = fn({
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
  const baseGateway = voke(createFunctions({ getUser: getUserBase }), {
    config: { name: "users" },
  });
  const variableGateway = voke(
    createFunctions({ getUser: getUserWithVariables }),
    { config: { name: "users" } }
  );
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
    'import { createRemoteFunctions } from "@vokejs/remote";'
  );
  expect(writes["src/voke/remotes/users.ts"]).toContain(
    "export const users = createRemoteFunctions"
  );
  expect(writes["src/voke/remotes/users.ts"]).toContain(
    "// @generated by Voke. Do not edit manually."
  );
});

const userIdContract: StandardSchemaV1<{ id: string }, { id: string }> = {
  "~standard": {
    validate: (value) =>
      typeof (value as { id?: unknown })?.id === "string"
        ? { value: value as { id: string } }
        : { issues: [{ message: "id is required" }] },
    vendor: "voke-test",
    version: 1,
  },
};

const startUsersGateway = () => {
  Bun.env.VOKE_DEV_SUMMARY = "1";
  console.info = () => {};

  return voke(
    createFunctions({
      explode: fn({
        handler: () => {
          throw new Error("database unreachable");
        },
        input: userIdContract,
        output: userIdContract,
      }),
      getUser: fn({
        handler: (payload) => ({ id: payload.id }),
        input: userIdContract,
        output: userIdContract,
      }),
    }),
    { config: { name: "users" } }
  );
};

const postInvoke = async (
  gateway: ReturnType<typeof startUsersGateway>,
  name: string,
  body: string
) => {
  const response = await gateway.request(`/_voke/functions/${name}/invoke`, {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  return { body: await response.json(), status: response.status };
};

test("the Dev Function Invoke Endpoint answers with the standard data envelope", async () => {
  const gateway = startUsersGateway();

  expect(
    await postInvoke(
      gateway,
      "getUser",
      JSON.stringify({ payload: { id: "usr_1" } })
    )
  ).toEqual({ body: { data: { id: "usr_1" } }, status: 200 });

  const contractResponse = await gateway.request("/_voke/contract");
  const contract = (await contractResponse.json()) as {
    data: { project: string };
  };

  expect(contract.data.project).toBe("users");
});

test("the contract artifact reads Standard JSON Schema through the shared reader", () => {
  const withJsonSchema: StandardSchemaV1<{ id: string }, { id: string }> = {
    "~standard": {
      ...userIdContract["~standard"],
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

test("the Dev Function Invoke Endpoint keeps its error envelopes and codes", async () => {
  const gateway = startUsersGateway();

  expect(
    await postInvoke(
      gateway,
      "getUser",
      JSON.stringify({
        contractFingerprint: "sha256:stale",
        payload: { id: "usr_1" },
      })
    )
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
  expect(
    await postInvoke(gateway, "missing", JSON.stringify({ payload: {} }))
  ).toEqual({
    body: {
      error: {
        code: "NOT_FOUND",
        message: "Remote Function not found: missing",
      },
    },
    status: 404,
  });

  const invalidPayload = await postInvoke(
    gateway,
    "getUser",
    JSON.stringify({ payload: {} })
  );

  expect(invalidPayload.status).toBe(400);
  expect(invalidPayload.body.error.code).toBe("BAD_REQUEST");
  expect(
    await postInvoke(
      gateway,
      "explode",
      JSON.stringify({ payload: { id: "usr_1" } })
    )
  ).toEqual({
    body: {
      error: { code: "INTERNAL_SERVER_ERROR", message: "database unreachable" },
    },
    status: 500,
  });
});

test("the Dev Function Invoke Endpoint rejects a request body that is not a JSON object with 400", async () => {
  const gateway = startUsersGateway();

  for (const body of ["{oops", "null", "[]"]) {
    expect(await postInvoke(gateway, "getUser", body)).toEqual({
      body: {
        error: {
          code: "BAD_REQUEST",
          message:
            "The Dev Function Invoke Endpoint expects a JSON object body",
        },
      },
      status: 400,
    });
  }
});

test("remote config and @vokejs/remote agree on the origin variable of a remote", async () => {
  const origin = "http://wallet-audit.local";
  const artifact = {
    fingerprint: "sha256:audit",
    functions: { ping: { output: { const: "pong" } } },
    project: "walletAudit",
    version: 1,
  } as const;
  const environment = remoteEnvironment({
    walletAudit: {
      contract: `${origin}/_voke/contract`,
      origin,
      out: "src/voke/remotes/walletAudit.ts",
    },
  });
  const requests: string[] = [];

  await withEnv(environment, () =>
    withGatewayFetch(
      origin,
      {
        fetch: (request) => {
          requests.push(request.url);

          return Response.json({ data: "pong" });
        },
      },
      async () => {
        const walletAudit = createRemoteFunctions("walletAudit", artifact);

        expect(await walletAudit.invoke("ping")).toBe("pong");
      }
    )
  );

  expect(requests).toEqual([`${origin}/_voke/functions/ping/invoke`]);
});
