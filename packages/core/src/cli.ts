#!/usr/bin/env bun

import packageJson from "../package.json";
import { createBuildPlan } from "./build";
import { synthesizeCloudFormation } from "./cloudformation";
import { defineConfig, loadVokeConfig } from "./config";
import type { VokeConfig } from "./config";
import { createDevPlan } from "./dev";
import { VokeError } from "./errors";
import { createLocalBootstrapPlan, LocalProviderError } from "./local";
import type { LocalProvider } from "./local";
import { generateRemoteModules } from "./remote";
import { writeServerlessMigration } from "./serverless-migration";

interface CreateApiProjectOptions {
  name: string;
  directory?: string;
}

interface CliOptions {
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
}

interface ParsedFlags {
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
  voke remote generate [name]
  voke local start [--compose .voke/local/docker-compose.yml]
  voke local stop [--compose .voke/local/docker-compose.yml]
  voke local reset [--compose .voke/local/docker-compose.yml]
  voke local bootstrap --name api [--stage local]
  voke migrate serverless [serverless.yml] [--out ./voke-migration]

Experimental:
  voke experimental deploy --name api [--stage local] [--template ./dist/cloudformation.json]
  voke experimental remove --name api [--stage local]
`);
};

const commandName = (argv: string[]): string => {
  const [command, subcommand] = argv;

  if (command === "experimental" && subcommand !== undefined) {
    return `${command} ${subcommand}`;
  }

  return command ?? "help";
};

const formatCommand = (argv: string[]): string => ["voke", ...argv].join(" ");

const commandUsage: Record<string, string> = {
  build: "Usage: voke build [entrypoint] [outdir]",
  create: "Usage: voke create api <name> [directory]",
  dev: "Usage: voke dev [entrypoint] [--hostname localhost] [--port 3000]",
  experimental:
    "Usage: voke experimental <deploy|remove> [--config voke.config.ts]",
  local: "Usage: voke local <start|stop|reset|bootstrap>",
  migrate:
    "Usage: voke migrate serverless [serverless.yml] [--out ./voke-migration]",
  remote: "Usage: voke remote generate [name]",
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

const stackName = (name: string, stage: string): string => `${name}-${stage}`;

const writeLocalCompose = async (
  config: VokeConfig,
  compose: string,
  flags: ParsedFlags
): Promise<void> => {
  const directory = compose.split("/").slice(0, -1).join("/");

  if (directory !== "") {
    await Bun.$`mkdir -p ${directory}`;
  }

  await Bun.write(
    compose,
    config.local.provider.composeConfig({
      dataDirectory: flags.values.data ?? ".voke/local/data",
      hostname: flags.values.hostname,
      image: flags.values.image,
      port:
        flags.values.port === undefined ? undefined : Number(flags.values.port),
      region: flags.values.region,
    })
  );
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

const runCommand = async (
  command: string[],
  options: CommandRunOptions = {}
): Promise<void> => {
  const stdout = options.stdoutFilter === undefined ? "inherit" : "pipe";
  const process = Bun.spawn(command, {
    env: {
      ...Bun.env,
      ...options.env,
    },
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

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const localProviderErrorMessage = (options: {
  provider: LocalProvider;
  localCommand: string;
  command: string[];
  cause: unknown;
}): string => {
  const commandText = options.command.join(" ");
  const base = `Voke local ${options.localCommand} failed while running: ${commandText}. ${errorMessage(options.cause)}`;

  if (options.provider.name !== "floci") {
    return `${base}\nLocal provider: ${options.provider.name}. Check this provider's local command configuration.`;
  }

  if (options.localCommand === "bootstrap") {
    return `${base}\nFloci is Voke's default optional local AWS provider. Make sure Floci is running with "voke local start", then retry "voke local bootstrap". You can also configure local.provider in voke.config.ts.`;
  }

  return `${base}\nFloci is Voke's default optional local AWS provider. Make sure Docker Compose is installed and Docker is running, then retry "voke local ${options.localCommand}". You can also configure local.provider in voke.config.ts.`;
};

const runLocalProviderCommand = async (options: {
  provider: LocalProvider;
  localCommand: string;
  command: string[];
  run: CommandRunner;
  env?: Record<string, string>;
}): Promise<void> => {
  try {
    await options.run(options.command, { env: options.env });
  } catch (error) {
    throw new LocalProviderError({
      cause: error,
      command: options.command,
      message: localProviderErrorMessage({
        cause: error,
        command: options.command,
        localCommand: options.localCommand,
        provider: options.provider,
      }),
      provider: options.provider.name,
    });
  }
};

const createTestTemplate =
  (): string => `import { expect, test } from "bun:test";
import { createTestClient } from "voke";

import service from "../src/index";

test("responds to health checks", async () => {
  const client = createTestClient(service);
  const response = await client.get("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { ok: true } });
});
`;

const createHealthRouteTemplate =
  (): string => `import type { Voke } from "voke";

export const createHealthRoute = (app: Voke) =>
  app.get("/health", {
    handler: () => ({ ok: true }),
  });
`;

const createVokeConfigTemplate = (
  name: string
): string => `import { defineConfig } from "voke";

export default defineConfig({
  build: {
    outdir: "./dist",
  },
  cloudFormation: {
    out: "./dist/cloudformation.json",
  },
  entrypoint: "./src/index.ts",
  name: "${name}",
});
`;

