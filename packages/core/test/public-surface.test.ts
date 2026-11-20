import { expect, test } from "bun:test";

import packageJson from "../package.json";
import * as voke from "../src/index";

// The pages that teach the vocabulary and the three ways to call a Function.
const documentationFiles = [
  "../../../README.md",
  "../../../apps/docs/app/layout.tsx",
  "../../../apps/docs/app/(home)/page.tsx",
  "../../../apps/docs/content/docs/index.mdx",
  "../../../apps/docs/content/docs/getting-started.mdx",
  "../../../apps/docs/content/docs/concepts.mdx",
  "../../../apps/docs/content/docs/guides/functions.mdx",
  "../../../apps/docs/content/docs/guides/http-routes.mdx",
  "../../../apps/docs/content/docs/guides/testing.mdx",
  "../../../docs/stable-public-surface.md",
];

// Every docs page, so no page teaches a removed name.
const teachingSurfaceFiles = [
  "../../../README.md",
  "../../../apps/docs/app/layout.tsx",
  "../../../apps/docs/app/(home)/page.tsx",
  "../../../apps/docs/content/docs/index.mdx",
  "../../../apps/docs/content/docs/getting-started.mdx",
  "../../../apps/docs/content/docs/concepts.mdx",
  "../../../apps/docs/content/docs/guides/functions.mdx",
  "../../../apps/docs/content/docs/guides/http-routes.mdx",
  "../../../apps/docs/content/docs/guides/openapi.mdx",
  "../../../apps/docs/content/docs/guides/schemas.mdx",
  "../../../apps/docs/content/docs/guides/authorizers.mdx",
  "../../../apps/docs/content/docs/guides/sqs-events.mdx",
  "../../../apps/docs/content/docs/guides/idempotency.mdx",
  "../../../apps/docs/content/docs/guides/sns-events.mdx",
  "../../../apps/docs/content/docs/guides/eventbridge-events.mdx",
  "../../../apps/docs/content/docs/guides/scheduled-functions.mdx",
  "../../../apps/docs/content/docs/guides/kinesis-events.mdx",
  "../../../apps/docs/content/docs/guides/dynamodb-stream-events.mdx",
  "../../../apps/docs/content/docs/guides/s3-events.mdx",
  "../../../apps/docs/content/docs/guides/dead-letter-queues.mdx",
  "../../../apps/docs/content/docs/guides/durable-functions.mdx",
  "../../../apps/docs/content/docs/guides/runtime-variables.mdx",
  "../../../apps/docs/content/docs/guides/resources.mdx",
  "../../../apps/docs/content/docs/guides/remote-functions.mdx",
  "../../../apps/docs/content/docs/guides/testing.mdx",
  "../../../apps/docs/content/docs/guides/local-aws.mdx",
  "../../../apps/docs/content/docs/guides/deploy.mdx",
  "../../../apps/docs/content/docs/guides/serverless-migration.mdx",
  "../../../apps/docs/content/docs/guides/plugins.mdx",
  "../../../apps/docs/content/docs/guides/troubleshooting.mdx",
  "../../../apps/docs/content/docs/reference/config.mdx",
  "../../../apps/docs/content/docs/reference/cli.mdx",
  "../../../apps/docs/content/docs/reference/errors.mdx",
  "../../../apps/docs/content/docs/reference/packages.mdx",
  "../../../packages/core/src/cli.ts",
  "../../../packages/core/src/serverless-migration.ts",
];

const firstPartyExampleFiles = [
  "../../../examples/cross-function/src/functions.ts",
  "../../../examples/cross-function/src/index.ts",
  "../../../examples/e2e/src/functions.ts",
  "../../../examples/e2e/src/index.ts",
  "../../../examples/hello-api/src/index.ts",
  "../../../examples/hello-api/src/local.ts",
  "../../../examples/hello-api/src/middleware/request-info.ts",
  "../../../examples/hello-api/src/plugins/request-timing.ts",
  "../../../examples/sqs-events/src/functions.ts",
  "../../../examples/event-sources/src/functions.ts",
  "../../../examples/stream-events/src/functions.ts",
  "../../../examples/durable-workflow/src/functions.ts",
  "../../../examples/durable-workflow/src/index.ts",
];

