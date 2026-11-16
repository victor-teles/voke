import { expect, test } from "bun:test";

import { createFunctions, InvokeError, voke, VokeConfigError } from "voke";

import { createLambdaHandlers, s3, secret } from "../src/index";
import type { S3AwsEvent, S3ObjectEvent } from "../src/index";

const isoSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

// Keys with characters that URL encoding would change: Voke never decodes a key.
const keyWithEncodedCharacters = "a b+c/%C3%A9%25.txt";
const keyWithSpace = "incoming/red flower.jpg";

const recordingFunctions = () => {
  const seen: S3ObjectEvent[] = [];
  const functions = createFunctions({
    onChange: s3({
      bucket: "uploadsBucket",
      handler: (event) => {
        seen.push(event);
      },
      on: ["created", "deleted"],
    }),
    onUpload: s3({
      bucket: "uploadsBucket",
      handler: (event) => {
        seen.push(event);
      },
      prefix: "incoming/",
    }),
  });

  return { functions, seen };
};

// Shaped like the "Object Created" example in the S3 user guide's EventBridge event page.
const objectCreatedEvent = (key: string): S3AwsEvent => ({
  account: "111122223333",
  detail: {
    bucket: { name: "voke-prod-uploadsbucket-1a2b3c" },
    "event-version": "1.2",
    object: {
      etag: "b1946ac92492d2347c6235b4d2611184",
      key,
      sequencer: "617f08299329d189",
      size: 5,
      "version-id": "IYV3p45BT0ac8hjHg1houSdS1a.Mro8e",
    },
    reason: "PutObject",
    "request-id": "N4N7GDK58NMKJ12R",
    requester: "123456789012",
    "source-ip-address": "192.0.2.1",
    version: "0",
  },
  "detail-type": "Object Created",
  id: "17793124-05d4-b198-2fde-7ededc63b103",
  region: "ca-central-1",
  resources: ["arn:aws:s3:::voke-prod-uploadsbucket-1a2b3c"],
  source: "aws.s3",
  time: "2021-11-12T00:00:00Z",
  version: "0",
});

// Shaped like the "Object Deleted (using DeleteObject)" example on the same page.
const objectDeletedEvent: S3AwsEvent = {
  account: "111122223333",
  detail: {
    bucket: { name: "voke-prod-uploadsbucket-1a2b3c" },
    "deletion-type": "Delete Marker Created",
    "event-version": "1.2",
    object: {
      etag: "d41d8cd98f00b204e9800998ecf8427e",
      key: "incoming/a.jpg",
      sequencer: "617f0837b476e463",
      "version-id": "1QW9g1Z99LUNbvaaYVpW9xDlOLU.qxgF",
    },
    reason: "DeleteObject",
    "request-id": "0BH729840619AG5K",
    requester: "123456789012",
    "source-ip-address": "192.0.2.1",
    version: "0",
  },
  "detail-type": "Object Deleted",
  id: "2ee9cc15-d022-99ea-1fb8-1b1bac4850f9",
  region: "ca-central-1",
  resources: ["arn:aws:s3:::voke-prod-uploadsbucket-1a2b3c"],
  source: "aws.s3",
  time: "2021-11-12T00:00:00Z",
  version: "0",
};

test("s3() requires bucket, the key of an s3Bucket() resource", () => {
  expect(() => s3({ handler: () => {} } as never)).toThrow(VokeConfigError);
  expect(() => s3({ bucket: "", handler: () => {} })).toThrow(VokeConfigError);
});

test("s3() rejects an empty or unknown on", () => {
  expect(() =>
    s3({ bucket: "uploadsBucket", handler: () => {}, on: [] })
  ).toThrow(VokeConfigError);
  expect(() =>
    s3({
      bucket: "uploadsBucket",
      handler: () => {},
      on: ["created", "restored"] as never,
    })
  ).toThrow('s3() on accepts only "created" and "deleted", not "restored"');
});

test("s3() rejects an empty prefix or suffix", () => {
  expect(() =>
    s3({ bucket: "uploadsBucket", handler: () => {}, prefix: "" })
  ).toThrow(VokeConfigError);
  expect(() =>
    s3({ bucket: "uploadsBucket", handler: () => {}, suffix: "" })
  ).toThrow(VokeConfigError);
});

