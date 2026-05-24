import { createResourceBindingName } from "./bindings";
import { VokeResourceBindingError } from "./errors";

export { parameter, secret } from "./aws-runtime-variables";

export interface AwsClientConfig {
  region: string;
  endpoint?: string;
}

export interface ResourceBinding<TValue extends string = string> {
  name: string;
  attribute: string;
  envName: string;
  value: () => TValue;
}

export const bindResource = <TValue extends string = string>(
  name: string,
  attribute: string
): ResourceBinding<TValue> => {
  const envName = createResourceBindingName(name, attribute);

  return {
    attribute,
    envName,
    name,
    value: () => {
      const value = Bun.env[envName];

      if (value === undefined || value === "") {
        throw new VokeResourceBindingError(
          `Missing AWS resource binding: ${envName}`
        );
      }

      return value as TValue;
    },
  };
};

export const createAwsClientConfig = (
  options: Partial<AwsClientConfig> = {}
): AwsClientConfig => {
  const endpoint =
    options.endpoint ??
    Bun.env.VOKE_AWS_ENDPOINT_URL ??
    Bun.env.AWS_ENDPOINT_URL;

  return {
    region:
      options.region ??
      Bun.env.AWS_REGION ??
      Bun.env.AWS_DEFAULT_REGION ??
      "us-east-1",
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
  };
};

export { createResourceBindingName };
export { toEnvKey } from "./env-key";
