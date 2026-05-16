import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import { defineConfig } from "./config";
import type { VokeConfigInput } from "./config";
import type { VokeEnv } from "./context";
import { jsonError } from "./http";

export interface ApiRouteModule<TEnv extends VokeEnv = VokeEnv> {
  basePath?: string;
  routes: Hono<TEnv>;
}

export interface ApiAppOptions {
  config: VokeConfigInput;
  middleware?: MiddlewareHandler<VokeEnv>[];
  routes?: ApiRouteModule[];
}

const handleRouteError = (error: Error): Response =>
  jsonError(error.message || "Internal server error", {
    code: "INTERNAL_SERVER_ERROR",
    status: 500,
  });

export const createApiApp = (options: ApiAppOptions): Hono<VokeEnv> => {
  const app = new Hono<VokeEnv>();
  const config = defineConfig(options.config);

  app.use("*", async (c, next) => {
    c.env.VOKE_CONFIG = config;
    await next();
  });

  for (const middleware of options.middleware ?? []) {
    app.use("*", middleware);
  }

  app.notFound(() =>
    jsonError("Route not found", { code: "NOT_FOUND", status: 404 })
  );

  app.onError(handleRouteError);

  for (const route of options.routes ?? []) {
    app.route(route.basePath ?? "/", route.routes);
  }

  return app;
};

export const routeModule = <TEnv extends VokeEnv>(
  routes: Hono<TEnv>,
  options: { basePath?: string } = {}
): ApiRouteModule<TEnv> => ({
  basePath: options.basePath,
  routes,
});
