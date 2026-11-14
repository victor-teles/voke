import type { MiddlewareHandler } from "hono";

export const requestInfo: MiddlewareHandler = async (c, next) => {
  await next();

  const env = (c.env ?? {}) as {
    lambdaContext?: { awsRequestId?: string };
    VOKE_AWS_CONTEXT?: { awsRequestId?: string };
  };
  const id =
    c.req.header("x-request-id") ??
    env.lambdaContext?.awsRequestId ??
    env.VOKE_AWS_CONTEXT?.awsRequestId;

  if (id !== undefined) {
    c.res.headers.set("x-request-id", id);
  }
};
