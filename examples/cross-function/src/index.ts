import { createFunctions, http, route, voke } from "voke";
import { withInvokeTrace } from "voke/invoke";
import { schema } from "voke/schema";

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

const getUserRoute = async (req: {
  params: { id: string };
  requestId: string | undefined;
}): Promise<{
  id: string;
  name: string;
  requestId: string | number | boolean | undefined;
}> =>
  await withInvokeTrace({ requestId: req.requestId }, () => {
    const functions = functionRuntime.current as UserFunctions | undefined;

    if (functions === undefined) {
      throw new Error("Function Registry is not initialized");
    }

    return functions.invoke("getUser", { id: req.params.id });
  });

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
