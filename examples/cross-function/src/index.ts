import {
  api,
  createGateway,
  defineFunction,
  defineFunctions,
  Voke,
  withInvokeTrace,
} from "voke";
import type { StandardSchemaV1 } from "voke";

import { getUser } from "./functions";

const schema = <TInput, TOutput = TInput>(
  validate: (value: TInput) => TOutput
): StandardSchemaV1<TInput, TOutput> => ({
  "~standard": {
    validate: (value) => ({ data: validate(value), success: true }),
    vendor: "voke-example",
    version: 1,
  },
});

const app = new Voke();

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
  headers: { "x-request-id": string | undefined };
  params: { id: string };
}): Promise<{
  id: string;
  name: string;
  requestId: string | number | boolean | undefined;
}> =>
  await withInvokeTrace({ requestId: req.headers["x-request-id"] }, () => {
    const functions = functionRuntime.current as UserFunctions | undefined;

    if (functions === undefined) {
      throw new Error("Function Registry is not initialized");
    }

    return functions.invoke("getUser", { id: req.params.id });
  });

const registry = defineFunctions({
  getUser,
  routes: defineFunction({
    routes: [
      app.get("/users/:id", {
        handler: getUserRoute,
        headers: schema<Headers, { "x-request-id": string | undefined }>(
          (headers) => ({
            "x-request-id": headers.get("x-request-id") ?? undefined,
          })
        ),
        params: schema<{ id: string }>((params) => params),
      }),
    ],
  }),
});
functionRuntime.current = registry;

const gateway = createGateway({
  config: { name: "cross-function-api" },
  functions: registry,
});

export default api(gateway, { name: "cross-function-api" });
