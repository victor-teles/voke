import type { VokeConfigInput } from "../src/config";
import type { LocalProvider } from "../src/local";

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

assertConfigInput({
  local: {
    provider: "floci",
  },
  name: "floci-local-api",
});

assertConfigInput({
  local: {
    provider: customProvider,
  },
  name: "custom-local-provider-api",
});

assertConfigInput({
  local: {
    // @ts-expect-error Local providers must be "floci" or a LocalProvider object.
    provider: "localstack",
  },
  name: "unsupported-local-provider-api",
});
