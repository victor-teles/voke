import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVokeModel, defineConfig } from "voke";
import type { ProviderCommandRunOptions } from "voke";

import { dynamodbTable, sqsQueue } from "../src/cloudformation";
import { aws, createAwsClientConfig } from "../src/index";
import {
  awsEmulator,
  createLocalWorkflow,
  floci,
  LocalProviderError,
  localOutputsPath,
} from "../src/local";
import type { AwsEmulatorDependencies } from "../src/local";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const tempProject = async (): Promise<string> => {
  // The real path, because process.cwd() resolves symlinks such as macOS /var -> /private/var.
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "voke-aws-emulator-"))
  );

  directories.push(directory);
  return directory;
};

const lifecycle = (
  directory: string,
  options: Record<string, string> = {}
) => ({
  directory,
  options,
  region: "sa-east-1",
});

const offline: Partial<AwsEmulatorDependencies> = {
  arch: "arm64",
  platform: "darwin",
};

test("writes a Dockerfile for the host architecture and a host-usable config", () => {
  const arm = awsEmulator({}, offline).files(
    lifecycle("/p/.voke/local/aws-emulator")
  );
  const pinned = awsEmulator(
    { version: "1.0.367" },
    { ...offline, arch: "x64" }
  ).files(lifecycle("/p/.voke/local/aws-emulator"));

  expect(arm["/p/.voke/local/aws-emulator/Dockerfile"]).toContain(
    "ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator-aarch64.rpm /tmp/aws-emulator.rpm"
  );
  expect(arm["/p/.voke/local/aws-emulator/config"]).toBe(
    "[default]\nregion = sa-east-1\n"
  );
  expect(pinned["/p/.voke/local/aws-emulator/Dockerfile"]).toContain(
    "aws-emulator-1.0.367-1-x86_64.rpm"
  );
});

test("starts on loopback with memory limits, the state volume and telemetry off", () => {
  const options = lifecycle("/p/.voke/local/aws-emulator");

  expect(awsEmulator({}, offline).startCommands(options)).toEqual([
    [
      "docker",
      "run",
      "--rm",
      "-d",
      "--name",
      "voke-aws-emulator-9297",
      "--memory=2g",
      "--memory-swap=2g",
      "-p",
      "127.0.0.1:9297:9297",
      "-v",
      "/p/.voke/local/aws-emulator:/home/emulator/.aws/emulator",
      "voke-aws-emulator:latest-aarch64",
      "-p",
      "9297",
      "-t",
      "off",
    ],
  ]);

  const [custom] = awsEmulator(
    { port: 9400, telemetry: true },
    { ...offline, platform: "linux", user: () => "1000:1000" }
  ).startCommands(options);

  expect(custom).toContain("127.0.0.1:9400:9400");
  expect(custom?.slice(-2)).toEqual(["-t", "on"]);
  expect(custom).toContain("--user");
});

test("stops the container, and reset starts a fresh one", () => {
  const provider = awsEmulator({}, offline);
  const options = lifecycle("/p/.voke/local/aws-emulator");

  expect(provider.stopCommands(options)).toEqual([
    ["docker", "stop", "voke-aws-emulator-9297"],
  ]);
  expect(provider.resetCommands(options)).toEqual([
    ["docker", "stop", "voke-aws-emulator-9297"],
    ...provider.startCommands(options),
  ]);
});

test("builds the image only when it is missing, or with --rebuild", async () => {
  const provider = awsEmulator({}, offline);
  const prepare = provider.prepareStart;
  const calls: string[][] = [];
  const present = (command: string[]) => {
    calls.push(command);
  };
  const missing = (command: string[]) => {
    calls.push(command);

    if (command[1] === "image") {
      throw new Error("No such image");
    }
  };

  await prepare?.(lifecycle("/state"), present);
  await prepare?.(lifecycle("/state"), missing);
  await prepare?.(lifecycle("/state", { rebuild: "true" }), present);

  expect(calls).toEqual([
    [
      "docker",
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      "voke-aws-emulator:latest-aarch64",
    ],
    [
      "docker",
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      "voke-aws-emulator:latest-aarch64",
    ],
    [
      "docker",
      "build",
      "-q",
      "-t",
      "voke-aws-emulator:latest-aarch64",
      "/state",
    ],
    [
      "docker",
      "build",
      "-q",
      "-t",
      "voke-aws-emulator:latest-aarch64",
      "/state",
    ],
  ]);
});

