import { aws } from "@voke/aws";
import { created } from "@voke/http";
import { schema } from "@voke/schema";
import { createFunctions, http, route, voke } from "voke";

import { sendWelcomeEmail } from "./functions";

const createUserBody = schema.object({
  email: schema.string(),
  id: schema.string(),
});

interface EmailFunctions {
  invoke: (
    name: "sendWelcomeEmail",
    payload: { userId: string; email: string }
  ) => Promise<{ queued: boolean; userId: string; email: string }>;
}

const functionRuntime: { current?: unknown } = {};

const createUser = async (req: {
  body: { id: string; email: string };
}): Promise<Response> => {
  const functions = functionRuntime.current as EmailFunctions | undefined;

  if (functions === undefined) {
    throw new Error("Function Registry is not initialized");
  }

  const welcome = await functions.invoke("sendWelcomeEmail", {
    email: req.body.email,
    userId: req.body.id,
  });

  return created({
    id: req.body.id,
    welcome,
  });
};

const registry = createFunctions({
  http: http({
    routes: [
      route.get("/health", {
        handler: () => ({ ok: true }),
      }),
      route.post("/users", {
        body: createUserBody,
        handler: createUser,
      }),
    ],
  }),
  sendWelcomeEmail,
});
functionRuntime.current = registry;

const gateway = voke(registry, {
  config: { name: "e2e-api" },
  provider: aws(),
});

export default gateway;
