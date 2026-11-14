import { handle } from "hono/aws-lambda";
import type {
  APIGatewayProxyResult,
  LambdaContext,
  LambdaEvent,
} from "hono/aws-lambda";
import type { RouteAuthContext } from "voke";

export type AwsLambdaHttpApiV2Event = LambdaEvent;
export type AwsLambdaContext = LambdaContext;
export type AwsLambdaHttpApiV2Result = APIGatewayProxyResult;

export type HonoLikeApp = Pick<Parameters<typeof handle>[0], "fetch">;

export interface LambdaRequestOptions {
  origin?: string;
}

export const createAwsLambdaHandler = (
  app: HonoLikeApp
): ReturnType<typeof handle> => handle(app as Parameters<typeof handle>[0]);

export const handleAwsLambdaRequest = (
  app: HonoLikeApp,
  event: LambdaEvent,
  context?: Partial<LambdaContext>
): Promise<APIGatewayProxyResult> =>
  handle(app as Parameters<typeof handle>[0])(event, context as LambdaContext);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The authorization result API Gateway attached to a request it already authorized. `env.event` is
 * set only by `createAwsLambdaHandler` (hono/aws-lambda), so requests from `voke dev` or
 * `gateway.request(...)` never carry one and keep local authorizer evaluation.
 */
export const awsRouteAuth = ({
  env,
}: {
  env: unknown;
}): RouteAuthContext | undefined => {
  const authorizer =
    isRecord(env) && isRecord(env.event) && isRecord(env.event.requestContext)
      ? env.event.requestContext.authorizer
      : undefined;

  if (!isRecord(authorizer)) {
    return undefined;
  }

  if (isRecord(authorizer.lambda)) {
    return { context: authorizer.lambda, source: "lambda" };
  }

  if (isRecord(authorizer.jwt) && isRecord(authorizer.jwt.claims)) {
    return { context: authorizer.jwt.claims, source: "jwt" };
  }

  return undefined;
};
