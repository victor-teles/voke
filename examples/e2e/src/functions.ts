import { defineFunction, defineFunctions } from "voke";
import type { StandardSchemaV1 } from "voke";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "voke-example",
    version: 1,
  },
});

export const sendWelcomeEmail = defineFunction({
  handler: (payload) => ({
    email: payload.email,
    queued: true,
    userId: payload.userId,
  }),
  input: schema<{ userId: string; email: string }>(),
  output: schema<{ queued: boolean; userId: string; email: string }>(),
});

export const functions = defineFunctions({ sendWelcomeEmail });
