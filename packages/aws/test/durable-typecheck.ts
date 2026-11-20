// Compile-time checks for durable(); `bun run typecheck` runs them.
import { createFunctions } from "voke";
import type { StandardSchemaV1 } from "voke";

import { durable } from "../src/index";
import type { DurableContext, DurableInvokeContext } from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

const functions = createFunctions({
  fulfilOrder: durable({
    executionTimeout: { hours: 24 },
    handler: async (order, context) => {
      // The payload is inferred from the input schema.
      const _id: string = order.id;
      // @ts-expect-error the payload has only the schema's fields.
      void order.missing;
      const _context: DurableInvokeContext = context;
      const _durable: DurableContext = context.durable;
      const reservation: string = await context.durable.step(
        "reserve-stock",
        async () => await Promise.resolve(`r-${order.id}`)
      );
      await context.durable.wait("cooling-off", { minutes: 10 });

      return { orderId: order.id, reservationId: reservation };
    },
    input: schema<{ id: string }>(),
    output: schema<{ orderId: string; reservationId: string }>(),
  }),
  nightlyReport: durable({
    executionTimeout: { minutes: 15 },
    handler: () => "done",
    output: schema<string>(),
  }),
});

// @ts-expect-error executionTimeout is required.
durable({ handler: () => "done", output: schema<string>() });

durable({
  executionTimeout: { hours: 1 },
  // @ts-expect-error the handler must return the output schema's input.
  handler: () => 42,
  output: schema<string>(),
});

export const checkDurableInvoke = async (): Promise<void> => {
  const receipt = await functions.invoke("fulfilOrder", { id: "o-1" });
  const _receiptId: string = receipt.reservationId;

  // @ts-expect-error the payload must match the input schema.
  await functions.invoke("fulfilOrder", { orderId: "o-1" });

  const started = await functions.invoke(
    "fulfilOrder",
    { id: "o-1" },
    { executionName: "order-o-1", mode: "async" }
  );
  const _accepted: true = started.accepted;
  const _executionId: string | undefined = started.executionId;

  const report: string = await functions.invoke("nightlyReport");
  void report;
};

// Resource Links: the handler reads only the resource keys the Function lists in `resources`.
createFunctions({
  linkedWorkflow: durable({
    executionTimeout: { hours: 1 },
    handler: (_payload, context) => {
      const _table: string = context.resource("ordersTable");
      // @ts-expect-error the Function does not link ordersQueue.
      void context.resource("ordersQueue");

      return "ok";
    },
    output: schema<string>(),
    resources: ["ordersTable"],
  }),
  unlinkedWorkflow: durable({
    executionTimeout: { hours: 1 },
    handler: (_payload, context) => {
      // @ts-expect-error a Function without resources links nothing.
      void context.resource("ordersTable");

      return "ok";
    },
    output: schema<string>(),
  }),
});
