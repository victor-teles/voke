import type { Context } from "hono";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";

import type { VokeConfig } from "./config";

export interface VokeBindings {
  event?: LambdaEvent;
  lambdaContext?: LambdaContext;
  VOKE_AWS_EVENT?: LambdaEvent;
  VOKE_AWS_CONTEXT?: LambdaContext;
  VOKE_CONFIG?: VokeConfig;
}

export interface VokeEnv {
  Bindings: VokeBindings;
}

export const awsEvent = (c: Context<VokeEnv>): LambdaEvent | undefined =>
  c.env.event ?? c.env.VOKE_AWS_EVENT;

export const awsContext = (c: Context<VokeEnv>): LambdaContext | undefined =>
  c.env.lambdaContext ?? c.env.VOKE_AWS_CONTEXT;

export const requestId = (c: Context<VokeEnv>): string | undefined =>
  awsContext(c)?.awsRequestId;
