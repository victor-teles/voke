#!/usr/bin/env bun

import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import packageJson from "../package.json";
import { defineConfig, loadVokeConfig } from "./config";
import type { VokeConfig } from "./config";
import { createDevPlan } from "./dev";
import { VokeConfigError, VokeError } from "./errors";
import type { FunctionRegistry, FunctionRegistryInput } from "./invoke";
import { createInternalModel } from "./model";
import { loadProject } from "./project";
import type { BuildPlan, ProviderDeployResult } from "./provider";
import { generateRemoteModules } from "./remote";
import { readEnv } from "./runtime-env";
import { writeServerlessMigration } from "./serverless-migration";

interface CreateApiProjectOptions {
  name: string;
  directory?: string;
}

interface CliOptions {
  /** Reads one line of confirmation; defaults to the terminal. */
  confirm?: (prompt: string) => Promise<string>;
  /** Whether the CLI may prompt; defaults to whether stdin is a terminal. */
  interactive?: boolean;
  output?: CliOutput;
  run?: CommandRunner;
  showDetails?: boolean;
}

type CliOutput = (message: string) => void;

type CommandRunner = (
  command: string[],
  options?: CommandRunOptions
) => void | Promise<void>;

interface CommandRunOptions {
  env?: Record<string, string>;
  stdoutFilter?: (line: string) => boolean;
  /** Names removed from the inherited environment before `env` is applied. */
  unsetEnv?: readonly string[];
}

export interface ParsedFlags {
  values: Record<string, string>;
  positional: string[];
}

type CommandHandler = (
  args: string[],
  flags: ParsedFlags,
  options: CliOptions
) => Promise<void>;

export class CliUsageError extends VokeError {
  constructor(message: string) {
    super(message, { code: "CLI_USAGE_ERROR" });
    this.name = "CliUsageError";
  }
}

const printHelp = (): void => {
  console.log(`Voke v${packageJson.version}

Usage:
  voke dev [entrypoint]
  voke build [entrypoint] [outdir]
  voke create api <name> [directory]
  voke synth [entrypoint] [out] [--config voke.config.ts] [--name api] [--stage local] [--region us-east-1]
  voke deploy [--stage dev] [--region us-east-1] [--config voke.config.ts] [--dry-run]
  voke remove [--stage dev] [--region us-east-1] [--config voke.config.ts] [--yes]
  voke remote generate [name]
  voke local start [--compose .voke/local/docker-compose.yml]
  voke local stop [--compose .voke/local/docker-compose.yml]
  voke local reset [--compose .voke/local/docker-compose.yml]
  voke local bootstrap --name api [--stage local]
  voke migrate serverless [serverless.yml] [--out ./voke-migration]
`);
};

const commandName = (argv: string[]): string => argv[0] ?? "help";

const formatCommand = (argv: string[]): string => ["voke", ...argv].join(" ");

const commandUsage: Record<string, string> = {
  build: "Usage: voke build [entrypoint] [outdir]",
  create: "Usage: voke create api <name> [directory]",
  deploy:
    "Usage: voke deploy [--stage dev] [--region us-east-1] [--config voke.config.ts] [--dry-run]",
  dev: "Usage: voke dev [entrypoint] [--hostname localhost] [--port 3000]",
  local: "Usage: voke local <start|stop|reset|bootstrap>",
  migrate:
    "Usage: voke migrate serverless [serverless.yml] [--out ./voke-migration]",
  remote: "Usage: voke remote generate [name]",
  remove:
    "Usage: voke remove [--stage dev] [--region us-east-1] [--config voke.config.ts] [--yes]",
  synth:
    "Usage: voke synth [entrypoint] [out] [--config voke.config.ts] [--name api] [--stage local] [--region us-east-1]",
};

const cliUsageMessage = (message: string, command: string): string => {
  const usage = commandUsage[command];

  if (usage === undefined) {
    return `Invalid CLI usage: ${message}\nRun \`voke --help\` to see available commands.`;
  }

  return `Invalid CLI usage: ${message}\n${usage}`;
};

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

// Flags that take no value: `--yes` means "true"; `--yes=false` is accepted too.
const booleanFlags = new Set(["dry-run", "force", "help", "verbose", "yes"]);

