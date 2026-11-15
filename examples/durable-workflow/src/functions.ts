import { durable } from "@voke/aws";
import { schema } from "@voke/schema";
import { createFunctions, http, route } from "voke";
import type { StandardSchemaOutput } from "voke";

const order = schema.object({
  id: schema.string().min(1),
  quantity: schema.number().int().min(1),
  sku: schema.string().min(1),
});

const receipt = schema.object({
  orderId: schema.string(),
  reservationId: schema.string(),
  trackingNumber: schema.string(),
});

type Order = StandardSchemaOutput<typeof order>;

/** Side effects the example records, standing in for a warehouse and a carrier API. */
export const warehouseLog: string[] = [];

const reserveStock = async (input: Order): Promise<{ id: string }> => {
  warehouseLog.push(`reserve ${input.quantity} x ${input.sku}`);

  return await Promise.resolve({ id: `res_${input.id}` });
};

const shipOrder = async (input: Order): Promise<{ trackingNumber: string }> => {
  warehouseLog.push(`ship ${input.id}`);

  return await Promise.resolve({ trackingNumber: `trk_${input.id}` });
};

/**
 * Reserves stock, waits out a ten-minute cancellation window, then ships. Each step is
 * checkpointed: after the wait, Lambda replays the handler and the reservation is not repeated.
 */
export const fulfilOrder = durable({
  executionTimeout: { hours: 24 },
  handler: async (input, context) => {
    const reservation = await context.durable.step(
      "reserve-stock",
      async () => await reserveStock(input)
    );
    await context.durable.wait("cancellation-window", { minutes: 10 });
    const shipment = await context.durable.step(
      "ship",
      async () => await shipOrder(input)
    );

    return {
      orderId: input.id,
      reservationId: reservation.id,
      trackingNumber: shipment.trackingNumber,
    };
  },
  input: order,
  output: receipt,
});

interface StartedFulfilment {
  executionId?: string;
  orderId: string;
}

// The order id names the execution, so a retried request does not start a second fulfilment.
const startFulfilment = async (input: Order): Promise<StartedFulfilment> => {
  // oxlint-disable-next-line no-use-before-define -- routes run only after the registry exists
  const started = await functions.invoke("fulfilOrder", input, {
    executionName: `order-${input.id}`,
    mode: "async",
  });

  return started.executionId === undefined
    ? { orderId: input.id }
    : { executionId: started.executionId, orderId: input.id };
};

export const functions = createFunctions({
  fulfilOrder,
  http: http({
    routes: [
      route.post("/orders", {
        body: order,
        handler: async (request) => await startFulfilment(request.body),
      }),
    ],
  }),
});
