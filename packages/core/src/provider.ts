import type { BuildPlan } from "./build";
import type { VokeBuildConfig, VokeConfig } from "./config";
import type { InvokeTransport } from "./invoke";
import type { VokeModel, VokeModelRecord } from "./model";
import type { RuntimeVariableProvider } from "./variables";

export interface ProviderExtensionRecord {
  provider: string;
  type: string;
  properties: VokeModelRecord;
}

export interface ProviderRuntimeCapability<TGatewayExtension = object> {
  gateway?: (input: {
    app: { fetch: (request: Request) => Response | Promise<Response> };
    config: VokeConfig;
  }) => TGatewayExtension;
  /** Runtime Variable providers this Provider supplies to every activated Function Registry. */
  variables?: () => readonly RuntimeVariableProvider[];
}

export interface ProviderInvokeCapability {
  transport?: () => InvokeTransport;
}

export interface ProviderBuildCapability {
  plan?: (input: { build: VokeBuildConfig; config: VokeConfig }) => BuildPlan;
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

export interface VokeProvider<TGatewayExtension = object> {
  build?: ProviderBuildCapability;
  invoke?: ProviderInvokeCapability;
  local?: ProviderLocalCapability;
  name: string;
  runtime?: ProviderRuntimeCapability<TGatewayExtension>;
  synthesis?: ProviderSynthesisCapability;
  validate?: (model: VokeModel) => void;
}

export type VokeProviderCapability =
  | ProviderBuildCapability
  | ProviderInvokeCapability
  | ProviderLocalCapability
  | ProviderRuntimeCapability
  | ProviderSynthesisCapability;
