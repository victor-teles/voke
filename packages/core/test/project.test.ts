import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "../src/cli";
import { defineConfig } from "../src/config";
import { VokeConfigError } from "../src/errors";
import { loadProject } from "../src/project";
import { tempPath } from "./support/temp";

const coreIndex = `${import.meta.dir}/../src/index.ts`;
const directories: string[] = [];

const writeEntrypoint = async (source: string): Promise<string> => {
  const directory = tempPath(`voke-project-${crypto.randomUUID()}`);
  const entrypoint = `${directory}/src/index.ts`;

  directories.push(directory);
  await Bun.write(entrypoint, source);

  return entrypoint;
};

const registrySource = `import { createFunctions, http, route } from "${coreIndex}";

export const functions = createFunctions({
  http: http({ routes: [route.get("/health", { handler: () => "ok" })] }),
});
`;

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

test("discovers the Function Registry of a Gateway default export", async () => {
  const entrypoint = await writeEntrypoint(`${registrySource}
import { voke } from "${coreIndex}";

export default voke(functions, { config: { name: "gateway-project" } });
`);
  const project = await loadProject({
    config: defineConfig({ name: "gateway-project" }),
    entrypoint,
  });

  expect(Object.keys(project.functions)).toEqual(["http"]);
  expect(project.entrypoint).toBe(entrypoint);
});

test("discovers a functions export when there is no Gateway", async () => {
  const entrypoint = await writeEntrypoint(registrySource);
  const project = await loadProject({
    config: defineConfig({ name: "registry-project" }),
    entrypoint,
  });

  expect(Object.keys(project.functions)).toEqual(["http"]);
});

test("resolves a relative entrypoint against the working directory", async () => {
  const entrypoint = await writeEntrypoint(registrySource);
  const cwd = entrypoint.slice(0, -"/src/index.ts".length);
  const project = await loadProject({
    config: defineConfig({ entrypoint: "./src/index.ts", name: "relative" }),
    cwd,
  });

  expect(project.entrypoint).toBe(entrypoint);
});

test("rejects an entrypoint that exports neither a Gateway nor a Function Registry", async () => {
  const entrypoint = await writeEntrypoint("export const answer = 42;\n");
  const load = loadProject({
    config: defineConfig({ name: "empty" }),
    entrypoint,
  });

  await expect(load).rejects.toBeInstanceOf(VokeConfigError);
  await expect(
    loadProject({ config: defineConfig({ name: "empty" }), entrypoint })
  ).rejects.toThrow(
    `${entrypoint}: The project entrypoint must export a Gateway (export default voke(functions, { config })) or a Function Registry (export const functions = createFunctions({ ... })).`
  );
});

test("wraps import failures with the entrypoint and a hint about side effects", async () => {
  const entrypoint = await writeEntrypoint(
    'throw new Error("database unreachable");\n'
  );

  await expect(
    loadProject({ config: defineConfig({ name: "broken" }), entrypoint })
  ).rejects.toThrow(
    `Could not import the project entrypoint ${entrypoint}: database unreachable. Voke imports your entrypoint to discover Functions; guard side effects with process.env.VOKE_SYNTH.`
  );
});

test("sets VOKE_SYNTH while importing the entrypoint and restores it after", async () => {
  const entrypoint = await writeEntrypoint(`${registrySource}
export const seenSynthFlag = process.env.VOKE_SYNTH;
`);
  const previous = process.env.VOKE_SYNTH;
  Reflect.deleteProperty(process.env, "VOKE_SYNTH");

  try {
    await loadProject({ config: defineConfig({ name: "flag" }), entrypoint });
    const module = (await import(entrypoint)) as { seenSynthFlag?: string };

    expect(module.seenSynthFlag).toBe("1");
    expect(process.env.VOKE_SYNTH).toBeUndefined();
  } finally {
    if (previous !== undefined) {
      process.env.VOKE_SYNTH = previous;
    }
  }
});

test("voke synth exits with the discovery error when the entrypoint exports no Functions", async () => {
  const entrypoint = await writeEntrypoint("export const answer = 42;\n");
  const configPath = `${entrypoint.slice(0, -"/src/index.ts".length)}/voke.config.ts`;

  await Bun.write(
    configPath,
    `export default { name: "no-functions", entrypoint: ${JSON.stringify(entrypoint)}, provider: { name: "test", synthesis: { synthesize: () => ({}) } } };\n`
  );

  await expect(runCli(["synth", "--config", configPath])).rejects.toThrow(
    "The project entrypoint must export a Gateway"
  );
});
