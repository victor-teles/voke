import { expect, test } from "bun:test";

import packageJson from "../package.json";
import * as voke from "../src/index";

const documentationFiles = [
  "../../../README.md",
  "../../../apps/docs/app/layout.tsx",
  "../../../apps/docs/app/page.tsx",
  "../../../apps/docs/content/docs/index.mdx",
  "../../../apps/docs/content/docs/getting-started.mdx",
  "../../../apps/docs/content/docs/guides/functions.mdx",
  "../../../apps/docs/content/docs/guides/gateway-testing.mdx",
  "../../../docs/e2e-testing.md",
  "../../../docs/serverless-framework-migration.md",
  "../../../docs/stable-public-surface.md",
];

const teachingSurfaceFiles = [
  "../../../README.md",
  "../../../apps/docs/app/layout.tsx",
  "../../../apps/docs/app/page.tsx",
  "../../../apps/docs/content/docs/index.mdx",
  "../../../apps/docs/content/docs/getting-started.mdx",
  "../../../apps/docs/content/docs/guides/functions.mdx",
  "../../../apps/docs/content/docs/guides/gateway-testing.mdx",
  "../../../docs/e2e-testing.md",
  "../../../docs/serverless-framework-migration.md",
  "../../../packages/core/src/cli.ts",
  "../../../packages/core/src/serverless-migration.ts",
];

const firstPartyExampleFiles = [
  "../../../examples/cross-function/src/functions.ts",
  "../../../examples/cross-function/src/index.ts",
  "../../../examples/e2e/src/functions.ts",
  "../../../examples/e2e/src/index.ts",
  "../../../examples/hello-api/src/index.ts",
  "../../../examples/hello-api/src/aws.ts",
  "../../../examples/hello-api/src/local.ts",
  "../../../examples/hello-api/src/middleware/request-info.ts",
  "../../../examples/sqs-events/src/functions.ts",
];

const readPackageFile = async (path: string): Promise<string> =>
  await Bun.file(new URL(path, import.meta.url)).text();

const importPackage = async (
  specifier: string
): Promise<Record<string, unknown>> => {
  if (specifier === "@voke/remote") {
    return await import("../../remote/src/index.ts");
  }

  if (specifier === "@voke/testing") {
    return await import("../../testing/src/index.ts");
  }

  return await import(specifier);
};

test("keeps the stable root runtime surface intentional", () => {
  expect(Object.keys(voke).toSorted()).toEqual([
    "InvokeError",
    "VokeConfigError",
    "activateFunctionRegistry",
    "createFunctions",
    "createHandlerNameFromEntrypoint",
    "createVokeModel",
    "defineConfig",
    "fn",
    "http",
    "invokeRegistryFunction",
    "loadVokeConfig",
    "route",
    "toEnvKey",
    "voke",
  ]);
});

test("keeps AWS authoring in @voke/aws", async () => {
  const aws = await importPackage("@voke/aws");

  expect(Object.keys(aws).toSorted()).toEqual([
    "aws",
    "bindResource",
    "createAuthorizers",
    "createAwsClientConfig",
    "createAwsLambdaHandler",
    "createAwsLambdaInvokeTransport",
    "createResourceBindingName",
    "createSqsEventHandler",
    "dynamodbTable",
    "eventBus",
    "handleAwsLambdaRequest",
    "jwtAuthorizer",
    "lambdaAuthorizer",
    "requestAuthorizer",
    "s3Bucket",
    "secret",
    "snsTopic",
    "sqs",
    "sqsEventSource",
    "sqsMessageBatch",
    "sqsQueue",
    "ssmParameter",
    "toEnvKey",
  ]);
  expect("dynamodbTable" in voke).toBe(false);
  expect("sqsQueue" in voke).toBe(false);
});

test("publishes only stable package subpaths", () => {
  expect(Object.keys(packageJson.exports).toSorted()).toEqual(["."]);
});

test("keeps provider-neutral testing helpers in @voke/testing", async () => {
  const testing = await importPackage("@voke/testing");

  expect(Object.keys(testing).toSorted()).toEqual([
    "createInvokeTestClient",
    "createTestClient",
  ]);
  expect("createTestClient" in voke).toBe(false);
});

