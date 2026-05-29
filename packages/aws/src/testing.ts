import type { CloudFormationTemplate } from "./cloudformation-synthesis";
import {
  createLocalAwsEnvironment,
  createLocalResourceBindings,
} from "./local";
import type { LocalAwsEnvironment } from "./local";
import { toEnvKey } from "./resources";

export interface StackTestContextOptions {
  accountId?: string;
  endpoint?: string;
  outputs?: Record<string, string>;
  region?: string;
  template: CloudFormationTemplate;
}

export interface StackSeedInput {
  dynamodb?: Record<string, Record<string, unknown>[]>;
  sqs?: Record<string, unknown[]>;
}

export interface StackSeedPlan {
  commands: string[][];
  environment: LocalAwsEnvironment;
}

export interface StackTestContext {
  bindings: Record<string, string>;
  createSeedPlan: (input: StackSeedInput) => StackSeedPlan;
  environment: LocalAwsEnvironment;
  output: (name: string) => string;
  outputs: Record<string, string>;
  resource: (name: string, attribute: string) => string;
  template: CloudFormationTemplate;
}

const toDynamoAttribute = (
  value: unknown
): Record<string, string | boolean> => {
  if (typeof value === "number") {
    return { N: String(value) };
  }
  if (typeof value === "boolean") {
    return { BOOL: value };
  }
  if (value === null) {
    return { NULL: true };
  }

  return { S: String(value) };
};

const toDynamoItem = (
  item: Record<string, unknown>
): Record<string, Record<string, string | boolean>> =>
  Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, toDynamoAttribute(value)])
  );

const stringifyOutput = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const resolveOutputs = (
  template: CloudFormationTemplate,
  overrides: Record<string, string> = {}
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(template.Outputs).map(([name, output]) => [
      name,
      stringifyOutput(output.Value),
    ])
  ),
  ...overrides,
});

const createSeedPlan = (
  input: StackSeedInput,
  environment: LocalAwsEnvironment,
  bindings: Record<string, string>
): StackSeedPlan => {
  const commands: string[][] = [];

  for (const [tableName, items] of Object.entries(input.dynamodb ?? {})) {
    for (const item of items) {
      commands.push([
        "aws",
        "dynamodb",
        "put-item",
        "--table-name",
        tableName,
        "--item",
        JSON.stringify(toDynamoItem(item)),
        "--region",
        environment.AWS_REGION,
      ]);
    }
  }

  for (const [queueName, messages] of Object.entries(input.sqs ?? {})) {
    const queueUrl =
      bindings[`VOKE_RESOURCE_${toEnvKey(queueName)}_URL`] ?? queueName;

    for (const message of messages) {
      commands.push([
        "aws",
        "sqs",
        "send-message",
        "--queue-url",
        queueUrl,
        "--message-body",
        JSON.stringify(message),
        "--region",
        environment.AWS_REGION,
      ]);
    }
  }

  return { commands, environment };
};

export const createStackTestContext = (
  options: StackTestContextOptions
): StackTestContext => {
  const environment = createLocalAwsEnvironment({
    endpoint: options.endpoint,
    region: options.region,
  });
  const bindings = createLocalResourceBindings(options.template, {
    accountId: options.accountId,
    endpoint: environment.AWS_ENDPOINT_URL,
    region: environment.AWS_REGION,
  });
  const outputs = resolveOutputs(options.template, options.outputs);

  return {
    bindings,
    createSeedPlan: (input) => createSeedPlan(input, environment, bindings),
    environment,
    output: (name) => {
      const value = outputs[name];

      if (value === undefined) {
        throw new Error(`Missing stack test output: ${name}`);
      }

      return value;
    },
    outputs,
    resource: (name, attribute) => {
      const envName = `VOKE_RESOURCE_${toEnvKey(name)}_${toEnvKey(attribute)}`;
      const value = bindings[envName];

      if (value === undefined) {
        throw new Error(`Missing stack test resource binding: ${envName}`);
      }

      return value;
    },
    template: options.template,
  };
};
