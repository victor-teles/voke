import { afterEach, expect, test } from "bun:test";

import { createFunctions, fn, InvokeError, voke, VokeConfigError } from "voke";
import type {
  ContractJsonSchema,
  FunctionContractArtifact,
  StandardSchemaV1,
} from "voke";

import { createRemoteFunctions } from "../src/index";

const schema = <TValue>(
  jsonSchema: ContractJsonSchema
): StandardSchemaV1<TValue, TValue> & { jsonSchema: ContractJsonSchema } => ({
  jsonSchema,
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

const userIdSchema = {
  properties: { id: { type: "string" } },
  required: ["id"],
  type: "object",
} as const;

const usersOrigin = "http://users.local";
const originEnvName = "VOKE_REMOTE_USERS_ORIGIN";
const previousInfo = console.info;

// Assigning `undefined` to an environment variable stores the string "undefined" in Bun,
// so restoring an unset variable deletes it instead.
const setEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }

  process.env[name] = value;
};

const previousEnv = {
  VOKE_DEV_SUMMARY: process.env.VOKE_DEV_SUMMARY,
  VOKE_REMOTE_USERS_ORIGIN: process.env.VOKE_REMOTE_USERS_ORIGIN,
};

afterEach(() => {
  setEnv("VOKE_DEV_SUMMARY", previousEnv.VOKE_DEV_SUMMARY);
  setEnv(originEnvName, previousEnv.VOKE_REMOTE_USERS_ORIGIN);
  console.info = previousInfo;
});

type FetchHandler = (
  request: Request,
  init: RequestInit | undefined
) => Response | Promise<Response>;

/** Replaces `fetch` for one operation and counts the requests it receives. */
const withFetch = async <TResult>(
  handler: FetchHandler,
  operation: () => Promise<TResult>
): Promise<{ requests: Request[]; result: TResult }> => {
  const previousFetch = globalThis.fetch;
  const requests: Request[] = [];

  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const request = new Request(input, init);
      requests.push(request);

      return await handler(request, init);
    },
    { preconnect: previousFetch.preconnect }
  ) as typeof fetch;

  try {
    return { requests, result: await operation() };
  } finally {
    globalThis.fetch = previousFetch;
  }
};

/** Settles only when the request's signal aborts, like a provider project that never answers. */
const neverAnswers: FetchHandler = async (_request, init) => {
  const signal = init?.signal;

  if (signal === undefined || signal === null) {
    throw new Error("the request carries no abort signal");
  }

  const { promise, reject } = Promise.withResolvers<Response>();

  signal.addEventListener("abort", () => {
    reject(signal.reason);
  });

  return await promise;
};

const usersArtifact = (fingerprint = "sha256:test") =>
  ({
    fingerprint,
    functions: {
      getUser: {
        input: userIdSchema,
        output: userIdSchema,
      },
    },
    project: "users",
    version: 1,
  }) as const satisfies FunctionContractArtifact;

const usersRegistry = () => {
  setEnv(originEnvName, usersOrigin);

  return createRemoteFunctions("users", usersArtifact());
};

/** Runs a call that must reject and returns the rejection. */
const rejectionOf = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to reject");
};

const expectInvokeError = (
  error: unknown,
  expected: {
    code: InvokeError["code"];
    message?: string;
    statusCode?: number;
  }
): InvokeError => {
  expect(error).toBeInstanceOf(InvokeError);
  const invokeError = error as InvokeError;

  expect(invokeError.code).toBe(expected.code);
  expect(invokeError.functionName).toBe("getUser");
  expect(invokeError.statusCode).toBe(expected.statusCode);

  if (expected.message !== undefined) {
    expect(invokeError.message).toBe(expected.message);
  }

  return invokeError;
};

