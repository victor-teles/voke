#!/usr/bin/env bun

import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import packageJson from "../package.json";
import {
  assertKnownFlags,
  assertPositionals,
  CliUsageError,
  cliUsageMessage,
  formatCommandHelp,
  formatHelp,
  formatPluginHelp,
  isHelpRequest,
  localSubcommands,
  missingProviderMessage,
  parseFlags,
  pluginCommandSpecs,
} from "./cli-spec";
import type { ParsedFlags } from "./cli-spec";
import { defineConfig, loadVokeConfig } from "./config";
import type { VokeConfig } from "./config";
import { createDevPlan } from "./dev";
import { runDoctor } from "./doctor";
import { VokeConfigError, VokeError } from "./errors";
import { functionRegistryEntries } from "./invoke";
import type { FunctionRegistry, FunctionRegistryInput } from "./invoke";
import { createInternalModel } from "./model";
import type { VokePlugin } from "./plugin";
import { loadProject } from "./project";
import type { BuildPlan, ProviderDeployResult } from "./provider";
import { generateRemoteModules } from "./remote";
import { readEnv } from "./runtime-env";
import { createProject, unscopedName } from "./scaffold";
import { writeServerlessMigration } from "./serverless-migration";
import type { ServerlessMigrationManualTask } from "./serverless-migration";

export { CliUsageError, type ParsedFlags } from "./cli-spec";
export { createApiProject } from "./scaffold";

interface CliOptions {
  /** Reads one line of confirmation; defaults to the terminal. */
  confirm?: (prompt: string) => Promise<string>;
  /**
   * The project directory: where the config file, package.json and the entrypoint resolve.
   * Default: the working directory. Build output and spawned tools still use the working directory.
   */
  cwd?: string;
  /** Whether the CLI may prompt; defaults to whether stdin is a terminal. */
  interactive?: boolean;
  output?: CliOutput;
  run?: CommandRunner;
  showDetails?: boolean;
}

type CliOutput = (message: string) => void;

const projectDirectory = (options: CliOptions): string =>
  options.cwd ?? process.cwd();

type CommandRunner = (
  command: string[],
  options?: CommandRunOptions
) => void | Promise<void>;

interface CommandRunOptions {
  /** Working directory for the command. Defaults to the current directory. */
  cwd?: string;
  env?: Record<string, string>;
  stdoutFilter?: (line: string) => boolean;
  /** Names removed from the inherited environment before `env` is applied. */
  unsetEnv?: readonly string[];
}

type CommandHandler = (
  flags: ParsedFlags,
  options: CliOptions
) => Promise<void>;

const commandName = (argv: string[]): string => argv[0] ?? "help";

const formatCommand = (argv: string[]): string => ["voke", ...argv].join(" ");

const cliRunDetails = (argv: string[]): string =>
  [
    `Voke v${packageJson.version}`,
    `Command: ${commandName(argv)}`,
    `Run: ${formatCommand(argv)}`,
    `Runtime: Bun ${Bun.version}`,
  ].join("\n");

const printRunDetails = (argv: string[], options: CliOptions): void => {
  if (options.showDetails !== true) {
    return;
  }

  const output = options.output ?? console.log;

  output(cliRunDetails(argv));
};

export const isFlagSet = (flags: ParsedFlags, name: string): boolean =>
  flags.values[name] !== undefined && flags.values[name] !== "false";

const forwardFilteredStdout = async (
  stdout: ReadableStream<Uint8Array>,
  stdoutFilter: (line: string) => boolean
): Promise<void> => {
  const decoder = new TextDecoder();
  let pending = "";

  for await (const chunk of stdout) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines) {
      if (stdoutFilter(line)) {
        process.stdout.write(`${line}\n`);
      }
    }
  }

  pending += decoder.decode();

  if (pending.length > 0 && stdoutFilter(pending)) {
    process.stdout.write(pending);
  }
};

const childEnvironment = (
  options: CommandRunOptions
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...Bun.env };

  for (const name of options.unsetEnv ?? []) {
    Reflect.deleteProperty(env, name);
  }

  return { ...env, ...options.env };
};

