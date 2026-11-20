import { expect, test } from "bun:test";

import corePackageJson from "../package.json";
import { CliUsageError, createApiProject, runCli, synth } from "../src/cli";
import { commandSpecs, formatCommandHelp, formatHelp } from "../src/cli-spec";
import { defineConfig } from "../src/config";
import { reservedPluginCommandNames } from "../src/plugin";
import { tempPath } from "./support/temp";

const writeProviderConfig = async (
  directory: string,
  name: string
): Promise<string> => {
  const path = `${directory}/voke.config.ts`;
  const entrypoint = `${directory}/src/index.ts`;

  await Bun.$`mkdir -p ${directory}`;
  // synth imports the entrypoint to discover the Functions it declares.
  await Bun.write(
    entrypoint,
    `import { createFunctions, http, route } from "${import.meta.dir}/../src/index.ts";

export const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
});
`
  );
  await Bun.write(
    path,
    `export default {
  entrypoint: ${JSON.stringify(entrypoint)},
  name: ${JSON.stringify(name)},
  provider: {
    name: "test",
    synthesis: {
      synthesize: ({ model }) => ({
        Description: \`custom artifact for \${model.service.name} (\${model.service.stage})\`,
      }),
    },
  },
};
`
  );

  return path;
};

test("prints useful run details for real CLI execution", async () => {
  const directory = tempPath(`voke-cli-details-${crypto.randomUUID()}`);
  const templatePath = `${directory}/template.json`;
  const configPath = await writeProviderConfig(directory, "details-api");
  const output: string[] = [];

  await runCli(
    [
      "synth",
      `--config=${configPath}`,
      "--name=details-api",
      "--stage=qa",
      `--out=${templatePath}`,
    ],
    {
      output: (message) => {
        output.push(message);
      },
      showDetails: true,
    }
  );

  expect(output).toEqual([
    [
      `Voke v${corePackageJson.version}`,
      "Command: synth",
      `Run: voke synth --config=${configPath} --name=details-api --stage=qa --out=${templatePath}`,
      `Runtime: Bun ${Bun.version}`,
    ].join("\n"),
    `Wrote template to ${templatePath}`,
  ]);
});

test("standardizes CLI usage errors for invalid commands and flags", async () => {
  await expect(runCli(["unknown"])).rejects.toThrow("Unknown command: unknown");
  await expect(runCli(["create"])).rejects.toThrow(
    "Usage: voke create <name> [directory]"
  );
  await expect(runCli(["build", "--entrypoint"])).rejects.toThrow(
    "Missing value for --entrypoint"
  );

  try {
    await runCli(["unknown"]);
  } catch (error) {
    expect(error).toBeInstanceOf(CliUsageError);
  }
});

test("synth uses the configured provider synthesis capability", async () => {
  const directory = tempPath(`voke-provider-synth-${crypto.randomUUID()}`);
  const out = `${directory}/template.json`;
  const config = defineConfig({
    name: "provider-synth",
    provider: {
      name: "custom",
      synthesis: {
        synthesize: ({ model }) => ({
          Description: `custom artifact for ${model.service.name}`,
        }),
      },
    },
  });

  await synth({ config, out });

  await expect(Bun.file(out).json()).resolves.toEqual({
    Description: "custom artifact for provider-synth",
  });
});

test("synth fails clearly when the configured provider cannot synthesize", async () => {
  const config = defineConfig({
    name: "no-synthesis-provider",
    provider: {
      name: "custom",
    },
  });

  await expect(synth({ config })).rejects.toThrow(
    'Provider "custom" does not support synthesis.'
  );
});

