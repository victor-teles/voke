import { aws } from "@voke/aws";
import type { LocalProvider } from "@voke/aws/local";

import { voke } from "../src/app";
import type { VokeConfigInput } from "../src/config";
import type { FunctionRegistry } from "../src/invoke";

declare const assertConfigInput: (config: VokeConfigInput) => void;

const customProvider: LocalProvider = {
  bootstrapPlan: ({ environment }) => ({
    commands: [],
    environment,
  }),
  composeConfig: () => "",
  defaults: {
    accountId: "111111111111",
    endpoint: "http://localhost:9999",
    region: "us-west-2",
  },
  environment: () => ({
    AWS_ACCESS_KEY_ID: "custom",
    AWS_DEFAULT_REGION: "us-west-2",
    AWS_ENDPOINT_URL: "http://localhost:9999",
    AWS_REGION: "us-west-2",
    AWS_SECRET_ACCESS_KEY: "custom",
    AWS_SESSION_TOKEN: "custom",
    VOKE_AWS_ENDPOINT_URL: "http://localhost:9999",
    VOKE_INVOKE_RUNTIME: "local",
    VOKE_LOCAL_PROVIDER: "custom-local-aws",
  }),
  name: "custom-local-aws",
  resetCommand: () => [],
  startCommand: () => [],
  stopCommand: () => [],
};

assertConfigInput({
  name: "node-runtime-api",
  runtime: {
    lambda: "nodejs22.x",
  },
});

assertConfigInput({
  name: "new-node-runtime-api",
  runtime: {
    lambda: "nodejs24.x",
  },
});

assertConfigInput({
  name: "unsupported-runtime-api",
  runtime: {
    // @ts-expect-error Voke only supports nodejs22.x and nodejs24.x.
    lambda: "nodejs20.x",
  },
});

assertConfigInput({
  name: "non-node-runtime-api",
  runtime: {
    // @ts-expect-error Voke only supports nodejs22.x and nodejs24.x.
    lambda: "python3.12",
  },
});

// The Local AWS Provider is an AWS Provider option: aws({ local }).
assertConfigInput({
  name: "floci-local-api",
  provider: aws(),
});

assertConfigInput({
  name: "custom-local-provider-api",
  provider: aws({ local: customProvider }),
});

assertConfigInput({
  // @ts-expect-error local settings moved to aws({ local }).
  local: { provider: customProvider },
  name: "core-local-api",
});

assertConfigInput({
  build: {
    external: [],
  },
  name: "bundled-sdk-api",
});

assertConfigInput({
  build: {
    // @ts-expect-error Voke always builds an ESM bundle for the Lambda Node.js runtime.
    target: "bun",
  },
  name: "removed-build-target-api",
});

// ADR 0007: Functions are declared in the project entrypoint and Voke generates the Lambda
// handlers, so these config keys no longer exist.
assertConfigInput({
  // @ts-expect-error Functions are declared in the project entrypoint, not in voke.config.ts.
  functions: {},
  name: "config-first-registry",
});

assertConfigInput({
  // @ts-expect-error The Lambda handler is generated per Function.
  handler: "index.handler",
  name: "top-level-handler",
});

assertConfigInput({
  cloudFormation: {
    // @ts-expect-error The Lambda handler is generated per Function.
    handler: "index.handler",
  },
  name: "cloudformation-handler",
});

assertConfigInput({
  api: {
    // @ts-expect-error HTTP routes come from route-backed Functions.
    routes: ["$default"],
  },
  name: "api-routes",
});

assertConfigInput({
  api: {
    // @ts-expect-error The single-function API mode was removed.
    function: "api",
  },
  name: "api-function",
});

// The Provider is configured in voke.config.ts only (`provider: aws()`), never on voke().
declare const providerFunctions: FunctionRegistry;
voke(providerFunctions, {
  config: { name: "provider-in-config", provider: { name: "test" } },
});
voke(providerFunctions, {
  config: { name: "provider-on-voke" },
  // @ts-expect-error Set the Provider in config: voke(functions, { config: { provider } }).
  provider: { name: "test" },
});

// One spelling per setting: resources and environment are top-level; cloudFormation holds only `out`.
assertConfigInput({
  cloudFormation: { out: "./dist/stack.json" },
  environment: { LOG_LEVEL: "info" },
  name: "top-level-resources",
  resources: {},
});

assertConfigInput({
  cloudFormation: {
    // @ts-expect-error Declare resources at the top level.
    resources: {},
  },
  name: "nested-resources",
});