const readPackageFile = async (path: string): Promise<string> =>
  await Bun.file(new URL(path, import.meta.url)).text();

const importPackage = async (
  specifier: string
): Promise<Record<string, unknown>> => {
  if (specifier === "@vokejs/remote") {
    return await import("../../remote/src/index.ts");
  }

  if (specifier === "@vokejs/testing") {
    return await import("../../testing/src/index.ts");
  }

  return await import(specifier);
};

test("keeps the stable root runtime surface intentional", () => {
  expect(Object.keys(voke).toSorted()).toEqual([
    "InvokeError",
    "VokeConfigError",
    "VokeDeployError",
    "VokeError",
    "VokeModelError",
    "VokeResourceBindingError",
    "VokeRuntimeVariableError",
    "activateFunctionRegistry",
    "createFunctions",
    "createHandlerExportName",
    "createHandlerNameFromEntrypoint",
    "createVariableProvider",
    "createVariableSource",
    "createVokeModel",
    "defineConfig",
    "fn",
    // Read Standard Schema results in Provider packages such as @vokejs/aws (SQS bodies).
    "formatValidationIssue",
    "functionRegistryEntries",
    "http",
    "invokeRegistryFunction",
    "loadVokeConfig",
    // A Provider building block: the project's Functions plus the Plugin-contributed ones.
    "projectFunctionEntries",
    // The one JSON Schema reader: OpenAPI documents and Function Contract Artifacts share it.
    "readJsonSchema",
    "readStandardResult",
    "route",
    "runRequestAuthorizer",
    "voke",
  ]);
  // toEnvKey is an AWS binding-name helper: it lives in @vokejs/aws only.
  expect("toEnvKey" in voke).toBe(false);
});

test("keeps AWS authoring in @vokejs/aws", async () => {
  const aws = await importPackage("@vokejs/aws");

  expect(Object.keys(aws).toSorted()).toEqual([
    "aws",
    "awsLambda",
    "awsPolicy",
    "createAuthorizers",
    "createAwsClientConfig",
    "createAwsLambdaInvokeTransport",
    "createLambdaHandlers",
    "createResourceBindingName",
    "createSqsEventHandler",
    "durable",
    "dynamodbStream",
    "eventBridge",
    "jwtAuthorizer",
    "kinesis",
    "lambdaAuthorizer",
    "parameter",
    "requestAuthorizer",
    "s3",
    "schedule",
    "secret",
    "sns",
    "sqs",
    "toEnvKey",
  ]);
  expect("dynamodbTable" in voke).toBe(false);
  expect("sqsQueue" in voke).toBe(false);
  expect("durable" in voke).toBe(false);
});

test("keeps CloudFormation synthesis and resource builders in @vokejs/aws/cloudformation", async () => {
  const cloudformation = await importPackage("@vokejs/aws/cloudformation");

  expect(Object.keys(cloudformation).toSorted()).toEqual([
    "dynamodbTable",
    "eventBus",
    "kinesisStream",
    "s3Bucket",
    "secret",
    "snsTopic",
    "sqsQueue",
    "ssmParameter",
    "synthesizeCloudFormation",
  ]);
});

test("keeps build helpers in @vokejs/build", async () => {
  const build = await importPackage("@vokejs/build");

  expect(Object.keys(build).toSorted()).toEqual([
    "createBuildPlan",
    "handlerModule",
  ]);
  expect("createBuildPlan" in voke).toBe(false);
});

test("publishes only stable package subpaths", () => {
  expect(Object.keys(packageJson.exports).toSorted()).toEqual(["."]);
});

test("keeps provider-neutral testing helpers in @vokejs/testing", async () => {
  const testing = await importPackage("@vokejs/testing");

  expect(Object.keys(testing).toSorted()).toEqual([
    "createInvokeTestClient",
    "createTestClient",
    "createTestJwt",
  ]);
  expect("createTestClient" in voke).toBe(false);
});

