import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CliUsageError,
  deployProject,
  removeProject,
  runCli,
} from "../src/cli";
import { defineConfig } from "../src/config";
import { createFunctions, http } from "../src/invoke";
import type {
  ProviderDeployInput,
  ProviderRemoveInput,
  VokeProvider,
} from "../src/provider";
import { route } from "../src/route-builder";
import { withEnv } from "./support/env";
import { tempPath } from "./support/temp";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
});

interface FakeProvider {
  deployed: ProviderDeployInput[];
  provider: VokeProvider;
  removed: ProviderRemoveInput[];
}

/** A Provider whose build plan points at files in a scratch directory and records deploys. */
const fakeProvider = async (
  options: { canDeploy?: boolean; status?: "absent" | "removed" } = {}
): Promise<FakeProvider & { directory: string }> => {
  const directory = tempPath(`voke-deploy-cli-${crypto.randomUUID()}`);
  const outdir = join(directory, "dist");
  const deployed: ProviderDeployInput[] = [];
  const removed: ProviderRemoveInput[] = [];

  directories.push(directory);
  await mkdir(outdir, { recursive: true });
  await writeFile(join(outdir, "index.js"), "export const http = () => {};\n");

  const provider: VokeProvider = {
    build: {
      plan: () => ({
        command: ["bun", "build"],
        entrypoints: [".voke/build/index.ts"],
        files: { [join(outdir, "package.json")]: '{"type":"module"}\n' },
        manifest: { functions: {} },
        outdir,
        outputs: { ".voke/build/index.ts": { file: join(outdir, "index.js") } },
        sources: {},
      }),
    },
    name: "fake",
    ...(options.canDeploy === false
      ? {}
      : {
          deploy: {
            deploy: async (input) => {
              deployed.push(input);

              return await Promise.resolve({
                id: `${input.config.name}-${input.stage}`,
                outputs: {
                  ApiUrl: "https://api.example.com",
                  FunctionName: "fn",
                },
                region: "us-east-1",
                status: input.dryRun
                  ? ("dry-run" as const)
                  : ("deployed" as const),
              });
            },
            remove: async (input) => {
              removed.push(input);

              return await Promise.resolve({
                status: options.status ?? "removed",
              });
            },
          },
        }),
  };

  return { deployed, directory, provider, removed };
};

const deployWith = async (
  fake: Awaited<ReturnType<typeof fakeProvider>>,
  stage: string,
  overrides: { dryRun?: boolean } = {}
) => {
  const lines: string[] = [];
  const result = await deployProject({
    config: defineConfig({ name: "shop", provider: fake.provider }),
    cwd: fake.directory,
    dryRun: overrides.dryRun,
    functions,
    output: (line) => {
      lines.push(line);
    },
    run: () => {},
    stage,
  });

  return { lines, result };
};

test("deploy builds through the Provider and hands it the artifact files", async () => {
  const fake = await fakeProvider();
  const { lines } = await deployWith(fake, "dev");
  const [input] = fake.deployed;

  expect(input?.stage).toBe("dev");
  expect(input?.config.stage).toBe("dev");
  expect(input?.artifactDirectory).toBe(join(fake.directory, "dist"));
  expect(input?.artifactFiles.toSorted()).toEqual(["index.js", "package.json"]);
  expect(input?.model.functions.http?.handler).toBe("index.http");
  // ApiUrl is printed first.
  expect(lines.slice(-2)).toEqual([
    "ApiUrl        https://api.example.com",
    "FunctionName  fn",
  ]);
});

test("deploy writes the stage outputs file, but not on a dry run", async () => {
  const fake = await fakeProvider();
  const outputsPath = join(fake.directory, ".voke", "outputs", "dev.json");

  await deployWith(fake, "dev", { dryRun: true });
  await expect(readFile(outputsPath, "utf-8")).rejects.toThrow();
  expect(fake.deployed[0]?.dryRun).toBe(true);

  await deployWith(fake, "dev");
  expect(JSON.parse(await readFile(outputsPath, "utf-8"))).toEqual({
    id: "shop-dev",
    outputs: { ApiUrl: "https://api.example.com", FunctionName: "fn" },
    region: "us-east-1",
    stage: "dev",
  });
});

test("deploy fails clearly without a Provider deploy capability", async () => {
  const fake = await fakeProvider({ canDeploy: false });

  await expect(deployWith(fake, "dev")).rejects.toThrow(
    'Provider "fake" does not support deploy.'
  );
  await expect(
    deployProject({
      config: defineConfig({ name: "shop" }),
      functions,
      stage: "dev",
    })
  ).rejects.toThrow(
    "No provider configured. Add a provider to voke.config.ts, for example:"
  );
});

