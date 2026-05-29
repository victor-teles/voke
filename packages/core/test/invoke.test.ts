import { expect, test } from "bun:test";

import { createGateway } from "../src/app";
import type { GatewayOptions } from "../src/app";
import { VokeConfigError } from "../src/errors";
import {
  createSqsEventHandler,
  defineFunction,
  defineFunctions,
  InvokeError,
  sqsEventSource,
  sqsMessageBatch,
  withInvokeTrace,
} from "../src/invoke";
import type { InvokeTransport, StandardSchemaV1 } from "../src/invoke";

const passthroughSchema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

const activateFunctions = <
  TFunctions extends NonNullable<GatewayOptions["functions"]>,
>(
  functions: TFunctions
): TFunctions => {
  createGateway({ functions });

  return functions;
};

const stringSchema: StandardSchemaV1<unknown, string> = {
  "~standard": {
    validate: (value) =>
      typeof value === "string"
        ? { data: value, success: true }
        : {
            issues: [{ message: "expected string" }],
            success: false,
          },
    vendor: "voke-test",
    version: 1,
  },
};

const userInputSchema: StandardSchemaV1<unknown, { id: string }> = {
  "~standard": {
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string"
        ? { data: { id: value.id }, success: true }
        : {
            issues: [{ message: "id is required" }],
            success: false,
          },
    vendor: "voke-test",
    version: 1,
  },
};

const userOutputSchema: StandardSchemaV1<
  unknown,
  { id: string; name: string }
> = {
  "~standard": {
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string" &&
      "name" in value &&
      typeof value.name === "string"
        ? { data: { id: value.id, name: value.name }, success: true }
        : {
            issues: [{ message: "user result is invalid" }],
            success: false,
          },
    vendor: "voke-test",
    version: 1,
  },
};

test("invokes registry functions with typed payloads and parsed results", async () => {
  const functions = activateFunctions(
    defineFunctions({
      getUser: defineFunction({
        handler: (payload) => ({
          id: payload.id,
          name: "Victor",
        }),
        input: userInputSchema,
        output: userOutputSchema,
      }),
    })
  );

  const user = await functions.invoke("getUser", { id: "usr_1" });

  expect(user).toEqual({ id: "usr_1", name: "Victor" });
});

test("uses registry keys as stable function identities and keeps helpers non-enumerable", async () => {
  const functions = activateFunctions(
    defineFunctions({
      getUser: defineFunction({
        handler: (payload) => ({
          id: payload.id,
          name: "Victor",
        }),
        input: userInputSchema,
        name: "deployed-get-user",
        output: userOutputSchema,
      }),
    })
  );

  expect(Object.keys(functions)).toEqual(["getUser"]);
  expect(functions.getUser.key).toBe("getUser");
  expect(functions.getUser.name).toBe("deployed-get-user");
  await expect(functions.invoke("getUser", {})).rejects.toMatchObject({
    code: "INVALID_PAYLOAD",
    functionName: "deployed-get-user",
    message: "Invalid payload for deployed-get-user: id is required",
  });
});

test("validates function results after invoking a function", async () => {
  const functions = activateFunctions(
    defineFunctions({
      createInvoice: defineFunction({
        handler: () => ({
          id: "",
        }),
        output: {
          "~standard": {
            validate: (value: unknown) =>
              typeof value === "object" &&
              value !== null &&
              "id" in value &&
              typeof value.id === "string" &&
              value.id !== ""
                ? { data: { id: value.id }, success: true }
                : {
                    issues: [{ message: "id is required" }],
                    success: false,
                  },
            vendor: "voke-test",
            version: 1,
          },
        },
      }),
    })
  );

  await expect(functions.invoke("createInvoice")).rejects.toMatchObject({
    code: "INVALID_RESULT",
    functionName: "createInvoice",
    message: "Invalid result from createInvoice: id is required",
  });
});

test("supports zero-input functions with no payload or undefined", async () => {
  const functions = activateFunctions(
    defineFunctions({
      ping: defineFunction({
        handler: () => ({ ok: true }),
        output: passthroughSchema<{ ok: boolean }>(),
      }),
    })
  );

  await expect(functions.invoke("ping")).resolves.toEqual({ ok: true });
  await expect(functions.invoke("ping")).resolves.toEqual({
    ok: true,
  });
});