export const runCommand = async (
  command: string[],
  options: CommandRunOptions = {}
): Promise<void> => {
  const stdout = options.stdoutFilter === undefined ? "inherit" : "pipe";
  const process = Bun.spawn(command, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: childEnvironment(options),
    stderr: "inherit",
    stdout,
  });

  if (
    options.stdoutFilter !== undefined &&
    process.stdout !== null &&
    process.stdout !== undefined
  ) {
    await forwardFilteredStdout(process.stdout, options.stdoutFilter);
  }

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
};

const hideBunDevelopmentServerBanner = (line: string): boolean =>
  !line.includes("Started development server:");

export const migrateServerless = async (
  flags: ParsedFlags
): Promise<{
  blockingTasks: ServerlessMigrationManualTask[];
  directory: string;
}> => {
  const sourcePath = flags.positional[0] ?? "./serverless.yml";
  const outDirectory = flags.values.out ?? "./voke-migration";
  const source = await Bun.file(sourcePath).text();
  const migration = await writeServerlessMigration({
    outDirectory,
    source,
  });

  return {
    blockingTasks: migration.report.manualTasks.filter(
      (task) => task.risk === "blocking"
    ),
    directory: outDirectory,
  };
};

/** Without a config file, the project is named after ./package.json (scope stripped). */
const packageJsonName = async (cwd: string): Promise<string | undefined> => {
  const file = Bun.file(resolve(cwd, "package.json"));

  if (!(await file.exists())) {
    return undefined;
  }

  try {
    const { name } = (await file.json()) as { name?: unknown };

    return typeof name === "string" && name !== ""
      ? unscopedName(name)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Commands that need a Provider fail before importing the project when none is configured. */
const assertProviderConfigured = (config: VokeConfig): void => {
  if (config.provider === undefined) {
    throw new CliUsageError(missingProviderMessage(config.name));
  }
};

/** The config file `loadConfigFromFlags` reads, when it exists. */
const configPathFromFlags = async (
  flags: ParsedFlags,
  cwd: string
): Promise<string | undefined> => {
  const configPath = flags.values.config ?? "voke.config.ts";

  return (await Bun.file(resolve(cwd, configPath)).exists())
    ? configPath
    : undefined;
};

const loadConfigFromFlags = async (
  flags: ParsedFlags,
  cwd: string
): Promise<VokeConfig> => {
  const configPath = flags.values.config ?? "voke.config.ts";

  if (
    flags.values.config !== undefined ||
    (await Bun.file(resolve(cwd, configPath)).exists())
  ) {
    return loadVokeConfig({ cwd, path: configPath });
  }

  return defineConfig({
    entrypoint: flags.values.entrypoint,
    name: flags.values.name ?? (await packageJsonName(cwd)) ?? "api",
    region: flags.values.region,
    stage: flags.values.stage,
  });
};

export const synth = async (options: {
  config?: VokeConfig;
  name?: string;
  stage?: string;
  region?: string;
  entrypoint?: string;
  /** The Function Registry discovered from the project entrypoint (see loadProject). */
  functions?: FunctionRegistry | FunctionRegistryInput;
  out?: string;
}): Promise<string> => {
  const config = defineConfig({
    ...(options.config ?? { name: "api" }),
    entrypoint: options.entrypoint ?? options.config?.entrypoint,
    name: options.name ?? options.config?.name ?? "api",
    region: options.region ?? options.config?.region,
    stage: options.stage ?? options.config?.stage,
  });
  const synthesize = config.provider?.synthesis?.synthesize;

  if (synthesize === undefined) {
    throw new CliUsageError(
      config.provider === undefined
        ? missingProviderMessage(config.name)
        : `Provider "${config.provider.name}" does not support synthesis.`
    );
  }

  const template = synthesize({
    config,
    model: createInternalModel({ ...config, functions: options.functions }),
  });
  const out = options.out ?? config.cloudFormation.out;

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(template, null, 2)}\n`);

  return out;
};

export const build = async (
  config: VokeConfig,
  options: {
    /** The config file the config was loaded from; the deployed handlers import it. */
    configPath?: string;
    /** The project entrypoint that declares the Functions. Defaults to `config.entrypoint`. */
    entrypoint?: string;
    functions: FunctionRegistry | FunctionRegistryInput;
    outdir?: string;
    run?: CommandRunner;
  }
): Promise<BuildPlan> => {
  const createPlan = config.provider?.build?.plan;

  if (createPlan === undefined) {
    throw new CliUsageError(
      config.provider === undefined
        ? missingProviderMessage(config.name)
        : `Provider "${config.provider.name}" does not support build.`
    );
  }

  const plan = createPlan({
    build:
      options.outdir === undefined
        ? config.build
        : { ...config.build, outdir: options.outdir },
    config,
    ...(options.configPath === undefined
      ? {}
      : { configPath: options.configPath }),
    entrypoint: options.entrypoint ?? config.entrypoint,
    functions: options.functions,
  });

  for (const [path, contents] of Object.entries(plan.sources)) {
    await Bun.write(path, contents);
  }

  await (options.run ?? runCommand)(plan.command);

  for (const [path, contents] of Object.entries(plan.files)) {
    await Bun.write(path, contents);
  }

  return plan;
};

const endpointEnvironment = ["VOKE_AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL"];

/** --stage, then VOKE_STAGE, then the config. */
const resolveStage = (flags: ParsedFlags, config: VokeConfig): string =>
  flags.values.stage ?? readEnv("VOKE_STAGE") ?? config.stage;

const assertDeployableStage = (stage: string): void => {
  const hasLocalEndpoint = endpointEnvironment.some(
    (name) => (readEnv(name) ?? "") !== ""
  );

  if (stage === "local" && !hasLocalEndpoint) {
    throw new CliUsageError(
      'Stage "local" is reserved for the local emulator. Deploy to AWS with: voke deploy --stage dev'
    );
  }
};

/** Bundle files relative to the build output directory; each must exist after the build. */
const artifactFilesOf = async (
  plan: BuildPlan,
  cwd: string
): Promise<{ directory: string; files: string[] }> => {
  const directory = resolve(cwd, plan.outdir);
  const paths = [
    ...Object.values(plan.outputs).map((output) => output.file),
    ...Object.keys(plan.files),
  ];
  const files = [
    ...new Set(paths.map((path) => relative(directory, resolve(cwd, path)))),
  ];

  for (const file of files) {
    try {
      await access(resolve(directory, file));
    } catch {
      throw new CliUsageError(
        `The build did not produce ${file} in ${plan.outdir}. Run voke build and check its output.`
      );
    }
  }

  return { directory, files };
};

const printDeployOutputs = (
  result: ProviderDeployResult,
  output: CliOutput
): void => {
  const entries = Object.entries(result.outputs).toSorted(([left], [right]) => {
    if (left === "ApiUrl") {
      return -1;
    }

    return right === "ApiUrl" ? 1 : left.localeCompare(right);
  });

  if (entries.length === 0) {
    return;
  }

  const width = Math.max(...entries.map(([key]) => key.length));

  output("");

  for (const [key, value] of entries) {
    output(`${key.padEnd(width)}  ${value}`);
  }
};

const writeDeployOutputs = async (
  result: ProviderDeployResult,
  stage: string,
  cwd: string
): Promise<string> => {
  const path = resolve(cwd, ".voke", "outputs", `${stage}.json`);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ id: result.id, outputs: result.outputs, region: result.region, stage }, null, 2)}\n`
  );

  return path;
};

