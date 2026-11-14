import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { floci, LocalProviderError } from "@voke/aws/local";

import { CliUsageError, runCli, runCommand } from "../src/cli";
import { tempPath } from "./support/temp";

const awsIndex = `${import.meta.dir}/../../aws/src/index.ts`;
const awsLocal = `${import.meta.dir}/../../aws/src/local.ts`;
const coreIndex = `${import.meta.dir}/../src/index.ts`;
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const customProviderSource = `{
  name: "custom-local-aws",
  defaults: {
    accountId: "111111111111",
    endpoint: "http://localhost:9999",
    region: "us-west-2",
  },
  environment: (options = {}) => ({
    AWS_ACCESS_KEY_ID: "custom",
    AWS_DEFAULT_REGION: options.region ?? "us-west-2",
    AWS_ENDPOINT_URL: options.endpoint ?? "http://localhost:9999",
    AWS_REGION: options.region ?? "us-west-2",
    AWS_SECRET_ACCESS_KEY: "custom",
    AWS_SESSION_TOKEN: "custom",
    VOKE_AWS_ENDPOINT_URL: options.endpoint ?? "http://localhost:9999",
    VOKE_INVOKE_RUNTIME: "local",
    VOKE_LOCAL_PROVIDER: "custom-local-aws",
  }),
  bindings: "guessed",
  files: ({ options }) => ({ [options.compose]: "services:\\n  custom:\\n    image: custom/aws\\n" }),
  bootstrapPlan: ({ environment, name, templatePath }) => ({
    commands: [["customctl", "apply", name, templatePath]],
    environment,
  }),
  flags: { compose: "Compose file" },
  startCommands: ({ options }) => [["customctl", "start", options.compose]],
  stopCommands: ({ options }) => [["customctl", "stop", options.compose]],
  resetCommands: ({ options }) => [["customctl", "reset", options.compose]],
}`;

/** Writes a voke.config.ts whose Provider is `provider` (source text). */
const writeProject = async (
  name: string,
  provider: string
): Promise<{ configPath: string; directory: string }> => {
  const directory = tempPath(`voke-local-${crypto.randomUUID()}`);
  const configPath = join(directory, "voke.config.ts");

  directories.push(directory);
  await mkdir(directory, { recursive: true });
  await writeFile(
    configPath,
    `import { aws } from "${awsIndex}";
import { floci } from "${awsLocal}";
import { defineConfig } from "${coreIndex}";

export default defineConfig({
  name: ${JSON.stringify(name)},
  provider: ${provider},
});
`
  );

  return { configPath, directory };
};

// Floci's environment is synchronous.
const flociEnvironment = () => floci().environment();

const recordingRunner = () => {
  const calls: { command: string[]; env?: Record<string, string> }[] = [];

  return {
    calls,
    run: (command: string[], options?: { env?: Record<string, string> }) => {
      calls.push({ command, env: options?.env });
    },
  };
};

test("runs local start, stop, reset, and bootstrap through the CLI parser", async () => {
  const { configPath, directory } = await writeProject(
    "configured",
    "aws({ local: floci() })"
  );
  const composePath = join(directory, "docker-compose.yml");
  const templatePath = join(directory, "template.json");
  const { calls, run } = recordingRunner();

  await runCli(
    ["local", "start", "--config", configPath, "--compose", composePath],
    { run }
  );
  await runCli(
    [
      "local",
      "bootstrap",
      "--config",
      configPath,
      "--name",
      "orders-api",
      "--stage",
      "local",
      "--template",
      templatePath,
    ],
    { run }
  );
  await runCli(
    ["local", "stop", "--config", configPath, "--compose", composePath],
    { run }
  );
  await runCli(
    ["local", "reset", "--config", configPath, "--compose", composePath],
    { run }
  );

  expect(await Bun.file(composePath).exists()).toBe(true);
  expect(await Bun.file(templatePath).exists()).toBe(true);
  expect(calls).toEqual([
    {
      command: ["docker", "compose", "-f", composePath, "up", "-d"],
      env: undefined,
    },
    {
      command: [
        "aws",
        "cloudformation",
        "deploy",
        "--stack-name",
        "orders-api-local",
        "--template-file",
        templatePath,
        "--capabilities",
        "CAPABILITY_IAM",
        "--region",
        "us-east-1",
      ],
      env: flociEnvironment(),
    },
    {
      command: ["docker", "compose", "-f", composePath, "down"],
      env: undefined,
    },
    {
      command: ["docker", "compose", "-f", composePath, "down", "-v"],
      env: undefined,
    },
  ]);
});

