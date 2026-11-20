// Type-level checks: tsgo compiles this file; bun test does not run it.
import { sqs } from "@vokejs/aws";
import type { SqsBatchResult } from "@vokejs/aws";
import { schema } from "@vokejs/schema";
import { createFunctions, fn, http, route } from "voke";

import { idempotent, idempotentBatch } from "../src/index";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
    ? true
    : false;
const assertType = <TCheck extends true>(): TCheck | undefined => undefined;

const chargeInput = schema.object({
  amount: schema.number(),
  orderId: schema.string(),
});
const chargeOutput = schema.object({ chargeId: schema.string() });

const functions = createFunctions({
  charge: fn({
    handler: idempotent(
      (payload) => {
        assertType<Equal<typeof payload.amount, number>>();
        assertType<Equal<typeof payload.orderId, string>>();

        return { chargeId: payload.orderId };
      },
      {
        key: (payload) => {
          assertType<Equal<typeof payload.orderId, string>>();

          return payload.orderId;
        },
      }
    ),
    input: chargeInput,
    output: chargeOutput,
  }),
  orders: http({
    routes: [
      route.post("/orders", {
        body: schema.object({ item: schema.string() }),
        handler: idempotent((request) => ({ item: request.body.item }), {
          key: (request) => request.headers["idempotency-key"],
          validate: (request) => request.body,
        }),
      }),
    ],
  }),
  settle: sqs({
    handler: idempotentBatch(
      (message) => {
        assertType<Equal<typeof message.body.paymentId, string>>();
      },
      { key: (message) => message.body.paymentId }
    ),
    message: schema.object({ paymentId: schema.string() }),
    queue: "paymentsQueue",
  }),
});

export const charged = async (): Promise<{ chargeId: string }> =>
  await functions.invoke("charge", { amount: 1, orderId: "ord_1" });

export const settled = async (): Promise<SqsBatchResult> =>
  await functions.sendEvent("settle", {
    messages: [{ body: { paymentId: "pay_1" } }],
  });

const wrapped = idempotent(
  (input: { id: string }, context: { requestId: string }) =>
    Promise.resolve(`${input.id}:${context.requestId}`),
  { key: (input) => input.id }
);

assertType<
  Equal<
    typeof wrapped,
    (input: { id: string }, context: { requestId: string }) => Promise<string>
  >
>();

// @ts-expect-error key is required
idempotent((input: { id: string }) => input, {});