test("generated API starter responds through the public test client", async () => {
  const directory = tempPath(`voke-create-smoke-${crypto.randomUUID()}`);

  await createApiProject({ directory, name: "smoke-api" });
  await Bun.$`mkdir -p ${directory}/node_modules`;
  await Bun.$`mkdir -p ${directory}/node_modules/@vokejs`;
  await Bun.$`ln -s ${import.meta.dir}/.. ${directory}/node_modules/voke`;
  await Bun.$`ln -s ${import.meta.dir}/../../aws ${directory}/node_modules/@vokejs/aws`;
  await Bun.$`ln -s ${import.meta.dir}/../node_modules/hono ${directory}/node_modules/hono`;

  const { default: service } = (await import(
    `${directory}/src/index.ts?t=${Date.now()}`
  )) as {
    default: { fetch: typeof fetch };
  };
  const { createTestClient } = await import("@vokejs/testing");
  const client = createTestClient(service);
  const response = await client.get("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { ok: true } });
});

test("supports equals-style flags as explicit overrides", async () => {
  const directory = tempPath(`voke-cli-contract-${crypto.randomUUID()}`);
  const templatePath = `${directory}/template.json`;
  const configPath = await writeProviderConfig(directory, "orders-api");

  await runCli([
    "synth",
    `--config=${configPath}`,
    "--name=orders-api",
    "--stage=qa",
    `--out=${templatePath}`,
  ]);
  const template = await Bun.file(templatePath).json();

  expect(template.Description).toBe("custom artifact for orders-api (qa)");
});

const capture = () => {
  const lines: string[] = [];

  return {
    lines,
    output: (message: string) => {
      lines.push(message);
    },
    text: () => lines.join("\n"),
  };
};

const commandNames = [
  "build",
  "create",
  "deploy",
  "dev",
  "doctor",
  "local",
  "migrate",
  "remote",
  "remove",
  "synth",
];

test("prints the version with --version and -v", async () => {
  for (const flag of ["--version", "-v"]) {
    const out = capture();

    await runCli([flag], { output: out.output });

    expect(out.lines).toEqual([`voke ${corePackageJson.version}`]);
  }
});

test("prints the command list through the injected output", async () => {
  for (const argv of [[], ["--help"], ["-h"], ["help"]]) {
    const out = capture();

    await runCli(argv, { output: out.output });

    for (const name of commandNames) {
      expect(out.text()).toContain(`voke ${name}`);
    }
    expect(out.text()).not.toContain("experimental");
  }
});

test("prints per-command help with usage, description and flags", async () => {
  for (const name of commandNames) {
    for (const argv of [
      [name, "--help"],
      [name, "-h"],
      ["help", name],
    ]) {
      const out = capture();

      await runCli(argv, { output: out.output });

      const lines = out.text().split("\n");

      expect(lines[0]).toStartWith(`Usage: voke ${name}`);
      expect(lines.length).toBeGreaterThan(2);
    }
  }

  const synthHelp = capture();

  await runCli(["synth", "--help"], { output: synthHelp.output });

  expect(synthHelp.text()).toContain("--stage");
  await expect(runCli(["help", "nope"])).rejects.toThrow(
    "Unknown command: nope"
  );
});

test("deploy help lists --accept-data-loss", async () => {
  const out = capture();

  await runCli(["deploy", "--help"], { output: out.output });

  expect(out.text()).toContain("[--accept-data-loss]");
  expect(out.text()).toMatch(
    /--accept-data-loss +Apply changes that remove or replace a resource that holds data/u
  );
});

test("rejects unknown flags and suggests the closest known flag", async () => {
  await expect(runCli(["synth", "--stag", "prod"])).rejects.toThrow(
    'Invalid CLI usage: Unknown flag --stag for "synth". Did you mean --stage?\nUsage: voke synth'
  );
  await expect(runCli(["deploy", "--dryrun"])).rejects.toThrow(
    'Unknown flag --dryrun for "deploy". Did you mean --dry-run?'
  );
  await expect(runCli(["synth", "--banana", "x"])).rejects.toThrow(
    'Invalid CLI usage: Unknown flag --banana for "synth".\nUsage: voke synth'
  );
  await expect(
    runCli(["migrate", "serverless", "--outt", "./x"])
  ).rejects.toThrow('Unknown flag --outt for "migrate". Did you mean --out?');
});

test("synth reports what it wrote, with a resource count when the artifact has resources", async () => {
  const directory = tempPath(`voke-synth-result-${crypto.randomUUID()}`);
  const configPath = await writeProviderConfig(directory, "result-api");
  const out = capture();

  await runCli(
    ["synth", "--config", configPath, "--out", `${directory}/plain.json`],
    { output: out.output }
  );

  expect(out.lines).toEqual([`Wrote template to ${directory}/plain.json`]);

  const withResources = `${directory}/resources.config.ts`;

  const baseConfig = await Bun.file(configPath).text();

  await Bun.write(
    withResources,
    baseConfig.replace(
      "Description: `custom artifact",
      "Resources: { A: {}, B: {} }, Description: `custom artifact"
    )
  );

  const counted = capture();

  await runCli(
    ["synth", "--config", withResources, "--out", `${directory}/r.json`],
    { output: counted.output }
  );

  expect(counted.lines).toEqual([
    `Wrote template to ${directory}/r.json (2 resources)`,
  ]);
});

test("migrate serverless reports the skeleton directory", async () => {
  const directory = tempPath(`voke-migrate-result-${crypto.randomUUID()}`);
  const source = `${directory}/serverless.yml`;
  const out = capture();

  await Bun.write(
    source,
    "service: tiny\nprovider:\n  name: aws\nfunctions:\n  hello:\n    handler: src/hello.handler\n"
  );
  await runCli(["migrate", "serverless", source, "--out", `${directory}/out`], {
    output: out.output,
  });

  expect(out.lines).toEqual([`Wrote migration skeleton to ${directory}/out`]);
});

test("zero-config names the project from package.json and asks for a provider", async () => {
  const directory = tempPath(`voke-zero-config-${crypto.randomUUID()}`);
  await Bun.write(
    `${directory}/package.json`,
    JSON.stringify({ name: "@acme/orders" })
  );
  await Bun.write(
    `${directory}/src/index.ts`,
    `import { createFunctions, http, route } from "${import.meta.dir}/../src/index.ts";

export const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
});
`
  );
  const synthesis = runCli(["synth"], { cwd: directory });

  await expect(synthesis).rejects.toThrow(CliUsageError);
  await expect(runCli(["synth"], { cwd: directory })).rejects.toThrow(
    `No provider configured. Add a provider to voke.config.ts, for example:

  import { aws } from "@vokejs/aws";
  export default defineConfig({ name: "orders", provider: aws() });`
  );
});

test("local reports one confirmation line after the provider workflow succeeds", async () => {
  const directory = tempPath(`voke-local-result-${crypto.randomUUID()}`);
  const configPath = `${directory}/voke.config.ts`;
  const out = capture();

  await Bun.write(
    configPath,
    `export default {
  name: "local-api",
  provider: {
    name: "fake",
    local: {
      workflow: {
        flags: { compose: "Compose file path" },
        bootstrap: async () => undefined,
        reset: async () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
      },
    },
  },
};
`
  );

  await runCli(
    ["local", "start", "--config", configPath, "--compose", "x.yml"],
    { output: out.output, run: () => {} }
  );
  await expect(
    runCli(["local", "start", "--config", configPath, "--composer", "x"], {
      run: () => {},
    })
  ).rejects.toThrow(
    'Unknown flag --composer for "local". Did you mean --compose?'
  );

  expect(out.lines).toEqual(["Started the local environment"]);
});

const recordingRunner = () => {
  const calls: { command: string[]; cwd?: string }[] = [];

  return {
    calls,
    run: (command: string[], options?: { cwd?: string }) => {
      calls.push({ command, cwd: options?.cwd });
    },
  };
};

test("create writes the starter, installs through the runner, and prints next steps", async () => {
  const directory = tempPath(`voke-create-${crypto.randomUUID()}`);
  const out = capture();
  const runner = recordingRunner();

  await runCli(["create", "orders-api", directory], {
    output: out.output,
    run: runner.run,
  });

  for (const file of [
    ".gitignore",
    "README.md",
    "package.json",
    "src/index.ts",
    "src/routes/health.ts",
    "test/api.test.ts",
    "tsconfig.json",
    "voke.config.ts",
  ]) {
    expect(await Bun.file(`${directory}/${file}`).exists()).toBe(true);
  }

  const manifest = await Bun.file(`${directory}/package.json`).json();
  const vokeVersions = Object.entries(
    manifest.dependencies as Record<string, string>
  )
    .filter(([name]) => name === "voke" || name.startsWith("@vokejs/"))
    .map(([, version]) => version);

  expect(manifest.name).toBe("orders-api");
  expect(vokeVersions).toEqual(
    Array.from({ length: 3 }, () => `^${corePackageJson.version}`)
  );
  expect(runner.calls).toEqual([
    { command: ["bun", "install"], cwd: directory },
  ]);
  expect(out.text()).toBe(
    [
      `Created orders-api in ${directory}`,
      "",
      "Next steps:",
      `  cd ${directory}`,
      "  bun run dev        # local API on http://localhost:3000",
      "  bun test",
      "  bun run deploy     # deploy the dev stage to AWS",
    ].join("\n")
  );
});

test("create keeps a scoped name and names the config without the scope", async () => {
  const directory = tempPath(`voke-create-scoped-${crypto.randomUUID()}`);

  await runCli(["create", "@acme/orders", directory, "--no-install"], {
    output: () => {},
  });

  const manifest = await Bun.file(`${directory}/package.json`).json();

  expect(manifest.name).toBe("@acme/orders");
  expect(await Bun.file(`${directory}/voke.config.ts`).text()).toContain(
    'name: "orders"'
  );
});

test("create --no-install skips bun install and lists it as a next step", async () => {
  const directory = tempPath(`voke-create-no-install-${crypto.randomUUID()}`);
  const out = capture();
  const runner = recordingRunner();

  await runCli(["create", "quiet-api", directory, "--no-install"], {
    output: out.output,
    run: runner.run,
  });

  expect(runner.calls).toEqual([]);
  expect(out.text()).toContain("  bun install\n");
});

test("create keeps the files and fails when bun install fails", async () => {
  const directory = tempPath(
    `voke-create-install-fails-${crypto.randomUUID()}`
  );

  await expect(
    runCli(["create", "broken-api", directory], {
      output: () => {},
      run: () => {
        throw new Error("network down");
      },
    })
  ).rejects.toThrow(
    `Created broken-api in ${directory}, but bun install failed. Install the dependencies with: cd ${directory} && bun install`
  );
  expect(await Bun.file(`${directory}/package.json`).exists()).toBe(true);
});

test("create refuses a non-empty directory unless --force, and --force keeps other files", async () => {
  const directory = tempPath(`voke-create-existing-${crypto.randomUUID()}`);

  await Bun.write(`${directory}/notes.txt`, "keep me");
  await Bun.write(`${directory}/src/index.ts`, "old");

  await expect(
    runCli(["create", "existing-api", directory, "--no-install"])
  ).rejects.toThrow(
    `Directory ${directory} is not empty. Choose another directory, or pass --force to write the starter files into it.`
  );

  await runCli(
    ["create", "existing-api", directory, "--no-install", "--force"],
    {
      output: () => {},
    }
  );

  expect(await Bun.file(`${directory}/notes.txt`).text()).toBe("keep me");
  expect(await Bun.file(`${directory}/src/index.ts`).text()).toContain(
    "createFunctions"
  );
});

const writePluginProject = async (directory: string): Promise<string> => {
  const configPath = `${directory}/voke.config.ts`;
  const coreIndex = `${import.meta.dir}/../src/index.ts`;

  await Bun.write(
    `${directory}/src/index.ts`,
    `import { createFunctions, http, route } from "${coreIndex}";

export const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
});
`
  );
  await Bun.write(
    configPath,
    `import { defineConfig, http, route } from "${coreIndex}";

export default defineConfig({
  entrypoint: ${JSON.stringify(`${directory}/src/index.ts`)},
  name: "plugin-cli",
  plugins: [
    {
      name: "docs",
      contributions: {
        functions: {
          page: http({ routes: [route.get("/docs", { handler: () => "docs" })] }),
        },
      },
      cli: {
        description: "API documentation.",
        commands: {
          export: {
            description: "Write the API description.",
            usage: "voke docs export [file] [--format json] [--pretty]",
            positionals: [{ name: "file" }],
            flags: {
              format: { description: "Output format" },
              pretty: { boolean: true, description: "Indent the output" },
            },
            run: async ({ config, flags, loadFunctions, output, positional }) => {
              const functions = await loadFunctions();
              output(JSON.stringify({
                flags,
                functions: functions.map(([key]) => key),
                name: config.name,
                positional,
              }));
            },
          },
        },
      },
    },
  ],
});
`
  );

  return configPath;
};

test("runs a Plugin command with its parsed flags, positionals and Functions", async () => {
  const directory = tempPath(`voke-plugin-cli-${crypto.randomUUID()}`);
  const configPath = await writePluginProject(directory);
  const lines: string[] = [];

  await runCli(
    [
      "docs",
      "export",
      "openapi.json",
      "--format",
      "yaml",
      "--pretty",
      `--config=${configPath}`,
    ],
    { output: (line) => lines.push(line) }
  );

  expect(JSON.parse(lines[0] ?? "{}")).toEqual({
    flags: { config: configPath, format: "yaml", pretty: "true" },
    functions: ["http", "docs-page"],
    name: "plugin-cli",
    positional: ["openapi.json"],
  });
});

test("a Plugin command rejects an argument beyond its declared positionals", async () => {
  const directory = tempPath(`voke-plugin-cli-${crypto.randomUUID()}`);
  const configPath = await writePluginProject(directory);

  await expect(
    runCli(["docs", "export", "a.json", "b.json", "--config", configPath])
  ).rejects.toThrow(
    'Invalid CLI usage: Unexpected argument "b.json" for "docs export".\nUsage: voke docs export [file] [--format json] [--pretty]'
  );
});

test("a Plugin command rejects an unknown flag with a suggestion", async () => {
  const directory = tempPath(`voke-plugin-cli-${crypto.randomUUID()}`);
  const configPath = await writePluginProject(directory);

  await expect(
    runCli(["docs", "export", "--formt", "json", "--config", configPath])
  ).rejects.toThrow(
    'Unknown flag --formt for "docs export". Did you mean --format?\nUsage: voke docs export [file] [--format json] [--pretty]'
  );
});

test("Plugin help lists its commands, and command help lists its flags", async () => {
  const directory = tempPath(`voke-plugin-cli-${crypto.randomUUID()}`);
  const configPath = await writePluginProject(directory);
  const lines: string[] = [];
  const output = (line: string) => lines.push(line);

  await runCli(["docs", "--config", configPath], { output });
  await runCli(["docs", "--help", "--config", configPath], { output });
  await runCli(["docs", "export", "--help", "--config", configPath], {
    output,
  });

  const pluginHelp = [
    "Usage: voke docs <command> [options]",
    "",
    "API documentation.",
    "",
    "Commands:",
    "  voke docs export  Write the API description.",
    "",
    "Run voke docs <command> --help for its flags.",
  ].join("\n");

  expect(lines).toEqual([
    pluginHelp,
    pluginHelp,
    [
      "Usage: voke docs export [file] [--format json] [--pretty]",
      "",
      "Write the API description.",
      "",
      "Flags:",
      "  --format <value>  Output format",
      "  --pretty          Indent the output",
      "  --config <value>  Config file. Default: voke.config.ts",
    ].join("\n"),
  ]);
});

test("voke --help lists Plugin commands when ./voke.config.ts loads", async () => {
  const directory = tempPath(`voke-plugin-cli-${crypto.randomUUID()}`);
  await writePluginProject(directory);
  const lines: string[] = [];

  await runCli(["--help"], {
    cwd: directory,
    output: (line) => lines.push(line),
  });

  expect(lines[0]).toContain(
    "Plugin commands:\n  voke docs export  Write the API description."
  );
});

test("voke --help still lists built-in commands when the config fails to load", async () => {
  const directory = tempPath(`voke-plugin-cli-${crypto.randomUUID()}`);
  await Bun.write(
    `${directory}/voke.config.ts`,
    "throw new Error('broken');\n"
  );
  const lines: string[] = [];

  await runCli(["--help"], {
    cwd: directory,
    output: (line) => lines.push(line),
  });

  expect(lines[0]).toContain("voke synth");
  expect(lines[0]).not.toContain("Plugin commands:");
});

test("an unknown command with a config but no matching Plugin keeps the usage error", async () => {
  const directory = tempPath(`voke-plugin-cli-${crypto.randomUUID()}`);
  const configPath = await writePluginProject(directory);

  await expect(runCli(["nope", "--config", configPath])).rejects.toThrow(
    "Unknown command: nope"
  );
  await expect(
    runCli(["docs", "import", "--config", configPath])
  ).rejects.toThrow("Unknown command: docs import");
});

test("voke openapi generate writes the OpenAPI document of a project", async () => {
  const directory = tempPath(`voke-openapi-cli-${crypto.randomUUID()}`);
  const coreIndex = `${import.meta.dir}/../src/index.ts`;
  const openapiIndex = `${import.meta.dir}/../../openapi/src/index.ts`;
  const configPath = `${directory}/voke.config.ts`;
  const lines: string[] = [];

  await Bun.write(
    `${directory}/src/index.ts`,
    `import { createFunctions, http, route } from "${coreIndex}";

export const functions = createFunctions({
  http: http({
    routes: [
      route.get("/health", { handler: () => "ok" }),
      route.get("/internal", { handler: () => "ok", meta: { hidden: true } }),
    ],
  }),
});
`
  );
  await Bun.write(
    configPath,
    `import { openapi } from "${openapiIndex}";

export default {
  entrypoint: ${JSON.stringify(`${directory}/src/index.ts`)},
  name: "openapi-cli",
  plugins: [openapi({ expose: true })],
};
`
  );

  await runCli(
    [
      "openapi",
      "generate",
      "--out",
      `${directory}/openapi.json`,
      `--config=${configPath}`,
    ],
    { output: (line) => lines.push(line) }
  );

  const document = await Bun.file(`${directory}/openapi.json`).json();

  expect(lines).toEqual([`Wrote ${directory}/openapi.json (1 operation)`]);
  expect(document).toMatchObject({
    info: { title: "openapi-cli" },
    openapi: "3.1.0",
  });
  expect(Object.keys(document.paths)).toEqual(["/health"]);
});

test("the reserved Plugin names are the built-in command names and help", () => {
  expect([...reservedPluginCommandNames].toSorted()).toEqual(
    [...Object.keys(commandSpecs), "help"].toSorted()
  );
});

test("create rejects invalid names and the removed create api form", async () => {
  await expect(runCli(["create", "My API", "--no-install"])).rejects.toThrow(
    'Invalid project name "My API". Use lowercase letters, digits, "-", "." or "_", optionally with a scope: my-api or @acme/my-api'
  );
  await expect(runCli(["create", "api", "orders"])).rejects.toThrow(
    'Invalid CLI usage: "voke create api" was replaced by: voke create <name> [directory]'
  );
});

test("every example deploys and removes the dev stage, as the scaffold does", async () => {
  const examples = `${import.meta.dir}/../../../examples`;
  const scripts: Record<string, Record<string, string>> = {};

  for await (const path of new Bun.Glob("*/package.json").scan(examples)) {
    const packageJson = (await Bun.file(`${examples}/${path}`).json()) as {
      scripts?: Record<string, string>;
    };
    const { deploy, remove } = packageJson.scripts ?? {};

    scripts[path] = {
      ...(deploy === undefined ? {} : { deploy }),
      ...(remove === undefined ? {} : { remove }),
    };
  }

  expect(Object.keys(scripts).length).toBeGreaterThan(0);

  for (const [path, { deploy, remove }] of Object.entries(scripts)) {
    expect({ deploy, path, remove }).toEqual({
      deploy: deploy === undefined ? undefined : "voke deploy --stage dev",
      path,
      remove: remove === undefined ? undefined : "voke remove --stage dev",
    });
  }
});

test("the CLI reference page shows the real help output", async () => {
  const page = await Bun.file(
    new URL(
      "../../../apps/docs/content/docs/reference/cli.mdx",
      import.meta.url
    )
  ).text();

  expect(page).toContain(formatHelp());

  for (const name of Object.keys(commandSpecs)) {
    expect(page).toContain(formatCommandHelp(name));
  }
});
