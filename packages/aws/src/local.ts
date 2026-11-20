import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";

import type {
  ProviderLocalWorkflow,
  ProviderLocalWorkflowContext,
  VokeModel,
} from "voke";

import {
  resourceOutputBindings,
  synthesizeCloudFormationFromModel,
} from "./cloudformation-synthesis";
import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "./cloudformation-synthesis";
import {
  LocalProviderError,
  localProviderFailureMessage,
} from "./local-provider";
import type {
  LocalAwsEnvironment,
  LocalAwsEnvironmentOptions,
  LocalBootstrapPlan,
  LocalProvider,
  LocalProviderLifecycleOptions,
} from "./local-provider";
import { createResourceBindingName } from "./resources";

export {
  awsEmulator,
  type AwsEmulatorDependencies,
  type AwsEmulatorOptions,
} from "./local-aws-emulator";
export {
  floci,
  LocalProviderError,
  type FlociComposeOptions,
  type FlociLocalProvider,
  type FlociLocalProviderOptions,
  type LocalAwsEnvironment,
  type LocalAwsEnvironmentOptions,
  type LocalBootstrapPlan,
  type LocalProvider,
  type LocalProviderBootstrapPlanOptions,
  type LocalProviderComposeOptions,
  type LocalProviderDefaults,
  type LocalProviderLifecycleOptions,
} from "./local-provider";

interface LocalBootstrapPlanBaseOptions {
  /** The Local AWS Provider's state directory; see `LocalAwsEnvironmentOptions.directory`. */
  directory?: string;
  endpoint?: string;
  name: string;
  provider: LocalProvider;
  region: string;
  stage: string;
  templatePath?: string;
}

/** Provision the resources of a model, or of a ready template (an escape hatch). */
export type LocalBootstrapPlanOptions = LocalBootstrapPlanBaseOptions &
  (
    | { model: VokeModel; template?: undefined }
    | { model?: undefined; template: CloudFormationTemplate }
  );

const defaultLocalEndpoint = "http://localhost:4566";
const defaultLocalRegion = "us-east-1";
const defaultLocalAccountId = "000000000000";

const writeFileCreatingDirectory = async (
  path: string,
  contents: string
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
};

const binding = (
  resource: string,
  attribute: string,
  value: string
): { envName: string; value: string } => ({
  envName: createResourceBindingName(resource, attribute),
  value,
});

const metadataBinding = (
  logicalId: string,
  resource: CloudFormationResource
): { attribute: string; resource: string } | undefined => {
  const metadata = resource.Metadata?.VokeBinding;

  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return undefined;
  }

  const attribute = metadata.Attribute;
  const name = metadata.Resource;

  if (typeof attribute !== "string" || typeof name !== "string") {
    return undefined;
  }

  return { attribute, resource: name || logicalId };
};

// Resources whose local binding is their logical id, under the `name` attribute by default.
const nameBoundResourceTypes = new Set([
  "AWS::DynamoDB::Table",
  "AWS::Events::EventBus",
  "AWS::Kinesis::Stream",
  "AWS::S3::Bucket",
  "AWS::SSM::Parameter",
]);

const resourceBindingFor = (
  logicalId: string,
  resource: CloudFormationResource,
  endpoint: string,
  accountId: string,
  region: string
): { envName: string; value: string } | undefined => {
  const modelBinding = metadataBinding(logicalId, resource);
  const bindingResource = modelBinding?.resource ?? logicalId;
  const bindingAttribute = modelBinding?.attribute;

  if (nameBoundResourceTypes.has(resource.Type)) {
    return binding(bindingResource, bindingAttribute ?? "name", logicalId);
  }

  if (resource.Type === "AWS::SQS::Queue") {
    return binding(
      bindingResource,
      bindingAttribute ?? "url",
      `${endpoint}/${accountId}/${logicalId}`
    );
  }

  if (resource.Type === "AWS::SNS::Topic") {
    return binding(
      bindingResource,
      bindingAttribute ?? "arn",
      `arn:aws:sns:${region}:${accountId}:${logicalId}`
    );
  }

  if (resource.Type === "AWS::SecretsManager::Secret") {
    return binding(
      bindingResource,
      bindingAttribute ?? "id",
      bindingAttribute === "arn"
        ? `arn:aws:secretsmanager:${region}:${accountId}:secret:${logicalId}`
        : logicalId
    );
  }

  return undefined;
};

export const createLocalAwsEnvironment = (
  options: LocalAwsEnvironmentOptions & { provider: LocalProvider }
): LocalAwsEnvironment | Promise<LocalAwsEnvironment> => {
  const { provider, ...environmentOptions } = options;

  return provider.environment(environmentOptions);
};

export const createLocalResourceBindings = (
  template: CloudFormationTemplate,
  options: { endpoint?: string; accountId?: string; region?: string } = {}
): Record<string, string> => {
  const endpoint = options.endpoint ?? defaultLocalEndpoint;
  const accountId = options.accountId ?? defaultLocalAccountId;
  const region = options.region ?? defaultLocalRegion;
  const bindings: Record<string, string> = {};

  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    const resourceBinding = resourceBindingFor(
      logicalId,
      resource,
      endpoint,
      accountId,
      region
    );

    if (resourceBinding === undefined) {
      continue;
    }

    bindings[resourceBinding.envName] = resourceBinding.value;
  }

  return bindings;
};

