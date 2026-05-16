import { expect, test } from "bun:test";

import {
  createFunctionRegistry,
  createInvoker,
  defineFunction,
  invoke,
  registerLocalFunction,
  resetLocalFunctions,
  withInvokeTrace,
} from "../src/index";
import type { InvokeTransport } from "../src/index";

test("invokes registered local functions with typed payloads and results", async () => {
  const getUser = defineFunction({
    handler: (payload: { id: string }) => ({
      id: payload.id,
      name: "Victor",
    }),
    name: "getUser",
  });
  const registry = createFunctionRegistry({ getUser });
  const invoker = createInvoker(registry);

  const user = await invoker("getUser", { id: "usr_1" });

  expect(user).toEqual({ id: "usr_1", name: "Victor" });
});

test("uses the default local registry from invoke()", async () => {
  resetLocalFunctions();
  registerLocalFunction(
    defineFunction({
      handler: (payload: { name: string }) => payload.name.toUpperCase(),
      name: "uppercaseName",
    })
  );

  await expect(
    invoke<{ name: string }, string>("uppercaseName", { name: "ada" })
  ).resolves.toBe("ADA");

  resetLocalFunctions();
});

test("validates payloads before invoking a function", async () => {
  const chargeUser = defineFunction({
    handler: (payload: { amount: number }) => ({
      charged: payload.amount,
    }),
    name: "chargeUser",
    validatePayload: (payload: { amount?: number }) => {
      if (typeof payload.amount !== "number" || payload.amount <= 0) {
        throw new Error("amount must be positive");
      }
    },
  });
  const invoker = createInvoker(createFunctionRegistry({ chargeUser }));

  await expect(
    invoker("chargeUser", { amount: 0 } as { amount: number })
  ).rejects.toThrow("Invalid payload for chargeUser: amount must be positive");
});

test("supports async local invocation mode", async () => {
  let processed = false;
  const sendEmail = defineFunction({
    handler: () => {
      processed = true;
      return { ok: true };
    },
    name: "sendEmail",
  });
  const invoker = createInvoker(createFunctionRegistry({ sendEmail }));

  const result = await invoker(
    "sendEmail",
    { to: "hello@example.com" },
    { mode: "async" }
  );
  await Bun.sleep(0);

  expect(result).toEqual({ accepted: true });
  expect(processed).toBe(true);
});

test("propagates tracing metadata to local functions", async () => {
  const createAudit = defineFunction({
    handler: (_payload: Record<string, never>, context) => context.trace,
    name: "createAudit",
  });
  const invoker = createInvoker(createFunctionRegistry({ createAudit }));

  const trace = await withInvokeTrace(
    { parentFunction: "api", requestId: "req_123" },
    () => invoker("createAudit", {})
  );

  expect(trace).toEqual({ parentFunction: "api", requestId: "req_123" });
});

test("invokes AWS Lambda through an injected transport", async () => {
  const calls: unknown[] = [];
  const transport: InvokeTransport = {
    invoke: (request) => {
      calls.push(request);
      return Promise.resolve({
        payload: { data: { id: "usr_1" } },
        statusCode: 200,
      });
    },
  };

  const result = await invoke<{ id: string }, { id: string }>(
    "getUser",
    { id: "usr_1" },
    {
      runtime: "aws",
      trace: { requestId: "req_aws" },
      transport,
    }
  );

  expect(result).toEqual({ id: "usr_1" });
  expect(calls).toEqual([
    {
      functionName: "getUser",
      invocationType: "RequestResponse",
      payload: {
        payload: { id: "usr_1" },
        trace: { requestId: "req_aws" },
      },
    },
  ]);
});

test("supports async AWS Lambda invocation mode", async () => {
  const transport: InvokeTransport = {
    invoke: (request) =>
      Promise.resolve({
        requestId: `queued-${request.functionName}`,
        statusCode: 202,
      }),
  };

  const result = await invoke(
    "sendEmail",
    { to: "hello@example.com" },
    {
      mode: "async",
      runtime: "aws",
      transport,
    }
  );

  expect(result).toEqual({ accepted: true, requestId: "queued-sendEmail" });
});

test("retries transient invoke failures and enforces timeout", async () => {
  let attempts = 0;
  const flaky = defineFunction({
    handler: () => {
      attempts += 1;

      if (attempts < 2) {
        throw new Error("temporarily unavailable");
      }

      return { ok: true };
    },
    name: "flaky",
  });
  const slow = defineFunction({
    handler: async () => {
      await Bun.sleep(50);
      return { ok: true };
    },
    name: "slow",
  });
  const invoker = createInvoker(createFunctionRegistry({ flaky, slow }));

  await expect(invoker("flaky", {}, { retries: 1 })).resolves.toEqual({
    ok: true,
  });
  await expect(invoker("slow", {}, { timeoutMs: 1 })).rejects.toThrow(
    "timed out"
  );
  expect(attempts).toBe(2);
});
