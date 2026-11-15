import { expect, test } from "bun:test";

import { voke } from "../src/app";
import { createFunctions, fn, InvokeError } from "../src/invoke";
import type {
  InvokeRequest,
  InvokeTransportResponse,
  StandardSchemaV1,
} from "../src/invoke";
import type { VokeProvider } from "../src/provider";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value }),
    vendor: "voke-test",
    version: 1,
  },
});

const orderSchema: StandardSchemaV1<unknown, { id: string }> = {
  "~standard": {
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string"
        ? { value: { id: value.id } }
        : { issues: [{ message: "id is required" }] },
    vendor: "voke-test",
    version: 1,
  },
};

interface FakeProvider {
  provider: VokeProvider;
  requests: InvokeRequest[];
  targeted: string[];
}

// A routed Function's result keeps a top-level `data` property: it is not unwrapped.
const remoteResult: InvokeTransportResponse = {
  payload: { data: "kept", id: "remote" },
  statusCode: 200,
};

const fakeProvider = (
  routed: ReadonlySet<string>,
  response: InvokeTransportResponse = remoteResult
): FakeProvider => {
  const requests: InvokeRequest[] = [];
  const targeted: string[] = [];

  return {
    provider: {
      invoke: {
        target: ({ key }) => {
          targeted.push(key);

          return routed.has(key)
            ? { functionName: `remote-${key}:current` }
            : undefined;
        },
        transport: () => ({
          invoke: (request) => {
            requests.push(request as InvokeRequest);

            return Promise.resolve(response);
          },
        }),
      },
      name: "fake",
    },
    requests,
    targeted,
  };
};

const createRegistry = (calls: string[]) =>
  createFunctions({
    lookup: fn({
      handler: (order) => {
        calls.push(`lookup:${order.id}`);

        return { id: order.id };
      },
      input: orderSchema,
      output: schema<{ id: string }>(),
    }),
    process: fn({
      handler: (order) => {
        calls.push(`process:${order.id}`);

        return { data: "local", id: order.id };
      },
      input: orderSchema,
      output: schema<{ data: string; id: string }>(),
    }),
  });

test("a Provider invoke target routes the Function through the Provider transport with the bare parsed payload", async () => {
  const calls: string[] = [];
  const functions = createRegistry(calls);
  const { provider, requests } = fakeProvider(new Set(["process"]));

  voke(functions, { config: { name: "orders", provider } });

  // The result is the raw response payload: a top-level `data` property is not unwrapped.
  await expect(functions.invoke("process", { id: "o-1" })).resolves.toEqual({
    data: "kept",
    id: "remote",
  });
  expect(calls).toEqual([]);
  expect(requests).toEqual([
    {
      functionName: "remote-process:current",
      invocationType: "RequestResponse",
      payload: { id: "o-1" },
    },
  ]);
});

test("an async Provider-routed invocation forwards the execution name and returns the execution id", async () => {
  const functions = createRegistry([]);
  const { provider, requests } = fakeProvider(new Set(["process"]), {
    executionId: "execution-1",
    requestId: "request-1",
    statusCode: 202,
  });

  voke(functions, { config: { name: "orders", provider } });

  await expect(
    functions.invoke(
      "process",
      { id: "o-2" },
      { executionName: "order-o-2", mode: "async" }
    )
  ).resolves.toEqual({
    accepted: true,
    executionId: "execution-1",
    requestId: "request-1",
  });
  expect(requests).toEqual([
    {
      executionName: "order-o-2",
      functionName: "remote-process:current",
      invocationType: "Event",
      payload: { id: "o-2" },
    },
  ]);
});

test("a Provider-routed invocation validates the payload before calling the transport", async () => {
  const functions = createRegistry([]);
  const { provider, requests } = fakeProvider(new Set(["process"]));

  voke(functions, { config: { name: "orders", provider } });

  const failure = await functions
    .invoke("process", { id: 1 } as never)
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(InvokeError);
  expect((failure as InvokeError).code).toBe("INVALID_PAYLOAD");
  expect(requests).toEqual([]);
});

test("Functions the Provider does not target still run in-process", async () => {
  const calls: string[] = [];
  const functions = createRegistry(calls);
  const { provider, requests, targeted } = fakeProvider(new Set(["process"]));

  voke(functions, { config: { name: "orders", provider } });

  await expect(functions.invoke("lookup", { id: "o-3" })).resolves.toEqual({
    id: "o-3",
  });
  expect(calls).toEqual(["lookup:o-3"]);
  expect(targeted).toEqual(["lookup"]);
  expect(requests).toEqual([]);
});

test("an explicit runtime skips the Provider invoke target", async () => {
  const calls: string[] = [];
  const functions = createRegistry(calls);
  const { provider, requests, targeted } = fakeProvider(new Set(["process"]));

  voke(functions, { config: { name: "orders", provider } });

  await expect(
    functions.invoke("process", { id: "o-4" }, { runtime: "local" })
  ).resolves.toEqual({ data: "local", id: "o-4" });
  expect(calls).toEqual(["process:o-4"]);
  expect(targeted).toEqual([]);
  expect(requests).toEqual([]);
});

test("an execution name on an invocation the Provider does not route rejects with INVALID_OPTIONS", async () => {
  const calls: string[] = [];
  const functions = createRegistry(calls);
  const { provider } = fakeProvider(new Set(["process"]));

  voke(functions, { config: { name: "orders", provider } });

  const failure = await functions
    .invoke("lookup", { id: "o-5" }, { executionName: "lookup-o-5" })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(InvokeError);
  expect((failure as InvokeError).code).toBe("INVALID_OPTIONS");
  expect((failure as InvokeError).message).toContain("executionName");
  expect(calls).toEqual([]);
});

test("a Provider target without a transport rejects with MISSING_TRANSPORT", async () => {
  const functions = createRegistry([]);

  voke(functions, {
    config: {
      name: "orders",
      provider: {
        invoke: { target: () => ({ functionName: "remote" }) },
        name: "fake",
      },
    },
  });

  const failure = await functions
    .invoke("process", { id: "o-6" })
    .catch((error: unknown) => error);

  expect((failure as InvokeError).code).toBe("MISSING_TRANSPORT");
});

test("a failed Provider-routed invocation rejects with TRANSPORT_STATUS_ERROR", async () => {
  const functions = createRegistry([]);
  const { provider } = fakeProvider(new Set(["process"]), {
    functionError: "Unhandled",
    statusCode: 200,
  });

  voke(functions, { config: { name: "orders", provider } });

  const failure = await functions
    .invoke("process", { id: "o-7" })
    .catch((error: unknown) => error);

  expect((failure as InvokeError).code).toBe("TRANSPORT_STATUS_ERROR");
  expect((failure as InvokeError).functionName).toBe("process");
});

test("an execution name is ignored in-process for a Function the Provider accepts it for", async () => {
  const calls: string[] = [];
  const functions = createRegistry(calls);

  voke(functions, {
    config: {
      name: "orders",
      provider: {
        invoke: {
          acceptsExecutionName: ({ key }) => key === "process",
          target: () => {},
        },
        name: "fake",
      },
    },
  });

  await expect(
    functions.invoke("process", { id: "o-8" }, { executionName: "order-o-8" })
  ).resolves.toEqual({ data: "local", id: "o-8" });
  expect(calls).toEqual(["process:o-8"]);

  const failure = await functions
    .invoke("lookup", { id: "o-8" }, { executionName: "lookup-o-8" })
    .catch((error: unknown) => error);

  expect((failure as InvokeError).code).toBe("INVALID_OPTIONS");
});