export const createLocalBootstrapPlan = async (
  options: LocalBootstrapPlanOptions
): Promise<LocalBootstrapPlan> => {
  // Local data is disposable, and a retained resource would block a later create.
  const template =
    options.template === undefined
      ? synthesizeCloudFormationFromModel(options.model, { retainData: false })
      : options.template;
  const templatePath =
    options.templatePath ?? ".voke/local/cloudformation.json";
  const environment = await createLocalAwsEnvironment({
    directory: options.directory,
    endpoint: options.endpoint,
    provider: options.provider,
    region: options.region,
  });

  await writeFileCreatingDirectory(
    templatePath,
    `${JSON.stringify(template, null, 2)}\n`
  );

  return await options.provider.bootstrapPlan({
    environment,
    name: options.name,
    region: options.region,
    stage: options.stage,
    template,
    templatePath,
  });
};

/** Where `voke local bootstrap` writes stack outputs for `voke dev`, relative to the project. */
export const localOutputsPath = join(".voke", "local", "outputs.json");

/** `.voke/local/outputs.json`: the bindings of a local stack and what they belong to. */
export interface LocalStackOutputs {
  bindings: Record<string, string>;
  endpoint: string;
  provider: string;
  region: string;
  stack: string;
}

/** Runs a command and returns its stdout; the core runner does not return output. */
export type CaptureCommand = (
  command: string[],
  options: { env: Record<string, string>; unsetEnv: readonly string[] }
) => Promise<string>;

