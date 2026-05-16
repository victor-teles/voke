import { defineFunction, registerLocalFunction } from "voke";

export const getUser = defineFunction({
  handler: (payload: { id: string }, context) => ({
    id: payload.id,
    name: "Victor",
    requestId: context.trace.requestId,
  }),
  name: "getUser",
  validatePayload: (payload: { id: string }) => {
    if (payload.id.trim() === "") {
      throw new Error("id is required");
    }
  },
});

registerLocalFunction(getUser);
