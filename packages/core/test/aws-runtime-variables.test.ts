import { expect, mock, test } from "bun:test";

const secretCalls: unknown[] = [];
const parameterCalls: unknown[] = [];
let secretResponse: unknown;
let parameterResponse: unknown;

const GetSecretValueCommand = function GetSecretValueCommand(
  this: { input: unknown },
  input: unknown
) {
  this.input = input;
};

const SecretsManagerClient = function SecretsManagerClient() {};

SecretsManagerClient.prototype.send = (command: {
  input: unknown;
}): Promise<unknown> => {
  secretCalls.push(command.input);

  if (secretResponse instanceof Error) {
    return Promise.resolve({});
  }

  return Promise.resolve(secretResponse);
};

const GetParameterCommand = function GetParameterCommand(
  this: { input: unknown },
  input: unknown
) {
  this.input = input;
};

const SSMClient = function SSMClient() {};

SSMClient.prototype.send = (command: { input: unknown }): Promise<unknown> => {
  parameterCalls.push(command.input);

  if (parameterResponse instanceof Error) {
    return Promise.resolve({});
  }

  return Promise.resolve(parameterResponse);
};

mock.module("@aws-sdk/client-secrets-manager", () => ({
  GetSecretValueCommand,
  SecretsManagerClient,
}));

mock.module("@aws-sdk/client-ssm", () => ({
  GetParameterCommand,
  SSMClient,
}));

test("creates AWS Runtime Variable descriptors for secrets and parameters", async () => {
  const { parameter, secret } = await import("../src/aws");

  const signingSecret = secret("/prod/stripe/key");
  const configParameter = parameter("/prod/app/config");
  const plainParameter = parameter("/prod/plain", { decrypt: false });
  const managedSecret = secret.fromResource("signingSecret");
  const managedParameter = parameter.fromResource("publicConfig");

  expect(signingSecret).toMatchObject({
    kind: "runtimeVariable",
    provider: "aws",
    source: {
      kind: "secretsManagerSecret",
      secretId: "/prod/stripe/key",
    },
  });
  expect(configParameter.source).toMatchObject({
    decrypt: true,
    kind: "ssmParameter",
    name: "/prod/app/config",
  });
  expect(plainParameter.source).toMatchObject({
    decrypt: false,
    kind: "ssmParameter",
    name: "/prod/plain",
  });
  expect(managedSecret.source).toMatchObject({
    kind: "secretsManagerSecretResource",
    resource: "signingSecret",
  });
  expect(managedParameter.source).toMatchObject({
    kind: "ssmParameterResource",
    resource: "publicConfig",
  });
  expect(Object.isFrozen(signingSecret)).toBe(true);
  expect(Object.isFrozen(signingSecret.source)).toBe(true);
});

test("loads AWS secrets and parameters through the automatic provider", async () => {
  secretCalls.length = 0;
  parameterCalls.length = 0;
  secretResponse = { SecretString: "secret-value" };
  parameterResponse = { Parameter: { Value: "parameter-value" } };
  const { createGateway } = await import("../src/app");
  const { defineFunction, defineFunctions } = await import("../src/invoke");
  const { parameter, secret } = await import("../src/aws");

  const functions = defineFunctions({
    readAwsVariables: defineFunction({
      handler: async (_payload, context) =>
        `${await context.variables.apiKey.text()}/${await context.variables.config.text()}`,
      output: {
        "~standard": {
          validate: (value) =>
            typeof value === "string"
              ? { data: value, success: true }
              : { issues: [{ message: "expected string" }], success: false },
          vendor: "voke-test",
          version: 1,
        },
      },
      variables: {
        apiKey: secret("prod/stripe"),
        config: parameter("/prod/config", { decrypt: false }),
      },
    }),
  });
  createGateway({ functions });

  await expect(functions.invoke("readAwsVariables")).resolves.toBe(
    "secret-value/parameter-value"
  );
  expect(secretCalls).toEqual([{ SecretId: "prod/stripe" }]);
  expect(parameterCalls).toEqual([
    { Name: "/prod/config", WithDecryption: false },
  ]);
});