/** Builds the project through its Provider and deploys it to the stage. */
export const deployProject = async (options: {
  /** Apply changes that remove or replace a resource that holds data. Default `false`. */
  acceptDataLoss?: boolean;
  config: VokeConfig;
  /** The config file the config was loaded from; the deployed handlers import it. */
  configPath?: string;
  cwd?: string;
  dryRun?: boolean;
  entrypoint?: string;
  functions: FunctionRegistry | FunctionRegistryInput;
  output?: CliOutput;
  region?: string;
  run?: CommandRunner;
  stage: string;
}): Promise<ProviderDeployResult> => {
  const output = options.output ?? console.log;
  const cwd = options.cwd ?? process.cwd();

  assertDeployableStage(options.stage);

  const config = defineConfig({ ...options.config, stage: options.stage });
  const deployToProvider = config.provider?.deploy?.deploy;

  if (deployToProvider === undefined) {
    throw new CliUsageError(
      config.provider === undefined
        ? missingProviderMessage(config.name)
        : `Provider "${config.provider.name}" does not support deploy.`
    );
  }

  output(`Building ${config.name} (${options.stage})`);
  const plan = await build(config, {
    configPath: options.configPath,
    entrypoint: options.entrypoint,
    functions: options.functions,
    run: options.run,
  });
  const artifact = await artifactFilesOf(plan, cwd);
  const result = await deployToProvider({
    acceptDataLoss: options.acceptDataLoss ?? false,
    artifactDirectory: artifact.directory,
    artifactFiles: artifact.files,
    config,
    dryRun: options.dryRun ?? false,
    model: createInternalModel({ ...config, functions: options.functions }),
    output,
    region: options.region,
    stage: options.stage,
  });

  printDeployOutputs(result, output);

  if (result.status !== "dry-run") {
    await writeDeployOutputs(result, options.stage, cwd);
  }

  return result;
};

