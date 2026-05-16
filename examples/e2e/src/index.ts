import { api, createApiApp, invoke, json } from "voke";

import "./functions";

const app = createApiApp({
  config: { name: "e2e-api" },
});

app.get("/health", () => json({ ok: true }));

app.post("/users", async (c) => {
  const body = await c.req.json<{ id: string; email: string }>();
  const welcome = await invoke<
    { userId: string; email: string },
    { queued: boolean; userId: string; email: string }
  >("sendWelcomeEmail", {
    email: body.email,
    userId: body.id,
  });

  return json(
    {
      id: body.id,
      welcome,
    },
    { status: 201 }
  );
});

const service = api(app, { name: "e2e-api" });

export const { handler } = service;
export default service;