test("maps missing AWS variables and binary secrets to Runtime Variable results", async () => {
  secretCalls.length = 0;
  parameterCalls.length = 0;
  const missingParameter = new Error("missing");
  missingParameter.name = "ParameterNotFound";
  parameterResponse = missingParameter;
  secretResponse = { SecretBinary: new Uint8Array([1, 2, 3]) };
  const { createGateway } = await import("../src/app");
  const { VokeRuntimeVariableError } = await import("../src/errors");
  const { defineFunction, defineFunctions } = await import("../src/invoke");
  const { parameter, secret } = await import("../src/aws");

  const functions = defineFunctions({
    readMissingParameter: defineFunction({
      handler: async (_payload, context) =>
        (await context.variables.optional.text()) ?? "missing",
      output: {
        "~standard": {
          validate: (value) =>
            typeof value === "string"
              ? { data: value, success: true }
              : { issues: [{ message: "expected string" }], success: false },
          vendor: "voke-test",
          version: 1,
        },
      },
      variables: {
        optional: parameter("/missing", undefined, { optional: true }),
      },
    }),
    readSecret: defineFunction({
      handler: async (_payload, context) =>
        await context.variables.apiKey.text(),
      output: {
        "~standard": {
          validate: (value) =>
            typeof value === "string"
              ? { data: value, success: true }
              : { issues: [{ message: "expected string" }], success: false },
          vendor: "voke-test",
          version: 1,
        },
      },
      variables: {
        apiKey: secret("binary-only"),
      },
    }),
  });
  createGateway({ functions });

  await expect(functions.invoke("readMissingParameter")).resolves.toBe(
    "missing"
  );
  await expect(functions.invoke("readSecret")).rejects.toThrow(
    VokeRuntimeVariableError
  );
  await expect(functions.invoke("readSecret")).rejects.toThrow(
    'Runtime variable "apiKey" for Function "readSecret" could not be loaded from aws secretsManagerSecret "secretsManagerSecret".'
  );
});

test("resolves AWS Runtime Variables from Voke-managed resource bindings", async () => {
  secretCalls.length = 0;
  parameterCalls.length = 0;
  secretResponse = { SecretString: "managed-secret-value" };
  parameterResponse = { Parameter: { Value: "managed-parameter-value" } };
  const { createResourceBindingName, parameter, secret } =
    await import("../src/aws");
  const signingSecretEnv = createResourceBindingName("signingSecret", "id");
  const publicConfigEnv = createResourceBindingName("publicConfig", "name");
  const previousSecret = Bun.env[signingSecretEnv];
  const previousParameter = Bun.env[publicConfigEnv];

  try {
    Bun.env[signingSecretEnv] = "signing-secret-id";
    Bun.env[publicConfigEnv] = "/public/config";
    const { createGateway } = await import("../src/app");
    const { defineFunction, defineFunctions } = await import("../src/invoke");
    const functions = defineFunctions({
      readManagedVariables: defineFunction({
        handler: async (_payload, context) =>
          `${await context.variables.signingSecret.text()}/${await context.variables.publicConfig.text()}`,
        output: {
          "~standard": {
            validate: (value) =>
              typeof value === "string"
                ? { data: value, success: true }
                : { issues: [{ message: "expected string" }], success: false },
            vendor: "voke-test",
            version: 1,
          },
        },
        variables: {
          publicConfig: parameter.fromResource("publicConfig"),
          signingSecret: secret.fromResource("signingSecret"),
        },
      }),
    });
    createGateway({ functions });

    await expect(functions.invoke("readManagedVariables")).resolves.toBe(
      "managed-secret-value/managed-parameter-value"
    );
    expect(secretCalls).toEqual([{ SecretId: "signing-secret-id" }]);
    expect(parameterCalls).toEqual([
      { Name: "/public/config", WithDecryption: true },
    ]);
  } finally {
    if (previousSecret === undefined) {
      Reflect.deleteProperty(Bun.env, signingSecretEnv);
    } else {
      Bun.env[signingSecretEnv] = previousSecret;
    }

    if (previousParameter === undefined) {
      Reflect.deleteProperty(Bun.env, publicConfigEnv);
    } else {
      Bun.env[publicConfigEnv] = previousParameter;
    }
  }
});
