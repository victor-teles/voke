export interface AwsClientConfig {
  region: string;
  endpoint?: string;
}

export {
  dynamodbTable,
  eventBus,
  s3Bucket,
  secret,
  snsTopic,
  sqsQueue,
  ssmParameter,
  type StackResourceDefinition,
} from "./cloudformation-synthesis";

export interface ResourceBinding<TValue extends string = string> {
  name: string;
  attribute: string;
  envName: string;
  value: () => TValue;
}

class VokeResourceBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VokeResourceBindingError";
  }
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