const createIndexTemplate =
  (): string => `import { api, createGateway, defineFunction, defineFunctions, Voke } from "voke";
import config from "../voke.config";
import { createHealthRoute } from "./routes/health";

const app = new Voke();
const functions = defineFunctions({
  routes: defineFunction({
    routes: [createHealthRoute(app)],
  }),
});

const gateway = createGateway({
  config: { ...config, functions },
});

export default api(gateway, { config });
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

export const remove = async (options: {
  name: string;
  stage: string;
  region: string;
  run?: CommandRunner;
}): Promise<void> => {
  await (options.run ?? runCommand)([
    "aws",
    "cloudformation",
    "delete-stack",
    "--stack-name",
    stackName(options.name, options.stage),
    "--region",
    options.region,
  ]);
};

export const deploy = async (options: {
  name: string;
  stage: string;
  region: string;
  template: string;
  run?: CommandRunner;
}): Promise<void> => {
  await (options.run ?? runCommand)([
    "aws",
    "cloudformation",
    "deploy",
    "--stack-name",
    stackName(options.name, options.stage),
    "--template-file",
    options.template,
    "--capabilities",
    "CAPABILITY_IAM",
    "--region",
    options.region,
  ]);
};

export const synth = async (options: {
  config?: VokeConfig;
  name?: string;
  stage?: string;
  region?: string;
  entrypoint?: string;
  out?: string;
}): Promise<string> => {
  const config = defineConfig({
    ...(options.config ?? { name: "api" }),
    entrypoint: options.entrypoint ?? options.config?.entrypoint,
    name: options.name ?? options.config?.name ?? "api",
    region: options.region ?? options.config?.region,
    stage: options.stage ?? options.config?.stage,
  });
  const template = synthesizeCloudFormation({
    ...config,
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
    entrypoints?: string[];
    outdir?: string;
    run?: CommandRunner;
  } = {}
): Promise<void> => {
  const plan = createBuildPlan(config, {
    entrypoints: options.entrypoints,
    outdir: options.outdir,
  });

  await (options.run ?? runCommand)(plan.command);
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
  });
};

export const local = async (
  subcommand: string | undefined,
  flags: ParsedFlags,
  run: CommandRunner = runCommand
): Promise<void> => {
  const compose = flags.values.compose ?? ".voke/local/docker-compose.yml";
  const config = await loadConfigFromFlags(flags);
  const {
    local: { provider },
  } = config;

  if (subcommand === "start") {
    await writeLocalCompose(config, compose, flags);
    await runLocalProviderCommand({
      command: provider.startCommand({ composePath: compose }),
      localCommand: "start",
      provider,
      run,
    });
    return;
  }

  if (subcommand === "stop") {
    await runLocalProviderCommand({
      command: provider.stopCommand({ composePath: compose }),
      localCommand: "stop",
      provider,
      run,
    });
    return;
  }

  if (subcommand === "reset") {
    await runLocalProviderCommand({
      command: provider.resetCommand({ composePath: compose }),
      localCommand: "reset",
      provider,
      run,
    });
    return;
  }

  if (subcommand === "bootstrap") {
    const name = flags.values.name ?? config.name;
    const stage = flags.values.stage ?? config.stage;
    const region = flags.values.region ?? config.region;
    const templatePath =
      flags.values.template ?? ".voke/local/cloudformation.json";
    const plan = await createLocalBootstrapPlan({
      config: {
        ...config,
        entrypoint: flags.values.entrypoint ?? config.entrypoint,
      },
      endpoint: flags.values.endpoint,
      name,
      region,
      stage,
      templatePath,
    });

    for (const command of plan.commands) {
      await runLocalProviderCommand({
        command,
        env: plan.environment,
        localCommand: "bootstrap",
        provider,
        run,
      });
    }
    return;
  }

  throw new CliUsageError("Usage: voke local <start|stop|reset|bootstrap>");
};

const experimental = async (
  subcommand: string | undefined,
  flags: ParsedFlags,
  options: CliOptions
): Promise<void> => {
  const config = await loadConfigFromFlags(flags);

  if (subcommand === "deploy") {
    await deploy({
      name: flags.values.name ?? config.name,
      region: flags.values.region ?? config.region,
      run: options.run ?? runCommand,
      stage: flags.values.stage ?? config.stage,
      template: flags.values.template ?? config.cloudFormation.out,
    });
    return;
  }

  if (subcommand === "remove") {
    await remove({
      name: flags.values.name ?? config.name,
      region: flags.values.region ?? config.region,
      run: options.run ?? runCommand,
      stage: flags.values.stage ?? config.stage,
    });
    return;
  }

  throw new CliUsageError(
    "Usage: voke experimental <deploy|remove> [--config voke.config.ts]"
  );
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

    await build(config, {
      entrypoints: entrypoint === undefined ? undefined : [entrypoint],
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
  experimental: async (args, flags, options) => {
    await experimental(args[0], flags, options);
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
  synth: async (_args, flags) => {
    const config = await loadConfigFromFlags(flags);
    await synth({
      config,
      entrypoint: flags.values.entrypoint ?? flags.positional[0],
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

  if (command === "deploy" || command === "remove") {
    throw new CliUsageError(
      `Deployment commands are experimental. Use: voke experimental ${command}`
    );
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
