import type { MiddlewareHandler } from "hono";
import type { VokeEnv } from "voke";
import { requestId } from "voke";

export const requestInfo: MiddlewareHandler<VokeEnv> = async (c, next) => {
  await next();

  const id = requestId(c);

  if (id !== undefined) {
    c.res.headers.set("x-request-id", id);
  }
};