test("runs CLI local commands through a configured custom Local AWS Provider", async () => {
  const { configPath, directory } = await writeProject(
    "custom-api",
    `aws({ local: ${customProviderSource} })`
  );
  const composePath = join(directory, "compose.yml");
  const templatePath = join(directory, "template.json");
  const { calls, run } = recordingRunner();

  await runCli(
    ["local", "start", "--config", configPath, "--compose", composePath],
    { run }
  );
  await runCli(
    ["local", "bootstrap", "--config", configPath, "--template", templatePath],
    { run }
  );
  await runCli(
    ["local", "stop", "--config", configPath, "--compose", composePath],
    { run }
  );
  await runCli(
    ["local", "reset", "--config", configPath, "--compose", composePath],
    { run }
  );

  expect(await Bun.file(composePath).text()).toBe(
    "services:\n  custom:\n    image: custom/aws\n"
  );
  expect(calls).toEqual([
    {
      command: ["customctl", "start", composePath],
      env: undefined,
    },
    {
      command: ["customctl", "apply", "custom-api", templatePath],
      env: {
        AWS_ACCESS_KEY_ID: "custom",
        AWS_DEFAULT_REGION: "us-east-1",
        AWS_ENDPOINT_URL: "http://localhost:9999",
        AWS_REGION: "us-east-1",
        AWS_SECRET_ACCESS_KEY: "custom",
        AWS_SESSION_TOKEN: "custom",
        VOKE_AWS_ENDPOINT_URL: "http://localhost:9999",
        VOKE_INVOKE_RUNTIME: "local",
        VOKE_LOCAL_PROVIDER: "custom-local-aws",
      },
    },
    {
      command: ["customctl", "stop", composePath],
      env: undefined,
    },
    {
      command: ["customctl", "reset", composePath],
      env: undefined,
    },
  ]);
});

const failingRun = () => {
  throw new Error("docker is not running");
};

test("wraps Floci local start failures with actionable Docker Compose guidance", async () => {
  const { configPath, directory } = await writeProject(
    "orders-api",
    "aws({ local: floci() })"
  );
  const composePath = join(directory, "docker-compose.yml");
  const start = () =>
    runCli(
      ["local", "start", "--config", configPath, "--compose", composePath],
      {
        run: failingRun,
      }
    );

  await expect(start()).rejects.toThrow(LocalProviderError);
  await expect(start()).rejects.toThrow(
    `Voke local start failed while running: docker compose -f ${composePath} up -d. docker is not running
Floci is an optional Local AWS Provider. Make sure Docker Compose is installed and Docker is running, then retry "voke local start". You can also pass another Local AWS Provider: aws({ local: ... })`
  );
});

test("wraps Floci bootstrap failures with start guidance and preserves env", async () => {
  const { configPath, directory } = await writeProject(
    "orders-api",
    "aws({ local: floci() })"
  );
  const templatePath = join(directory, "template.json");
  let commandEnv: Record<string, string> | undefined;

  await expect(
    runCli(
      [
        "local",
        "bootstrap",
        "--config",
        configPath,
        "--stage",
        "local",
        "--template",
        templatePath,
      ],
      {
        run: (_command, options) => {
          commandEnv = options?.env;
          throw new Error("cannot reach local CloudFormation endpoint");
        },
      }
    )
  ).rejects.toThrow(
    `Floci is an optional Local AWS Provider. Make sure Floci is running with "voke local start", then retry "voke local bootstrap". You can also pass another Local AWS Provider: aws({ local: ... })`
  );

  expect(commandEnv).toEqual(flociEnvironment());
});

test("wraps custom Local AWS Provider failures without Floci-specific guidance", async () => {
  const { configPath, directory } = await writeProject(
    "custom-api",
    `aws({ local: ${customProviderSource} })`
  );
  const composePath = join(directory, "compose.yml");

  await expect(
    runCli(
      ["local", "start", "--config", configPath, "--compose", composePath],
      {
        run: () => {
          throw new Error("custom provider unavailable");
        },
      }
    )
  ).rejects.toThrow(
    `Voke local start failed while running: customctl start ${composePath}. custom provider unavailable
Local provider: custom-local-aws. Check this provider's local command configuration.`
  );
});

test("voke local needs a Provider with a local workflow", async () => {
  const withoutProvider = await writeProject("plain", "undefined");
  const withoutWorkflow = await writeProject("neutral", '{ name: "neutral" }');

  await expect(
    runCli(["local", "start", "--config", withoutProvider.configPath], {
      run: () => {},
    })
  ).rejects.toThrow(CliUsageError);
  await expect(
    runCli(["local", "start", "--config", withoutProvider.configPath], {
      run: () => {},
    })
  ).rejects.toThrow(
    "No provider configured. Add a provider to voke.config.ts, for example:"
  );
  await expect(
    runCli(["local", "start", "--config", withoutWorkflow.configPath], {
      run: () => {},
    })
  ).rejects.toThrow('Provider "neutral" does not support voke local.');
});

test("the command runner removes unset variables from the child environment", async () => {
  const directory = tempPath(`voke-unset-env-${crypto.randomUUID()}`);
  const output = join(directory, "env.txt");
  const previous = process.env.VOKE_UNSET_PROBE;

  directories.push(directory);
  await mkdir(directory, { recursive: true });
  process.env.VOKE_UNSET_PROBE = "inherited";

  try {
    await runCommand(
      [
        "bun",
        "-e",
        `await Bun.write(${JSON.stringify(output)}, (process.env.VOKE_UNSET_PROBE ?? "absent") + "|" + process.env.VOKE_SET_PROBE)`,
      ],
      { env: { VOKE_SET_PROBE: "applied" }, unsetEnv: ["VOKE_UNSET_PROBE"] }
    );

    expect(await Bun.file(output).text()).toBe("absent|applied");
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "VOKE_UNSET_PROBE");
    } else {
      process.env.VOKE_UNSET_PROBE = previous;
    }
  }
});
