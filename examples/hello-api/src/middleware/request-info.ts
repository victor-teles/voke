import type { MiddlewareHandler } from "hono";

export const requestInfo: MiddlewareHandler = async (c, next) => {
  await next();

  const id =
    c.req.header("x-request-id") ??
    (c.env as { lambdaContext?: { awsRequestId?: string } }).lambdaContext
      ?.awsRequestId;

  if (id !== undefined) {
    c.res.headers.set("x-request-id", id);
  }
};
