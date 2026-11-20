import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import gateway from "../src/index";
import config from "../voke.config";

// The Lambda Bundle is loaded by every Function at cold start, so it must hold run-time code only.
// This test builds it through the AWS Provider's build plan, exactly as `voke build` does, and
// reads the bundler's metafile to prove no deploy-time module comes back.
const directory = join(import.meta.dir, "..");

/**
 * The Lambda Bundle of this example in bytes: 137,637 when set, rounded up to the next 5,000 plus
 * 5,000 of headroom. It guards against deploy-time code (CloudFormation synthesis, deploy, the
 * local workflow) re-entering the bundle. Raise it only after checking the metafile
 * (`bun build ... --metafile`) for a deploy-time module.
 */
const maxBundleBytes = 145_000;

const deployTimeModules = [
  ...[
    "provider.ts",
    "build.ts",
    "data-retention.ts",
    "dead-letter-queue.ts",
    "deploy.ts",
    "deploy-clients.ts",
    "zip.ts",
    "local.ts",
    "local-aws-emulator.ts",
    "local-provider.ts",
    "diagnostics.ts",
    "durable-synthesis.ts",
    "event-source-resources.ts",
    "event-sources.ts",
    "testing.ts",
  ].map((file) => `packages/aws/src/${file}`),
  "packages/build/src/index.ts",
  ...[
    "cli.ts",
    "cli-spec.ts",
    "dev.ts",
    "doctor.ts",
    "model.ts",
    "project.ts",
    "scaffold.ts",
    "serverless-migration.ts",
  ].map((file) => `packages/core/src/${file}`),
];

const deployTimeMarkers = [
  "AWSTemplateFormatVersion",
  "AWS::Lambda::Function",
  "AWS::IAM::Role",
  "AWS::Lambda::EventSourceMapping",
  "@aws-sdk/client-cloudformation",
  "@aws-sdk/client-s3",
  "node:zlib",
  "node:child_process",
  "voke-manifest.json",
];

interface Metafile {
  outputs: Record<
    string,
    { inputs: Record<string, { bytesInOutput: number }> }
  >;
}

let outdir = "";
let bundle = "";
let bundleBytes = 0;
/** Bytes each input module contributes to the bundle, keyed by its path in the metafile. */
const inputBytes = new Map<string, number>();

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), "voke-bundle-"));

  const plan = config.provider?.build?.plan?.({
    build: { ...config.build, outdir },
    config,
    configPath: "voke.config.ts",
    entrypoint: config.entrypoint,
    functions: gateway.functions,
  });

  if (plan === undefined) {
    throw new Error("The AWS Provider must provide a build plan");
  }

  for (const [path, contents] of Object.entries(plan.sources)) {
    await Bun.write(resolve(directory, path), contents);
  }

  const metafilePath = join(outdir, "meta.json");
  const build = Bun.spawn([...plan.command, `--metafile=${metafilePath}`], {
    cwd: directory,
    stderr: "pipe",
    stdout: "pipe",
  });

  if ((await build.exited) !== 0) {
    throw new Error(
      `bundle build failed: ${await new Response(build.stderr).text()}`
    );
  }

  const bundleFile = Bun.file(join(outdir, "index.js"));

  bundle = await bundleFile.text();
  bundleBytes = bundleFile.size;

  const metafile = (await Bun.file(metafilePath).json()) as Metafile;

  for (const output of Object.values(metafile.outputs)) {
    for (const [path, { bytesInOutput }] of Object.entries(output.inputs)) {
      inputBytes.set(path, (inputBytes.get(path) ?? 0) + bytesInOutput);
    }
  }
});

afterAll(async () => {
  // `.voke/` is git-ignored and may hold `voke local` outputs, so only the bundle is removed.
  await rm(outdir, { force: true, recursive: true });
});

const bytesFrom = (suffix: string): number =>
  [...inputBytes]
    .filter(([path]) => path.endsWith(suffix))
    .reduce((total, [, bytes]) => total + bytes, 0);

test("the Lambda Bundle holds no deploy-time module", () => {
  // Guards against a changed metafile path format making the assertions below pass vacuously.
  expect(bytesFrom("packages/aws/src/lambda-handlers.ts")).toBeGreaterThan(0);

  const present = Object.fromEntries(
    deployTimeModules
      .map((suffix) => [suffix, bytesFrom(suffix)] as const)
      .filter(([, bytes]) => bytes > 0)
  );

  expect(present).toEqual({});
});

test("the Lambda Bundle holds no deploy-time code", () => {
  expect(deployTimeMarkers.filter((marker) => bundle.includes(marker))).toEqual(
    []
  );
});

test("the Lambda Bundle keeps function names for stack traces", () => {
  expect(bundle).toContain("createLambdaHandlers");
});

test("the Lambda Bundle stays within the size budget", () => {
  expect(bundleBytes).toBeLessThanOrEqual(maxBundleBytes);
});
