import { schema } from "@voke/schema";
import { createFunctions, fn } from "voke";

const welcomeEmailInput = schema.object({
  email: schema.string(),
  userId: schema.string(),
});

const welcomeEmailOutput = schema.object({
  email: schema.string(),
  queued: schema.boolean(),
  userId: schema.string(),
});

export const sendWelcomeEmail = fn({
  handler: (payload) => ({
    email: payload.email,
    queued: true,
    userId: payload.userId,
  }),
  input: welcomeEmailInput,
  output: welcomeEmailOutput,
});

export const functions = createFunctions({ sendWelcomeEmail });