const captureCommand: CaptureCommand = async (command, options) => {
  // Typed as ProcessEnv so the spawn call also typechecks in apps whose types extend it (Next.js
  // makes NODE_ENV required).
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const name of options.unsetEnv) {
    Reflect.deleteProperty(env, name);
  }

  const [program = "", ...args] = command;
  const child = spawn(program, args, {
    env: { ...env, ...options.env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const chunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  // oxlint-disable-next-line promise/avoid-new -- adapts the child process exit event
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }

  return Buffer.concat(chunks).toString("utf-8");
};

export interface LocalWorkflowDependencies {
  capture: CaptureCommand;
  /** The project directory. Default: the current directory. */
  cwd: () => string;
  output: (line: string) => void;
}

const defaultWorkflowDependencies: LocalWorkflowDependencies = {
  capture: captureCommand,
  cwd: () => process.cwd(),
  output: (line) => {
    console.log(line);
  },
};

/** The outputs file, if it belongs to this provider, stack and endpoint; stale files are ignored. */
export const readLocalStackOutputs = async (
  expected: Omit<LocalStackOutputs, "bindings" | "region">,
  cwd: string = process.cwd()
): Promise<Record<string, string> | undefined> => {
  let outputs: Partial<LocalStackOutputs>;

  try {
    outputs = JSON.parse(
      await readFile(resolvePath(cwd, localOutputsPath), "utf-8")
    ) as Partial<LocalStackOutputs>;
  } catch {
    return undefined;
  }

  const matches =
    outputs.provider === expected.provider &&
    outputs.stack === expected.stack &&
    outputs.endpoint === expected.endpoint;

  return matches ? outputs.bindings : undefined;
};

const runLocalCommand = async (
  provider: LocalProvider,
  context: ProviderLocalWorkflowContext,
  localCommand: string,
  command: string[],
  env?: Record<string, string>
): Promise<void> => {
  try {
    await context.run(command, {
      env,
      unsetEnv: provider.unsetEnvironment ?? [],
    });
  } catch (error) {
    throw new LocalProviderError({
      cause: error,
      command,
      message: localProviderFailureMessage({
        cause: error,
        command,
        localCommand,
        provider,
      }),
      provider: provider.name,
    });
  }
};

const commonWorkflowFlags = {
  endpoint: "Local AWS endpoint for bootstrap",
  template:
    "Template written by bootstrap. Default: .voke/local/cloudformation.json",
} as const;

interface StackDescriptionJson {
  Stacks?: { Outputs?: { OutputKey?: string; OutputValue?: string }[] }[];
}

/** Maps the stack's outputs to `VOKE_RESOURCE_*` variables through the model's resources. */
const bindingsFromOutputs = (
  model: VokeModel,
  description: StackDescriptionJson
): Record<string, string> => {
  const variables = resourceOutputBindings(model);
  const bindings: Record<string, string> = {};

  for (const output of description.Stacks?.[0]?.Outputs ?? []) {
    const variable =
      output.OutputKey === undefined ? undefined : variables[output.OutputKey];

    if (variable !== undefined && output.OutputValue !== undefined) {
      bindings[variable] = output.OutputValue;
    }
  }

  return bindings;
};

/**
 * `voke local start|stop|reset|bootstrap` for a Local AWS Provider. Providers that bind from stack
 * outputs get a resources-only template; bootstrap writes the outputs to `.voke/local/outputs.json`
 * for `voke dev`, and stop and reset delete it because the emulator's state is gone.
 */
export const createLocalWorkflow = (
  provider: LocalProvider,
  dependencies: Partial<LocalWorkflowDependencies> = {}
): ProviderLocalWorkflow => {
  const deps = { ...defaultWorkflowDependencies, ...dependencies };
  const lifecycleOf = (
    context: ProviderLocalWorkflowContext
  ): LocalProviderLifecycleOptions => ({
    directory: resolvePath(deps.cwd(), ".voke", "local", provider.name),
    options: context.options,
    region: context.config.region,
  });
  const removeOutputs = async (): Promise<void> => {
    await rm(resolvePath(deps.cwd(), localOutputsPath), { force: true });
  };
  const runAll = async (
    context: ProviderLocalWorkflowContext,
    localCommand: string,
    commands: string[][]
  ): Promise<void> => {
    for (const command of commands) {
      await runLocalCommand(provider, context, localCommand, command);
    }
  };
  const bootstrapFromOutputs = async (
    context: ProviderLocalWorkflowContext
  ): Promise<void> => {
    const { config, model } = context;
    const stack = `${config.name}-${config.stage}`;
    const environment = await createLocalAwsEnvironment({
      directory: lifecycleOf(context).directory,
      endpoint: context.options.endpoint,
      provider,
      region: config.region,
    });
    const plan = await createLocalBootstrapPlan({
      directory: lifecycleOf(context).directory,
      endpoint: context.options.endpoint,
      name: config.name,
      provider,
      region: config.region,
      stage: config.stage,
      template: synthesizeCloudFormationFromModel(model, {
        retainData: false,
        scope: "resources",
      }),
      templatePath:
        context.options.template ?? ".voke/local/cloudformation.json",
    });

    for (const command of plan.commands) {
      await runLocalCommand(
        provider,
        context,
        "bootstrap",
        command,
        environment
      );
    }

    const describe = [
      "aws",
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      stack,
      "--region",
      config.region,
      "--output",
      "json",
    ];
    let description: StackDescriptionJson;

    try {
      description = JSON.parse(
        await deps.capture(describe, {
          env: environment,
          unsetEnv: provider.unsetEnvironment ?? [],
        })
      ) as StackDescriptionJson;
    } catch (error) {
      throw new LocalProviderError({
        cause: error,
        command: describe,
        message: localProviderFailureMessage({
          cause: error,
          command: describe,
          localCommand: "bootstrap",
          provider,
        }),
        provider: provider.name,
      });
    }

    const bindings = bindingsFromOutputs(model, description);
    const outputs: LocalStackOutputs = {
      bindings,
      endpoint: environment.AWS_ENDPOINT_URL,
      provider: provider.name,
      region: config.region,
      stack,
    };

    await writeFileCreatingDirectory(
      resolvePath(deps.cwd(), localOutputsPath),
      `${JSON.stringify(outputs, null, 2)}\n`
    );

    for (const [variable, value] of Object.entries(bindings)) {
      deps.output(`${variable}=${value}`);
    }
  };

  return {
    bootstrap: async (context) => {
      if (provider.bindings === "outputs") {
        await bootstrapFromOutputs(context);
        return;
      }

      const { config } = context;
      const plan = await createLocalBootstrapPlan({
        endpoint: context.options.endpoint,
        model: context.model,
        name: config.name,
        provider,
        region: config.region,
        stage: config.stage,
        templatePath:
          context.options.template ?? ".voke/local/cloudformation.json",
      });

      for (const command of plan.commands) {
        await runLocalCommand(
          provider,
          context,
          "bootstrap",
          command,
          plan.environment
        );
      }
    },
    flags: { ...commonWorkflowFlags, ...provider.flags },
    reset: async (context) => {
      const lifecycle = lifecycleOf(context);

      await runAll(context, "reset", provider.resetCommands(lifecycle));
      await removeOutputs();
      await provider.waitUntilReady?.(lifecycle);
    },
    start: async (context) => {
      const lifecycle = lifecycleOf(context);

      for (const [path, contents] of Object.entries(
        provider.files(lifecycle)
      )) {
        await writeFileCreatingDirectory(path, contents);
      }

      await provider.prepareStart?.(lifecycle, (command, options) =>
        context.run(command, {
          ...options,
          unsetEnv: provider.unsetEnvironment ?? [],
        })
      );
      await runAll(context, "start", provider.startCommands(lifecycle));
      await provider.waitUntilReady?.(lifecycle);

      if (provider.bindings === "outputs") {
        deps.output(`${provider.name} endpoint: ${provider.defaults.endpoint}`);
        deps.output(`State: ${lifecycle.directory}`);
        deps.output("Next: voke local bootstrap");
      }
    },
    stop: async (context) => {
      await runAll(
        context,
        "stop",
        provider.stopCommands(lifecycleOf(context))
      );
      await removeOutputs();
    },
  };
};