const readConfirmation = async (prompt: string): Promise<string> => {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await reader.question(prompt);
  } finally {
    reader.close();
  }
};

/** Removes a deployed stage through its Provider, after confirmation. */
export const removeProject = async (
  options: {
    config: VokeConfig;
    output?: CliOutput;
    region?: string;
    stage: string;
    yes?: boolean;
  },
  cli: CliOptions = {}
): Promise<"absent" | "removed"> => {
  const output = options.output ?? console.log;
  const config = defineConfig({ ...options.config, stage: options.stage });
  const removeFromProvider = config.provider?.deploy?.remove;

  if (removeFromProvider === undefined) {
    throw new CliUsageError(
      config.provider === undefined
        ? missingProviderMessage(config.name)
        : `Provider "${config.provider.name}" does not support remove.`
    );
  }

  if (options.yes !== true) {
    const target = `${config.name}-${options.stage}`;
    const interactive = cli.interactive ?? process.stdin.isTTY === true;

    if (!interactive) {
      throw new CliUsageError(
        `voke remove deletes ${target} and its resources. Run it in a terminal to confirm, or pass --yes.`
      );
    }

    const answer = await (cli.confirm ?? readConfirmation)(
      `This deletes ${target} and its resources. Type ${target} to confirm: `
    );

    if (answer.trim() !== target) {
      throw new CliUsageError(`Removal cancelled; ${target} was not changed.`);
    }
  }

  const { status } = await removeFromProvider({
    config,
    output,
    region: options.region,
    stage: options.stage,
  });

  output(
    status === "absent"
      ? "Nothing to remove"
      : `Removed ${config.name}-${options.stage}`
  );

  return status;
};

export const dev = async (
  config: VokeConfig,
  options: {
    endpoint?: string;
    entrypoint?: string;
    hostname?: string;
    port?: number;
    region?: string;
    run?: CommandRunner;
    stage?: string;
  } = {}
): Promise<void> => {
  const plan = await createDevPlan(config, {
    endpoint: options.endpoint,
    entrypoint: options.entrypoint,
    hostname: options.hostname,
    port: options.port,
    region: options.region,
    stage: options.stage,
  });

  await (options.run ?? runCommand)(plan.command, {
    env: plan.environment,
    stdoutFilter: hideBunDevelopmentServerBanner,
    unsetEnv: plan.unsetEnvironment,
  });
};

type LocalSubcommand = (typeof localSubcommands)[number];

const isLocalSubcommand = (
  value: string | undefined
): value is LocalSubcommand =>
  localSubcommands.includes(value as LocalSubcommand);

