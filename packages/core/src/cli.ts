#!/usr/bin/env bun

import { synthesizeCloudFormation } from "./cloudformation";
import { defineConfig, loadVokeConfig } from "./config";
import type { VokeConfig } from "./config";
import { createFlociComposeConfig, createLocalBootstrapPlan } from "./local";
import { writeServerlessMigration } from "./serverless-migration";

interface CreateApiProjectOptions {
  name: string;
  directory?: string;
}

interface CliOptions {
  run?: CommandRunner;
}

type CommandRunner = (
  command: string[],
  options?: CommandRunOptions
) => void | Promise<void>;

interface CommandRunOptions {
  env?: Record<string, string>;
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

const printHelp = (): void => {
  console.log(`Voke

Usage:
  voke dev [entrypoint]
  voke build [entrypoint] [outdir]
  voke create api <name> [directory]
  voke synth [entrypoint] [out] [--config voke.config.ts] [--name api] [--stage local] [--region us-east-1]
  voke deploy --name api [--stage local] [--template ./dist/cloudformation.json]
  voke remove --name api [--stage local]
  voke local start [--compose .voke/local/docker-compose.yml]
  voke local stop [--compose .voke/local/docker-compose.yml]
  voke local reset [--compose .voke/local/docker-compose.yml]
  voke local bootstrap --name api [--stage local]
  voke migrate serverless [serverless.yml] [--out ./voke-migration]
`);
};

const parseFlags = (args: string[]): ParsedFlags => {
  const values: Record<string, string> = {};
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg?.startsWith("--") === true) {
      const key = arg.slice(2);
      const value = args[index + 1];

      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for --${key}`);
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

const writeFlociCompose = async (
  compose: string,
  flags: ParsedFlags
): Promise<void> => {
  const directory = compose.split("/").slice(0, -1).join("/");

  if (directory !== "") {
    await Bun.$`mkdir -p ${directory}`;
  }

  await Bun.write(
    compose,
    createFlociComposeConfig({
      dataDirectory: flags.values.data ?? ".voke/local/data",
      hostname: flags.values.hostname,
      image: flags.values.image,
      port:
        flags.values.port === undefined ? undefined : Number(flags.values.port),
      region: flags.values.region,
    })
  );
};

const runCommand = async (
  command: string[],
  options: CommandRunOptions = {}
): Promise<void> => {
  const process = Bun.spawn(command, {
    env: {
      ...Bun.env,
      ...options.env,
    },
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
};

const createTestTemplate =
  (): string => `import { expect, test } from "bun:test";
import { handler } from "../src/index";

test("responds to health checks", async () => {
  const response = await handler({
    rawPath: "/health",
    requestContext: {
      http: {
        method: "GET",
        path: "/health",
      },
    },
  });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ data: { ok: true } });
});
`;

const createHealthRouteTemplate = (): string => `import { Hono } from "hono";
import { json } from "voke";

export const healthRoutes = new Hono();

healthRoutes.get("/health", () => json({ ok: true }));
`;

const createVokeConfigTemplate = (
  name: string
): string => `import { defineConfig } from "voke";

export default defineConfig({
  name: "${name}",
  entrypoint: "./src/index.ts",
  build: {
    outdir: "./dist",
  },
  cloudFormation: {
    out: "./dist/cloudformation.json",
  },
});
`;

const createIndexTemplate =
  (): string => `import { api, createApiApp } from "voke";
import config from "../voke.config";
import { healthRoutes } from "./routes/health";

const app = createApiApp({
  config,
});

app.route("/", healthRoutes);

const service = api(app, { config });

export const handler = service.handler;
export default service;
`;

const createTsconfig = (): Record<string, unknown> => ({
  extends: "../../tsconfig.json",
  include: ["voke.config.ts", "src/**/*.ts", "test/**/*.ts"],
});

const createPackageJson = (packageName: string): Record<string, unknown> => ({
  dependencies: {
    hono: "^4.0.0",
    voke: "workspace:*",
  },
  devDependencies: {
    "@types/bun": "latest",
    "@typescript/native-preview": "^7.0.0-dev.20260516.1"
  },
  name: packageName,
  private: true,
  scripts: {
    build: "voke build ./src/index.ts ./dist",
    clean: "rm -rf dist coverage",
    dev: "voke dev ./src/index.ts",
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
  entrypoint: string,
  outdir: string
): Promise<void> => {
  await Bun.$`bun build ${entrypoint} --outdir ${outdir} --target bun`;
};

export const dev = async (entrypoint: string): Promise<void> => {
  await Bun.$`bun --hot ${entrypoint}`;
};

export const local = async (
  subcommand: string | undefined,
  flags: ParsedFlags,
  run: CommandRunner = runCommand
): Promise<void> => {
  const compose = flags.values.compose ?? ".voke/local/docker-compose.yml";

  if (subcommand === "start") {
    await writeFlociCompose(compose, flags);
    await run(["docker", "compose", "-f", compose, "up", "-d"]);
    return;
  }

  if (subcommand === "stop") {
    await run(["docker", "compose", "-f", compose, "down"]);
    return;
  }

  if (subcommand === "reset") {
    await run(["docker", "compose", "-f", compose, "down", "-v"]);
    return;
  }

  if (subcommand === "bootstrap") {
    const config = await loadConfigFromFlags(flags);
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
      await run(command, { env: plan.environment });
    }
    return;
  }

  throw new Error("Usage: voke local <start|stop|reset|bootstrap>");
};

const commandHandlers: Record<string, CommandHandler> = {
  build: async (args, flags) => {
    const config = await loadConfigFromFlags(flags);
    await build(
      args[0] ?? flags.values.entrypoint ?? config.entrypoint,
      args[1] ?? flags.values.outdir ?? config.build.outdir
    );
  },
  create: async (args) => {
    if (args[0] !== "api") {
      printHelp();
      return;
    }

    const [, name, directory] = args;

    if (name === undefined) {
      throw new Error("Usage: voke create api <name> [directory]");
    }

    await createApiProject({ directory, name });
  },
  deploy: async (_args, flags, options) => {
    await deploy({
      name: flags.values.name ?? "api",
      region: flags.values.region ?? "us-east-1",
      run: options.run ?? runCommand,
      stage: flags.values.stage ?? "local",
      template: flags.values.template ?? "./dist/cloudformation.json",
    });
  },
  dev: async (args, flags) => {
    const config = await loadConfigFromFlags(flags);
    await dev(args[0] ?? flags.values.entrypoint ?? config.entrypoint);
  },
  local: async (args, flags, options) => {
    await local(args[0], flags, options.run ?? runCommand);
  },
  migrate: async (args) => {
    if (args[0] !== "serverless") {
      printHelp();
      return;
    }

    await migrateServerless(parseFlags(args.slice(1)));
  },
  remove: async (_args, flags, options) => {
    await remove({
      name: flags.values.name ?? "api",
      region: flags.values.region ?? "us-east-1",
      run: options.run ?? runCommand,
      stage: flags.values.stage ?? "local",
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
  const flags = parseFlags(args);
  const handler = command === undefined ? undefined : commandHandlers[command];

  if (handler !== undefined) {
    await handler(args, flags, options);
    return;
  }

  printHelp();
};

if (import.meta.main) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
