import type {
  FunctionSynthesisConfig,
  InvokeContext,
  StandardSchemaV1,
} from "./invoke";
import type { RuntimeVariableCatalog } from "./variables";

export type AuthorizerIdentitySource = string | readonly string[];

export interface JwtAuthorizerDefinition {
  readonly audience: readonly string[];
  readonly identitySource: readonly string[];
  readonly issuer: string;
  readonly kind: "jwt";
}

export interface LambdaAuthorizerDefinition {
  readonly cacheTtlSeconds: number;
  readonly function: LambdaAuthorizerTarget;
  readonly identitySource: readonly string[];
  readonly kind: "lambda";
}

export type LambdaAuthorizerTarget =
  | string
  | {
      readonly arn: string;
    }
  | {
      readonly deployedName: string;
    };

export type HttpAuthorizerDefinition =
  | JwtAuthorizerDefinition
  | LambdaAuthorizerDefinition;

export interface AuthorizerRequest {
  readonly headers: Headers;
  readonly raw: Request;
  readonly request: Request;
}

export interface AuthorizerResult<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly authorized: boolean;
  readonly context?: TContext;
}

export type RequestAuthorizerHandler<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> = (
  request: AuthorizerRequest,
  context: InvokeContext<TVariables>
) => AuthorizerResult<TContext> | Promise<AuthorizerResult<TContext>>;

export interface RequestAuthorizerFunctionInput<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> {
  readonly context?: StandardSchemaV1<unknown, TContext>;
  readonly handler: RequestAuthorizerHandler<TContext, TVariables>;
  readonly name?: string;
  readonly synthesis?: FunctionSynthesisConfig;
  readonly variables?: TVariables;
}

export interface RequestAuthorizerFunctionDefinition<
  TKey extends string = string,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> {
  readonly context?: StandardSchemaV1<unknown, TContext>;
  readonly handler: RequestAuthorizerHandler<TContext, TVariables>;
  readonly key: TKey;
  readonly kind: "authorizer";
  readonly name?: string;
  readonly routes: readonly [];
  readonly synthesis?: RequestAuthorizerFunctionInput<TContext>["synthesis"];
  readonly variables?: TVariables;
}

export type AuthorizerRegistryInput = Record<string, HttpAuthorizerDefinition>;

export type AuthorizerRegistry<
  TAuthorizers extends AuthorizerRegistryInput = AuthorizerRegistryInput,
> = {
  readonly [TKey in keyof TAuthorizers]: TAuthorizers[TKey];
};

export interface JwtAuthorizerInput {
  readonly audience: string | readonly string[];
  readonly identitySource?: AuthorizerIdentitySource;
  readonly issuer: string;
}

export interface LambdaAuthorizerInput {
  readonly cacheTtlSeconds?: number;
  readonly function: LambdaAuthorizerTarget;
  readonly identitySource?: AuthorizerIdentitySource;
}

const defaultIdentitySource = "$request.header.Authorization";

const toIdentitySources = (
  identitySource: AuthorizerIdentitySource | undefined
): readonly string[] => {
  if (identitySource === undefined) {
    return Object.freeze([defaultIdentitySource]);
  }

  if (typeof identitySource === "string") {
    return Object.freeze([identitySource]);
  }

  return Object.freeze([...identitySource]);
};

export const jwtAuthorizer = (
  input: JwtAuthorizerInput
): JwtAuthorizerDefinition =>
  Object.freeze({
    audience: Object.freeze(
      Array.isArray(input.audience) ? [...input.audience] : [input.audience]
    ),
    identitySource: toIdentitySources(input.identitySource),
    issuer: input.issuer,
    kind: "jwt" as const,
  });

export const lambdaAuthorizer = (
  input: LambdaAuthorizerInput
): LambdaAuthorizerDefinition =>
  Object.freeze({
    cacheTtlSeconds: input.cacheTtlSeconds ?? 0,
    function: input.function,
    identitySource: toIdentitySources(input.identitySource),
    kind: "lambda" as const,
  });

export const createAuthorizers = <
  const TAuthorizers extends AuthorizerRegistryInput,
>(
  authorizers: TAuthorizers
): AuthorizerRegistry<TAuthorizers> => Object.freeze({ ...authorizers });

export const requestAuthorizer = <
  const TContext extends Record<string, unknown> = Record<string, unknown>,
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
>(
  input: RequestAuthorizerFunctionInput<TContext, TVariables>
): RequestAuthorizerFunctionDefinition<string, TContext, TVariables> =>
  Object.freeze({
    context: input.context,
    handler: input.handler,
    key: "",
    kind: "authorizer" as const,
    name: input.name,
    routes: Object.freeze([]) as readonly [],
    synthesis: input.synthesis,
    variables: input.variables,
  });
