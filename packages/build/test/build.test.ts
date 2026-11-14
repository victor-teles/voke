import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFunctions, defineConfig, fn, http, route } from "voke";
import type { StandardSchemaV1 } from "voke";

import { createBuildPlan } from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value }),
    vendor: "voke-test",
    version: 1,
  },
});

const buildConfig = (build: Parameters<typeof defineConfig>[0]["build"] = {}) =>
  defineConfig({ build, name: "build-test" }).build;

test("plans one Node.js ESM bundle per entrypoint with the AWS SDK external", () => {
  const plan = createBuildPlan({
    build: buildConfig({ outdir: "./build" }),
    entrypoints: ["./src/index.ts"],
    functions: {},
  });

  expect(plan).toEqual({
    command: [
      "bun",
      "build",
      "./src/index.ts",
      "--outdir",
      "./build",
      "--target",
      "node",
      "--format",
      "esm",
      "--external",
      "@aws-sdk/*",
    ],
    entrypoints: ["./src/index.ts"],
    files: { "build/package.json": '{"type":"module"}\n' },
    manifest: { functions: {} },
    outdir: "./build",
    outputs: { "./src/index.ts": { file: "build/index.js" } },
    sources: {},
  });
});

test("bundles the AWS SDK when build.external is empty and passes every pattern", () => {
  expect(
    createBuildPlan({
      build: buildConfig({ external: [] }),
      entrypoints: ["./src/index.ts"],
      functions: {},
    }).command
  ).not.toContain("--external");
  expect(
    createBuildPlan({
      build: buildConfig({ external: ["@aws-sdk/*", "sharp"] }),
      entrypoints: ["./src/index.ts"],
      functions: {},
    }).command.slice(-4)
  ).toEqual(["--external", "@aws-sdk/*", "--external", "sharp"]);
});

test("gives Functions with an explicit synthesis.entrypoint their own bundle and handler", () => {
  const functions = createFunctions({
    checkout: fn({
      handler: (payload) => ({ id: payload.cartId }),
      input: schema<{ cartId: string }>(),
      output: schema<{ id: string }>(),
      synthesis: { entrypoint: "./src/functions/checkout.ts" },
    }),
    users: http({
      routes: [route.get("/users", { handler: () => [] })],
      synthesis: {
        entrypoint: "./src/functions/users.ts",
        handler: "users.main",
      },
    }),
    web: http({ routes: [route.get("/", { handler: () => "ok" })] }),
  });
  const plan = createBuildPlan({
    build: buildConfig(),
    entrypoints: ["./src/index.ts"],
    functions,
  });

  expect(plan.entrypoints).toEqual([
    "./src/index.ts",
    "./src/functions/checkout.ts",
    "./src/functions/users.ts",
  ]);
  // Outputs keep their path under the entrypoints' common directory, as the bundler does.
  expect(plan.outputs).toEqual({
    "./src/functions/checkout.ts": { file: "dist/functions/checkout.js" },
    "./src/functions/users.ts": { file: "dist/functions/users.js" },
    "./src/index.ts": { file: "dist/index.js" },
  });
  expect(plan.manifest.functions).toEqual({
    checkout: {
      file: "dist/functions/checkout.js",
      handler: "functions/checkout.handler",
    },
    users: { file: "dist/functions/users.js", handler: "users.main" },
  });
});

test("planned output paths match what the bundler writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voke-build-plan-"));

  try {
    await Bun.write(join(directory, "src/index.ts"), "export const a = 1;\n");
    await Bun.write(join(directory, "src/functions/job.ts"), "export const b = 2;\n");
    const plan = createBuildPlan({
      build: buildConfig(),
      entrypoints: ["./src/index.ts", "./src/functions/job.ts"],
      functions: {},
    });
    const child = Bun.spawn(plan.command, { cwd: directory, stderr: "pipe" });

    expect(await child.exited).toBe(0);

    for (const output of Object.values(plan.outputs)) {
      expect(await Bun.file(join(directory, output.file)).exists()).toBe(true);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("plans the same bundle paths for Windows-style separators", () => {
  const posix = createBuildPlan({
    build: buildConfig({ outdir: "./build" }),
    entrypoints: ["./src/jobs/report.ts", "./src/index.ts"],
    functions: {},
  });
  const windows = createBuildPlan({
    build: buildConfig({ outdir: ".\\build" }),
    entrypoints: [".\\src\\jobs\\report.ts", ".\\src\\index.ts"],
    functions: {},
  });

  expect(Object.values(windows.outputs)).toEqual(Object.values(posix.outputs));
  expect(windows.files).toEqual(posix.files);
});