test("the local stage is reserved for the emulator unless an endpoint is configured", async () => {
  const fake = await fakeProvider();

  await withEnv(
    { AWS_ENDPOINT_URL: undefined, VOKE_AWS_ENDPOINT_URL: undefined },
    async () => {
      await expect(deployWith(fake, "local")).rejects.toThrow(
        'Stage "local" is reserved for the local emulator. Deploy to AWS with: voke deploy --stage dev'
      );
    }
  );
  expect(fake.deployed).toEqual([]);

  await withEnv({ AWS_ENDPOINT_URL: "http://localhost:4566" }, async () => {
    await deployWith(fake, "local");
  });
  expect(fake.deployed).toHaveLength(1);
});

test("remove asks for the stack name in a terminal, or --yes", async () => {
  const fake = await fakeProvider();
  const config = defineConfig({ name: "shop", provider: fake.provider });
  const prompts: string[] = [];

  await expect(
    removeProject(
      { config, output: () => {}, stage: "dev" },
      {
        confirm: async (prompt) => {
          prompts.push(prompt);

          return await Promise.resolve("nope");
        },
        interactive: true,
      }
    )
  ).rejects.toThrow("Removal cancelled; shop-dev was not changed.");
  expect(fake.removed).toEqual([]);

  await removeProject(
    { config, output: () => {}, stage: "dev" },
    {
      confirm: async () => await Promise.resolve("shop-dev"),
      interactive: true,
    }
  );
  await removeProject(
    { config, output: () => {}, stage: "dev", yes: true },
    { interactive: false }
  );

  expect(prompts[0]).toContain("Type shop-dev to confirm");
  expect(fake.removed).toHaveLength(2);
});

test("remove refuses to run unconfirmed outside a terminal", async () => {
  const fake = await fakeProvider();
  const config = defineConfig({ name: "shop", provider: fake.provider });

  await expect(
    removeProject(
      { config, output: () => {}, stage: "dev" },
      { interactive: false }
    )
  ).rejects.toBeInstanceOf(CliUsageError);
  expect(fake.removed).toEqual([]);
});

test("remove reports a stage that is not deployed", async () => {
  const fake = await fakeProvider({ status: "absent" });
  const lines: string[] = [];

  await removeProject(
    {
      config: defineConfig({ name: "shop", provider: fake.provider }),
      output: (line) => {
        lines.push(line);
      },
      stage: "dev",
      yes: true,
    },
    {}
  );

  expect(lines).toEqual(["Nothing to remove"]);
});

const ignoreOutput = (): undefined => undefined;

test("the CLI routes deploy and remove, with boolean flags, to the configured Provider", async () => {
  const directory = tempPath(`voke-deploy-routing-${crypto.randomUUID()}`);
  const configPath = join(directory, "voke.config.ts");
  const calls =
    (globalThis as { vokeDeployCalls?: string[] }).vokeDeployCalls ?? [];
  (globalThis as { vokeDeployCalls?: string[] }).vokeDeployCalls = calls;
  calls.length = 0;
  directories.push(directory);

  await mkdir(join(directory, "src", "dist"), { recursive: true });
  await writeFile(join(directory, "src", "dist", "index.js"), "export {};\n");
  await writeFile(
    join(directory, "src", "index.ts"),
    `import { createFunctions, http, route } from "${import.meta.dir}/../src/index.ts";

export const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
});
`
  );
  await writeFile(
    configPath,
    `const calls = globalThis.vokeDeployCalls;
const outdir = ${JSON.stringify(join(directory, "src", "dist"))};

export default {
  entrypoint: ${JSON.stringify(join(directory, "src", "index.ts"))},
  name: "routed",
  provider: {
    name: "recording",
    build: {
      plan: () => ({
        command: ["bun", "build"],
        entrypoints: [],
        files: {},
        manifest: { functions: {} },
        outdir,
        outputs: { entry: { file: outdir + "/index.js" } },
        sources: {},
      }),
    },
    deploy: {
      deploy: async (input) => {
        calls.push(
          "deploy:" + input.stage + ":" + input.dryRun + ":" + input.acceptDataLoss
        );
        return { id: "routed-" + input.stage, outputs: {}, status: "dry-run" };
      },
      remove: async (input) => {
        calls.push("remove:" + input.stage);
        return { status: "removed" };
      },
    },
  },
};
`
  );

  await runCli(
    ["deploy", "--config", configPath, "--stage", "dev", "--dry-run"],
    {
      output: ignoreOutput,
      run: () => {},
    }
  );
  await runCli(
    ["deploy", "--config", configPath, "--stage", "dev", "--accept-data-loss"],
    {
      output: ignoreOutput,
      run: () => {},
    }
  );
  await runCli(["remove", "--config", configPath, "--stage", "dev", "--yes"], {
    output: ignoreOutput,
  });

  expect(calls).toEqual([
    "deploy:dev:true:false",
    "deploy:dev:false:true",
    "remove:dev",
  ]);
});

test("voke experimental is no longer a command", async () => {
  await expect(runCli(["experimental", "deploy"])).rejects.toThrow(
    CliUsageError
  );
});
