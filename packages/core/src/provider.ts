import type { VokeBuildConfig, VokeConfig } from "./config";
import type {
  AnyFunctionDefinition,
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

/** Where the Provider invokes a Function it routes through its transport. */
export interface ProviderInvokeTarget {
  /** The name the transport invokes, such as a qualified deployed name. */
  functionName: string;
}

export interface ProviderInvokeCapability {
  /**
   * Whether the Function accepts `executionName`. A routed invocation passes the name to the
   * transport; an in-process run of an accepting Function ignores it. Any other Function rejects
   * it with `INVALID_OPTIONS`.
   */
  acceptsExecutionName?: (input: {
    definition: AnyFunctionDefinition;
    key: string;
  }) => boolean;
  transport?: () => InvokeTransport;
  /**
   * Returns a target when this Function must be invoked through `transport()` instead of
   * in-process; undefined keeps the default path. Not consulted when the caller sets
   * `runtime` explicitly.
   */
  target?: (input: {
    definition: AnyFunctionDefinition;
    key: string;
  }) => ProviderInvokeTarget | undefined;
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

export interface ProviderDeployInput {
  config: VokeConfig;
  model: VokeModel;
  /** Build output directory produced by the Provider build plan. */
  artifactDirectory: string;
  /** Files in artifactDirectory that belong to the deployable artifact (from the build plan). */
  artifactFiles: readonly string[];
  stage: string;
  /** Opaque Provider region; the Provider applies its own default when absent. */
  region?: string;
  /** Plan the deployment and report the changes without applying them. */
  dryRun: boolean;
  /** The user accepted changes that remove or replace resources holding data. */
  acceptDataLoss: boolean;
  output: (line: string) => void;
}

export interface ProviderDeployResult {
  /** Deployment identifier, for display and the outputs file. */
  id: string;
  region?: string;
  status: "deployed" | "dry-run" | "unchanged";
  /** Provider outputs; "ApiUrl" is printed first when present. */
  outputs: Record<string, string>;
}

export interface ProviderRemoveInput {
  config: VokeConfig;
  stage: string;
  region?: string;
  output: (line: string) => void;
}

/**
 * Deploys a built project and removes a deployed stage. The CLI owns stage resolution, the
 * build, confirmation and the outputs file; the Provider owns everything platform-specific.
 */
export interface ProviderDeployCapability {
  deploy?: (input: ProviderDeployInput) => Promise<ProviderDeployResult>;
  remove?: (
    input: ProviderRemoveInput
  ) => Promise<{ status: "absent" | "removed" }>;
}

export interface ProviderBuildInput {
  build: VokeBuildConfig;
  config: VokeConfig;
  /** The config file the CLI loaded; absent when the config came from flags. */
  configPath?: string;
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

export interface ProviderCommandRunOptions {
  env?: Record<string, string>;
  /** Names removed from the inherited process environment before `env` is applied. */
  unsetEnv?: readonly string[];
}

export type ProviderCommandRunner = (
  command: string[],
  options?: ProviderCommandRunOptions
) => void | Promise<void>;

export interface ProviderLocalDevEnvironment {
  environment: Record<string, string>;
  /** Variables the `voke dev` child must not inherit, such as real cloud credentials. */
  unsetEnvironment?: readonly string[];
}

export interface ProviderLocalWorkflowContext {
  /** Config resolved with the CLI's name, stage and region overrides. */
  config: VokeConfig;
  model: VokeModel;
  /** The `voke local` flags, including the ones the workflow declares in `flags`. */
  options: Readonly<Record<string, string>>;
  run: ProviderCommandRunner;
}

/** The `voke local start|stop|reset|bootstrap` workflow a Provider runs for local development. */
export interface ProviderLocalWorkflow {
  /** Extra `voke local` flags the workflow reads, with a description; others are rejected. */
  flags?: Readonly<Record<string, string>>;
  bootstrap: (context: ProviderLocalWorkflowContext) => Promise<void>;
  reset: (context: ProviderLocalWorkflowContext) => Promise<void>;
  start: (context: ProviderLocalWorkflowContext) => Promise<void>;
  stop: (context: ProviderLocalWorkflowContext) => Promise<void>;
}

export interface ProviderLocalCapability {
  devEnvironment?: (input: {
    config: VokeConfig;
    endpoint?: string;
    model: VokeModel;
    region: string;
    stage: string;
  }) => ProviderLocalDevEnvironment | Promise<ProviderLocalDevEnvironment>;
  workflow?: ProviderLocalWorkflow;
}

export type DiagnosticStatus = "ok" | "warn" | "fail";

/** One `voke doctor` row. `detail` says what was found or how to fix it; never a secret. */
export interface DiagnosticResult {
  check: string;
  detail: string;
  status: DiagnosticStatus;
}

/** Provider checks that `voke doctor` runs after its own, such as credentials and local tools. */
export interface ProviderDiagnosticsCapability {
  run: (input: {
    config: VokeConfig;
    model: VokeModel;
  }) => Promise<DiagnosticResult[]>;
}

export interface VokeProvider {
  build?: ProviderBuildCapability;
  deploy?: ProviderDeployCapability;
  diagnostics?: ProviderDiagnosticsCapability;
  invoke?: ProviderInvokeCapability;
  local?: ProviderLocalCapability;
  name: string;
  runtime?: ProviderRuntimeCapability;
  synthesis?: ProviderSynthesisCapability;
  validate?: (model: VokeModel) => void;
}

export type VokeProviderCapability =
  | ProviderBuildCapability
  | ProviderDeployCapability
  | ProviderDiagnosticsCapability
  | ProviderInvokeCapability
  | ProviderLocalCapability
  | ProviderRuntimeCapability
  | ProviderSynthesisCapability;
