// Compile-time checks for sns(), eventBridge() and schedule(); `bun run typecheck` runs them.
import { createFunctions } from "voke";
import type { StandardSchemaV1 } from "voke";

import { eventBridge, schedule, sns } from "../src/index";
import type { ScheduledEvent } from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

const ignoreEvent = (): void => {
  // These checks only need a handler of the right type.
};

const orderCreated = schema<{ orderId: string; total: number }>();

const functions = createFunctions({
  nightly: schedule({
    expression: "rate(1 day)",
    handler: (event) => {
      const _event: ScheduledEvent = event;
      const _attempt: number = event.attempt;
    },
  }),
  onOrder: sns({
    handler: (message) => {
      // The handler input is inferred from the message schema.
      const _orderId: string = message.body.orderId;
      const _total: number = message.body.total;
      const _topicArn: string = message.topicArn;
      // @ts-expect-error the body has only the schema's fields.
      void message.body.missing;
    },
    message: orderCreated,
    topic: "ordersTopic",
  }),
  onPaid: eventBridge({
    detail: orderCreated,
    handler: (event) => {
      const _orderId: string = event.detail.orderId;
      const _detailType: string = event.detailType;
      // @ts-expect-error the detail has only the schema's fields.
      void event.detail.missing;
    },
    pattern: { source: ["orders"] },
  }),
});

// sendEvent resolves to the handler's own result: nothing.
const _snsResult: Promise<void> = functions.sendEvent("onOrder", {
  message: { orderId: "o1", total: 10 },
});
const _eventBridgeResult: Promise<void> = functions.sendEvent("onPaid", {
  detail: { orderId: "o1", total: 10 },
});
const _scheduleResult: Promise<void> = functions.sendEvent("nightly", {});

// @ts-expect-error an SNS Function takes { message }, not an SQS batch.
void functions.sendEvent("onOrder", { messages: [] });
// @ts-expect-error the message must match the schema.
void functions.sendEvent("onOrder", { message: { orderId: 1, total: 10 } });
// @ts-expect-error an EventBridge Function takes { detail }.
void functions.sendEvent("onPaid", { message: { orderId: "o1", total: 10 } });
// @ts-expect-error a schedule Function takes no payload of its own.
void functions.sendEvent("nightly", { detail: {} });

sns({
  handler: ignoreEvent,
  message: orderCreated,
  // @ts-expect-error SNS Functions cannot serve HTTP routes.
  routes: [],
  topic: "ordersTopic",
});
eventBridge({
  detail: orderCreated,
  handler: ignoreEvent,
  pattern: { source: ["orders"] },
  // @ts-expect-error EventBridge Functions cannot serve HTTP routes.
  routes: [],
});
schedule({
  expression: "rate(1 day)",
  handler: ignoreEvent,
  // @ts-expect-error schedule Functions cannot serve HTTP routes.
  routes: [],
});
sns({
  // @ts-expect-error handlers return nothing; SNS ignores the result.
  handler: () => ({ ok: true }),
  message: orderCreated,
  topic: "ordersTopic",
});

// Resource Links: each handler reads only the resource keys its Function lists in `resources`.
createFunctions({
  linkedNightly: schedule({
    expression: "rate(1 day)",
    handler: (_event, context) => {
      const _table: string = context.resource("ordersTable");
      // @ts-expect-error the Function does not link ordersTopic.
      void context.resource("ordersTopic");
    },
    resources: ["ordersTable"],
  }),
  linkedOnEvent: eventBridge({
    detail: orderCreated,
    handler: (event, context) => {
      const _orderId: string = event.detail.orderId;
      const _table: string = context.resource("ordersTable");
      // @ts-expect-error the Function does not link ordersTopic.
      void context.resource("ordersTopic");
    },
    pattern: { source: ["orders"] },
    resources: ["ordersTable"],
  }),
  linkedOnOrder: sns({
    handler: (message, context) => {
      const _orderId: string = message.body.orderId;
      const _table: string = context.resource("ordersTable");
      // @ts-expect-error the Function does not link ordersTopic.
      void context.resource("ordersTopic");
    },
    message: orderCreated,
    resources: ["ordersTable"],
    topic: "ordersTopic",
  }),
  unlinkedNightly: schedule({
    expression: "rate(1 day)",
    handler: (_event, context) => {
      // @ts-expect-error a Function without resources links nothing.
      void context.resource("ordersTable");
    },
  }),
  unlinkedOnEvent: eventBridge({
    detail: orderCreated,
    handler: (_event, context) => {
      // @ts-expect-error a Function without resources links nothing.
      void context.resource("ordersTable");
    },
    pattern: { source: ["orders"] },
  }),
  unlinkedOnOrder: sns({
    handler: (_message, context) => {
      // @ts-expect-error a Function without resources links nothing.
      void context.resource("ordersTable");
    },
    message: orderCreated,
    topic: "ordersTopic",
  }),
});
