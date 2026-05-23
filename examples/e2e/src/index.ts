import {
  api,
  createGateway,
  defineFunction,
  defineFunctions,
  Voke,
} from "voke";
import type { StandardSchemaV1 } from "voke";

import { sendWelcomeEmail } from "./functions";

const schema = <TInput, TOutput = TInput>(
  validate: (value: TInput) => TOutput
): StandardSchemaV1<TInput, TOutput> => ({
  "~standard": {
    validate: (value) => ({ data: validate(value), success: true }),
    vendor: "voke-example",
    version: 1,
  },
});

const createUserBody = schema<unknown, { id: string; email: string }>(
  (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      "email" in value &&
      typeof value.id === "string" &&
      typeof value.email === "string"
    ) {
      return { email: value.email, id: value.id };
    }

    return { email: "", id: "" };
  }
);

const app = new Voke();

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

  return Response.json(
    {
      data: {
        id: req.body.id,
        welcome,
      },
    },
    { status: 201 }
  );
};

const registry = defineFunctions({
  routes: defineFunction({
    routes: [
      app.get("/health", {
        handler: () => ({ ok: true }),
      }),
      app.post("/users", {
        body: createUserBody,
        handler: createUser,
      }),
    ],
  }),
  sendWelcomeEmail,
});
functionRuntime.current = registry;

const gateway = createGateway({
  config: { name: "e2e-api" },
  functions: registry,
});

export default api(gateway, { name: "e2e-api" });
