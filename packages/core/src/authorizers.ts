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
  TResource extends string = string,
> = (
  request: AuthorizerRequest,
  context: InvokeContext<TVariables, TResource>
) => AuthorizerResult<TContext> | Promise<AuthorizerResult<TContext>>;

export interface RequestAuthorizerFunctionInput<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
  TResources extends readonly string[] = readonly string[],
> {
  readonly context?: StandardSchemaV1<unknown, TContext>;
  readonly handler: RequestAuthorizerHandler<
    TContext,
    TVariables,
    TResources[number]
  >;
  readonly name?: string;
  /** Resource Links: the resource keys this Function reads through `context.resource`. */
  readonly resources?: TResources;
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
  readonly resources?: readonly string[];
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
