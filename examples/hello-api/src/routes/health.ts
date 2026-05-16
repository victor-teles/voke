import { Hono } from "hono";
import { getConfig, json } from "voke";
import type { VokeEnv } from "voke";

export const healthRoutes = new Hono<VokeEnv>();

healthRoutes.get("/", (c) => {
  const config = getConfig(c);

  return json({
    ok: true,
    service: config.name,
    stage: config.stage,
  });
});
