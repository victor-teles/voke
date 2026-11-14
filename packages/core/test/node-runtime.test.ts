import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { aws } from "@voke/aws";

import { defineConfig } from "../src/config";
import { functions } from "./fixtures/node-runtime/index";
import { createHttpApiEvent } from "./support/http-api-event";

// Built bundles must run on the AWS Lambda Node.js runtime, so this test builds the
// fixture project through the AWS Provider's build plan, exactly as `voke build` does
// (generated entry module included), and loads the output with real Node.
// The output lives under packages/core so Node resolves the external AWS SDK from
// the workspace node_modules, as the Lambda runtime resolves its bundled SDK.
const packageDirectory = join(import.meta.dir, "..");
const outputRoot = join(packageDirectory, ".tmp-node-runtime");
const outdir = join(outputRoot, crypto.randomUUID());
const entrypoint = "./test/fixtures/node-runtime/index.ts";
const bundlePath = join(outdir, "index.js");

interface LambdaResult {
  body: string;
  statusCode: number;
}

const runInNode = async <TResult = LambdaResult>(
  exportName: string,
  events: unknown[],
  env: Record<string, string> = {}
): Promise<TResult[]> => {
  const script = `
const handlers = await import(${JSON.stringify(`file://${bundlePath}`)});
const handler = handlers[${JSON.stringify(exportName)}];
const events = JSON.parse(process.env.VOKE_TEST_EVENTS);
const results = [];
for (const event of events) {
  const result = await handler(event, {});
  results.push(result.statusCode === undefined ? result : { body: result.body, statusCode: result.statusCode });
}
process.stdout.write(JSON.stringify(results));
`;
  // Module syntax detection is off so the bundle loads as ESM only because of the
  // package.json the build plan writes, not because this Node version guesses it.
  const child = Bun.spawn(
    [
      "node",
      "--no-experimental-detect-module",
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: packageDirectory,
      env: {
        PATH: process.env.PATH ?? "",
        VOKE_TEST_EVENTS: JSON.stringify(events),
        ...env,
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`node exited with ${exitCode}: ${stderr}`);
  }

  return JSON.parse(stdout) as TResult[];
};

beforeAll(async () => {
  if (Bun.which("node") === null) {
    throw new Error(
      "node is required on PATH: this test proves Voke bundles run on the Lambda Node.js runtime"
    );
  }

  const provider = aws();
  const config = defineConfig({ entrypoint, name: "node-runtime", provider });
  const plan = provider.build?.plan?.({
    build: { ...config.build, outdir },
    config,
    entrypoint,
    functions,
  });

  if (plan === undefined) {
    throw new Error("The AWS Provider must provide a build plan");
  }

  for (const [path, contents] of Object.entries(plan.sources)) {
    await Bun.write(resolve(packageDirectory, path), contents);
  }

  const build = Bun.spawn(plan.command, {
    cwd: packageDirectory,
    stderr: "pipe",
    stdout: "pipe",
  });

  if ((await build.exited) !== 0) {
    throw new Error(
      `bundle build failed: ${await new Response(build.stderr).text()}`
    );
  }

  for (const [path, contents] of Object.entries(plan.files)) {
    const filePath = resolve(packageDirectory, path);

    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(filePath, contents);
  }
});

afterAll(async () => {
  await rm(outputRoot, { force: true, recursive: true });
  await rm(join(packageDirectory, ".voke"), { force: true, recursive: true });
});

test("build writes a module-type package.json next to the bundle", async () => {
  expect(await Bun.file(join(outdir, "package.json")).json()).toEqual({
    type: "module",
  });
});

test("built bundle does not reference the Bun global", async () => {
  const bundle = await Bun.file(bundlePath).text();

  expect(bundle).not.toMatch(/\bBun\./u);
});

test("built bundle serves Gateway routes on the Node.js runtime", async () => {
  const results = await runInNode(
    "http",
    [
      createHttpApiEvent("GET", "/health"),
      createHttpApiEvent("GET", "/greeting"),
      createHttpApiEvent("GET", "/table"),
      createHttpApiEvent("GET", "/missing"),
    ],
    { VOKE_RESOURCE_USERS_TABLE_NAME: "users-node" }
  );

  expect(results).toEqual([
    {
      body: JSON.stringify({ data: { ok: true, runtime: "node" } }),
      statusCode: 200,
    },
    {
      body: JSON.stringify({ data: { message: "Hello, Node" } }),
      statusCode: 200,
    },
    {
      body: JSON.stringify({ data: { table: "users-node" } }),
      statusCode: 200,
    },
    {
      body: JSON.stringify({
        error: { code: "NOT_FOUND", message: "Route not found" },
      }),
      statusCode: 404,
    },
  ]);
});

const record = (messageId: string, body: string) => ({
  attributes: {},
  awsRegion: "us-east-1",
  body,
  eventSource: "aws:sqs",
  eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:orders",
  md5OfBody: "",
  messageAttributes: {},
  messageId,
  receiptHandle: `receipt-${messageId}`,
});
test("built bundle runs the generated SQS handler on the Node.js runtime", async () => {
  const results = await runInNode<{ batchItemFailures: unknown[] }>(
    "processOrder",
    [
      {
        Records: [record("valid", '{"name":"Ada"}'), record("bad", "not json")],
      },
    ]
  );

  expect(results).toEqual([{ batchItemFailures: [{ itemIdentifier: "bad" }] }]);
});
