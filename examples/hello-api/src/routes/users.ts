import { Hono } from "hono";
import { json, jsonError, routeModule } from "voke";
import type { VokeEnv } from "voke";

interface User {
  id: string;
  name: string;
}

const users = new Map<string, User>([
  ["usr_1", { id: "usr_1", name: "Victor" }],
]);

const routes = new Hono<VokeEnv>();

routes.get("/", () => json([...users.values()]));

routes.get("/:id", (c) => {
  const user = users.get(c.req.param("id"));

  if (user === undefined) {
    return jsonError("User not found", { code: "USER_NOT_FOUND", status: 404 });
  }

  return json(user);
});

routes.post("/", async (c) => {
  let body: { name?: unknown } | undefined;

  try {
    body = await c.req.json<{ name?: unknown }>();
  } catch {
    body = undefined;
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";

  if (name.length === 0) {
    return jsonError("User name is required", {
      code: "USER_NAME_REQUIRED",
      status: 400,
    });
  }

  const user = {
    id: `usr_${users.size + 1}`,
    name,
  };

  users.set(user.id, user);

  return json(user, { status: 201 });
});

export const usersRoutes = routeModule(routes, { basePath: "/users" });
