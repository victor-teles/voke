// Run-time module: bundled into deployed Functions, so it must not import deploy-time code.
// `voke build` resolves `#provider` here through the `voke-runtime` condition; every other
// consumer resolves `./provider.ts`, whose `aws()` adds the deploy-time capabilities.
import type { VokeProvider } from "voke";

import type { AwsRetainData } from "./data-retention";
import { awsRouteAuth } from "./lambda";
import { createAwsInvokeCapability } from "./lambda-invoke-transport";
import type { AwsLambdaOptions } from "./lambda-settings";
import type { LocalProvider } from "./local-provider";
import { createAwsRuntimeVariableProvider } from "./runtime-variables";

export interface AwsProviderOptions {
  /** Lambda settings for every Function: runtime, architecture and log retention. */
  lambda?: AwsLambdaOptions;
  /**
   * The Local AWS Provider for `voke local` and `voke dev`. Defaults to the AWS Emulator,
   * `awsEmulator()`; pass `floci()` from "@voke/aws/local" for Floci.
   */
  local?: LocalProvider;
  /**
   * Whether `voke deploy` keeps tables, buckets and generated secrets when they leave the stack,
   * are replaced, or the stage is removed. Default `true` on every stage. A predicate decides per
   * resource with the resolved stage: `({ stage }) => stage === "prod"`. Local AWS Providers
   * never retain.
   */
  retainData?: AwsRetainData;
}

/** The capabilities a deployed Function reads from the AWS Provider: its name, invocation and runtime. */
export const awsRuntimeCapabilities = (): Pick<
  VokeProvider,
  "invoke" | "name" | "runtime"
> => ({
  invoke: createAwsInvokeCapability(),
  name: "aws",
  runtime: {
    routeAuth: awsRouteAuth,
    variables: () => [createAwsRuntimeVariableProvider()],
  },
});

/**
 * `aws()` as a deployed Function sees it: the run-time capabilities only. The options are accepted
 * and ignored; `voke build` and `voke deploy` already validated them with the full `aws()`.
 */
export const aws = (_options: AwsProviderOptions = {}): VokeProvider =>
  awsRuntimeCapabilities();