test("supports async local invocation mode", async () => {
  let processed = false;
  const functions = activateFunctions(
    defineFunctions({
      sendEmail: defineFunction({
        handler: () => {
          processed = true;
          return { ok: true };
        },
        output: passthroughSchema<{ ok: boolean }>(),
      }),
    })
  );

  const result = await functions.invoke("sendEmail", undefined, {
    mode: "async",
  });
  await Bun.sleep(0);

  expect(result).toEqual({ accepted: true });
  expect(processed).toBe(true);
});

test("reports async local invocation failures through an injected callback", async () => {
  const errors: Error[] = [];
  const functions = activateFunctions(
    defineFunctions({
      failEmail: defineFunction({
        handler: () => {
          throw new Error("email provider unavailable");
        },
        output: passthroughSchema<{ ok: boolean }>(),
      }),
    })
  );
  const options = {
    mode: "async" as const,
    onAsyncError: (error: InvokeError): void => {
      errors.push(error);
    },
  };

  await expect(
    functions.invoke("failEmail", undefined, options)
  ).resolves.toEqual({
    accepted: true,
  });
  await Bun.sleep(1);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(InvokeError);
  expect(errors[0]).toMatchObject({
    code: "LOCAL_FUNCTION_FAILED",
    functionName: "failEmail",
    message: 'invoke("failEmail") failed: email provider unavailable',
  });
});

test("propagates tracing metadata to local functions", async () => {
  const functions = activateFunctions(
    defineFunctions({
      createAudit: defineFunction({
        handler: (_payload, context) => context.trace,
        output: passthroughSchema<Record<string, unknown>>(),
      }),
    })
  );

  const trace = await withInvokeTrace(
    { parentFunction: "api", requestId: "req_123" },
    () => functions.invoke("createAudit")
  );

  expect(trace).toEqual({ parentFunction: "api", requestId: "req_123" });
});

test("sends SQS events to event source functions with minimal messages", async () => {
  const handled: string[] = [];
  const orderMessageSchema: StandardSchemaV1<unknown, { orderId: string }> = {
    "~standard": {
      validate: (value) =>
        typeof value === "object" &&
        value !== null &&
        "orderId" in value &&
        typeof value.orderId === "string"
          ? { data: { orderId: value.orderId }, success: true }
          : {
              issues: [{ message: "orderId is required" }],
              success: false,
            },
      vendor: "voke-test",
      version: 1,
    },
  };
  const functions = defineFunctions({
    processOrder: defineFunction({
      events: [sqsEventSource("ordersQueue")],
      handler: (event) => {
        for (const message of event.messages) {
          handled.push(message.body.orderId);
        }

        return event.ok();
      },
      input: sqsMessageBatch(orderMessageSchema),
    }),
  });

  const result = await functions.sendEvent("processOrder", {
    messages: [{ body: { orderId: "ord_1" } }, { body: { orderId: "ord_2" } }],
  });

  expect(handled).toEqual(["ord_1", "ord_2"]);
  expect(result).toEqual({ batchItemFailures: [] });
});

test("rejects SQS event source functions mixed with HTTP routes or invokable output", () => {
  expect(() =>
    defineFunction({
      events: [sqsEventSource("ordersQueue")],
      handler: (event: { ok: () => unknown }) => event.ok(),
      input: sqsMessageBatch(userInputSchema),
      routes: [
        {
          handler: () => ({ ok: true }),
          method: "GET",
          middleware: [],
          path: "/orders",
        },
      ],
    } as never)
  ).toThrow(VokeConfigError);
  expect(() =>
    defineFunction({
      events: [sqsEventSource("ordersQueue")],
      handler: (event: { ok: () => unknown }) => event.ok(),
      input: sqsMessageBatch(userInputSchema),
      output: userOutputSchema,
    } as never)
  ).toThrow(VokeConfigError);
});

test("automatically reports invalid SQS message bodies as per-message failures", async () => {
  const handled: string[] = [];
  const functions = defineFunctions({
    processOrder: defineFunction({
      events: [sqsEventSource("ordersQueue")],
      handler: (event) => {
        for (const message of event.messages) {
          handled.push(message.body.id);
        }

        return event.ok();
      },
      input: sqsMessageBatch(userInputSchema),
    }),
  });

  const result = await functions.sendEvent("processOrder", {
    messages: [
      { body: { id: "usr_1" }, id: "valid" },
      { body: {}, id: "invalid" },
      { body: { id: "usr_2" }, id: "valid-2" },
    ],
  });

  expect(handled).toEqual(["usr_1", "usr_2"]);
  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: "invalid" }],
  });
});

