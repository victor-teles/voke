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
});

test("publishes CloudFormation synthesis from @voke/aws/cloudformation", async () => {
  const cloudformation = await importPackage("@voke/aws/cloudformation");

  expect(Object.keys(cloudformation).toSorted()).toEqual([
    "synthesizeCloudFormation",
  ]);
});
