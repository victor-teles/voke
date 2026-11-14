import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "../src/cli";
import { defineConfig } from "../src/config";
import { tempPath } from "./support/temp";

const awsIndex = `${import.meta.dir}/../../aws/src/index.ts`;
const coreIndex = `${import.meta.dir}/../src/index.ts`;

const writeProject = async (
  directory: string,
  options: { provider: boolean }
): Promise<string> => {
  const configPath = `${directory}/voke.config.ts`;

  await Bun.write(
    configPath,
    `${options.provider ? `import { aws } from "${awsIndex}";\n` : ""}import { defineConfig } from "${coreIndex}";

export default defineConfig({
  name: "build-api",
  entrypoint: "./src/api.ts",
  build: { outdir: "./configured-dist" },${options.provider ? "\n  provider: aws()," : ""}
});
`
  );
  await Bun.write(
    `${directory}/src/api.ts`,
    `import { createFunctions, http, route } from "${coreIndex}";

export const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
});
`
  );

  return configPath;
};

test("build CLI builds the Provider's plan from the Functions the entrypoint declares", async () => {
  const directory = tempPath(`voke-build-cli-${crypto.randomUUID()}`);
  const configPath = await writeProject(directory, { provider: true });
  const commands: string[][] = [];
  const previousPwd = process.env.PWD;

  try {
    process.env.PWD = directory;
    await runCli(["build", "--config", configPath], {
      run: (command) => {
        commands.push(command);
      },
    });
  } finally {
    process.env.PWD = previousPwd;
  }

  expect(commands).toEqual([
    [
      "bun",
      "build",
      ".voke/build/index.ts",
      "--outdir",
      "./configured-dist",
      "--target",
      "node",
      "--format",
      "esm",
      "--external",
      "@aws-sdk/*",
    ],
  ]);

  // The CLI writes the generated entry before bundling and the build metadata after.
  // Paths are relative, so they resolve against the test's working directory.
  try {
    expect(await Bun.file(".voke/build/index.ts").text()).toContain(
      'export const http = handlers["http"];'
    );
    expect(await Bun.file("./configured-dist/package.json").json()).toEqual({
      type: "module",
    });
    expect(
      await Bun.file("./configured-dist/voke-manifest.json").json()
    ).toEqual({
      functions: {
        http: { file: "configured-dist/index.js", handler: "index.http" },
      },
    });
  } finally {
    await rm(".voke", { force: true, recursive: true });
    await rm("./configured-dist", { force: true, recursive: true });
    await rm(directory, { force: true, recursive: true });
  }
});

test("build CLI fails clearly when no Provider is configured", async () => {
  const directory = tempPath(`voke-build-no-provider-${crypto.randomUUID()}`);
  const configPath = await writeProject(directory, { provider: false });
  const previousPwd = process.env.PWD;

  try {
    process.env.PWD = directory;
    await expect(
      runCli(["build", "--config", configPath], { run: () => {} })
    ).rejects.toThrow("No provider configured for build.");
  } finally {
    process.env.PWD = previousPwd;
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects the removed build.target option with the replacement behavior", () => {
  const input = {
    build: { target: "bun" },
    name: "legacy-target",
  } as unknown as Parameters<typeof defineConfig>[0];

  expect(() => defineConfig(input)).toThrow(
    'Invalid Voke config at build.target: "build.target" was removed; Voke always builds an ESM bundle for the Lambda Node.js runtime'
  );
});
