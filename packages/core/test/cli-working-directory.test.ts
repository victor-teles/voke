import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { loadVokeConfig } from "../src/config";
import { loadProject } from "../src/project";
import { withEnv } from "./support/env";
import { tempPath } from "./support/temp";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const coreIndex = join(import.meta.dir, "..", "src", "index.ts");
const root = tempPath(`voke-cli-cwd-${crypto.randomUUID()}`);
const project = join(root, "project");
const elsewhere = join(root, "elsewhere");

const synthesisProvider = `{
    name: "test",
    synthesis: {
      synthesize: ({ model }) => ({ Description: "template for " + model.service.name }),
    },
  }`;

let fixture: Promise<void> | undefined;

/** A project with a relative entrypoint, and another directory with a different config. */
const writeFixture = async (): Promise<void> => {
  await Bun.write(
    join(project, "src", "index.ts"),
    `import { createFunctions, http, route } from ${JSON.stringify(coreIndex)};

export const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
});
`
  );
  await Bun.write(
    join(project, "voke.config.ts"),
    `export default {
  entrypoint: "./src/index.ts",
  name: "here",
  provider: ${synthesisProvider},
};
`
  );
  await Bun.write(
    join(elsewhere, "voke.config.ts"),
    `export default { name: "elsewhere", provider: ${synthesisProvider} };\n`
  );
};

const ensureFixture = (): Promise<void> => {
  fixture ??= writeFixture();
  return fixture;
};

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const templateDescription = async (path: string): Promise<unknown> => {
  const template = (await Bun.file(path).json()) as { Description?: unknown };

  return template.Description;
};

/** Runs `voke synth` in a real process started in the project directory. */
const spawnSynth = async (
  env: Record<string, string | undefined>,
  out: string
): Promise<{ exitCode: number; stderr: string }> => {
  const child = Bun.spawn([process.execPath, cliPath, "synth", "--out", out], {
    cwd: project,
    env,
    stderr: "pipe",
    stdout: "ignore",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stderr };
};

test("voke synth finds the project from the process working directory when PWD is stale", async () => {
  await ensureFixture();
  const out = join(root, "stale-pwd.json");

  const result = await spawnSynth({ ...process.env, PWD: elsewhere }, out);

  expect(result).toEqual({ exitCode: 0, stderr: "" });
  expect(await templateDescription(out)).toBe("template for here");
});

test("voke synth finds the project from the process working directory when PWD is unset", async () => {
  await ensureFixture();
  const out = join(root, "no-pwd.json");
  const env: Record<string, string | undefined> = { ...process.env };

  Reflect.deleteProperty(env, "PWD");

  const result = await spawnSynth(env, out);

  expect(result).toEqual({ exitCode: 0, stderr: "" });
  expect(await templateDescription(out)).toBe("template for here");
});

test("runCli resolves the project from its cwd option, not PWD", async () => {
  await ensureFixture();
  const out = join(root, "option.json");

  await withEnv({ PWD: elsewhere }, () =>
    runCli(["synth", "--out", out], { cwd: project, output: () => {} })
  );

  expect(await templateDescription(out)).toBe("template for here");
});

test("loadVokeConfig and loadProject do not read PWD", async () => {
  await ensureFixture();

  await withEnv({ PWD: join(root, "does-not-exist") }, async () => {
    const config = await loadVokeConfig({
      path: join(project, "voke.config.ts"),
    });
    const absolute = await loadProject({
      config,
      entrypoint: join(project, "src", "index.ts"),
    });
    const relative = await loadProject({ config, cwd: project });

    expect(config.name).toBe("here");
    expect(absolute.entrypoint).toBe(join(project, "src", "index.ts"));
    expect(relative.entrypoint).toBe(join(project, "src", "index.ts"));
  });
});
