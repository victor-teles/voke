import type {
  AuthorizerIdentitySource,
  AuthorizerRegistry,
  AuthorizerRegistryInput,
  JwtAuthorizerDefinition,
  JwtAuthorizerInput,
  LambdaAuthorizerDefinition,
  LambdaAuthorizerInput,
  RequestAuthorizerFunctionDefinition,
  RequestAuthorizerFunctionInput,
  RuntimeVariableCatalog,
} from "voke";

export type {
  AuthorizerIdentitySource,
  AuthorizerRegistry,
  AuthorizerRegistryInput,
  AuthorizerRequest,
  AuthorizerResult,
  HttpAuthorizerDefinition,
  JwtAuthorizerDefinition,
  JwtAuthorizerInput,
  LambdaAuthorizerDefinition,
  LambdaAuthorizerInput,
  LambdaAuthorizerTarget,
  RequestAuthorizerFunctionDefinition,
  RequestAuthorizerFunctionInput,
  RequestAuthorizerHandler,
} from "voke";

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
