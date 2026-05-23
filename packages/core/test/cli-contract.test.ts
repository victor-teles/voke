import { expect, test } from "bun:test";

import { CliUsageError, createApiProject, runCli } from "../src/cli";

test("prints useful run details for real CLI execution", async () => {
  const directory = `/private/tmp/voke-cli-details-${crypto.randomUUID()}`;
  const templatePath = `${directory}/template.json`;
  const output: string[] = [];

  await runCli(
    ["synth", "--name=details-api", "--stage=qa", `--out=${templatePath}`],
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
      `Run: voke synth --name=details-api --stage=qa --out=${templatePath}`,
      `Runtime: Bun ${Bun.version}`,
    ].join("\n"),
  ]);
});

test("keeps deploy and remove outside the stable top-level command matrix", async () => {
  await expect(runCli(["deploy", "--name", "orders-api"])).rejects.toThrow(
    "Deployment commands are experimental. Use: voke experimental deploy"
  );
  await expect(runCli(["remove", "--name", "orders-api"])).rejects.toThrow(
    "Deployment commands are experimental. Use: voke experimental remove"
  );
});

test("runs experimental deploy and remove explicitly", async () => {
  const commands: string[][] = [];

  await runCli(
    [
      "experimental",
      "deploy",
      "--name",
      "orders-api",
      "--stage",
      "prod",
      "--template",
      "./dist/cloudformation.json",
    ],
    {
      run: (command) => {
        commands.push(command);
      },
    }
  );
  await runCli(
    ["experimental", "remove", "--name", "orders-api", "--stage", "prod"],
    {
      run: (command) => {
        commands.push(command);
      },
    }
  );

  expect(commands).toEqual([
    [
      "aws",
      "cloudformation",
      "deploy",
      "--stack-name",
      "orders-api-prod",
      "--template-file",
      "./dist/cloudformation.json",
      "--capabilities",
      "CAPABILITY_IAM",
      "--region",
      "us-east-1",
    ],
    [
      "aws",
      "cloudformation",
      "delete-stack",
      "--stack-name",
      "orders-api-prod",
      "--region",
      "us-east-1",
    ],
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

test("creates a config-first API starter with stable files", async () => {
  const directory = `/private/tmp/voke-create-api-${crypto.randomUUID()}`;

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
  expect(config).toContain('name: "orders-api"');
  expect(config).toContain('entrypoint: "./src/index.ts"');
  expect(config).toContain('out: "./dist/cloudformation.json"');
  expect(index).toContain("new Voke");
  expect(index).toContain("defineFunctions");
  expect(index).toContain("createGateway");
  expect(index).toContain("config");
  expect(index).not.toContain("Bun.serve");
  expect(healthRoute).toContain("createHealthRoute");
  expect(healthRoute).toContain('app.get("/health"');
  expect(testFile).toContain("createTestClient");
  expect(testFile).toContain('await client.get("/health")');
});

test("generated API starter responds through the public test client", async () => {
  const directory = `/private/tmp/voke-create-smoke-${crypto.randomUUID()}`;

  await createApiProject({ directory, name: "smoke-api" });
  await Bun.$`mkdir -p ${directory}/node_modules`;
  await Bun.$`ln -s ${import.meta.dir}/.. ${directory}/node_modules/voke`;
  await Bun.$`ln -s ${import.meta.dir}/../node_modules/hono ${directory}/node_modules/hono`;

  const { default: service } = (await import(
    `${directory}/src/index.ts?t=${Date.now()}`
  )) as {
    default: { fetch: typeof fetch };
  };
  const { createTestClient } = await import("../src/e2e");
  const client = createTestClient(service);
  const response = await client.get("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { ok: true } });
});

test("supports equals-style flags as explicit overrides", async () => {
  const directory = `/private/tmp/voke-cli-contract-${crypto.randomUUID()}`;
  const templatePath = `${directory}/template.json`;

  await runCli([
    "synth",
    "--name=orders-api",
    "--stage=qa",
    `--out=${templatePath}`,
  ]);
  const template = await Bun.file(templatePath).json();

  expect(template.Description).toBe("Voke stack for orders-api (qa)");
});