export const isFlagSet = (flags: ParsedFlags, name: string): boolean =>
  flags.values[name] !== undefined && flags.values[name] !== "false";

const parseFlags = (args: string[]): ParsedFlags => {
  const values: Record<string, string> = {};
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg?.startsWith("--") === true) {
      const [rawKey, inlineValue] = arg.slice(2).split(/[=](.*)/su, 2);
      const key = rawKey ?? "";

      if (key === "") {
        throw new CliUsageError(`Invalid flag: ${arg}`);
      }

      if (inlineValue !== undefined) {
        values[key] = inlineValue;
        continue;
      }

      if (booleanFlags.has(key)) {
        values[key] = "true";
        continue;
      }

      const value = args[index + 1];

      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`Missing value for --${key}`);
      }

      values[key] = value;
      index += 1;
      continue;
    }

    if (arg !== undefined) {
      positional.push(arg);
    }
  }

  return { positional, values };
};

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

const createTestTemplate =
  (): string => `import { expect, test } from "bun:test";
import { createTestClient } from "@voke/testing";

import service from "../src/index";

test("responds to health checks", async () => {
  const client = createTestClient(service);
  const response = await client.get("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { ok: true } });
});
`;

const createHealthRouteTemplate = (): string => `import { route } from "voke";

export const healthRoute = route.get("/health", {
    handler: () => ({ ok: true }),
  });
`;

const createVokeConfigTemplate = (
  name: string
): string => `import { aws } from "@voke/aws";
import { defineConfig } from "voke";

export default defineConfig({
  build: {
    outdir: "./dist",
  },
  cloudFormation: {
    out: "./dist/cloudformation.json",
  },
  entrypoint: "./src/index.ts",
  name: "${name}",
  provider: aws(),
});
`;

const createIndexTemplate =
  (): string => `import { createFunctions, http, voke } from "voke";
import config from "../voke.config";
import { healthRoute } from "./routes/health";

const functions = createFunctions({
  http: http({
    routes: [healthRoute],
  }),
});

export default voke(functions, { config });
`;

const createTsconfig = (): Record<string, unknown> => ({
  compilerOptions: {
    allowImportingTsExtensions: true,
    lib: ["ESNext", "DOM"],
    module: "Preserve",
    moduleDetection: "force",
    moduleResolution: "bundler",
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: "ESNext",
    types: ["bun"],
    verbatimModuleSyntax: true,
  },
  include: ["voke.config.ts", "src/**/*.ts", "test/**/*.ts"],
});

const createPackageJson = (packageName: string): Record<string, unknown> => ({
  dependencies: {
    "@voke/aws": `^${packageJson.version}`,
    "@voke/testing": `^${packageJson.version}`,
    hono: "^4.0.0",
    voke: `^${packageJson.version}`,
  },
  devDependencies: {
    "@types/bun": "latest",
    "@typescript/native-preview": "^7.0.0-dev.20260516.1",
  },
  name: packageName,
  private: true,
  scripts: {
    build: "voke build",
    clean: "rm -rf dist coverage",
    dev: "voke dev",
    local: "voke local start",
    synth: "voke synth",
    test: "bun test",
    typecheck: "bunx tsgo --project tsconfig.json --noEmit",
  },
  type: "module",
  version: "0.0.0",
});

export const migrateServerless = async (
  flags: ParsedFlags
): Promise<string> => {
  const sourcePath = flags.positional[0] ?? "./serverless.yml";
  const outDirectory =
    flags.values.out ?? flags.positional[1] ?? "./voke-migration";
  const source = await Bun.file(sourcePath).text();

  await writeServerlessMigration({
    outDirectory,
    source,
  });

  return outDirectory;
};

const loadConfigFromFlags = async (flags: ParsedFlags): Promise<VokeConfig> => {
  const configPath = flags.values.config ?? "voke.config.ts";

  if (await Bun.file(configPath).exists()) {
    return loadVokeConfig({ path: configPath });
  }

  if (flags.values.config !== undefined) {
    return loadVokeConfig({ path: configPath });
  }

  return defineConfig({
    entrypoint: flags.values.entrypoint,
    name: flags.values.name ?? "api",
    region: flags.values.region,
    stage: flags.values.stage,
  });
};