/** `voke local <start|stop|reset|bootstrap>`, run by the configured Provider's local workflow. */
export const local = async (
  subcommand: string | undefined,
  flags: ParsedFlags,
  run: CommandRunner = runCommand,
  cwd: string = process.cwd()
): Promise<void> => {
  if (!isLocalSubcommand(subcommand)) {
    throw new CliUsageError("Usage: voke local <start|stop|reset|bootstrap>");
  }

  const loaded = await loadConfigFromFlags(flags, cwd);
  const config = defineConfig({
    ...loaded,
    entrypoint: flags.values.entrypoint ?? loaded.entrypoint,
    name: flags.values.name ?? loaded.name,
    region: flags.values.region ?? loaded.region,
    stage: flags.values.stage ?? loaded.stage,
  });
  assertProviderConfigured(config);

  const workflow = config.provider?.local?.workflow;

  if (workflow === undefined) {
    throw new VokeConfigError(
      `Provider "${config.provider?.name}" does not support voke local.`
    );
  }

  assertKnownFlags("local", flags, Object.keys(workflow.flags ?? {}));
  await workflow[subcommand]({
    config,
    model: createInternalModel(config),
    options: flags.values,
    run,
  });
};

/** `voke remote generate [name]`: one remote when named, otherwise every remote. */
const remote = async (flags: ParsedFlags, cwd: string): Promise<string[]> => {
  const config = await loadConfigFromFlags(flags, cwd);
  const [, name] = flags.positional;

  return await generateRemoteModules(config, {
    names: name === undefined ? undefined : [name],
  });
};

const localResults: Record<LocalSubcommand, string> = {
  bootstrap: "Bootstrapped the local stack",
  reset: "Reset the local environment",
  start: "Started the local environment",
  stop: "Stopped the local environment",
};

/** `Wrote template to <path> (<n> resources)`; the count only when the artifact has `Resources`. */
const synthResultLine = async (out: string): Promise<string> => {
  const artifact = (await Bun.file(out).json()) as { Resources?: unknown };
  const resources =
    typeof artifact.Resources === "object" && artifact.Resources !== null
      ? Object.keys(artifact.Resources).length
      : undefined;

  return `Wrote template to ${out}${resources === undefined ? "" : ` (${resources} resources)`}`;
};

const outputOf = (options: CliOptions): CliOutput =>
  options.output ?? console.log;

const portPattern = /^\d+$/u;
const maxPort = 65_535;

/** `--port`, when given: digits only, from 1 to 65535. */
const portFromFlags = (flags: ParsedFlags): number | undefined => {
  const value = flags.values.port;

  if (value === undefined) {
    return undefined;
  }

  const port = Number(value);

  if (!portPattern.test(value) || port < 1 || port > maxPort) {
    throw new CliUsageError(
      `Invalid value for --port: ${JSON.stringify(value)}. Expected a port number from 1 to 65535.`
    );
  }

  return port;
};

