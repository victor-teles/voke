import { expect, test } from "bun:test";

import { createSqsEventHandler, sqs } from "@vokejs/aws";

import { voke } from "../src/app";
import type { VokeOptions } from "../src/app";
import { VokeConfigError, VokeRuntimeVariableError } from "../src/errors";
import {
  fn,
  createFunctions,
  http,
  InvokeError,
  withInvokeTrace,
} from "../src/invoke";
import type {
  FunctionRegistry,
  InvokeTransport,
  StandardSchemaV1,
} from "../src/invoke";
import { createVariableProvider, createVariableSource } from "../src/variables";

const passthroughSchema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value }),
    vendor: "voke-test",
    version: 1,
  },
});

const activateFunctions = <TFunctions extends FunctionRegistry>(
  functions: TFunctions,
  options: VokeOptions = {}
): TFunctions => {
  voke(functions, {
    ...options,
    config: { name: "api", ...options.config },
  });

  return functions;
};

const stringSchema: StandardSchemaV1<unknown, string> = {
  "~standard": {
    validate: (value) =>
      typeof value === "string"
        ? { value }
        : {
            issues: [{ message: "expected string" }],
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
        ? { value: { id: value.id } }
        : {
            issues: [{ message: "id is required" }],
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
        ? { value: { id: value.id, name: value.name } }
        : {
            issues: [{ message: "user result is invalid" }],
          },
    vendor: "voke-test",
    version: 1,
  },
};

test("invokes registry functions with typed payloads and parsed results", async () => {
  const functions = activateFunctions(
    createFunctions({
      getUser: fn({
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

test("reads declared Runtime Variables during local Function invocation", async () => {
  const provider = createVariableProvider({
    id: "test",
    load: ({ variableKey }) => ({
      status: "found",
      value: `loaded:${variableKey}`,
    }),
  });
  const functions = activateFunctions(
    createFunctions({
      readSecret: fn({
        handler: async (_payload, context) =>
          await context.variables.apiKey.text(),
        output: stringSchema,
        variables: {
          apiKey: createVariableSource("test", {
            id: "api-key",
            kind: "secret",
          }),
        },
      }),
    }),
    { variables: { providers: [provider] } }
  );

  await expect(functions.invoke("readSecret")).resolves.toBe("loaded:apiKey");
});

test("uses Gateway Runtime Variable overrides during local Function invocation", async () => {
  const provider = createVariableProvider({
    id: "test",
    load: () => ({ status: "found", value: "provider-value" }),
  });
  const functions = activateFunctions(
    createFunctions({
      readSecret: fn({
        handler: async (_payload, context) =>
          await context.variables.apiKey.text(),
        output: stringSchema,
        variables: {
          apiKey: createVariableSource("test", {
            id: "api-key",
            kind: "secret",
          }),
        },
      }),
    }),
    {
      variables: {
        overrides: {
          functions: {
            readSecret: { apiKey: "override-value" },
          },
        },
        providers: [provider],
      },
    }
  );

  await expect(functions.invoke("readSecret")).resolves.toBe("override-value");
});

test("caches Runtime Variables by warm Function and variable key", async () => {
  const calls: string[] = [];
  const provider = createVariableProvider({
    id: "test",
    load: ({ functionKey, variableKey }) => {
      calls.push(`${functionKey}:${variableKey}`);

      return {
        status: "found",
        value: `${functionKey}:${variableKey}:${calls.length}`,
      };
    },
  });
  const sharedSource = createVariableSource("test", {
    id: "shared",
    kind: "secret",
  });
  const functions = activateFunctions(
    createFunctions({
      first: fn({
        handler: async (_payload, context) =>
          `${await context.variables.apiKey.text()}/${await context.variables.otherKey.text()}`,
        output: stringSchema,
        variables: {
          apiKey: sharedSource,
          otherKey: sharedSource,
        },
      }),
      second: fn({
        handler: async (_payload, context) =>
          await context.variables.apiKey.text(),
        output: stringSchema,
        variables: { apiKey: sharedSource },
      }),
    }),
    { variables: { providers: [provider] } }
  );

  await expect(functions.invoke("first")).resolves.toBe(
    "first:apiKey:1/first:otherKey:2"
  );
  await expect(functions.invoke("first")).resolves.toBe(
    "first:apiKey:1/first:otherKey:2"
  );
  await expect(functions.invoke("second")).resolves.toBe("second:apiKey:3");
  expect(calls).toEqual(["first:apiKey", "first:otherKey", "second:apiKey"]);
});

test("loads beforeHandler Runtime Variables in parallel before running handlers", async () => {
  let handlerStarted = false;
  const started: string[] = [];
  const resolvers = new Map<string, PromiseWithResolvers<null>>();
  const provider = createVariableProvider({
    id: "test",
    load: async ({ variableKey }) => {
      const gate = Promise.withResolvers<null>();
      started.push(variableKey);
      resolvers.set(variableKey, gate);
      await gate.promise;

      return { status: "found", value: `loaded:${variableKey}` };
    },
  });
  const functions = activateFunctions(
    createFunctions({
      readSecret: fn({
        handler: async (_payload, context) => {
          handlerStarted = true;

          return `${await context.variables.first.text()}/${await context.variables.second.text()}`;
        },
        output: stringSchema,
        variables: {
          first: createVariableSource(
            "test",
            { id: "first", kind: "secret" },
            { load: "beforeHandler" }
          ),
          second: createVariableSource(
            "test",
            { id: "second", kind: "secret" },
            { load: "beforeHandler" }
          ),
        },
      }),
    }),
    { variables: { providers: [provider] } }
  );

  const result = functions.invoke("readSecret");
  await Promise.resolve();
  expect(started.toSorted()).toEqual(["first", "second"]);
  expect(handlerStarted).toBe(false);
  resolvers.get("first")?.resolve(null);
  resolvers.get("second")?.resolve(null);
  await expect(result).resolves.toBe("loaded:first/loaded:second");
  expect(handlerStarted).toBe(true);
});

test("blocks handlers on required beforeHandler Runtime Variable failures", async () => {
  let handlerStarted = false;
  const provider = createVariableProvider({
    id: "test",
    load: () => ({ status: "missing" }),
  });
  const functions = activateFunctions(
    createFunctions({
      readSecret: fn({
        handler: () => {
          handlerStarted = true;

          return "handler";
        },
        output: stringSchema,
        variables: {
          apiKey: createVariableSource(
            "test",
            { id: "api-key", kind: "secret" },
            { load: "beforeHandler" }
          ),
        },
      }),
    }),
    { variables: { providers: [provider] } }
  );

  await expect(functions.invoke("readSecret")).rejects.toThrow(
    VokeRuntimeVariableError
  );
  expect(handlerStarted).toBe(false);
});

test("reads declared Runtime Variables from route and SQS Function contexts", async () => {
  const provider = createVariableProvider({
    id: "test",
    load: ({ variableKey }) => ({
      status: "found",
      value: `loaded:${variableKey}`,
    }),
  });
  const functions = activateFunctions(
    createFunctions({
      api: http({
        routes: (route) =>
          route.get("/secret", {
            handler: async (_request, context) =>
              await context.variables.apiKey.text(),
          }),
        variables: {
          apiKey: createVariableSource("test", {
            id: "api-key",
            kind: "secret",
          }),
        },
      }),
      processMessage: sqs({
        handler: async (_batch, context) => {
          const value = await context.variables.queueKey.text();

          return { batchItemFailures: [{ itemIdentifier: value }] };
        },
        message: passthroughSchema<{ id: string }>(),
        queue: "events",
        variables: {
          queueKey: createVariableSource("test", {
            id: "queue-key",
            kind: "secret",
          }),
        },
      }),
    }),
    { variables: { providers: [provider] } }
  );

  const routeValue = await (
    functions.route as (
      method: string,
      path: string,
      request: unknown
    ) => Promise<unknown>
  )("GET", "/secret", {});
  expect(routeValue).toBe("loaded:apiKey");
  await expect(
    functions.sendEvent("processMessage", {
      messages: [{ body: { id: "msg" }, id: "msg" }],
      source: "sqs",
    })
  ).resolves.toEqual({
    batchItemFailures: [{ itemIdentifier: "loaded:queueKey" }],
  });
});

test("uses registry keys as stable function identities and keeps helpers non-enumerable", async () => {
  const functions = activateFunctions(
    createFunctions({
      getUser: fn({
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
    createFunctions({
      createInvoice: fn({
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
                ? { value: { id: value.id } }
                : {
                    issues: [{ message: "id is required" }],
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
    createFunctions({
      ping: fn({
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
    createFunctions({
      sendEmail: fn({
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
    createFunctions({
      failEmail: fn({
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
    createFunctions({
      createAudit: fn({
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
          ? { value: { orderId: value.orderId } }
          : {
              issues: [{ message: "orderId is required" }],
            },
      vendor: "voke-test",
      version: 1,
    },
  };
  const functions = createFunctions({
    processOrder: sqs({
      handler: (event) => {
        for (const message of event.messages) {
          handled.push(message.body.orderId);
        }

        return event.ok();
      },
      message: orderMessageSchema,
      queue: "ordersQueue",
    }),
  });

  const result = await functions.sendEvent("processOrder", {
    messages: [{ body: { orderId: "ord_1" } }, { body: { orderId: "ord_2" } }],
  });

  expect(handled).toEqual(["ord_1", "ord_2"]);
  expect(result).toEqual({ batchItemFailures: [] });
});

test("createFunctions rejects Event Source Functions mixed with HTTP routes or an output schema", () => {
  // Provider packages build Event Source Functions directly, so createFunctions owns these rules.
  const processOrder = sqs({
    handler: (batch) => batch.ok(),
    message: userInputSchema,
    queue: "ordersQueue",
  });

  expect(() =>
    createFunctions({
      processOrder: {
        ...processOrder,
        routes: [
          {
            handler: () => ({ ok: true }),
            method: "GET",
            middleware: [],
            path: "/orders",
          },
        ],
      } as never,
    })
  ).toThrow("Event Source Functions cannot define HTTP routes in v1.");
  expect(() =>
    createFunctions({
      processOrder: { ...processOrder, output: userOutputSchema } as never,
    })
  ).toThrow(
    "Event Source Functions cannot define an output schema because Voke owns the event response contract."
  );
});

test("createFunctions rejects a Function whose Event Sources have different sources", () => {
  const processOrder = sqs({
    handler: (batch) => batch.ok(),
    message: userInputSchema,
    queue: "ordersQueue",
  });

  expect(() =>
    createFunctions({
      processOrder: {
        ...processOrder,
        events: [
          ...processOrder.events,
          { properties: {}, resource: "ordersTopic", source: "sns" },
        ],
      },
    })
  ).toThrow(
    'Function "processOrder" mixes Event Sources "sqs" and "sns"; a Function\'s Event Sources must share one source.'
  );
});

test("createFunctions rejects an Event Source Function without an Event Source", () => {
  const processOrder = sqs({
    handler: (batch) => batch.ok(),
    message: userInputSchema,
    queue: "ordersQueue",
  });

  expect(() =>
    createFunctions({ processOrder: { ...processOrder, events: [] } })
  ).toThrow(VokeConfigError);
});

test("rejects an invalid event with a message that names its Event Source", async () => {
  const functions = createFunctions({
    processOrder: sqs({
      handler: (batch) => batch.ok(),
      message: userInputSchema,
      queue: "ordersQueue",
    }),
  });

  await expect(
    functions.sendEvent("processOrder", { messages: "nope" } as never)
  ).rejects.toThrow('Invalid "sqs" event for processOrder');
});

test("automatically reports invalid SQS message bodies as per-message failures", async () => {
  const handled: string[] = [];
  const functions = createFunctions({
    processOrder: sqs({
      handler: (event) => {
        for (const message of event.messages) {
          handled.push(message.body.id);
        }

        return event.ok();
      },
      message: userInputSchema,
      queue: "ordersQueue",
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
  const functions = createFunctions({
    processOrder: sqs({
      handler: (event) => {
        const result = event.batchResult();

        for (const message of event.messages) {
          if (message.body.id === "usr_failed") {
            result.fail(message);
          }
        }

        return result;
      },
      message: userInputSchema,
      queue: "ordersQueue",
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
  const functions = createFunctions({
    processOrder: sqs({
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
      invalidMessageBody: "include",
      message: userInputSchema,
      queue: "ordersQueue",
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
  const functions = createFunctions({
    processOrder: sqs({
      handler: (event) => {
        for (const message of event.messages) {
          handled.push(message.body.id);
        }

        return event.ok();
      },
      message: userInputSchema,
      queue: "ordersQueue",
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
      {
        attributes: {},
        awsRegion: "us-east-1",
        body: "not json",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:orders",
        md5OfBody: "",
        messageAttributes: {},
        messageId: "malformed",
        receiptHandle: "receipt-malformed",
      },
    ],
  });

  // A malformed body fails only its own message, never the whole batch.
  expect(handled).toEqual(["usr_1"]);
  expect(response).toEqual({
    batchItemFailures: [
      { itemIdentifier: "invalid" },
      { itemIdentifier: "malformed" },
    ],
  });
});

test("deployed SQS adapter fails clearly for incompatible functions and handler failures", async () => {
  const functions = createFunctions({
    getUser: fn({
      handler: (payload) => ({ id: payload.id, name: "Victor" }),
      input: userInputSchema,
      output: userOutputSchema,
    }),
    processOrder: sqs({
      handler: () => {
        throw new Error("processor unavailable");
      },
      message: userInputSchema,
      queue: "ordersQueue",
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
  const functions = createFunctions({
    getUser: fn({
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
  const functions = createFunctions({
    worker: fn({
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
  const functions = createFunctions({
    getUser: fn({
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
  const functions = createFunctions({
    sendEmail: fn({
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
    createFunctions({
      flaky: fn({
        handler: () => {
          attempts += 1;

          if (attempts < 2) {
            throw new Error("temporarily unavailable");
          }

          return { ok: true };
        },
        output: passthroughSchema<{ ok: boolean }>(),
      }),
      slow: fn({
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
  const functions = createFunctions({
    syncWorker: fn({
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
