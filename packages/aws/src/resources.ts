import { VokeResourceBindingError } from "voke";

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

export const toEnvKey = (value: string): string =>
  value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll(/[^A-Za-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .toUpperCase();

export const createResourceBindingName = (
  name: string,
  attribute: string
): string => `VOKE_RESOURCE_${toEnvKey(name)}_${toEnvKey(attribute)}`;

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
      const value = process.env[envName];

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
    process.env.VOKE_AWS_ENDPOINT_URL ??
    process.env.AWS_ENDPOINT_URL;
  const region =
    [
      options.region,
      process.env.AWS_REGION,
      process.env.AWS_DEFAULT_REGION,
    ].find((value) => value !== undefined && value !== "") ?? "us-east-1";

  return {
    region,
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
  };
};
