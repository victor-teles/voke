import { expect, test } from "bun:test";

import packageJson from "../package.json";
import * as aws from "../src/aws";
import * as voke from "../src/index";

test("keeps the stable root runtime surface intentional", () => {
  expect(Object.keys(voke).toSorted()).toEqual([
    "api",
    "awsContext",
    "awsEvent",
    "bindResource",
    "createApiApp",
    "createAwsClientConfig",
    "createFlociComposeConfig",
    "createFunctionRegistry",
    "createHttpApiEvent",
    "createInvokeTestClient",
    "createInvoker",
    "createLocalAwsEnvironment",
    "createLocalBootstrapPlan",
    "createLocalResourceBindings",
    "createStackTestContext",
    "createTestClient",
    "defineConfig",
    "defineFunction",
    "getConfig",
    "invoke",
    "json",
    "jsonError",
    "loadVokeConfig",
    "registerLocalFunction",
    "requestId",
    "resetLocalFunctions",
    "routeModule",
    "synthesizeCloudFormation",
    "withInvokeTrace",
  ]);
});

test("keeps AWS resource authoring on the voke/aws subpath", () => {
  expect(Object.keys(aws).toSorted()).toEqual([
    "bindResource",
    "createAwsClientConfig",
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
    "./cloudformation",
    "./e2e",
    "./invoke",
    "./local",
    "./serverless-migration",
  ]);
});