test("waits for the CA file and the health route", async () => {
  let clock = 0;
  const fetched: { ca: string; url: string }[] = [];
  const provider = awsEmulator(
    {},
    {
      ...offline,
      exists: (path) =>
        Promise.resolve(path.endsWith("ca.pem") && clock >= 500),
      fetch: (url, init) => {
        fetched.push({ ca: init.tls.ca, url });
        return Promise.resolve(new Response("ok"));
      },
      now: () => clock,
      readFile: () => Promise.resolve("CA"),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    }
  );

  await provider.waitUntilReady?.(lifecycle("/state"));

  expect(fetched).toEqual([
    { ca: "CA", url: "https://127.0.0.1:9297/__admin/health" },
  ]);
});

test("times out with a docker logs hint when the emulator never answers", async () => {
  let clock = 0;
  const provider = awsEmulator(
    {},
    {
      ...offline,
      exists: () => Promise.resolve(false),
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    }
  );

  await expect(provider.waitUntilReady?.(lifecycle("/state"))).rejects.toThrow(
    "AWS Emulator did not become ready on https://127.0.0.1:9297 within 30s. Check: docker logs voke-aws-emulator-9297"
  );
});

test("points clients at the emulator by file paths, without real credentials", async () => {
  const provider = awsEmulator(
    {},
    { ...offline, exists: () => Promise.resolve(true) }
  );
  const environment = await provider.environment({
    directory: "/p/.voke/local/aws-emulator",
    region: "sa-east-1",
  });

  expect(environment).toEqual({
    AWS_CA_BUNDLE: "/p/.voke/local/aws-emulator/9297/ca.pem",
    AWS_CONFIG_FILE: "/p/.voke/local/aws-emulator/config",
    AWS_DEFAULT_REGION: "sa-east-1",
    AWS_DISABLE_HOST_PREFIX_INJECTION: "true",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_ENDPOINT_URL: "https://127.0.0.1:9297",
    AWS_REGION: "sa-east-1",
    AWS_SHARED_CREDENTIALS_FILE:
      "/p/.voke/local/aws-emulator/9297/emulator_credentials",
    NODE_EXTRA_CA_CERTS: "/p/.voke/local/aws-emulator/9297/ca.pem",
    VOKE_AWS_ENDPOINT_URL: "https://127.0.0.1:9297",
    VOKE_INVOKE_RUNTIME: "local",
    VOKE_LOCAL_PROVIDER: "aws-emulator",
  });
  expect("AWS_ACCESS_KEY_ID" in environment).toBe(false);
  expect(provider.unsetEnvironment).toEqual([
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
  ]);
});

test("reports a stopped emulator with the start command", async () => {
  const provider = awsEmulator(
    {},
    { ...offline, exists: () => Promise.resolve(false) }
  );

  await expect(
    provider.environment({ directory: "/p/.voke/local/aws-emulator" })
  ).rejects.toThrow(LocalProviderError);
  await expect(
    provider.environment({ directory: "/p/.voke/local/aws-emulator" })
  ).rejects.toThrow("Start it with: voke local start");
});

const projectConfig = () =>
  defineConfig({
    name: "hello-api",
    region: "us-east-1",
    resources: {
      eventsQueue: sqsQueue(),
      usersTable: dynamodbTable({ partitionKey: "id" }),
    },
    stage: "local",
  });