test("combines invalid SQS message failures with handler-reported failures", async () => {
  const functions = defineFunctions({
    processOrder: defineFunction({
      events: [sqsEventSource("ordersQueue")],
      handler: (event) => {
        const result = event.batchResult();

        for (const message of event.messages) {
          if (message.body.id === "usr_failed") {
            result.fail(message);
          }
        }

        return result;
      },
      input: sqsMessageBatch(userInputSchema),
    }),
  });

  const result = await functions.sendEvent("processOrder", {
    messages: [
      { body: { id: "usr_failed" }, id: "handler-failed" },
      { body: "not json", id: "invalid-json" },
      { body: {}, id: "schema-failed" },
    ],
  });

  expect(result).toEqual({
    batchItemFailures: [
      { itemIdentifier: "invalid-json" },
      { itemIdentifier: "schema-failed" },
      { itemIdentifier: "handler-failed" },
    ],
  });
});

test("can include invalid SQS message bodies for manual handling", async () => {
  const seen: string[] = [];
  const functions = defineFunctions({
    processOrder: defineFunction({
      events: [sqsEventSource("ordersQueue")],
      handler: (event) => {
        const result = event.batchResult();

        for (const message of event.messages) {
          if (message.valid) {
            seen.push(message.body.id);
          } else {
            seen.push(message.rawBody);
            result.fail(message);
          }
        }

        return result;
      },
      input: sqsMessageBatch(userInputSchema, {
        invalidMessageBody: "include",
      }),
    }),
  });

  const result = await functions.sendEvent("processOrder", {
    messages: [
      { body: { id: "usr_1" }, id: "valid" },
      { body: {}, id: "invalid" },
    ],
  });

  expect(seen).toEqual(["usr_1", "{}"]);
  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: "invalid" }],
  });
});

test("handles deployed AWS SQS events through the Voke adapter", async () => {
  const handled: string[] = [];
  const functions = defineFunctions({
    processOrder: defineFunction({
      events: [sqsEventSource("ordersQueue")],
      handler: (event) => {
        for (const message of event.messages) {
          handled.push(message.body.id);
        }

        return event.ok();
      },
      input: sqsMessageBatch(userInputSchema),
    }),
  });
  const handler = createSqsEventHandler({
    function: "processOrder",
    functions,
  });

  const response = await handler({
    Records: [
      {
        attributes: {},
        awsRegion: "us-east-1",
        body: JSON.stringify({ id: "usr_1" }),
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:orders",
        md5OfBody: "",
        messageAttributes: {},
        messageId: "valid",
        receiptHandle: "receipt-valid",
      },
      {
        attributes: {},
        awsRegion: "us-east-1",
        body: "{}",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:orders",
        md5OfBody: "",
        messageAttributes: {},
        messageId: "invalid",
        receiptHandle: "receipt-invalid",
      },
    ],
  });

  expect(handled).toEqual(["usr_1"]);
  expect(response).toEqual({
    batchItemFailures: [{ itemIdentifier: "invalid" }],
  });
});

test("deployed SQS adapter fails clearly for incompatible functions and handler failures", async () => {
  const functions = defineFunctions({
    getUser: defineFunction({
      handler: (payload) => ({ id: payload.id, name: "Victor" }),
      input: userInputSchema,
      output: userOutputSchema,
    }),
    processOrder: defineFunction({
      events: [sqsEventSource("ordersQueue")],
      handler: () => {
        throw new Error("processor unavailable");
      },
      input: sqsMessageBatch(userInputSchema),
    }),
  });
  const event = {
    Records: [
      {
        attributes: {},
        awsRegion: "us-east-1",
        body: JSON.stringify({ id: "usr_1" }),
        eventSource: "aws:sqs" as const,
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:orders",
        md5OfBody: "",
        messageAttributes: {},
        messageId: "valid",
        receiptHandle: "receipt-valid",
      },
    ],
  };

  await expect(
    createSqsEventHandler({
      function: "getUser" as never,
      functions,
    })(event)
  ).rejects.toMatchObject({
    code: "MISSING_FUNCTION",
    functionName: "getUser",
    message:
      'Function "getUser" cannot receive events with functions.sendEvent',
  });
  await expect(
    createSqsEventHandler({
      function: "processOrder",
      functions,
    })(event)
  ).rejects.toThrow("processor unavailable");
});

