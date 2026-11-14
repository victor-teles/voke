import type {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  createVariableProvider,
  createVariableSource,
  VokeRuntimeVariableError,
} from "voke";
import type { RuntimeVariableOptions, RuntimeVariableProvider } from "voke";

import { createResourceBindingName } from "./resources";

export const awsRuntimeVariableProviderId = "aws";

interface AwsVariableBuilderOptions {
  readonly decrypt?: boolean;
}

type AwsRuntimeVariableSource =
  | {
      readonly kind: "secretsManagerSecret";
      readonly secretId: string;
    }
  | {
      readonly kind: "secretsManagerSecretResource";
      readonly resource: string;
    }
  | {
      readonly decrypt: boolean;
      readonly kind: "ssmParameter";
      readonly name: string;
    }
  | {
      readonly decrypt: boolean;
      readonly kind: "ssmParameterResource";
      readonly resource: string;
    };

const awsSecretSource = (secretId: string, options?: RuntimeVariableOptions) =>
  createVariableSource(
    awsRuntimeVariableProviderId,
    {
      kind: "secretsManagerSecret",
      secretId,
    },
    options
  );

const awsParameterSource = (
  name: string,
  builderOptions: AwsVariableBuilderOptions = {},
  options?: RuntimeVariableOptions
) =>
  createVariableSource(
    awsRuntimeVariableProviderId,
    {
      decrypt: builderOptions.decrypt ?? true,
      kind: "ssmParameter",
      name,
    },
    options
  );

export const secret = Object.assign(awsSecretSource, {
  fromResource: (resource: string, options?: RuntimeVariableOptions) =>
    createVariableSource(
      awsRuntimeVariableProviderId,
      {
        kind: "secretsManagerSecretResource",
        resource,
      },
      options
    ),
});

export const parameter = Object.assign(awsParameterSource, {
  fromResource: (
    resource: string,
    builderOptions: AwsVariableBuilderOptions = {},
    options?: RuntimeVariableOptions
  ) =>
    createVariableSource(
      awsRuntimeVariableProviderId,
      {
        decrypt: builderOptions.decrypt ?? true,
        kind: "ssmParameterResource",
        resource,
      },
      options
    ),
});

const isMissingAwsValue = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "ParameterNotFound" ||
    error.name === "ResourceNotFoundException");

const secretIdFromSource = (
  source: Extract<
    AwsRuntimeVariableSource,
    {
      readonly kind: "secretsManagerSecret" | "secretsManagerSecretResource";
    }
  >
): string => {
  if (source.kind === "secretsManagerSecret") {
    return source.secretId;
  }

  return process.env[createResourceBindingName(source.resource, "id")] ?? "";
};

const parameterNameFromSource = (
  source: Extract<
    AwsRuntimeVariableSource,
    { readonly kind: "ssmParameter" | "ssmParameterResource" }
  >
): string => {
  if (source.kind === "ssmParameter") {
    return source.name;
  }

  return process.env[createResourceBindingName(source.resource, "name")] ?? "";
};

const createSecretsManager = async () => {
  const sdk = await import("@aws-sdk/client-secrets-manager");

  return {
    GetSecretValueCommand: sdk.GetSecretValueCommand,
    client: new sdk.SecretsManagerClient({}),
  };
};
const createSsm = async () => {
  const sdk = await import("@aws-sdk/client-ssm");

  return {
    GetParameterCommand: sdk.GetParameterCommand,
    client: new sdk.SSMClient({}),
  };
};

export const createAwsRuntimeVariableProvider = (): RuntimeVariableProvider => {
  // The SDKs load on first use, so importing @voke/aws or activating a Gateway stays cheap,
  // and bundles keep @aws-sdk/* external (the Lambda Node.js runtime provides it).
  let secretsManager:
    | Promise<{
        client: SecretsManagerClient;
        GetSecretValueCommand: typeof GetSecretValueCommand;
      }>
    | undefined;
  let ssm:
    | Promise<{
        client: SSMClient;
        GetParameterCommand: typeof GetParameterCommand;
      }>
    | undefined;
  const loadSecretsManager = () => {
    secretsManager ??= createSecretsManager();

    return secretsManager;
  };
  const loadSsm = () => {
    ssm ??= createSsm();

    return ssm;
  };

  return createVariableProvider({
    id: awsRuntimeVariableProviderId,
    load: async ({ source }) => {
      const awsSource = source as AwsRuntimeVariableSource;

      try {
        if (
          awsSource.kind === "secretsManagerSecret" ||
          awsSource.kind === "secretsManagerSecretResource"
        ) {
          const secrets = await loadSecretsManager();
          const result = await secrets.client.send(
            new secrets.GetSecretValueCommand({
              SecretId: secretIdFromSource(awsSource),
            })
          );

          if (
            typeof result === "object" &&
            result !== null &&
            "SecretString" in result &&
            typeof result.SecretString === "string"
          ) {
            return { status: "found", value: result.SecretString };
          }

          throw new VokeRuntimeVariableError(
            "AWS Secrets Manager binary-only secrets are not supported by Runtime Variables."
          );
        }

        const parameters = await loadSsm();
        const result = await parameters.client.send(
          new parameters.GetParameterCommand({
            Name: parameterNameFromSource(awsSource),
            WithDecryption: awsSource.decrypt,
          })
        );

        if (
          typeof result === "object" &&
          result !== null &&
          "Parameter" in result &&
          typeof result.Parameter === "object" &&
          result.Parameter !== null &&
          "Value" in result.Parameter &&
          typeof result.Parameter.Value === "string"
        ) {
          return { status: "found", value: result.Parameter.Value };
        }

        return { status: "missing" };
      } catch (error) {
        if (isMissingAwsValue(error)) {
          return { status: "missing" };
        }

        throw error;
      }
    },
  });
};
