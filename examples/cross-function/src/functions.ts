import { createFunctions, fn } from "voke";
import { schema } from "voke/schema";

const getUserInput = schema.object({
  id: schema.string().min(1),
});

const getUserOutput = schema.object({
  id: schema.string(),
  name: schema.string(),
  requestId: schema.optional(schema.string()),
});

export const getUser = fn({
  handler: (payload, context) => ({
    id: payload.id,
    name: "Victor",
    requestId:
      typeof context.trace.requestId === "string"
        ? context.trace.requestId
        : undefined,
  }),
  input: getUserInput,
  output: getUserOutput,
});

export const functions = createFunctions({ getUser });