test("keeps AWS testing helpers in @vokejs/aws/testing", async () => {
  const awsTesting = await importPackage("@vokejs/aws/testing");

  expect(Object.keys(awsTesting).toSorted()).toEqual([
    "createStackTestContext",
    "runDurable",
    "setupDurableTests",
    "teardownDurableTests",
  ]);
  expect("createStackTestContext" in voke).toBe(false);
  expect("runDurable" in voke).toBe(false);
});

test("keeps Remote Function helpers in @vokejs/remote", async () => {
  const remote = await importPackage("@vokejs/remote");

  expect(Object.keys(remote).toSorted()).toEqual(["createRemoteFunctions"]);
  expect("createRemoteFunctions" in voke).toBe(false);
  expect("defineRemoteFunctions" in voke).toBe(false);
});

test("keeps HTTP helpers in @vokejs/http", async () => {
  const httpHelpers = await importPackage("@vokejs/http");

  expect(Object.keys(httpHelpers).toSorted()).toEqual([
    "created",
    "error",
    "noContent",
    "ok",
    "response",
  ]);
  expect("ok" in voke).toBe(false);
  expect("response" in voke).toBe(false);
});

test("@vokejs/http is the same source as core's response helpers", async () => {
  // Core cannot import @vokejs/* packages, so the helpers exist in both; they must not drift.
  expect(await readPackageFile("../../http/src/index.ts")).toBe(
    await readPackageFile("../src/response.ts")
  );
});

test("keeps schema helpers in @vokejs/schema", async () => {
  const schemaHelpers = await importPackage("@vokejs/schema");

  expect(Object.keys(schemaHelpers).toSorted()).toEqual(["schema"]);
  expect("schema" in voke).toBe(false);
});

test("keeps OpenAPI helpers in @vokejs/openapi", async () => {
  const openapiHelpers = await importPackage("@vokejs/openapi");

  expect(Object.keys(openapiHelpers).toSorted()).toEqual([
    "createOpenApiDocument",
    "openapi",
  ]);
  expect("openapi" in voke).toBe(false);
  expect("createOpenApiDocument" in voke).toBe(false);
});

test("keeps idempotency helpers in @vokejs/idempotency", async () => {
  const idempotencyHelpers = await importPackage("@vokejs/idempotency");

  expect(Object.keys(idempotencyHelpers).toSorted()).toEqual([
    "IdempotencyError",
    "dynamoDbStore",
    "idempotency",
    "idempotent",
    "idempotentBatch",
    "memoryStore",
  ]);
  expect("idempotent" in voke).toBe(false);
});

test("keeps local AWS provider helpers in @vokejs/aws/local", async () => {
  const local = await importPackage("@vokejs/aws/local");

  expect(Object.keys(local).toSorted()).toEqual([
    "LocalProviderError",
    "awsEmulator",
    "createLocalAwsEnvironment",
    "createLocalBootstrapPlan",
    "createLocalResourceBindings",
    "createLocalWorkflow",
    "floci",
    "localOutputsPath",
    "readLocalStackOutputs",
  ]);
  expect("floci" in voke).toBe(false);
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
    "new Voke(",
    "registerLocalFunction",
    "resetLocalFunctions",
    "sqsEventSource",
    "sqsMessageBatch",
    "createAwsLambdaHandler",
    "handleAwsLambdaRequest",
    "jsonError",
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
    "new Voke(",
    "sqsEventSource",
    "sqsMessageBatch",
    "createAwsLambdaHandler",
    "handleAwsLambdaRequest",
    "jsonError",
  ]) {
    expect(combinedSurfaces).not.toContain(removedApi);
  }

  expect(combinedSurfaces).not.toContain(
    "Function-first AWS Lambda framework for Bun"
  );
  expect(combinedSurfaces).not.toContain("Hono-compatible APIs");
  expect(combinedSurfaces).not.toContain("Bun-first");
});
