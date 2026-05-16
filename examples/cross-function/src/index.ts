import { api, createApiApp, invoke, json, withInvokeTrace } from "voke";

import "./functions";

const app = createApiApp({
  config: { name: "cross-function-api" },
});

app.get("/users/:id", async (c) => {
  const user = await withInvokeTrace(
    { requestId: c.req.header("x-request-id") },
    () =>
      invoke<
        { id: string },
        { id: string; name: string; requestId?: string | number | boolean }
      >("getUser", { id: c.req.param("id") })
  );

  return json(user);
});

const service = api(app, { name: "cross-function-api" });

export const { handler } = service;
export default service;
