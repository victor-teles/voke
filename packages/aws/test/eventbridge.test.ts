import { expect, test } from "bun:test";

import { createFunctions, InvokeError, VokeConfigError } from "voke";
import type { StandardSchemaV1 } from "voke";

import { createLambdaHandlers, eventBridge } from "../src/index";
import type { EventBridgeAwsEvent, EventBridgeEvent } from "../src/index";

interface PaidOrder {
  orderId: string;
}

// Accepts `{ orderId: string }` and reports any other value as one issue.
const paidOrder: StandardSchemaV1<PaidOrder, PaidOrder> = {
  "~standard": {
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { orderId?: unknown }).orderId === "string"
        ? { value: value as PaidOrder }
        : { issues: [{ message: "orderId is required", path: ["orderId"] }] },
    vendor: "voke-test",
    version: 1,
  },
};

// Accepts any object, so an empty `detail` is valid.
const anyDetail: StandardSchemaV1<object, object> = {
  "~standard": {
    validate: (value) => ({ value: value as object }),
    vendor: "voke-test",
    version: 1,
  },
};

const isoSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

const awsEvent = (detail: unknown): EventBridgeAwsEvent => ({
  account: "123456789012",
  detail,
  "detail-type": "OrderPaid",
  id: "6a7e8feb-b491-4cf7-a9f1-bf3703467718",
  region: "us-east-1",
  resources: ["arn:aws:orders:us-east-1:123456789012:order/o9"],
  source: "orders",
  time: "2024-03-01T12:00:00Z",
  version: "0",
});

const recordingFunctions = () => {
  const seen: EventBridgeEvent<PaidOrder>[] = [];
  const functions = createFunctions({
    onPaid: eventBridge({
      detail: paidOrder,
      handler: (event) => {
        seen.push(event);
      },
      pattern: {
        detail: { status: ["PAID"] },
        detailType: ["OrderPaid", "OrderSettled"],
        source: ["orders"],
      },
    }),
  });

  return { functions, seen };
};

test("eventBridge() requires a pattern with a source or a detail type", () => {
  expect(() =>
    eventBridge({
      detail: paidOrder,
      handler: () => {},
      pattern: {},
    })
  ).toThrow(VokeConfigError);
  expect(() =>
    eventBridge({
      detail: paidOrder,
      handler: () => {},
      pattern: { detail: { status: ["PAID"] }, source: [] },
    })
  ).toThrow(VokeConfigError);
  expect(() =>
    eventBridge({ detail: paidOrder, handler: () => {} } as never)
  ).toThrow(VokeConfigError);
});

test("eventBridge() rejects an empty bus key", () => {
  expect(() =>
    eventBridge({
      bus: "",
      detail: paidOrder,
      handler: () => {},
      pattern: { source: ["orders"] },
    })
  ).toThrow(VokeConfigError);
});

test("eventBridge() stores the bus and the pattern it was given", () => {
  const onBus = eventBridge({
    bus: "ordersBus",
    detail: paidOrder,
    handler: () => {},
    pattern: { detailType: ["OrderPaid"] },
  });
  const onDefaultBus = eventBridge({
    detail: paidOrder,
    handler: () => {},
    pattern: { detail: { status: ["PAID"] }, source: ["orders"] },
  });

  expect(onBus.events).toEqual([
    {
      properties: { pattern: { detailType: ["OrderPaid"] } },
      resource: "ordersBus",
      source: "eventBridge",
    },
  ]);
  expect(onDefaultBus.events).toEqual([
    {
      properties: {
        pattern: { detail: { status: ["PAID"] }, source: ["orders"] },
      },
      source: "eventBridge",
    },
  ]);
});

test("sendEvent fills source and detail type from the first values of the pattern", async () => {
  const { functions, seen } = recordingFunctions();

  await expect(
    functions.sendEvent("onPaid", { detail: { orderId: "o1" } })
  ).resolves.toBeUndefined();

  const [event] = seen;

  expect(event).toMatchObject({
    account: "000000000000",
    detail: { orderId: "o1" },
    detailType: "OrderPaid",
    id: "evt_1",
    region: "local",
    resources: [],
    source: "orders",
  });
  expect(event?.time).toMatch(isoSeconds);
  expect(event?.raw["detail-type"]).toBe("OrderPaid");
});

test("sendEvent passes the optional id, time, source and detail type through", async () => {
  const { functions, seen } = recordingFunctions();

  await functions.sendEvent("onPaid", {
    detail: { orderId: "o1" },
    detailType: "OrderSettled",
    id: "evt-42",
    source: "billing",
    time: "2024-03-01T12:00:00Z",
  });

  expect(seen[0]).toMatchObject({
    detailType: "OrderSettled",
    id: "evt-42",
    source: "billing",
    time: "2024-03-01T12:00:00Z",
  });
});

test("sendEvent defaults a missing source when the pattern only lists detail types", async () => {
  const seen: EventBridgeEvent<object>[] = [];
  const functions = createFunctions({
    onAny: eventBridge({
      detail: anyDetail,
      handler: (event) => {
        seen.push(event);
      },
      pattern: { detailType: ["Anything"] },
    }),
  });

  await functions.sendEvent("onAny", { detail: {} });
  expect(seen[0]).toMatchObject({
    detail: {},
    detailType: "Anything",
    source: "voke.local",
  });
});

test("an invalid detail rejects with INVALID_PAYLOAD and never reaches the handler", async () => {
  const { functions, seen } = recordingFunctions();
  const rejection = await functions
    .sendEvent("onPaid", { detail: {} as never })
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(InvokeError);
  expect(rejection).toMatchObject({
    code: "INVALID_PAYLOAD",
    issues: [{ message: "orderId is required", path: ["orderId"] }],
    message:
      "Invalid EventBridge event detail for evt_1: orderId: orderId is required",
  });
  expect(seen).toEqual([]);
});

test("the deployed handler accepts a real EventBridge event and resolves to undefined", async () => {
  const { functions, seen } = recordingFunctions();
  const event = awsEvent({ orderId: "o9" });

  await expect(
    createLambdaHandlers({ functions }).onPaid?.(event)
  ).resolves.toBeUndefined();
  expect(seen).toEqual([
    {
      account: "123456789012",
      detail: { orderId: "o9" },
      detailType: "OrderPaid",
      id: "6a7e8feb-b491-4cf7-a9f1-bf3703467718",
      raw: event,
      region: "us-east-1",
      resources: ["arn:aws:orders:us-east-1:123456789012:order/o9"],
      source: "orders",
      time: "2024-03-01T12:00:00Z",
    },
  ]);
});

test("the deployed handler accepts an event whose detail is an empty object", async () => {
  const seen: EventBridgeEvent<object>[] = [];
  const functions = createFunctions({
    onAny: eventBridge({
      detail: anyDetail,
      handler: (event) => {
        seen.push(event);
      },
      pattern: { source: ["orders"] },
    }),
  });

  await createLambdaHandlers({ functions }).onAny?.(awsEvent({}));
  expect(seen[0]?.detail).toEqual({});
});

test("the deployed handler fails the invocation for an invalid detail", async () => {
  const { functions, seen } = recordingFunctions();

  await expect(
    createLambdaHandlers({ functions }).onPaid?.(awsEvent({ status: "PAID" }))
  ).rejects.toMatchObject({
    code: "INVALID_PAYLOAD",
    message: expect.stringContaining(
      "Invalid EventBridge event detail for 6a7e8feb-b491-4cf7-a9f1-bf3703467718"
    ),
  });
  expect(seen).toEqual([]);
});
