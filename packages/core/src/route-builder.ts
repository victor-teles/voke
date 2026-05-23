import type { MiddlewareHandler } from "hono";

import type { VokeEnv } from "./context";
import type {
  RouteDefinition,
  RouteDefinitionInput,
  RouteMethod,
  StandardSchemaV1,
} from "./invoke";

type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

export class Voke {
  readonly #middleware: MiddlewareHandler<VokeEnv>[] = [];

  use(middleware: MiddlewareHandler<VokeEnv>): this {
    this.#middleware.push(middleware);

    return this;
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
      TResult
    >
  ): RouteDefinition<
    "DELETE",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult
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
      TResult
    >
  ): RouteDefinition<
    "GET",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult
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
      TResult
    >
  ): RouteDefinition<
    "HEAD",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult
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
      TResult
    >
  ): RouteDefinition<
    "OPTIONS",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult
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
      TResult
    >
  ): RouteDefinition<
    "PATCH",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult
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
      TResult
    >
  ): RouteDefinition<
    "POST",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult
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
      TResult
    >
  ): RouteDefinition<
    "PUT",
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult
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
      TResult
    >
  ): RouteDefinition<
    TMethod,
    TPath,
    TBodySchema,
    TParamsSchema,
    TQuerySchema,
    THeadersSchema,
    TOutputSchema,
    TResult
  > {
    return {
      ...definition,
      method,
      middleware: [...this.#middleware],
      path,
    };
  }
}