const stackDescription = JSON.stringify({
  Stacks: [
    {
      Outputs: [
        {
          OutputKey: "UsersTableName",
          OutputValue: "hello-api-local-UsersTable-EF18",
        },
        {
          OutputKey: "EventsQueueUrl",
          OutputValue:
            "https://sqs.us-east-1.amazonaws.com/000000000000/hello-api-local-EventsQueue-23CE",
        },
      ],
    },
  ],
});

test("bootstrap deploys resources only and writes the stack outputs for voke dev", async () => {
  const project = await tempProject();
  const state = join(project, ".voke", "local", "aws-emulator");
  const calls: { command: string[]; options?: ProviderCommandRunOptions }[] =
    [];
  const captured: { command: string[]; unsetEnv: readonly string[] }[] = [];
  const lines: string[] = [];
  // Only the project's state counts as running, so a lookup elsewhere fails like a stopped emulator.
  const provider = awsEmulator(
    {},
    {
      ...offline,
      exists: (path) => Promise.resolve(path.startsWith(state)),
    }
  );
  const workflow = createLocalWorkflow(provider, {
    capture: (command, options) => {
      captured.push({ command, unsetEnv: options.unsetEnv });
      return Promise.resolve(stackDescription);
    },
    cwd: () => project,
    output: (line) => {
      lines.push(line);
    },
  });
  const config = projectConfig();
  const template = join(project, "template.json");

  await workflow.bootstrap({
    config,
    model: createVokeModel(config),
    options: { template },
    run: (command, options) => {
      calls.push({ command, options });
    },
  });

  const deployed = await Bun.file(template).json();

  expect(Object.keys(deployed.Resources).toSorted()).toEqual([
    "EventsQueue",
    "UsersTable",
  ]);
  // Local data is disposable: nothing is retained.
  expect(JSON.stringify(deployed)).not.toContain("DeletionPolicy");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.command).toEqual([
    "aws",
    "cloudformation",
    "deploy",
    "--stack-name",
    "hello-api-local",
    "--template-file",
    template,
    "--region",
    "us-east-1",
    "--no-fail-on-empty-changeset",
  ]);
  expect(calls[0]?.options?.env?.AWS_SHARED_CREDENTIALS_FILE).toBe(
    join(state, "9297", "emulator_credentials")
  );
  expect(calls[0]?.options?.unsetEnv).toEqual(provider.unsetEnvironment);
  expect(captured[0]?.command.slice(0, 3)).toEqual([
    "aws",
    "cloudformation",
    "describe-stacks",
  ]);
  expect(captured[0]?.unsetEnv).toEqual(provider.unsetEnvironment);
  expect(await Bun.file(join(project, localOutputsPath)).json()).toEqual({
    bindings: {
      VOKE_RESOURCE_EVENTS_QUEUE_URL:
        "https://sqs.us-east-1.amazonaws.com/000000000000/hello-api-local-EventsQueue-23CE",
      VOKE_RESOURCE_USERS_TABLE_NAME: "hello-api-local-UsersTable-EF18",
    },
    endpoint: "https://127.0.0.1:9297",
    provider: "aws-emulator",
    region: "us-east-1",
    stack: "hello-api-local",
  });
  expect(lines).toContain(
    "VOKE_RESOURCE_USERS_TABLE_NAME=hello-api-local-UsersTable-EF18"
  );
});