test("s3() rejects a prefix that ends or a suffix that starts with * when both are set", () => {
  // Both together become one wildcard pattern, where "\**" would read as consecutive wildcards.
  expect(() =>
    s3({
      bucket: "uploadsBucket",
      handler: () => {},
      prefix: "incoming*",
      suffix: ".jpg",
    })
  ).toThrow(VokeConfigError);
  expect(() =>
    s3({
      bucket: "uploadsBucket",
      handler: () => {},
      prefix: "incoming/",
      suffix: "*.jpg",
    })
  ).toThrow(VokeConfigError);
  expect(() =>
    s3({ bucket: "uploadsBucket", handler: () => {}, prefix: "incoming*" })
  ).not.toThrow();
});

test("s3() stores the bucket key, the events and the filters it was given", () => {
  const onUpload = s3({
    bucket: "uploadsBucket",
    handler: () => {},
    prefix: "incoming/",
    suffix: ".jpg",
  });
  const onDelete = s3({
    bucket: "uploadsBucket",
    handler: () => {},
    on: ["deleted"],
  });

  expect(onUpload.events).toEqual([
    {
      properties: {
        deadLetterQueue: true,
        on: ["created"],
        prefix: "incoming/",
        suffix: ".jpg",
      },
      resource: "uploadsBucket",
      source: "s3",
    },
  ]);
  expect(onDelete.events).toEqual([
    {
      properties: { deadLetterQueue: true, on: ["deleted"] },
      resource: "uploadsBucket",
      source: "s3",
    },
  ]);
});

test("sendEvent calls the handler with the first kind, the bucket key, an id and a time", async () => {
  const { functions, seen } = recordingFunctions();

  await expect(
    functions.sendEvent("onUpload", { key: "incoming/a.jpg" })
  ).resolves.toBeUndefined();

  const [event] = seen;

  expect(event).toMatchObject({
    bucket: "uploadsBucket",
    id: "evt_1",
    key: "incoming/a.jpg",
    kind: "created",
    reason: "PutObject",
  });
  expect(event?.time).toMatch(isoSeconds);
  expect(event?.raw.source).toBe("aws.s3");
  expect(event?.raw["detail-type"]).toBe("Object Created");
  expect(event).not.toHaveProperty("size");
});

test("sendEvent passes the optional bucket, size, etag and version through", async () => {
  const { functions, seen } = recordingFunctions();

  await functions.sendEvent("onChange", {
    bucket: "my-bucket",
    etag: "abc",
    id: "evt-42",
    key: "a.jpg",
    kind: "deleted",
    size: 12,
    time: "2024-03-01T12:00:00Z",
    versionId: "v1",
  });

  expect(seen[0]).toMatchObject({
    bucket: "my-bucket",
    deletionType: "Permanently Deleted",
    etag: "abc",
    id: "evt-42",
    key: "a.jpg",
    kind: "deleted",
    reason: "DeleteObject",
    size: 12,
    time: "2024-03-01T12:00:00Z",
    versionId: "v1",
  });
});

test("sendEvent rejects a kind the Function does not listen to", async () => {
  const { functions, seen } = recordingFunctions();
  const rejection = await functions
    .sendEvent("onUpload", { key: "incoming/a.jpg", kind: "deleted" })
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(InvokeError);
  expect(rejection).toMatchObject({ code: "INVALID_PAYLOAD" });
  expect(seen).toEqual([]);
});

