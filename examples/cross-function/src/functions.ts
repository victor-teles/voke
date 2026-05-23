import { defineFunction, defineFunctions } from "voke";
import type { StandardSchemaV1 } from "voke";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "voke-example",
    version: 1,
  },
});

const getUserInput: StandardSchemaV1<{ id: string }, { id: string }> = {
  "~standard": {
    validate: (value) =>
      value.id.trim() === ""
        ? { issues: [{ message: "id is required" }], success: false }
        : { data: value, success: true },
    vendor: "voke-example",
    version: 1,
  },
};

export const getUser = defineFunction({
  handler: (payload, context) => ({
    id: payload.id,
    name: "Victor",
    requestId: context.trace.requestId,
  }),
  input: getUserInput,
  output: schema<{
    id: string;
    name: string;
    requestId: string | number | boolean | undefined;
  }>(),
});

export const functions = defineFunctions({ getUser });