export const createApiProject = async (
  options: CreateApiProjectOptions
): Promise<string> => {
  const directory = options.directory ?? `./${options.name}`;
  const packageName = options.name.includes("/")
    ? options.name
    : `@voke/${options.name}`;

  await Bun.$`mkdir -p ${directory}/src/routes ${directory}/test`;

  await Bun.write(
    `${directory}/package.json`,
    `${JSON.stringify(createPackageJson(packageName), null, 2)}\n`
  );
  await Bun.write(
    `${directory}/tsconfig.json`,
    `${JSON.stringify(createTsconfig(), null, 2)}\n`
  );
  await Bun.write(
    `${directory}/voke.config.ts`,
    createVokeConfigTemplate(options.name)
  );
  await Bun.write(`${directory}/src/index.ts`, createIndexTemplate());
  await Bun.write(
    `${directory}/src/routes/health.ts`,
    createHealthRouteTemplate()
  );
  await Bun.write(`${directory}/test/api.test.ts`, createTestTemplate());

  return directory;
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
        ? "No provider configured for synthesis."
        : `Provider "${config.provider.name}" does not support synthesis.`
    );
  }

  const template = synthesize({
    config,
    model: createInternalModel({ ...config, functions: options.functions }),
  });
  const out = options.out ?? config.cloudFormation.out;
  const directory = out.split("/").slice(0, -1).join("/");

  if (directory !== "") {
    await Bun.$`mkdir -p ${directory}`;
  }

  await Bun.write(out, `${JSON.stringify(template, null, 2)}\n`);

  return out;
};

