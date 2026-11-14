import type { MiddlewareHandler } from "hono";

import type { VokeEnv } from "./context";
import type {
  RouteDefinition,
  RouteDefinitionInput,
  RouteMethod,
  StandardSchemaV1,
} from "./invoke";
import type { RuntimeVariableCatalog } from "./variables";

type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

export class Voke<
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> {
  readonly #middleware: readonly MiddlewareHandler<VokeEnv>[];

  constructor(middleware: readonly MiddlewareHandler<VokeEnv>[] = []) {
    this.#middleware = Object.freeze([...middleware]);
  }

  use(middleware: MiddlewareHandler<VokeEnv>): Voke<TVariables> {
    return new Voke([...this.#middleware, middleware]);
  }

  delete<
    const TPath extends string,
    const TBodySchema extends AnyStandardSchema | undefined = undefined,
    const TParamsSchema extends AnyStandardSchema | undefined = undefined,
    const TQuerySchema extends AnyStandardSchema | undefined = undefined,
    const THeadersSchema extends AnyStandardSchema | undefined = undefined,
    const TOutputSchema extends AnyStandardSchema | undefined = undefined,
    const TResult = unknown,
  >(
    path: TPath,
    definition: RouteDefinitionInput<
      "DELETE",
      TPath,
      TBodySchema,
      TParamsSchema,
      TQuerySchema,
      THeadersSchema,
      TOutputSchema,
      TResult,
      TVariables
    >
  ): RouteDefinition<
    "DELETE",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult,
    TVariables
  > {
    return this.route("DELETE", path, definition);
  }

  get<
    const TPath extends string,
    const TBodySchema extends AnyStandardSchema | undefined = undefined,
    const TParamsSchema extends AnyStandardSchema | undefined = undefined,
    const TQuerySchema extends AnyStandardSchema | undefined = undefined,
    const THeadersSchema extends AnyStandardSchema | undefined = undefined,
    const TOutputSchema extends AnyStandardSchema | undefined = undefined,
    const TResult = unknown,
  >(
    path: TPath,
    definition: RouteDefinitionInput<
      "GET",
      TPath,
      TBodySchema,
      TParamsSchema,
      TQuerySchema,
      THeadersSchema,
      TOutputSchema,
      TResult,
      TVariables
    >
  ): RouteDefinition<
    "GET",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult,
    TVariables
  > {
    return this.route("GET", path, definition);
  }

  head<
    const TPath extends string,
    const TBodySchema extends AnyStandardSchema | undefined = undefined,
    const TParamsSchema extends AnyStandardSchema | undefined = undefined,
    const TQuerySchema extends AnyStandardSchema | undefined = undefined,
    const THeadersSchema extends AnyStandardSchema | undefined = undefined,
    const TOutputSchema extends AnyStandardSchema | undefined = undefined,
    const TResult = unknown,
  >(
    path: TPath,
    definition: RouteDefinitionInput<
      "HEAD",
      TPath,
      TBodySchema,
      TParamsSchema,
      TQuerySchema,
      THeadersSchema,
      TOutputSchema,
      TResult,
      TVariables
    >
  ): RouteDefinition<
    "HEAD",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult,
    TVariables
  > {
    return this.route("HEAD", path, definition);
  }

  options<
    const TPath extends string,
    const TBodySchema extends AnyStandardSchema | undefined = undefined,
    const TParamsSchema extends AnyStandardSchema | undefined = undefined,
    const TQuerySchema extends AnyStandardSchema | undefined = undefined,
    const THeadersSchema extends AnyStandardSchema | undefined = undefined,
    const TOutputSchema extends AnyStandardSchema | undefined = undefined,
    const TResult = unknown,
  >(
    path: TPath,
    definition: RouteDefinitionInput<
      "OPTIONS",
      TPath,
      TBodySchema,
      TParamsSchema,
      TQuerySchema,
      THeadersSchema,
      TOutputSchema,
      TResult,
      TVariables
    >
  ): RouteDefinition<
    "OPTIONS",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult,
    TVariables
  > {
    return this.route("OPTIONS", path, definition);
  }

  patch<
    const TPath extends string,
    const TBodySchema extends AnyStandardSchema | undefined = undefined,
    const TParamsSchema extends AnyStandardSchema | undefined = undefined,
    const TQuerySchema extends AnyStandardSchema | undefined = undefined,
    const THeadersSchema extends AnyStandardSchema | undefined = undefined,
    const TOutputSchema extends AnyStandardSchema | undefined = undefined,
    const TResult = unknown,
  >(
    path: TPath,
    definition: RouteDefinitionInput<
      "PATCH",
      TPath,
      TBodySchema,
      TParamsSchema,
      TQuerySchema,
      THeadersSchema,
      TOutputSchema,
      TResult,
      TVariables
    >
  ): RouteDefinition<
    "PATCH",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult,
    TVariables
  > {
    return this.route("PATCH", path, definition);
  }

  post<
    const TPath extends string,
    const TBodySchema extends AnyStandardSchema | undefined = undefined,
    const TParamsSchema extends AnyStandardSchema | undefined = undefined,
    const TQuerySchema extends AnyStandardSchema | undefined = undefined,
    const THeadersSchema extends AnyStandardSchema | undefined = undefined,
    const TOutputSchema extends AnyStandardSchema | undefined = undefined,
    const TResult = unknown,
  >(
    path: TPath,
    definition: RouteDefinitionInput<
      "POST",
      TPath,
      TBodySchema,
      TParamsSchema,
      TQuerySchema,
      THeadersSchema,
      TOutputSchema,
      TResult,
      TVariables
    >
  ): RouteDefinition<
    "POST",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult,
    TVariables
  > {
    return this.route("POST", path, definition);
  }

  put<
    const TPath extends string,
    const TBodySchema extends AnyStandardSchema | undefined = undefined,
    const TParamsSchema extends AnyStandardSchema | undefined = undefined,
    const TQuerySchema extends AnyStandardSchema | undefined = undefined,
    const THeadersSchema extends AnyStandardSchema | undefined = undefined,
    const TOutputSchema extends AnyStandardSchema | undefined = undefined,
    const TResult = unknown,
  >(
    path: TPath,
    definition: RouteDefinitionInput<
      "PUT",
      TPath,
      TBodySchema,
      TParamsSchema,
      TQuerySchema,
      THeadersSchema,
      TOutputSchema,
      TResult,
      TVariables
    >
  ): RouteDefinition<
    "PUT",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult,
    TVariables
  > {
    return this.route("PUT", path, definition);
  }

  route<
    const TMethod extends RouteMethod,
    const TPath extends string,
    const TBodySchema extends AnyStandardSchema | undefined = undefined,
    const TParamsSchema extends AnyStandardSchema | undefined = undefined,
    const TQuerySchema extends AnyStandardSchema | undefined = undefined,
    const THeadersSchema extends AnyStandardSchema | undefined = undefined,
    const TOutputSchema extends AnyStandardSchema | undefined = undefined,
    const TResult = unknown,
  >(
    method: TMethod,
    path: TPath,
    definition: RouteDefinitionInput<
      TMethod,
      TPath,
      TBodySchema,
      TParamsSchema,
      TQuerySchema,
      THeadersSchema,
      TOutputSchema,
      TResult,
      TVariables
    >
  ): RouteDefinition<
    TMethod,
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult,
    TVariables
  > {
    if (
      (method === "GET" || method === "HEAD") &&
      definition.body !== undefined
    ) {
      throw new Error(`${method} ${path} cannot define a body schema`);
    }

    return {
      ...definition,
      method,
      middleware: Object.freeze([
        ...this.#middleware,
        ...(definition.middleware ?? []),
      ]),
      path,
    };
  }
}

export const route = Object.freeze(new Voke());
