import { expect, test } from "bun:test";

import { createFunctions, InvokeError, voke, VokeConfigError } from "voke";
import type { StandardSchemaV1 } from "voke";

import { createLambdaHandlers, secret, sns } from "../src/index";
import type { SnsAwsEvent, SnsMessage, SnsRecord } from "../src/index";

interface Order {
  orderId: string;
}

// Accepts `{ orderId: string }` and reports any other value as one issue.
const order: StandardSchemaV1<Order, Order> = {
  "~standard": {
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { orderId?: unknown }).orderId === "string"
        ? { value: value as Order }
        : { issues: [{ message: "orderId is required", path: ["orderId"] }] },
    vendor: "voke-test",
    version: 1,
  },
};

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const snsEvent = (message: string): SnsAwsEvent => ({
  Records: [
    {
      EventSource: "aws:sns",
      EventSubscriptionArn:
        "arn:aws:sns:us-east-1:123456789012:orders:21be56ed-a058-49f5-8c98-aedd2564c486",
      EventVersion: "1.0",
      Sns: {
        Message: message,
        MessageAttributes: {
          type: { Type: "String", Value: "created" },
        },
        MessageId: "95df01b4-ee98-5cb9-9903-4c221d41eb5e",
        Signature: "signature",
        SignatureVersion: "1",
        SigningCertUrl: "https://sns.us-east-1.amazonaws.com/cert.pem",
        Subject: "OrderCreated",
        Timestamp: "2019-01-02T12:45:07.000Z",
        TopicArn: "arn:aws:sns:us-east-1:123456789012:orders",
        Type: "Notification",
        UnsubscribeUrl: "https://sns.us-east-1.amazonaws.com/unsubscribe",
      },
    },
  ],
});

const recordingFunctions = () => {
  const seen: SnsMessage<Order>[] = [];
  const functions = createFunctions({
    onOrder: sns({
      handler: (message) => {
        seen.push(message);
      },
      message: order,
      topic: "ordersTopic",
    }),
  });

  return { functions, seen };
};

test("sns() requires a topic resource key", () => {
  expect(() => sns({ handler: () => {}, message: order } as never)).toThrow(
    VokeConfigError
  );
  expect(() => sns({ handler: () => {}, message: order, topic: "" })).toThrow(
    VokeConfigError
  );
});

test("sns() rejects an unknown filter policy scope", () => {
  expect(() =>
    sns({
      filterPolicyScope: "Headers" as never,
      handler: () => {},
      message: order,
      topic: "ordersTopic",
    })
  ).toThrow(VokeConfigError);
});

test("sns() stores the topic and only the filter settings that were set", () => {
  const plain = sns({
    handler: () => {},
    message: order,
    topic: "ordersTopic",
  });
  const filtered = sns({
    filterPolicy: { type: ["created"] },
    filterPolicyScope: "MessageBody",
    handler: () => {},
    message: order,
    topic: "ordersTopic",
  });

  expect(plain.events).toEqual([
    {
      properties: { deadLetterQueue: true },
      resource: "ordersTopic",
      source: "sns",
    },
  ]);
  expect(filtered.events).toEqual([
    {
      properties: {
        deadLetterQueue: true,
        filterPolicy: { type: ["created"] },
        filterPolicyScope: "MessageBody",
      },
      resource: "ordersTopic",
      source: "sns",
    },
  ]);
});

test("sendEvent gives the handler a parsed body and synthesized SNS metadata", async () => {
  const { functions, seen } = recordingFunctions();

  await expect(
    functions.sendEvent("onOrder", { message: { orderId: "o1" } })
  ).resolves.toBeUndefined();

  const [message] = seen;

  expect(message?.body).toEqual({ orderId: "o1" });
  expect(message?.id).toBe("msg_1");
  expect(message?.topicArn).toBe("arn:aws:sns:local:000000000000:ordersTopic");
  expect(message?.timestamp).toMatch(isoTimestamp);
  expect(message?.attributes).toEqual({});
  expect(message?.subject).toBeUndefined();
  expect(message?.raw.EventSource).toBe("aws:sns");
  expect(message?.raw.Sns.Message).toBe('{"orderId":"o1"}');
});

test("sendEvent passes the optional id, subject and attributes through", async () => {
  const { functions, seen } = recordingFunctions();

  await functions.sendEvent("onOrder", {
    attributes: { type: { type: "String", value: "created" } },
    id: "m-42",
    message: { orderId: "o1" },
    subject: "OrderCreated",
  });

  expect(seen[0]).toMatchObject({
    attributes: { type: { type: "String", value: "created" } },
    id: "m-42",
    subject: "OrderCreated",
  });
});

test("an invalid SNS body rejects with INVALID_PAYLOAD and never reaches the handler", async () => {
  const { functions, seen } = recordingFunctions();
  const rejection = await functions
    .sendEvent("onOrder", { message: { orderId: 1 } as never })
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(InvokeError);
  expect(rejection).toMatchObject({
    code: "INVALID_PAYLOAD",
    issues: [{ message: "orderId is required", path: ["orderId"] }],
  });
  expect((rejection as Error).message).toBe(
    "Invalid SNS message body for msg_1: orderId: orderId is required"
  );
  expect(seen).toEqual([]);
});

test("an SNS Message that is not JSON rejects with INVALID_PAYLOAD", async () => {
  const { functions, seen } = recordingFunctions();

  await expect(
    functions.sendEvent("onOrder", { message: "not json" as never })
  ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  expect(seen).toEqual([]);
});

test("the deployed handler accepts a real SNS Lambda event and resolves to undefined", async () => {
  const { functions, seen } = recordingFunctions();
  const event = snsEvent('{"orderId":"o9"}');

  await expect(
    createLambdaHandlers({ functions }).onOrder?.(event)
  ).resolves.toBeUndefined();
  expect(seen).toEqual([
    {
      attributes: { type: { type: "String", value: "created" } },
      body: { orderId: "o9" },
      id: "95df01b4-ee98-5cb9-9903-4c221d41eb5e",
      raw: event.Records.at(0) as SnsRecord,
      subject: "OrderCreated",
      timestamp: "2019-01-02T12:45:07.000Z",
      topicArn: "arn:aws:sns:us-east-1:123456789012:orders",
    },
  ]);
});

test("the deployed handler fails the invocation for a Message that is not JSON", async () => {
  const { functions, seen } = recordingFunctions();

  await expect(
    createLambdaHandlers({ functions }).onOrder?.(snsEvent("Hello from SNS!"))
  ).rejects.toMatchObject({
    code: "INVALID_PAYLOAD",
    message: expect.stringContaining(
      "Invalid SNS message body for 95df01b4-ee98-5cb9-9903-4c221d41eb5e"
    ),
  });
  expect(seen).toEqual([]);
});

test("the deployed handler rejects an SNS event without a record", async () => {
  const { functions } = recordingFunctions();

  await expect(
    createLambdaHandlers({ functions }).onOrder?.({ Records: [] })
  ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
});

test("sns() Functions read Runtime Variables from their handler context", async () => {
  const seen: string[] = [];
  const functions = createFunctions({
    onOrder: sns({
      handler: async (_message, context) => {
        seen.push(await context.variables.signingKey.text());
      },
      message: order,
      topic: "ordersTopic",
      variables: { signingKey: secret("prod/signing-key") },
    }),
  });
  voke(functions, {
    config: { name: "sns-variables" },
    variables: { overrides: { defaults: { signingKey: "test-key" } } },
  });

  await functions.sendEvent("onOrder", { message: { orderId: "o1" } });
  expect(seen).toEqual(["test-key"]);
});
