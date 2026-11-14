import { handle } from "hono/aws-lambda";
import type {
  APIGatewayProxyResult,
  LambdaContext,
  LambdaEvent,
} from "hono/aws-lambda";

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
