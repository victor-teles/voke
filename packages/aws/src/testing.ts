import type {
  DurableOperation,
  TestResult,
} from "@aws/durable-execution-sdk-js-testing";
import { VokeConfigError } from "voke";
import type { FunctionRegistry } from "voke";

import type { CloudFormationTemplate } from "./cloudformation-synthesis";
import {
  recordLocalDurableExecutions,
  setupLocalDurableEnvironment,
  teardownLocalDurableEnvironment,
} from "./durable-local";
import {
  createLocalAwsEnvironment,
  createLocalResourceBindings,
} from "./local";
import type { LocalAwsEnvironment } from "./local";
import { floci } from "./local-provider";
import type { LocalProvider } from "./local-provider";
import { toEnvKey } from "./resources";

export interface StackTestContextOptions {
  accountId?: string;
  endpoint?: string;
  outputs?: Record<string, string>;
  /** The Local AWS Provider the stack runs on. Defaults to Floci. */
  local?: LocalProvider;
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
  key: string,
  value: unknown
): Record<string, string | boolean> => {
  if (typeof value === "string") {
    return { S: value };
  }
  if (typeof value === "number") {
    return { N: String(value) };
  }
  if (typeof value === "boolean") {
    return { BOOL: value };
  }
  if (value === null) {
    return { NULL: true };
  }

  throw new Error(
    `Unsupported DynamoDB seed attribute "${key}". Expected string, number, boolean, or null.`
  );
};

const toDynamoItem = (
  item: Record<string, unknown>
): Record<string, Record<string, string | boolean>> =>
  Object.fromEntries(
    Object.entries(item).map(([key, value]) => [
      key,
      toDynamoAttribute(key, value),
    ])
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
    const resolvedTableName =
      bindings[`VOKE_RESOURCE_${toEnvKey(tableName)}_NAME`] ?? tableName;

    for (const item of items) {
      commands.push([
        "aws",
        "dynamodb",
        "put-item",
        "--table-name",
        resolvedTableName,
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
    provider: options.local ?? floci(),
    region: options.region,
  });

  // The stack test context is synchronous and still Floci-shaped; the AWS Emulator's environment
  // depends on its running state, so it needs an async, outputs-based context (a follow-up).
  if (environment instanceof Promise) {
    throw new TypeError(
      "createStackTestContext needs a Local AWS Provider with a synchronous environment, such as floci()."
    );
  }

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

/** The result of one durable Function run through `runDurable`. */
export interface DurableRun<TResult = unknown> {
  /** The SDK testing runner's view of the execution: status, history events, invocations. */
  execution: TestResult<unknown>;
  /** Every durable operation the execution recorded, in order. */
  operations: DurableOperation[];
  /** The Function's validated output. */
  result: TResult;
}

/**
 * Makes local durable runs skip time: waits and step retry delays complete at once. Call it in
 * `beforeAll`. It installs a fake clock, so `Date` and timers in the test file are faked too.
 */
export const setupDurableTests = async (): Promise<void> => {
  await setupLocalDurableEnvironment();
};

/** Stops the local durable environment and restores real timers. Call it in `afterAll`. */
export const teardownDurableTests = async (): Promise<void> => {
  await teardownLocalDurableEnvironment();
};

type LocalInvoke = (
  key: string,
  payload: unknown,
  options: { runtime: "local" }
) => Promise<unknown>;

/**
 * Invokes a durable Function locally through `functions.invoke`, so payload and result are
 * validated, and returns its result with the operations the execution recorded.
 */
export const runDurable = async <TResult = unknown>(
  functions: Pick<FunctionRegistry, "invoke">,
  key: string,
  payload?: unknown
): Promise<DurableRun<TResult>> => {
  const invoke = functions.invoke as unknown as LocalInvoke;
  const { executions, result } = await recordLocalDurableExecutions(
    async () => await invoke(key, payload, { runtime: "local" })
  );
  const run = executions.at(-1);

  if (run === undefined) {
    throw new VokeConfigError(
      `runDurable: Function "${key}" is not a durable Function; declare it with durable() from "@voke/aws".`
    );
  }

  return {
    execution: run.execution,
    operations: run.operations,
    result: result as TResult,
  };
};
