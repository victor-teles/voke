import { expect, test } from "bun:test";

import * as voke from "../src/index";

const importPackage = async (
  specifier: string
): Promise<Record<string, unknown>> => await import(specifier);

test("publishes AWS provider helpers from @voke/aws", async () => {
  const awsPackage = await importPackage("@voke/aws");

  expect(Object.keys(awsPackage).toSorted()).toEqual([
    "aws",
    "bindResource",
    "createAuthorizers",
    "createAwsClientConfig",
    "createAwsLambdaHandler",
    "createAwsLambdaInvokeTransport",
    "createResourceBindingName",
    "createSqsEventHandler",
    "handleAwsLambdaRequest",
    "jwtAuthorizer",
    "lambdaAuthorizer",
    "parameter",
    "requestAuthorizer",
    "secret",
    "sqs",
    "sqsEventSource",
    "sqsMessageBatch",
    "toEnvKey",
  ]);
  expect("dynamodbTable" in voke).toBe(false);
});

test("publishes CloudFormation synthesis and resource builders from @voke/aws/cloudformation", async () => {
  const cloudformation = await importPackage("@voke/aws/cloudformation");

  expect(Object.keys(cloudformation).toSorted()).toEqual([
    "dynamodbTable",
    "eventBus",
    "s3Bucket",
    "secret",
    "snsTopic",
    "sqsQueue",
    "ssmParameter",
    "synthesizeCloudFormation",
  ]);
});
