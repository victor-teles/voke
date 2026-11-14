import { expect, test } from "bun:test";

import { CliUsageError, createApiProject, runCli, synth } from "../src/cli";
import { defineConfig } from "../src/config";
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
      "Voke v0.0.0",
      "Command: synth",
      `Run: voke synth --config=${configPath} --name=details-api --stage=qa --out=${templatePath}`,
      `Runtime: Bun ${Bun.version}`,
    ].join("\n"),
  ]);
});

test("standardizes CLI usage errors for invalid commands and flags", async () => {
  await expect(runCli(["unknown"])).rejects.toThrow("Unknown command: unknown");
  await expect(runCli(["create"])).rejects.toThrow(
    "Usage: voke create api <name> [directory]"
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

test("creates a config-first API starter with stable files", async () => {
  const directory = tempPath(`voke-create-api-${crypto.randomUUID()}`);

  await runCli(["create", "api", "orders-api", directory]);

  const packageJson = await Bun.file(`${directory}/package.json`).json();
  const config = await Bun.file(`${directory}/voke.config.ts`).text();
  const index = await Bun.file(`${directory}/src/index.ts`).text();
  const healthRoute = await Bun.file(
    `${directory}/src/routes/health.ts`
  ).text();
  const testFile = await Bun.file(`${directory}/test/api.test.ts`).text();

  expect(packageJson.scripts).toEqual({
    build: "voke build",
    clean: "rm -rf dist coverage",
    dev: "voke dev",
    local: "voke local start",
    synth: "voke synth",
    test: "bun test",
    typecheck: "bunx tsgo --project tsconfig.json --noEmit",
  });
  expect(packageJson.dependencies["@voke/aws"]).toBe("^0.0.0");
  expect(config).toContain('name: "orders-api"');
  expect(config).toContain('entrypoint: "./src/index.ts"');
  expect(config).toContain('out: "./dist/cloudformation.json"');
  expect(config).toContain('import { aws } from "@voke/aws";');
  expect(config).toContain("provider: aws()");
  expect(index).toContain("createFunctions");
  expect(index).toContain("http");
  expect(index).toContain("voke");
  expect(index).toContain("config");
  expect(index).not.toContain("Bun.serve");
  expect(healthRoute).toContain("healthRoute");
  expect(healthRoute).toContain('route.get("/health"');
  expect(testFile).toContain("createTestClient");
  expect(testFile).toContain('await client.get("/health")');
});

test("generated API starter responds through the public test client", async () => {
  const directory = tempPath(`voke-create-smoke-${crypto.randomUUID()}`);

  await createApiProject({ directory, name: "smoke-api" });
  await Bun.$`mkdir -p ${directory}/node_modules`;
  await Bun.$`mkdir -p ${directory}/node_modules/@voke`;
  await Bun.$`ln -s ${import.meta.dir}/.. ${directory}/node_modules/voke`;
  await Bun.$`ln -s ${import.meta.dir}/../../aws ${directory}/node_modules/@voke/aws`;
  await Bun.$`ln -s ${import.meta.dir}/../node_modules/hono ${directory}/node_modules/hono`;

  const { default: service } = (await import(
    `${directory}/src/index.ts?t=${Date.now()}`
  )) as {
    default: { fetch: typeof fetch };
  };
  const { createTestClient } = await import("@voke/testing");
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
