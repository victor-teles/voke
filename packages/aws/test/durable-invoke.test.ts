import { afterAll, afterEach, expect, test } from "bun:test";

import type {
  InvokeCommand,
  InvokeCommandOutput,
} from "@aws-sdk/client-lambda";
import { createFunctions, fn, InvokeError, voke } from "voke";
import type { StandardSchemaV1, VokeProvider } from "voke";

import { aws, createAwsLambdaInvokeTransport, durable } from "../src/index";
import type { AwsLambdaInvokeClient } from "../src/index";
import { teardownDurableTests } from "../src/testing";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

const targetVariable = "VOKE_INVOKE_TARGET_FULFIL_ORDER";
const executionArn =
  "arn:aws:lambda:us-east-1:123456789012:function:shop-fulfilOrder:3/durable-execution/order-1/abc";

afterEach(() => {
  Reflect.deleteProperty(process.env, targetVariable);
});

afterAll(async () => {
  await teardownDurableTests();
});

const fakeClient = (
  response: Partial<InvokeCommandOutput>
): { client: AwsLambdaInvokeClient; inputs: unknown[] } => {
  const inputs: unknown[] = [];

  return {
    client: {
      send: (command: InvokeCommand) => {
        inputs.push(command.input);

        return Promise.resolve({
          $metadata: { requestId: "request-1" },
          ...response,
        } as InvokeCommandOutput);
      },
    },
    inputs,
  };
};

// The aws() Provider with its Lambda transport pointed at a fake client.
const providerWith = (client: AwsLambdaInvokeClient): VokeProvider => {
  const provider = aws();

  return {
    ...provider,
    invoke: {
      ...provider.invoke,
      transport: () => createAwsLambdaInvokeTransport({ client }),
    },
  };
};

const createShopFunctions = (calls: string[]) =>
  createFunctions({
    fulfilOrder: durable({
      executionTimeout: { hours: 24 },
      handler: (order: { id: string }) => {
        calls.push(`fulfil:${order.id}`);

        return { orderId: order.id };
      },
      input: schema<{ id: string }>(),
      output: schema<{ orderId: string }>(),
    }),
    lookup: fn({
      handler: (order: { id: string }) => {
        calls.push(`lookup:${order.id}`);

        return order.id;
      },
      input: schema<{ id: string }>(),
      output: schema<string>(),
    }),
  });

test("deployed, an async invoke of a durable Function starts an execution at its live alias", async () => {
  process.env[targetVariable] = "shop-fulfilOrder:live";
  const calls: string[] = [];
  const functions = createShopFunctions(calls);
  const { client, inputs } = fakeClient({
    DurableExecutionArn: executionArn,
    StatusCode: 202,
  });

  voke(functions, { config: { name: "shop", provider: providerWith(client) } });

  await expect(
    functions.invoke(
      "fulfilOrder",
      { id: "o-1" },
      { executionName: "order-1", mode: "async" }
    )
  ).resolves.toEqual({
    accepted: true,
    executionId: executionArn,
    requestId: "request-1",
  });
  expect(calls).toEqual([]);
  expect(inputs).toEqual([
    {
      DurableExecutionName: "order-1",
      FunctionName: "shop-fulfilOrder:live",
      InvocationType: "Event",
      Payload: new TextEncoder().encode(JSON.stringify({ id: "o-1" })),
    },
  ]);
});

test("deployed, a sync invoke of a durable Function returns the execution's result as it is", async () => {
  process.env[targetVariable] = "shop-fulfilOrder:live";
  const functions = createShopFunctions([]);
  const { client, inputs } = fakeClient({
    Payload: new TextEncoder().encode(
      JSON.stringify({ orderId: "o-2" })
    ) as InvokeCommandOutput["Payload"],
    StatusCode: 200,
  });

  voke(functions, { config: { name: "shop", provider: providerWith(client) } });

  await expect(functions.invoke("fulfilOrder", { id: "o-2" })).resolves.toEqual(
    { orderId: "o-2" }
  );
  expect(inputs).toHaveLength(1);
  expect((inputs[0] as { InvocationType: string }).InvocationType).toBe(
    "RequestResponse"
  );
});

test("without the target variable a durable Function runs locally and ignores its execution name", async () => {
  const calls: string[] = [];
  const functions = createShopFunctions(calls);
  const { client, inputs } = fakeClient({ StatusCode: 202 });

  voke(functions, { config: { name: "shop", provider: providerWith(client) } });

  await expect(
    functions.invoke("fulfilOrder", { id: "o-3" }, { executionName: "order-3" })
  ).resolves.toEqual({ orderId: "o-3" });
  expect(calls).toEqual(["fulfil:o-3"]);
  expect(inputs).toEqual([]);
});

test("a Function that is not durable still runs in-process when deployed", async () => {
  process.env[targetVariable] = "shop-fulfilOrder:live";
  process.env.VOKE_INVOKE_TARGET_LOOKUP = "shop-lookup:live";
  const calls: string[] = [];
  const functions = createShopFunctions(calls);
  const { client, inputs } = fakeClient({ StatusCode: 200 });

  voke(functions, { config: { name: "shop", provider: providerWith(client) } });

  try {
    await expect(functions.invoke("lookup", { id: "o-4" })).resolves.toBe(
      "o-4"
    );
    expect(calls).toEqual(["lookup:o-4"]);
    expect(inputs).toEqual([]);
  } finally {
    delete process.env.VOKE_INVOKE_TARGET_LOOKUP;
  }
});

test("executionName on a Function that is not durable rejects with INVALID_OPTIONS", async () => {
  const functions = createShopFunctions([]);
  const { client } = fakeClient({ StatusCode: 200 });

  voke(functions, { config: { name: "shop", provider: providerWith(client) } });

  const failure = await functions
    .invoke("lookup", { id: "o-5" }, { executionName: "lookup-5" })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(InvokeError);
  expect((failure as InvokeError).code).toBe("INVALID_OPTIONS");
});
