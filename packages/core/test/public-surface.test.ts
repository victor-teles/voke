import { expect, test } from "bun:test";

import packageJson from "../package.json";
import * as aws from "../src/aws";
import * as cloudformation from "../src/cloudformation";
import * as testing from "../src/e2e";
import * as voke from "../src/index";
import * as local from "../src/local";
import * as remote from "../src/remote";
import * as responseHelpers from "../src/response";
import * as schemaHelpers from "../src/schema";
import * as variables from "../src/variables";

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

test("keeps the stable root runtime surface intentional", () => {
  expect(Object.keys(voke).toSorted()).toEqual([
    "createAuthorizers",
    "createFunctions",
    "defineConfig",
    "fn",
    "http",
    "jwtAuthorizer",
    "lambdaAuthorizer",
    "requestAuthorizer",
    "route",
    "sqs",
    "voke",
  ]);
});

test("keeps AWS runtime helpers on the voke/aws subpath", () => {
  expect(Object.keys(aws).toSorted()).toEqual([
    "bindResource",
    "createAwsClientConfig",
    "createResourceBindingName",
    "parameter",
    "secret",
    "toEnvKey",
  ]);
  expect("dynamodbTable" in voke).toBe(false);
  expect("sqsQueue" in voke).toBe(false);
});

test("keeps AWS resource authoring on the voke/cloudformation subpath", () => {
  expect(Object.keys(cloudformation)).toContain("dynamodbTable");
  expect(Object.keys(cloudformation)).toContain("eventBus");
  expect(Object.keys(cloudformation)).toContain("s3Bucket");
  expect(Object.keys(cloudformation)).toContain("secret");
  expect(Object.keys(cloudformation)).toContain("snsTopic");
  expect(Object.keys(cloudformation)).toContain("sqsQueue");
  expect(Object.keys(cloudformation)).toContain("ssmParameter");
  expect("dynamodbTable" in aws).toBe(false);
  expect("ssmParameter" in aws).toBe(false);
});

test("publishes only stable package subpaths", () => {
  expect(Object.keys(packageJson.exports).toSorted()).toEqual([
    ".",
    "./aws",
    "./build",
    "./cloudformation",
    "./config",
    "./context",
    "./dev",
    "./invoke",
    "./local",
    "./model",
    "./remote",
    "./response",
    "./schema",
    "./serverless-migration",
    "./testing",
    "./variables",
  ]);
});

test("publishes Runtime Variable extension helpers on voke/variables", () => {
  expect(Object.keys(variables).toSorted()).toEqual([
    "VokeRuntimeVariableError",
    "createRuntimeVariableCache",
    "createRuntimeVariables",
    "createVariableProvider",
    "createVariableSource",
    "loadRuntimeVariablesBeforeHandler",
  ]);
});

test("keeps testing helpers on the voke/testing subpath", () => {
  expect(Object.keys(testing).toSorted()).toEqual([
    "createHttpApiEvent",
    "createInvokeTestClient",
    "createStackTestContext",
    "createTestClient",
  ]);
  expect("createTestClient" in voke).toBe(false);
});

test("keeps Remote Function helpers on the voke/remote subpath", () => {
  expect(Object.keys(remote).toSorted()).toContain("createRemoteFunctions");
  expect("createRemoteFunctions" in voke).toBe(false);
  expect("defineRemoteFunctions" in voke).toBe(false);
});

test("keeps response helpers on the voke/response subpath", () => {
  expect(Object.keys(responseHelpers).toSorted()).toEqual([
    "created",
    "error",
    "noContent",
    "ok",
    "response",
  ]);
  expect("ok" in voke).toBe(false);
  expect("response" in voke).toBe(false);
});

test("keeps schema helpers on the voke/schema subpath", () => {
  expect(Object.keys(schemaHelpers).toSorted()).toEqual(["schema"]);
  expect("schema" in voke).toBe(false);
});

test("keeps local provider helpers on the voke/local subpath", () => {
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
