import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { createFunctions, fn } from "voke";
import type { StandardSchemaV1 } from "voke";

import { createLambdaHandlers, durable } from "../src/index";
import { setupDurableTests, teardownDurableTests } from "../src/testing";

const orderSchema: StandardSchemaV1<unknown, { id: string }> = {
  "~standard": {
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string"
        ? { value: { id: value.id } }
        : { issues: [{ message: "expected an order" }] },
    vendor: "voke-test",
    version: 1,
  },
};

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

const targetVariable = "VOKE_INVOKE_TARGET_FULFIL_ORDER";

beforeAll(async () => {
  await setupDurableTests();
});

afterAll(async () => {
  await teardownDurableTests();
});

afterEach(() => {
  Reflect.deleteProperty(process.env, targetVariable);
});

const createProject = (calls: string[]) => ({
  functions: createFunctions({
    fulfilOrder: durable({
      executionTimeout: { hours: 1 },
      handler: async (order, context) => {
        const reservation = await context.durable.step("reserve", () => {
          calls.push(`reserve:${order.id}`);

          return Promise.resolve(`r-${order.id}`);
        });
        await context.durable.wait("settle", { minutes: 5 });

        return { orderId: order.id, reservation };
      },
      input: orderSchema,
      output: schema<{ orderId: string; reservation: string }>(),
    }),
    ping: fn({ handler: () => "pong", output: schema<string>() }),
  }),
});

test("the Lambda handler of a durable Function runs the execution with the handler's DurableContext", async () => {
  const calls: string[] = [];
  // Deployed, the variable is set on every Function; inside its own execution it is ignored.
  process.env[targetVariable] = "shop-fulfilOrder:live";
  const handlers = createLambdaHandlers(createProject(calls));
  const runner = new LocalDurableTestRunner({
    handlerFunction: handlers.fulfilOrder as never,
  });

  const execution = await runner.run({ payload: { id: "o-1" } });

  expect(execution.getStatus()).toBe("SUCCEEDED");
  expect(execution.getResult()).toEqual({
    orderId: "o-1",
    reservation: "r-o-1",
  });
  // The operations belong to the Lambda's own execution, not to a nested local one.
  expect(
    execution.getOperations().map((operation) => operation.getName())
  ).toEqual(["reserve", "settle"]);
  expect(calls).toEqual(["reserve:o-1"]);
});

test("the Lambda handler of a durable Function validates the event as the Function's payload", async () => {
  const calls: string[] = [];
  const handlers = createLambdaHandlers(createProject(calls));
  const runner = new LocalDurableTestRunner({
    handlerFunction: handlers.fulfilOrder as never,
  });

  const execution = await runner.run({ payload: { order: "o-2" } });

  expect(execution.getStatus()).toBe("FAILED");
  expect(execution.getError().errorMessage).toContain("Invalid payload");
  expect(calls).toEqual([]);
});

test("other Functions keep the plain invokable Lambda handler", async () => {
  const handlers = createLambdaHandlers(createProject([]));

  await expect(handlers.ping?.(null)).resolves.toBe("pong");
});