const startUsersGateway = () => {
  setEnv("VOKE_DEV_SUMMARY", "1");
  console.info = () => {};

  const functions = createFunctions({
    getUser: fn({
      handler: (payload, context) => ({
        id: payload.id,
        name: "Victor",
        requestId: String(context.trace.requestId ?? ""),
      }),
      input: schema<{ id: string }>(userIdSchema),
      output: schema<{ id: string; name: string; requestId: string }>({
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

  return voke(functions, { config: { name: "users" } });
};

const gatewayHandler =
  (gateway: ReturnType<typeof startUsersGateway>): FetchHandler =>
  (request) =>
    gateway.fetch(request);

const fetchUsersContract = async (
  gateway: ReturnType<typeof startUsersGateway>
): Promise<FunctionContractArtifact> => {
  const response = await gateway.request("/_voke/contract");
  const body = (await response.json()) as { data: FunctionContractArtifact };

  return body.data;
};

test("invokes a Function of another project and passes the trace", async () => {
  const gateway = startUsersGateway();
  const artifact = await fetchUsersContract(gateway);
  const users = createRemoteFunctions(
    "users",
    artifact as FunctionContractArtifact<{
      getUser: { input: ContractJsonSchema; output: ContractJsonSchema };
    }>
  );

  setEnv(originEnvName, usersOrigin);

  const { requests, result } = await withFetch(gatewayHandler(gateway), () =>
    users.invoke(
      "getUser",
      { id: "usr_1" },
      { trace: { requestId: "req_remote" } }
    )
  );

  expect(result).toEqual({
    id: "usr_1",
    name: "Victor",
    requestId: "req_remote",
  });
  expect(requests.map((request) => request.url)).toEqual([
    `${usersOrigin}/_voke/functions/getUser/invoke`,
  ]);
});

test("a stale contract fingerprint rejects with contract drift and HTTP 409", async () => {
  const gateway = startUsersGateway();
  const artifact = await fetchUsersContract(gateway);
  const users = createRemoteFunctions("users", {
    ...artifact,
    fingerprint: "sha256:stale",
  } as FunctionContractArtifact<{
    getUser: { input: ContractJsonSchema; output: ContractJsonSchema };
  }>);

  setEnv(originEnvName, usersOrigin);

  const { result: error } = await withFetch(gatewayHandler(gateway), () =>
    rejectionOf(() => users.invoke("getUser", { id: "usr_1" }))
  );

  expectInvokeError(error, {
    code: "TRANSPORT_FAILED",
    message:
      'Remote Function contract drift for "users". Run `voke remote generate users`.',
    statusCode: 409,
  });
});

test("a key the provider project does not have rejects with MISSING_FUNCTION and HTTP 404", async () => {
  const gateway = startUsersGateway();
  const artifact = await fetchUsersContract(gateway);
  const users = createRemoteFunctions("users", {
    // Built by hand with the provider's fingerprint, so the call passes the drift check.
    ...artifact,
    functions: {
      ...artifact.functions,
      deleteUser: { input: userIdSchema, output: true },
    },
  } as FunctionContractArtifact<{
    deleteUser: { input: ContractJsonSchema; output: ContractJsonSchema };
  }>);

  setEnv(originEnvName, usersOrigin);

  const { result: error } = await withFetch(gatewayHandler(gateway), () =>
    rejectionOf(() => users.invoke("deleteUser", { id: "usr_1" }))
  );

  expect(error).toBeInstanceOf(InvokeError);
  expect((error as InvokeError).code).toBe("MISSING_FUNCTION");
  expect((error as InvokeError).functionName).toBe("deleteUser");
  expect((error as InvokeError).statusCode).toBe(404);
});

test("an HTML error page rejects with TRANSPORT_FAILED and the HTTP status", async () => {
  const users = usersRegistry();
  const { result: error } = await withFetch(
    () =>
      new Response("<html>Bad Gateway</html>", {
        headers: { "content-type": "text/html" },
        status: 502,
      }),
    () => rejectionOf(() => users.invoke("getUser", { id: "usr_1" }))
  );

  expectInvokeError(error, {
    code: "TRANSPORT_FAILED",
    message: "Remote Function invocation failed with HTTP 502",
    statusCode: 502,
  });
});

test("a 2xx answer without a data envelope rejects with TRANSPORT_FAILED", async () => {
  for (const body of ["", "null", "[]", '"ok"']) {
    const users = usersRegistry();
    const { result: error } = await withFetch(
      () => new Response(body, { status: 200 }),
      () => rejectionOf(() => users.invoke("getUser", { id: "usr_1" }))
    );

    expectInvokeError(error, {
      code: "TRANSPORT_FAILED",
      message:
        "Remote Function getUser answered HTTP 200 without a Voke data envelope",
      statusCode: 200,
    });
  }
});

test("an error body without a message falls back to the HTTP status message", async () => {
  for (const body of [
    '{"error":"plain"}',
    '"oops"',
    '{"error":{"message":""}}',
  ]) {
    const users = usersRegistry();
    const { result: error } = await withFetch(
      () => new Response(body, { status: 500 }),
      () => rejectionOf(() => users.invoke("getUser", { id: "usr_1" }))
    );

    expectInvokeError(error, {
      code: "TRANSPORT_FAILED",
      message: "Remote Function invocation failed with HTTP 500",
      statusCode: 500,
    });
  }
});

test("a request that cannot reach the provider project rejects with TRANSPORT_FAILED and the cause", async () => {
  const users = usersRegistry();
  const cause = new TypeError("fetch failed");
  const { result: error } = await withFetch(
    () => Promise.reject(cause),
    () => rejectionOf(() => users.invoke("getUser", { id: "usr_1" }))
  );

  const invokeError = expectInvokeError(error, {
    code: "TRANSPORT_FAILED",
    message: "Remote Function getUser request failed: fetch failed",
  });

  expect(invokeError.cause).toBe(cause);
});

test("timeoutMs cancels the request and rejects with TIMEOUT", async () => {
  const users = usersRegistry();
  const { requests, result: error } = await withFetch(neverAnswers, () =>
    rejectionOf(() =>
      users.invoke("getUser", { id: "usr_1" }, { timeoutMs: 5 })
    )
  );

  expectInvokeError(error, {
    code: "TIMEOUT",
    message: "Remote Function getUser timed out after 5ms",
  });
  expect(requests).toHaveLength(1);
});

test("retries repeats a 5xx answer and stops at the first success", async () => {
  const failing = usersRegistry();
  const exhausted = await withFetch(
    () => new Response("unavailable", { status: 503 }),
    () =>
      rejectionOf(() =>
        failing.invoke("getUser", { id: "usr_1" }, { retries: 2 })
      )
  );

  expect(exhausted.requests).toHaveLength(3);
  expectInvokeError(exhausted.result, {
    code: "TRANSPORT_FAILED",
    statusCode: 503,
  });

  const recovering = usersRegistry();
  let attempt = 0;
  const recovered = await withFetch(
    () => {
      attempt += 1;

      return attempt === 1
        ? new Response("unavailable", { status: 503 })
        : Response.json({ data: { id: "usr_1" } });
    },
    () => recovering.invoke("getUser", { id: "usr_1" }, { retries: 2 })
  );

  expect(recovered.requests).toHaveLength(2);
  expect(recovered.result).toEqual({ id: "usr_1" });
});

test("retries never repeats a 4xx answer", async () => {
  for (const status of [400, 409]) {
    const users = usersRegistry();
    const { requests, result: error } = await withFetch(
      () =>
        Response.json(
          { error: { code: "BAD_REQUEST", message: "rejected" } },
          { status }
        ),
      () =>
        rejectionOf(() =>
          users.invoke("getUser", { id: "usr_1" }, { retries: 2 })
        )
    );

    expect(requests).toHaveLength(1);
    expectInvokeError(error, {
      code: "TRANSPORT_FAILED",
      message: "rejected",
      statusCode: status,
    });
  }
});

test("retries repeats a timed-out attempt with a fresh time limit", async () => {
  const users = usersRegistry();
  const { requests, result: error } = await withFetch(neverAnswers, () =>
    rejectionOf(() =>
      users.invoke("getUser", { id: "usr_1" }, { retries: 2, timeoutMs: 5 })
    )
  );

  expect(requests).toHaveLength(3);
  expectInvokeError(error, { code: "TIMEOUT" });
});

test("unsupported or invalid invoke options reject with INVALID_OPTIONS before any request", async () => {
  const invalidOptions = [
    { mode: "async" },
    { mode: "sync" },
    { executionName: "x" },
    { timeoutMs: 0 },
    { timeoutMs: Number.NaN },
    { retries: -1 },
    { retries: 1.5 },
  ];

  for (const options of invalidOptions) {
    const users = usersRegistry();
    const { requests, result: error } = await withFetch(
      () => Response.json({ data: { id: "usr_1" } }),
      () =>
        rejectionOf(() =>
          users.invoke("getUser", { id: "usr_1" }, options as never)
        )
    );

    expect(requests).toHaveLength(0);
    expectInvokeError(error, { code: "INVALID_OPTIONS" });
  }

  const users = usersRegistry();
  const accepted = await withFetch(
    () => Response.json({ data: { id: "usr_1" } }),
    () =>
      users.invoke("getUser", { id: "usr_1" }, {
        mode: undefined,
      } as never)
  );

  expect(accepted.result).toEqual({ id: "usr_1" });
});

test("a registry without a runtime target rejects with VokeConfigError", async () => {
  setEnv(originEnvName, undefined);
  const users = createRemoteFunctions("users", usersArtifact());
  const { requests, result: error } = await withFetch(
    () => Response.json({ data: { id: "usr_1" } }),
    () => rejectionOf(() => users.invoke("getUser", { id: "usr_1" }))
  );

  expect(error).toBeInstanceOf(VokeConfigError);
  expect((error as Error).message).toContain(
    'Remote Function Registry "users" has no runtime target'
  );
  expect(requests).toHaveLength(0);
});

test("the contract checks the payload before the request and the result after it", async () => {
  const users = usersRegistry();
  const invalidPayload = await withFetch(
    () => Response.json({ data: { id: "usr_1" } }),
    () => rejectionOf(() => users.invoke("getUser", {} as never))
  );

  expect(invalidPayload.requests).toHaveLength(0);
  expectInvokeError(invalidPayload.result, { code: "INVALID_PAYLOAD" });

  const invalidResult = await withFetch(
    () => Response.json({ data: { id: 1 } }),
    () => rejectionOf(() => users.invoke("getUser", { id: "usr_1" }))
  );

  expectInvokeError(invalidResult.result, { code: "INVALID_RESULT" });
});

test("a registry rejects a contract for another project", () => {
  expect(() =>
    createRemoteFunctions("wallet", usersArtifact() as never)
  ).toThrow(VokeConfigError);
});