test("keeps AWS testing helpers in @voke/aws/testing", async () => {
  const awsTesting = await importPackage("@voke/aws/testing");

  expect(Object.keys(awsTesting).toSorted()).toEqual([
    "createStackTestContext",
  ]);
  expect("createStackTestContext" in voke).toBe(false);
});

test("keeps Remote Function helpers in @voke/remote", async () => {
  const remote = await importPackage("@voke/remote");

  expect(Object.keys(remote).toSorted()).toContain("createRemoteFunctions");
  expect("createRemoteFunctions" in voke).toBe(false);
  expect("defineRemoteFunctions" in voke).toBe(false);
});

test("keeps HTTP helpers in @voke/http", async () => {
  const httpHelpers = await importPackage("@voke/http");

  expect(Object.keys(httpHelpers).toSorted()).toEqual([
    "created",
    "error",
    "json",
    "jsonError",
    "noContent",
    "ok",
    "response",
  ]);
  expect("ok" in voke).toBe(false);
  expect("response" in voke).toBe(false);
});

test("keeps schema helpers in @voke/schema", async () => {
  const schemaHelpers = await importPackage("@voke/schema");

  expect(Object.keys(schemaHelpers).toSorted()).toEqual(["schema"]);
  expect("schema" in voke).toBe(false);
});

test("keeps local AWS provider helpers in @voke/aws/local", async () => {
  const local = await importPackage("@voke/aws/local");

  expect(Object.keys(local).toSorted()).toEqual([
    "LocalProviderError",
    "createFlociComposeConfig",
    "createFlociLocalProvider",
    "createLocalAwsEnvironment",
    "createLocalBootstrapPlan",
    "createLocalResourceBindings",
    "resolveLocalProvider",
  ]);
  expect("createFlociLocalProvider" in voke).toBe(false);
});

test("documents the stable Function-first Gateway vocabulary", async () => {
  const docs = await Promise.all(documentationFiles.map(readPackageFile));
  const combinedDocs = docs.join("\n");

  for (const term of [
    "Function",
    "Function Registry",
    "Function Contract",
    "Gateway",
    "Route Builder",
  ]) {
    expect(combinedDocs).toContain(term);
  }

  expect(combinedDocs).toContain("functions.invoke(");
  expect(combinedDocs).toContain("functions.route(");
  expect(combinedDocs).toContain("gateway.request(");
});

test("keeps first-party examples on the Function-first Gateway API", async () => {
  const examples = await Promise.all(
    firstPartyExampleFiles.map(readPackageFile)
  );
  const combinedExamples = examples.join("\n");

  for (const symbol of [
    "createFunctions",
    "fn",
    "http",
    "route",
    "sqs",
    "voke",
  ]) {
    expect(combinedExamples).toContain(symbol);
  }

  for (const removedApi of [
    "api(",
    "createGateway",
    "createApiApp",
    "createFunctionRegistry",
    "defineFunction",
    "defineFunctions",
    "new Voke",
    "registerLocalFunction",
    "resetLocalFunctions",
    "sqsEventSource",
    "sqsMessageBatch",
  ]) {
    expect(combinedExamples).not.toContain(removedApi);
  }
});

test("keeps first-party teaching surfaces off removed authoring names", async () => {
  const surfaces = await Promise.all(teachingSurfaceFiles.map(readPackageFile));
  const combinedSurfaces = surfaces.join("\n");

  for (const removedApi of [
    "createGateway",
    "defineFunction",
    "defineFunctions",
    "new Voke",
    "sqsEventSource",
    "sqsMessageBatch",
  ]) {
    expect(combinedSurfaces).not.toContain(removedApi);
  }

  expect(combinedSurfaces).not.toContain(
    "Function-first AWS Lambda framework for Bun"
  );
  expect(combinedSurfaces).not.toContain("Hono-compatible APIs");
  expect(combinedSurfaces).not.toContain("Bun-first");
});
