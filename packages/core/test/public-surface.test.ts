import { expect, test } from "bun:test";

import packageJson from "../package.json";
import * as aws from "../src/aws";
import * as voke from "../src/index";
import * as local from "../src/local";

const documentationFiles = [
  "../../../README.md",
  "../../../docs/e2e-testing.md",
  "../../../docs/serverless-framework-migration.md",
  "../../../docs/stable-public-surface.md",
];

const firstPartyExampleFiles = [
  "../../../examples/cross-function/src/functions.ts",
  "../../../examples/cross-function/src/index.ts",
  "../../../examples/e2e/src/functions.ts",
  "../../../examples/e2e/src/index.ts",
  "../../../examples/hello-api/src/index.ts",
  "../../../examples/sqs-events/src/functions.ts",
];

const readPackageFile = async (path: string): Promise<string> =>
  await Bun.file(new URL(path, import.meta.url)).text();

test("keeps the stable root runtime surface intentional", () => {
  expect(Object.keys(voke).toSorted()).toEqual([
    "InvokeError",
    "Voke",
    "VokeConfigError",
    "VokeError",
    "VokeModelError",
    "VokeResourceBindingError",
    "api",
    "awsContext",
    "awsEvent",
    "bindResource",
    "createApiApp",
    "createAwsClientConfig",
    "createBuildPlan",
    "createDevPlan",
    "createFlociComposeConfig",
    "createFunctionContractArtifact",
    "createGateway",
    "createHttpApiEvent",
    "createInternalModel",
    "createInvokeTestClient",
    "createLocalAwsEnvironment",
    "createLocalBootstrapPlan",
    "createLocalResourceBindings",
    "createResourceBindingDefinition",
    "createResourceBindingName",
    "createSqsEventHandler",
    "createStackTestContext",
    "createTestClient",
    "defineConfig",
    "defineFunction",
    "defineFunctions",
    "defineRemoteFunctions",
    "generateRemoteModules",
    "getConfig",
    "invokeRegistryFunction",
    "json",
    "jsonError",
    "loadVokeConfig",
    "mountDevFunctionEndpoints",
    "renderRemoteModule",
    "requestId",
    "routeModule",
    "sqsEventSource",
    "sqsMessageBatch",
    "synthesizeCloudFormation",
    "synthesizeCloudFormationFromModel",
    "withInvokeTrace",
  ]);
});

test("keeps AWS resource authoring on the voke/aws subpath", () => {
  expect(Object.keys(aws).toSorted()).toEqual([
    "bindResource",
    "createAwsClientConfig",
    "createResourceBindingName",
    "dynamodbTable",
    "eventBus",
    "s3Bucket",
    "secret",
    "snsTopic",
    "sqsQueue",
    "ssmParameter",
    "toEnvKey",
  ]);
  expect("dynamodbTable" in voke).toBe(false);
  expect("sqsQueue" in voke).toBe(false);
});

test("publishes only stable package subpaths", () => {
  expect(Object.keys(packageJson.exports).toSorted()).toEqual([
    ".",
    "./aws",
    "./build",
    "./cloudformation",
    "./dev",
    "./e2e",
    "./invoke",
    "./local",
    "./serverless-migration",
  ]);
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
    "defineFunctions",
    "defineFunction",
    "new Voke",
    "createGateway",
  ]) {
    expect(combinedExamples).toContain(symbol);
  }

  for (const removedApi of [
    "createApiApp",
    "createFunctionRegistry",
    "registerLocalFunction",
    "resetLocalFunctions",
  ]) {
    expect(combinedExamples).not.toContain(removedApi);
  }
});
