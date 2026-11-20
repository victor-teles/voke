import { expect, test } from "bun:test";

import { createFunctions, createVokeModel } from "voke";
import type { EventFunctionDefinition, StandardSchemaV1 } from "voke";

import { sqsQueue, synthesizeCloudFormation } from "../src/cloudformation";
import { awsEventSourceRuntimeSources } from "../src/event-source-runtime";
import { awsEventSources } from "../src/event-sources";
import { aws, createLambdaHandlers, sqs } from "../src/index";
import type { SqsMessageBatch } from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

// An Event Source the AWS Provider has no adapter for, as another Provider package could author.
const unsupportedFunction: EventFunctionDefinition = {
  events: [{ properties: { every: "1 hour" }, source: "carrierPigeon" }],
  handler: () => "delivered",
  input: schema<unknown>(),
  key: "",
  kind: "event",
};

const unsupportedMessage =
  'Function "deliver" uses Event Source "carrierPigeon", which the AWS Provider does not support.';

const sqsRecord = (messageId: string, body: string) => ({
  attributes: { ApproximateReceiveCount: "1" },
  awsRegion: "us-east-1",
  body,
  eventSource: "aws:sqs" as const,
  eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:orders",
  md5OfBody: "",
  messageAttributes: {},
  messageId,
  receiptHandle: `receipt-${messageId}`,
});

test("the deployed SQS handler gives the Function the same normalized batch as before", async () => {
  const seen: SqsMessageBatch<{ id: string }>[] = [];
  const functions = createFunctions({
    processOrder: sqs({
      handler: (batch) => {
        seen.push(batch);

        return batch.ok();
      },
      message: schema<{ id: string }>(),
      queue: "ordersQueue",
    }),
  });
  const record = sqsRecord("m1", '{"id":"ord_1"}');

  await expect(
    createLambdaHandlers({ functions }).processOrder?.({ Records: [record] })
  ).resolves.toEqual({ batchItemFailures: [] });
  expect(seen[0]?.source).toBe("sqs");
  expect(seen[0]?.messages).toEqual([
    {
      attributes: { ApproximateReceiveCount: "1" },
      body: { id: "ord_1" },
      id: "m1",
      messageAttributes: {},
      raw: record,
      valid: true,
    },
  ]);
});

test("Lambda handlers reject an Event Source the AWS Provider does not support", () => {
  const functions = createFunctions({ deliver: unsupportedFunction });

  expect(() => createLambdaHandlers({ functions })).toThrow(unsupportedMessage);
});

test("the AWS Provider rejects an Event Source it does not support during model validation", () => {
  expect(() =>
    createVokeModel({
      functions: createFunctions({ deliver: unsupportedFunction }),
      name: "pigeon-post",
      provider: aws(),
    })
  ).toThrow(unsupportedMessage);
});

test("synthesis rejects an Event Source the AWS Provider does not support instead of skipping it", () => {
  expect(() =>
    synthesizeCloudFormation({
      functions: createFunctions({ deliver: unsupportedFunction }),
      name: "pigeon-post",
    })
  ).toThrow(unsupportedMessage);
});

test("SQS Event Sources still synthesize one event source mapping per queue", () => {
  const template = synthesizeCloudFormation({
    functions: createFunctions({
      processOrder: sqs({
        handler: (batch) => batch.ok(),
        message: schema<{ id: string }>(),
        queues: [
          "ordersQueue",
          { batchSize: 2, enabled: false, queue: "priorityQueue" },
        ],
      }),
    }),
    name: "orders",
    resources: { ordersQueue: sqsQueue(), priorityQueue: sqsQueue() },
  });

  expect(
    template.Resources.ProcessOrderFunctionOrdersQueueEventSourceMapping
  ).toEqual({
    Properties: {
      BatchSize: 10,
      Enabled: true,
      EventSourceArn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
      FunctionName: { Ref: "ProcessOrderFunction" },
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      MaximumBatchingWindowInSeconds: 0,
    },
    Type: "AWS::Lambda::EventSourceMapping",
  });
  expect(
    template.Resources.ProcessOrderFunctionPriorityQueueEventSourceMapping
      ?.Properties
  ).toMatchObject({ BatchSize: 2, Enabled: false });
});

test("every Event Source has both a run-time and a deploy-time adapter", () => {
  expect(awsEventSourceRuntimeSources().toSorted()).toEqual(
    awsEventSources().toSorted()
  );
  expect(awsEventSources()).toHaveLength(7);
});