test("sendEvent rejects a missing key", async () => {
  const { functions, seen } = recordingFunctions();

  await expect(
    functions.sendEvent("onUpload", {} as never)
  ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  expect(seen).toEqual([]);
});

test("sendEvent applies no prefix or suffix filter locally", async () => {
  const { functions, seen } = recordingFunctions();

  await functions.sendEvent("onUpload", { key: "elsewhere/a.txt" });
  expect(seen[0]?.key).toBe("elsewhere/a.txt");
});

test("sendEvent passes the key through byte for byte, never decoded", async () => {
  const { functions, seen } = recordingFunctions();

  await functions.sendEvent("onUpload", { key: keyWithEncodedCharacters });
  await functions.sendEvent("onUpload", { key: keyWithSpace });
  await functions.sendEvent("onUpload", { key: "fotos/canção é.png" });
  expect(seen.map((event) => event.key)).toEqual([
    keyWithEncodedCharacters,
    keyWithSpace,
    "fotos/canção é.png",
  ]);
});

test("s3() Functions read Runtime Variables from their handler context", async () => {
  const seen: string[] = [];
  const functions = createFunctions({
    onUpload: s3({
      bucket: "uploadsBucket",
      handler: async (_event, context) => {
        seen.push(await context.variables.signingKey.text());
      },
      variables: { signingKey: secret("prod/signing-key") },
    }),
  });
  voke(functions, {
    config: { name: "s3-variables" },
    variables: { overrides: { defaults: { signingKey: "test-key" } } },
  });

  await functions.sendEvent("onUpload", { key: "a.jpg" });
  expect(seen).toEqual(["test-key"]);
});

test("the deployed handler normalizes a real Object Created event", async () => {
  const { functions, seen } = recordingFunctions();
  const event = objectCreatedEvent("incoming/a.jpg");

  await expect(
    createLambdaHandlers({ functions }).onUpload?.(event)
  ).resolves.toBeUndefined();
  expect(seen).toEqual([
    {
      bucket: "voke-prod-uploadsbucket-1a2b3c",
      etag: "b1946ac92492d2347c6235b4d2611184",
      id: "17793124-05d4-b198-2fde-7ededc63b103",
      key: "incoming/a.jpg",
      kind: "created",
      raw: event,
      reason: "PutObject",
      sequencer: "617f08299329d189",
      size: 5,
      time: "2021-11-12T00:00:00Z",
      versionId: "IYV3p45BT0ac8hjHg1houSdS1a.Mro8e",
    },
  ]);
});

test("the deployed handler normalizes a real Object Deleted event", async () => {
  const { functions, seen } = recordingFunctions();

  await createLambdaHandlers({ functions }).onChange?.(objectDeletedEvent);
  expect(seen).toEqual([
    {
      bucket: "voke-prod-uploadsbucket-1a2b3c",
      deletionType: "Delete Marker Created",
      etag: "d41d8cd98f00b204e9800998ecf8427e",
      id: "2ee9cc15-d022-99ea-1fb8-1b1bac4850f9",
      key: "incoming/a.jpg",
      kind: "deleted",
      raw: objectDeletedEvent,
      reason: "DeleteObject",
      sequencer: "617f0837b476e463",
      time: "2021-11-12T00:00:00Z",
      versionId: "1QW9g1Z99LUNbvaaYVpW9xDlOLU.qxgF",
    },
  ]);
});

test("the deployed handler passes the delivered key through byte for byte", async () => {
  const { functions, seen } = recordingFunctions();
  const handler = createLambdaHandlers({ functions }).onUpload;

  await handler?.(objectCreatedEvent(keyWithEncodedCharacters));
  await handler?.(objectCreatedEvent(keyWithSpace));
  await handler?.(objectCreatedEvent("fotos/canção é.png"));
  expect(seen.map((event) => event.key)).toEqual([
    keyWithEncodedCharacters,
    keyWithSpace,
    "fotos/canção é.png",
  ]);
});

test("the deployed handler rejects an event that is not from S3", async () => {
  const { functions, seen } = recordingFunctions();

  await expect(
    createLambdaHandlers({ functions }).onUpload?.({
      ...objectCreatedEvent("a.jpg"),
      source: "orders",
    })
  ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  expect(seen).toEqual([]);
});

test("the deployed handler rejects an event without an object key", async () => {
  const { functions, seen } = recordingFunctions();
  const event = objectCreatedEvent("a.jpg");
  const rejection = await createLambdaHandlers({ functions })
    .onUpload?.({ ...event, detail: { ...event.detail, object: {} } })
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(InvokeError);
  expect(rejection).toMatchObject({ code: "INVALID_PAYLOAD" });
  expect(seen).toEqual([]);
});

test("the deployed handler rejects an event type S3 Event Sources do not handle", async () => {
  const { functions } = recordingFunctions();

  await expect(
    createLambdaHandlers({ functions }).onChange?.({
      ...objectCreatedEvent("a.jpg"),
      "detail-type": "Object Restore Completed",
    })
  ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
});
