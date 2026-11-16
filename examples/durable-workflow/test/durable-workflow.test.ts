import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { aws } from "@vokejs/aws";
import type { CloudFormationTemplate } from "@vokejs/aws/cloudformation";
import {
  runDurable,
  setupDurableTests,
  teardownDurableTests,
} from "@vokejs/aws/testing";
import { createTestClient } from "@vokejs/testing";
import { createVokeModel } from "voke";

import { functions, warehouseLog } from "../src/functions";
import gateway from "../src/index";
import config from "../voke.config";

const order = { id: "ord_1", quantity: 2, sku: "sku_red" };

// Durable waits and retry delays complete at once in these tests.
beforeAll(async () => {
  await setupDurableTests();
});

afterAll(async () => {
  await teardownDurableTests();
});

beforeEach(() => {
  warehouseLog.length = 0;
});

test("a fulfilment reserves once, waits out the cancellation window and ships", async () => {
  const run = await runDurable(functions, "fulfilOrder", order);

  expect(run.result).toEqual({
    orderId: "ord_1",
    reservationId: "res_ord_1",
    trackingNumber: "trk_ord_1",
  });
  expect(warehouseLog).toEqual(["reserve 2 x sku_red", "ship ord_1"]);
  expect(
    run.operations.map((operation) => [
      operation.getName(),
      operation.getType(),
    ])
  ).toEqual([
    ["reserve-stock", "STEP"],
    ["cancellation-window", "WAIT"],
    ["ship", "STEP"],
  ]);
  expect(run.operations[1]?.getWaitDetails()?.waitSeconds).toBe(600);
});

test("functions.invoke runs the same workflow and returns the validated receipt", async () => {
  await expect(functions.invoke("fulfilOrder", order)).resolves.toEqual({
    orderId: "ord_1",
    reservationId: "res_ord_1",
    trackingNumber: "trk_ord_1",
  });
});

test("POST /orders starts a fulfilment and answers at once", async () => {
  const client = createTestClient(gateway);
  const response = await client.post("/orders", { json: order });

  expect(response.status).toBe(200);
  // Locally the execution runs in-process, so there is no Lambda execution id.
  expect(await response.json()).toEqual({ data: { orderId: "ord_1" } });
});

test("the deployed stack runs fulfilOrder as a durable function behind the live alias", () => {
  const provider = aws();
  const template = provider.synthesis?.synthesize?.({
    config,
    model: createVokeModel({ ...config, functions }),
  }) as CloudFormationTemplate;
  const resources = Object.values(template.Resources);
  const durableFunction = template.Resources.FulfilOrderFunction;

  expect(durableFunction?.Properties.DurableConfig).toEqual({
    ExecutionTimeout: 86_400,
  });
  expect(
    resources.filter(
      (resource) =>
        resource.Type === "AWS::Lambda::Version" &&
        resource.DeletionPolicy === "Retain"
    )
  ).toHaveLength(1);
  expect(
    resources.filter(
      (resource) =>
        resource.Type === "AWS::Lambda::Alias" &&
        resource.Properties.Name === "live"
    )
  ).toHaveLength(1);
});
