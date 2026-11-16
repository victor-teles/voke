export interface AwsClientConfig {
  region: string;
  endpoint?: string;
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

/**
 * Config for every AWS SDK client: `new SQSClient(createAwsClientConfig())`. Under a Local AWS
 * Provider it sets an explicit `endpoint`, which is a safety guarantee, not a convenience: SQS queue
 * URLs carry the real AWS host (`https://sqs.<region>.amazonaws.com/...`), and a client without an
 * explicit endpoint sends queue calls to that host, that is, to real AWS.
 */
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
