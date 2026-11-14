import { createResourceBindingName } from "./bindings";
import { VokeResourceBindingError } from "./errors";
import { readEnv } from "./runtime-env";

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
      const value = readEnv(envName);

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
    readEnv("VOKE_AWS_ENDPOINT_URL") ??
    readEnv("AWS_ENDPOINT_URL");
  const region =
    [options.region, readEnv("AWS_REGION"), readEnv("AWS_DEFAULT_REGION")].find(
      (value) => value !== undefined && value !== ""
    ) ?? "us-east-1";

  return {
    region,
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
  };
};

export { createResourceBindingName };
export { toEnvKey } from "./env-key";