const commandHandlers: Record<string, CommandHandler> = {
  build: async (flags, options) => {
    const cwd = projectDirectory(options);
    const config = await loadConfigFromFlags(flags, cwd);

    assertProviderConfigured(config);

    const entrypoint = flags.positional[0] ?? flags.values.entrypoint;
    const project = await loadProject({ config, cwd, entrypoint });
    const plan = await build(config, {
      configPath: await configPathFromFlags(flags, cwd),
      entrypoint: entrypoint ?? config.entrypoint,
      functions: project.functions,
      outdir: flags.positional[1] ?? flags.values.outdir,
      run: options.run ?? runCommand,
    });

    outputOf(options)(`Built ${plan.outdir}`);
  },
  create: async (flags, options) => {
    const [name, directory] = flags.positional;

    if (name === "api" && directory !== undefined) {
      throw new CliUsageError(
        '"voke create api" was replaced by: voke create <name> [directory]'
      );
    }

    await createProject({
      directory,
      force: isFlagSet(flags, "force"),
      install: !isFlagSet(flags, "no-install"),
      // assertPositionals has checked the required name.
      name: name ?? "",
      output: outputOf(options),
      run: options.run ?? runCommand,
    });
  },
  deploy: async (flags, options) => {
    const cwd = projectDirectory(options);
    const config = await loadConfigFromFlags(flags, cwd);

    assertProviderConfigured(config);

    const project = await loadProject({ config, cwd });

    await deployProject({
      acceptDataLoss: isFlagSet(flags, "accept-data-loss"),
      config,
      configPath: await configPathFromFlags(flags, cwd),
      cwd,
      dryRun: isFlagSet(flags, "dry-run"),
      functions: project.functions,
      output: options.output,
      region: flags.values.region,
      run: options.run ?? runCommand,
      stage: resolveStage(flags, config),
    });
  },
  dev: async (flags, options) => {
    const config = await loadConfigFromFlags(flags, projectDirectory(options));

    if (config.provider === undefined) {
      outputOf(options)(`Note: ${missingProviderMessage(config.name)}`);
    }

    await dev(config, {
      endpoint: flags.values.endpoint,
      entrypoint: flags.positional[0] ?? flags.values.entrypoint,
      hostname: flags.values.hostname,
      port: portFromFlags(flags),
      region: flags.values.region,
      run: options.run ?? runCommand,
      stage: flags.values.stage,
    });
  },
  doctor: async (flags, options) => {
    const result = await runDoctor({
      configPath: flags.values.config,
      cwd: projectDirectory(options),
      output: outputOf(options),
    });

    if (result.failed) {
      throw new VokeError(
        "voke doctor found problems; see the fail rows above.",
        {
          code: "CONFIG_ERROR",
        }
      );
    }
  },
  local: async (flags, options) => {
    const [subcommand] = flags.positional;

    await local(
      subcommand,
      flags,
      options.run ?? runCommand,
      projectDirectory(options)
    );
    outputOf(options)(localResults[subcommand as LocalSubcommand]);
  },
  migrate: async (flags, options) => {
    const { blockingTasks, directory } = await migrateServerless({
      positional: flags.positional.slice(1),
      values: flags.values,
    });
    const output = outputOf(options);

    output(`Wrote migration skeleton to ${directory}`);

    if (blockingTasks.length > 0) {
      output(
        `${blockingTasks.length} blocking task(s) in ${directory}/MIGRATION_REPORT.md:`
      );

      for (const task of blockingTasks) {
        output(`- ${task.message}`);
      }
    }
  },
  remote: async (flags, options) => {
    const paths = await remote(flags, projectDirectory(options));

    for (const path of paths) {
      outputOf(options)(`Wrote ${path}`);
    }
  },
  remove: async (flags, options) => {
    const config = await loadConfigFromFlags(flags, projectDirectory(options));

    assertProviderConfigured(config);

    await removeProject(
      {
        config,
        output: options.output,
        region: flags.values.region,
        stage: resolveStage(flags, config),
        yes: isFlagSet(flags, "yes"),
      },
      options
    );
  },
  synth: async (flags, options) => {
    const cwd = projectDirectory(options);
    const config = await loadConfigFromFlags(flags, cwd);

    assertProviderConfigured(config);

    const entrypoint = flags.positional[0] ?? flags.values.entrypoint;
    const project = await loadProject({ config, cwd, entrypoint });
    const out = await synth({
      config,
      entrypoint,
      functions: project.functions,
      name: flags.values.name,
      out: flags.positional[1] ?? flags.values.out,
      region: flags.values.region,
      stage: flags.values.stage,
    });

    outputOf(options)(await synthResultLine(out));
  },
};

// Provider-declared flags are checked by the command itself, once the config is loaded.
const commandsWithProviderFlags = new Set(["local"]);

const withUsage = (error: unknown, command: string): unknown =>
  error instanceof CliUsageError &&
  !error.message.startsWith("Invalid CLI usage:")
    ? new CliUsageError(cliUsageMessage(error.message, command))
    : error;

// Help lists Plugin commands when ./voke.config.ts loads; a config that fails to load never
// breaks help, which then lists the built-in commands only.
const helpPlugins = async (cwd: string): Promise<readonly VokePlugin[]> => {
  const path = resolve(cwd, "voke.config.ts");

  try {
    if (!(await Bun.file(path).exists())) {
      return [];
    }

    const config = await loadVokeConfig({ path });

    return config.plugins;
  } catch {
    return [];
  }
};