test("invokes AWS Lambda through an injected transport", async () => {
  const calls: unknown[] = [];
  const transport: InvokeTransport = {
    invoke: (request) => {
      calls.push(request);
      return Promise.resolve({
        payload: { data: { id: "usr_1", name: "Victor" } },
        statusCode: 200,
      });
    },
  };
  const functions = defineFunctions({
    getUser: defineFunction({
      handler: (payload) => ({
        id: payload.id,
        name: "local",
      }),
      input: userInputSchema,
      output: userOutputSchema,
    }),
  });

  const result = await functions.invoke(
    "getUser",
    { id: "usr_1" },
    {
      runtime: "aws",
      trace: { requestId: "req_aws" },
      transport,
    }
  );

  expect(result).toEqual({ id: "usr_1", name: "Victor" });
  expect(calls).toEqual([
    {
      functionName: "getUser",
      invocationType: "RequestResponse",
      payload: {
        payload: { id: "usr_1" },
        trace: { requestId: "req_aws" },
      },
    },
  ]);
});

test("requires an injected transport for AWS runtime invocation", async () => {
  const functions = defineFunctions({
    worker: defineFunction({
      handler: ({ id }: { id: string }) => ({ id }),
      input: passthroughSchema<{ id: string }>(),
      name: "deployed-worker",
      output: passthroughSchema<{ id: string }>(),
    }),
  });

  await expect(
    functions.invoke("worker", { id: "usr_1" }, { runtime: "aws" })
  ).rejects.toMatchObject({
    code: "MISSING_TRANSPORT",
    functionName: "deployed-worker",
    message:
      'invoke("deployed-worker") requires an InvokeTransport for runtime "aws"',
  });
});

test("fails predictably when AWS transport returns an error", async () => {
  const functions = defineFunctions({
    getUser: defineFunction({
      handler: (payload) => ({
        id: payload.id,
        name: "local",
      }),
      input: userInputSchema,
      output: userOutputSchema,
    }),
  });

  const transport: InvokeTransport = {
    invoke: () =>
      Promise.resolve({
        payload: { error: "boom" },
        requestId: "req_failed",
        statusCode: 500,
      }),
  };

  await expect(
    functions.invoke(
      "getUser",
      { id: "usr_1" },
      {
        runtime: "aws",
        transport,
      }
    )
  ).rejects.toMatchObject({
    code: "TRANSPORT_STATUS_ERROR",
    functionName: "getUser",
    message: 'invoke("getUser") failed with status 500',
    requestId: "req_failed",
    statusCode: 500,
  });
});

test("supports async AWS Lambda invocation mode", async () => {
  const transport: InvokeTransport = {
    invoke: (request) =>
      Promise.resolve({
        requestId: `queued-${request.functionName}`,
        statusCode: 202,
      }),
  };
  const functions = defineFunctions({
    sendEmail: defineFunction({
      handler: (payload) => payload,
      input: stringSchema,
      output: stringSchema,
    }),
  });

  const result = await functions.invoke("sendEmail", "hello", {
    mode: "async",
    runtime: "aws",
    transport,
  });

  expect(result).toEqual({ accepted: true, requestId: "queued-sendEmail" });
});

test("retries transient invoke failures and enforces timeout", async () => {
  let attempts = 0;
  const functions = activateFunctions(
    defineFunctions({
      flaky: defineFunction({
        handler: () => {
          attempts += 1;

          if (attempts < 2) {
            throw new Error("temporarily unavailable");
          }

          return { ok: true };
        },
        output: passthroughSchema<{ ok: boolean }>(),
      }),
      slow: defineFunction({
        handler: async () => {
          await Bun.sleep(50);
          return { ok: true };
        },
        output: passthroughSchema<{ ok: boolean }>(),
      }),
    })
  );

  await expect(
    functions.invoke("flaky", undefined, { retries: 1 })
  ).resolves.toEqual({
    ok: true,
  });
  await expect(
    functions.invoke("slow", undefined, { timeoutMs: 1 })
  ).rejects.toMatchObject({
    code: "TIMEOUT",
    functionName: "slow",
    message: 'invoke("slow") timed out after 1ms',
  });
  expect(attempts).toBe(2);
});

test("retries failed transport errors", async () => {
  let attempts = 0;
  const transport: InvokeTransport = {
    invoke: () => {
      attempts += 1;
      throw new Error("socket closed");
    },
  };
  const functions = defineFunctions({
    syncWorker: defineFunction({
      handler: () => ({ ok: true }),
      output: passthroughSchema<{ ok: boolean }>(),
    }),
  });

  await expect(
    functions.invoke("syncWorker", undefined, {
      retries: 1,
      runtime: "aws",
      transport,
    })
  ).rejects.toMatchObject({
    code: "TRANSPORT_FAILED",
    functionName: "syncWorker",
    message: 'invoke("syncWorker") transport failed: socket closed',
  });
  expect(attempts).toBe(2);
});
