import type { VokeBuildConfig, VokeConfig } from "./config";
import type {
  FunctionRegistry,
  FunctionRegistryInput,
  InvokeTransport,
  RouteAuthContext,
} from "./invoke";
import type { VokeModel, VokeModelRecord } from "./model";
import type { RuntimeVariableProvider } from "./variables";

export interface ProviderExtensionRecord {
  provider: string;
  type: string;
  properties: VokeModelRecord;
}

export interface ProviderRuntimeCapability {
  /**
   * Returns the authorization result the platform already established for this request (for
   * example an API Gateway authorizer), or undefined to evaluate the route's authorizer locally.
   * `env` is the Gateway request's Hono env, set by the Provider's own runtime adapter.
   */
  routeAuth?: (input: { env: unknown }) => RouteAuthContext | undefined;
  /** Runtime Variable providers this Provider supplies to every activated Function Registry. */
  variables?: () => readonly RuntimeVariableProvider[];
}

export interface ProviderInvokeCapability {
  transport?: () => InvokeTransport;
}

export interface BuildPlanOutput {
  /** The bundle file this entrypoint produces. */
  file: string;
}

export interface BuildPlanFunction {
  /** The bundle file that contains the Function's Lambda handler. */
  file: string;
  /** The Lambda handler string, `<module>.<export>`. */
  handler: string;
}

export interface BuildPlan {
  /** The bundler command to run from the project directory. */
  command: string[];
  /** Bundle entrypoints, in the order passed to the bundler. */
  entrypoints: string[];
  /** Files to write after the bundler succeeds, keyed by path. */
  files: Record<string, string>;
  /** Where each Function's Lambda handler lives in the build output, keyed by registry key. */
  manifest: { functions: Record<string, BuildPlanFunction> };
  outdir: string;
  outputs: Record<string, BuildPlanOutput>;
  /** Generated source files to write before the bundler runs, keyed by path. */
  sources: Record<string, string>;
}

export interface ProviderBuildInput {
  build: VokeBuildConfig;
  config: VokeConfig;
  /** The project entrypoint that declares the Functions. */
  entrypoint: string;
  functions: FunctionRegistry | FunctionRegistryInput;
}

export interface ProviderBuildCapability {
  plan?: (input: ProviderBuildInput) => BuildPlan;
}

export interface ProviderSynthesisCapability<TArtifact = unknown> {
  synthesize?: (input: { config: VokeConfig; model: VokeModel }) => TArtifact;
}

export interface ProviderLocalCapability<TWorkflow = unknown> {
  devEnvironment?: (input: {
    config: VokeConfig;
    endpoint?: string;
    model: VokeModel;
    region: string;
    stage: string;
  }) => Record<string, string>;
  workflow?: (input: { config: VokeConfig; model: VokeModel }) => TWorkflow;
}

export interface VokeProvider {
  build?: ProviderBuildCapability;
  invoke?: ProviderInvokeCapability;
  local?: ProviderLocalCapability;
  name: string;
  runtime?: ProviderRuntimeCapability;
  synthesis?: ProviderSynthesisCapability;
  validate?: (model: VokeModel) => void;
}

export type VokeProviderCapability =
  | ProviderBuildCapability
  | ProviderInvokeCapability
  | ProviderLocalCapability
  | ProviderRuntimeCapability
  | ProviderSynthesisCapability;