const printTopLevel = async (
  command: string | undefined,
  args: string[],
  output: CliOutput,
  cwd: string
): Promise<boolean> => {
  if (command === undefined || command === "--help" || command === "-h") {
    output(formatHelp(await helpPlugins(cwd)));
    return true;
  }

  if (command === "--version" || command === "-v") {
    output(`voke ${packageJson.version}`);
    return true;
  }

  if (command === "help") {
    output(
      args[0] === undefined
        ? formatHelp(await helpPlugins(cwd))
        : formatCommandHelp(args[0])
    );
    return true;
  }

  return false;
};

const unknownCommandError = (command: string | undefined): CliUsageError =>
  new CliUsageError(
    cliUsageMessage(`Unknown command: ${command}`, command ?? "")
  );

/** `--config <path>` or `--config=<path>` from raw arguments, before the command is known. */
const configFlagValue = (args: readonly string[]): string | undefined => {
  for (const [index, arg] of args.entries()) {
    if (arg === "--config") {
      return args[index + 1];
    }

    if (arg.startsWith("--config=")) {
      return arg.slice("--config=".length);
    }
  }

  return undefined;
};

// `voke <plugin> <command>`: built-in commands win, so this runs only for an unknown command name.
const runPluginCommand = async (
  name: string,
  args: string[],
  options: CliOptions
): Promise<void> => {
  const output = outputOf(options);
  const cwd = projectDirectory(options);
  const configPath = configFlagValue(args) ?? "voke.config.ts";

  if (!(await Bun.file(resolve(cwd, configPath)).exists())) {
    throw unknownCommandError(name);
  }

  const config = await loadVokeConfig({ cwd, path: configPath });
  const plugin = config.plugins.find(
    (candidate) => candidate.name === name && candidate.cli !== undefined
  );

  if (plugin === undefined) {
    throw unknownCommandError(name);
  }

  const [subcommand, ...rest] = args;

  // `voke docs`, `voke docs --help` and `voke docs --config x` print the Plugin's commands.
  if (subcommand === undefined || subcommand.startsWith("-")) {
    output(formatPluginHelp(plugin));
    return;
  }

  const command = plugin.cli?.commands[subcommand];

  if (command === undefined) {
    throw new CliUsageError(
      `Invalid CLI usage: Unknown command: ${name} ${subcommand}\nRun \`voke ${name} --help\` to see its commands.`
    );
  }

  const key = `${name} ${subcommand}`;
  const specs = pluginCommandSpecs(plugin, subcommand, command);

  if (isHelpRequest(rest)) {
    output(formatCommandHelp(key, specs));
    return;
  }

  try {
    const flags = parseFlags(key, rest, specs);

    assertKnownFlags(key, flags, [], specs);
    assertPositionals(key, flags, specs);
    printRunDetails([name, ...args], options);
    await command.run({
      config,
      cwd,
      flags: flags.values,
      loadFunctions: async () => {
        const project = await loadProject({ config, cwd });

        return functionRegistryEntries(project.functions);
      },
      output,
      positional: flags.positional,
    });
  } catch (error) {
    throw error instanceof CliUsageError &&
      !error.message.startsWith("Invalid CLI usage:")
      ? new CliUsageError(cliUsageMessage(error.message, key, specs))
      : error;
  }
};

export const runCli = async (
  argv: string[] = Bun.argv.slice(2),
  options: CliOptions = {}
): Promise<void> => {
  const [command, ...args] = argv;
  const output = outputOf(options);

  if (await printTopLevel(command, args, output, projectDirectory(options))) {
    return;
  }

  const handler = command === undefined ? undefined : commandHandlers[command];

  if (command === undefined) {
    throw unknownCommandError(command);
  }

  if (handler === undefined) {
    await runPluginCommand(command, args, options);
    return;
  }

  if (isHelpRequest(args)) {
    output(formatCommandHelp(command));
    return;
  }

  try {
    const flags = parseFlags(command, args);

    if (!commandsWithProviderFlags.has(command)) {
      assertKnownFlags(command, flags);
    }

    assertPositionals(command, flags);
    printRunDetails(argv, options);
    await handler(flags, options);
  } catch (error) {
    throw withUsage(error, command);
  }
};

if (import.meta.main) {
  try {
    await runCli(undefined, { showDetails: false });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Every command awaits its work, so exit even if an SDK left a socket or timer open.
  process.exit(0);
}