test("start writes the files, waits until ready and prints the next step; stop and reset drop the outputs", async () => {
  const project = await tempProject();
  const outputsFile = join(project, localOutputsPath);
  const lines: string[] = [];
  const calls: { command: string[]; options?: ProviderCommandRunOptions }[] =
    [];
  const provider = awsEmulator(
    {},
    {
      ...offline,
      exists: () => Promise.resolve(true),
      fetch: () => Promise.resolve(new Response("ok")),
      readFile: () => Promise.resolve("CA"),
    }
  );
  const workflow = createLocalWorkflow(provider, {
    cwd: () => project,
    output: (line) => {
      lines.push(line);
    },
  });
  const config = projectConfig();
  const context = {
    config,
    model: createVokeModel(config),
    options: {},
    run: (command: string[], options?: ProviderCommandRunOptions) => {
      calls.push({ command, options });
    },
  };

  await workflow.start(context);

  expect(
    await Bun.file(
      join(project, ".voke/local/aws-emulator/Dockerfile")
    ).exists()
  ).toBe(true);
  expect(
    calls.every((call) => call.options?.unsetEnv === provider.unsetEnvironment)
  ).toBe(true);
  expect(lines).toEqual([
    "aws-emulator endpoint: https://127.0.0.1:9297",
    `State: ${join(project, ".voke/local/aws-emulator")}`,
    "Next: voke local bootstrap",
  ]);

  for (const step of ["stop", "reset"] as const) {
    await mkdir(join(project, ".voke/local"), { recursive: true });
    await writeFile(outputsFile, "{}");
    await workflow[step](context);

    expect(await Bun.file(outputsFile).exists()).toBe(false);
  }
});

test("aws() defaults to the AWS Emulator; aws({ local: floci() }) selects Floci", () => {
  expect(aws().local?.workflow?.flags).toHaveProperty("rebuild");
  expect(aws({ local: floci() }).local?.workflow?.flags).toHaveProperty(
    "compose"
  );
  expect(aws({ local: floci() }).local?.workflow?.flags).not.toHaveProperty(
    "rebuild"
  );
});

test("voke dev binds resources from a matching outputs file, and none from a stale one", async () => {
  const project = await tempProject();
  const previous = process.cwd();
  const state = join(project, ".voke", "local", "aws-emulator");
  const config = projectConfig();
  const devEnvironment = () =>
    aws().local?.devEnvironment?.({
      config,
      model: createVokeModel(config),
      region: "us-east-1",
      stage: "local",
    });

  await mkdir(join(state, "9297"), { recursive: true });
  await writeFile(
    join(project, localOutputsPath),
    JSON.stringify({
      bindings: {
        VOKE_RESOURCE_USERS_TABLE_NAME: "hello-api-local-UsersTable-EF18",
      },
      endpoint: "https://127.0.0.1:9297",
      provider: "aws-emulator",
      region: "us-east-1",
      stack: "hello-api-local",
    })
  );
  process.chdir(project);

  try {
    const fresh = await devEnvironment();

    expect(fresh?.environment.VOKE_RESOURCE_USERS_TABLE_NAME).toBe(
      "hello-api-local-UsersTable-EF18"
    );
    expect(fresh?.environment.NODE_EXTRA_CA_CERTS).toBe(
      join(state, "9297", "ca.pem")
    );
    expect(fresh?.unsetEnvironment).toContain("AWS_PROFILE");

    await writeFile(
      join(project, localOutputsPath),
      JSON.stringify({
        bindings: { VOKE_RESOURCE_USERS_TABLE_NAME: "old" },
        endpoint: "https://127.0.0.1:9297",
        provider: "aws-emulator",
        region: "us-east-1",
        stack: "other-api-local",
      })
    );

    const stale = await devEnvironment();

    expect(stale?.environment.VOKE_RESOURCE_USERS_TABLE_NAME).toBeUndefined();
  } finally {
    process.chdir(previous);
  }
});

test("createAwsClientConfig keeps an explicit endpoint, so queue URLs never send calls to real AWS", () => {
  const previous = process.env.VOKE_AWS_ENDPOINT_URL;

  process.env.VOKE_AWS_ENDPOINT_URL = "https://127.0.0.1:9297";

  try {
    expect(createAwsClientConfig({ region: "us-east-1" })).toEqual({
      endpoint: "https://127.0.0.1:9297",
      region: "us-east-1",
    });
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "VOKE_AWS_ENDPOINT_URL");
    } else {
      process.env.VOKE_AWS_ENDPOINT_URL = previous;
    }
  }
});
