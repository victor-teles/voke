import { defineFunction, registerLocalFunction } from "voke";

export const sendWelcomeEmail = defineFunction({
  handler: (payload: { userId: string; email: string }) => ({
    email: payload.email,
    queued: true,
    userId: payload.userId,
  }),
  name: "sendWelcomeEmail",
});

registerLocalFunction(sendWelcomeEmail);
