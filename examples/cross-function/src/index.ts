import { schema } from "@voke/schema";
import { createFunctions, http, route, voke } from "voke";

import { getUser } from "./functions";

const userParams = schema.object({
  id: schema.string(),
});

interface UserFunctions {
  invoke: (
    name: "getUser",
    payload: { id: string }
  ) => Promise<{
    id: string;
    name: string;
    requestId: string | number | boolean | undefined;
  }>;
}

const functionRuntime: { current?: unknown } = {};

const getUserRoute = (req: {
  params: { id: string };
  requestId: string | undefined;
}): Promise<{
  id: string;
  name: string;
  requestId: string | number | boolean | undefined;
}> => {
  const functions = functionRuntime.current as
    | (UserFunctions & {
        invoke: (
          name: "getUser",
          payload: { id: string },
          options: { trace: { requestId: string | undefined } }
        ) => ReturnType<UserFunctions["invoke"]>;
      })
    | undefined;

  if (functions === undefined) {
    throw new Error("Function Registry is not initialized");
  }

  return functions.invoke(
    "getUser",
    { id: req.params.id },
    {
      trace: { requestId: req.requestId },
    }
  );
};

const registry = createFunctions({
  getUser,
  http: http({
    routes: [
      route.get("/users/:id", {
        handler: (req) =>
          getUserRoute({
            params: req.params,
            requestId: req.raw.headers.get("x-request-id") ?? undefined,
          }),
        params: userParams,
      }),
    ],
  }),
});
functionRuntime.current = registry;

const gateway = voke(registry, {
  config: { name: "cross-function-api" },
});

export default gateway;