export const build = async (
  config: VokeConfig,
  options: {
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
        ? "No provider configured for build."
        : `Provider "${config.provider.name}" does not support build.`
    );
  }

  const plan = createPlan({
    build:
      options.outdir === undefined
        ? config.build
        : { ...config.build, outdir: options.outdir },
    config,
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
  config: VokeConfig;
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
  const cwd = options.cwd ?? readEnv("PWD") ?? ".";

  assertDeployableStage(options.stage);

  const config = defineConfig({ ...options.config, stage: options.stage });
  const deployToProvider = config.provider?.deploy?.deploy;

  if (deployToProvider === undefined) {
    throw new CliUsageError(
      config.provider === undefined
        ? "No provider configured for deploy. Set provider: aws() in voke.config.ts."
        : `Provider "${config.provider.name}" does not support deploy.`
    );
  }

  output(`Building ${config.name} (${options.stage})`);
  const plan = await build(config, {
    entrypoint: options.entrypoint,
    functions: options.functions,
    run: options.run,
  });
  const artifact = await artifactFilesOf(plan, cwd);
  const result = await deployToProvider({
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
        ? "No provider configured for remove. Set provider: aws() in voke.config.ts."
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

const localSubcommands = ["start", "stop", "reset", "bootstrap"] as const;

type LocalSubcommand = (typeof localSubcommands)[number];

const isLocalSubcommand = (
  value: string | undefined
): value is LocalSubcommand =>
  localSubcommands.includes(value as LocalSubcommand);

/** `voke local <start|stop|reset|bootstrap>`, run by the configured Provider's local workflow. */
export const local = async (
  subcommand: string | undefined,
  flags: ParsedFlags,
  run: CommandRunner = runCommand
): Promise<void> => {
  if (!isLocalSubcommand(subcommand)) {
    throw new CliUsageError("Usage: voke local <start|stop|reset|bootstrap>");
  }

  const loaded = await loadConfigFromFlags(flags);
  const config = defineConfig({
    ...loaded,
    entrypoint: flags.values.entrypoint ?? loaded.entrypoint,
    name: flags.values.name ?? loaded.name,
    region: flags.values.region ?? loaded.region,
    stage: flags.values.stage ?? loaded.stage,
  });
  const workflow = config.provider?.local?.workflow;

  if (workflow === undefined) {
    throw new VokeConfigError(
      config.provider === undefined
        ? "No provider configured for voke local."
        : `Provider "${config.provider.name}" does not support voke local.`
    );
  }

  await workflow[subcommand]({
    config,
    model: createInternalModel(config),
    options: flags.values,
    run,
  });
};

const remote = async (
  subcommand: string | undefined,
  flags: ParsedFlags
): Promise<void> => {
  if (subcommand !== "generate") {
    throw new CliUsageError("Usage: voke remote generate [name]");
  }

  const config = await loadConfigFromFlags(flags);
  await generateRemoteModules(config, {
    names:
      flags.positional.length === 0 ? undefined : flags.positional.slice(1),
  });
};

const commandHandlers: Record<string, CommandHandler> = {
  build: async (_args, flags, options) => {
    const config = await loadConfigFromFlags(flags);
    const entrypoint = flags.positional[0] ?? flags.values.entrypoint;
    const project = await loadProject({ config, entrypoint });

    await build(config, {
      entrypoint: entrypoint ?? config.entrypoint,
      functions: project.functions,
      outdir: flags.positional[1] ?? flags.values.outdir,
      run: options.run ?? runCommand,
    });
  },
  create: async (args) => {
    if (args[0] !== "api") {
      throw new CliUsageError("Usage: voke create api <name> [directory]");
    }

    const [, name, directory] = args;

    if (name === undefined) {
      throw new CliUsageError("Usage: voke create api <name> [directory]");
    }

    await createApiProject({ directory, name });
  },
  deploy: async (_args, flags, options) => {
    const config = await loadConfigFromFlags(flags);
    const project = await loadProject({ config });

    await deployProject({
      config,
      dryRun: isFlagSet(flags, "dry-run"),
      functions: project.functions,
      output: options.output,
      region: flags.values.region,
      run: options.run ?? runCommand,
      stage: resolveStage(flags, config),
    });
  },
  dev: async (_args, flags, options) => {
    const config = await loadConfigFromFlags(flags);
    await dev(config, {
      endpoint: flags.values.endpoint,
      entrypoint: flags.positional[0] ?? flags.values.entrypoint,
      hostname: flags.values.hostname,
      port:
        flags.values.port === undefined ? undefined : Number(flags.values.port),
      region: flags.values.region,
      run: options.run ?? runCommand,
      stage: flags.values.stage,
    });
  },
  local: async (args, flags, options) => {
    await local(args[0], flags, options.run ?? runCommand);
  },
  migrate: async (args) => {
    if (args[0] !== "serverless") {
      throw new CliUsageError(
        "Usage: voke migrate serverless [serverless.yml] [--out ./voke-migration]"
      );
    }

    await migrateServerless(parseFlags(args.slice(1)));
  },
  remote: async (args, flags) => {
    await remote(args[0], {
      positional: args,
      values: flags.values,
    });
  },
  remove: async (_args, flags, options) => {
    const config = await loadConfigFromFlags(flags);

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
  synth: async (_args, flags) => {
    const config = await loadConfigFromFlags(flags);
    const entrypoint = flags.values.entrypoint ?? flags.positional[0];
    const project = await loadProject({ config, entrypoint });

    await synth({
      config,
      entrypoint,
      functions: project.functions,
      name: flags.values.name,
      out: flags.values.out ?? flags.positional[1],
      region: flags.values.region,
      stage: flags.values.stage,
    });
  },
};

export const runCli = async (
  argv: string[] = Bun.argv.slice(2),
  options: CliOptions = {}
): Promise<void> => {
  const [command, ...args] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  let flags: ParsedFlags;

  try {
    flags = parseFlags(args);
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw new CliUsageError(cliUsageMessage(error.message, command));
    }

    throw error;
  }

  const handler = commandHandlers[command];

  if (handler !== undefined) {
    printRunDetails(argv, options);
    try {
      await handler(args, flags, options);
    } catch (error) {
      if (
        error instanceof CliUsageError &&
        !error.message.startsWith("Invalid CLI usage:")
      ) {
        throw new CliUsageError(cliUsageMessage(error.message, command));
      }

      throw error;
    }
    return;
  }

  throw new CliUsageError(
    cliUsageMessage(`Unknown command: ${command}`, command)
  );
};

if (import.meta.main) {
  try {
    await runCli(undefined, { showDetails: false });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
