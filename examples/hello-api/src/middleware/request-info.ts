import type { MiddlewareHandler } from "hono";
import { requestId } from "voke/context";
import type { VokeEnv } from "voke/context";

export const requestInfo: MiddlewareHandler<VokeEnv> = async (c, next) => {
  await next();

  const id = requestId(c);

  if (id !== undefined) {
    c.res.headers.set("x-request-id", id);
  }
};
