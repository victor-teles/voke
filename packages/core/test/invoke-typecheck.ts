import { requestAuthorizer, sqs } from "@voke/aws";
import type { SqsBatchResult } from "@voke/aws";

import { fn, createFunctions, http } from "../src/invoke";
import type {
  AsyncInvokeResult,
  EventFunctionDefinition,
  StandardSchemaV1,
} from "../src/invoke";
import { createVariableSource } from "../src/variables";

const schema = <TInput, TOutput = TInput>(): StandardSchemaV1<
  TInput,
  TOutput
> => ({
  "~standard": {
    validate: (value) => ({ value: value as unknown as TOutput }),
    vendor: "voke-test",
    version: 1,
  },
});

const getUserInput = schema<{ id: string }>();
const getUserOutput = schema<{ id: string; name: string }>();
const apiKey = createVariableSource("test", { id: "api-key", kind: "secret" });
const eagerlyLoadedApiKey = createVariableSource(
  "test",
  { id: "api-key", kind: "secret" },
  { cache: { ttlSeconds: 30 }, load: "beforeHandler" }
);
const uncachedKey = createVariableSource(
  "test",
  { id: "uncached", kind: "secret" },
  { cache: false }
);

const functions = createFunctions({
  authorizeRequest: requestAuthorizer({
    handler: async (_request, context) => {
      const _apiKeyText: string = await context.variables.apiKey.text();
      // @ts-expect-error only this Function's declared Runtime Variable keys are visible.
      void context.variables.missingKey;

      return { authorized: true };
    },
    variables: { apiKey },
  }),
  getUser: fn({
    handler: async (payload, context) => {
      const _apiKeyText: string = await context.variables.apiKey.text();
      const _apiKeyHandle: typeof context.variables.apiKey =
        await context.variables.apiKey.refresh();
      // @ts-expect-error only this Function's declared Runtime Variable keys are visible.
      void context.variables.missingKey;

      return {
        id: payload.id,
        name: "Victor",
      };
    },
    input: getUserInput,
    output: getUserOutput,
    variables: { apiKey, eagerlyLoadedApiKey, uncachedKey },
  }),
  health: fn({
    handler: () => ({ ok: true }),
    output: schema<{ ok: boolean }>(),
  }),
  processOrder: sqs({
    handler: (event) => {
      const _orderId: string = event.messages[0]?.body.orderId ?? "";

      return event.ok();
    },
    message: schema<{ orderId: string }>(),
    queue: "ordersQueue",
  }),
  processOrderWithInvalidMessages: sqs({
    handler: (event) => {
      for (const message of event.messages) {
        if (message.valid) {
          const _orderId: string = message.body.orderId;
        } else {
          const _rawBody: string = message.rawBody;
          const _error: Error = message.error;
        }
      }

      return event.ok();
    },
    invalidMessageBody: "include",
    message: schema<{ orderId: string }>(),
    queues: [{ batchSize: 1, queue: "ordersQueue" }, "priorityQueue"],
  }),
  processSecretOrder: sqs({
    handler: async (event, context) => {
      const _apiKeyText: string = await context.variables.apiKey.text();
      // @ts-expect-error only this Function's declared Runtime Variable keys are visible.
      void context.variables.missingKey;

      return event.ok();
    },
    message: schema<{ orderId: string }>(),
    queue: "secretOrdersQueue",
    variables: { apiKey },
  }),
  publicRoute: fn({
    synthesis: {
      memory: 512,
      timeout: 30,
    },
  }),
  secureRoute: http({
    routes: (route) =>
      route.get("/secure", {
        handler: async (_request, context) => {
          const apiKeyText: string = await context.variables.apiKey.text();
          // @ts-expect-error only this Function's declared Runtime Variable keys are visible.
          void context.variables.missingKey;

          return { apiKeyText };
        },
        output: schema<{ apiKeyText: string }>(),
      }),
    variables: { apiKey },
  }),
});

const _userResult: Promise<{ id: string; name: string }> = functions.invoke(
  "getUser",
  {
    id: "usr_1",
  }
);

const _queuedResult: Promise<AsyncInvokeResult> = functions.invoke(
  "getUser",
  { id: "usr_1" },
  { mode: "async" }
);

const _healthResult: Promise<{ ok: boolean }> = functions.invoke("health");
void functions.invoke("health");

// @ts-expect-error payload shape is inferred from the input schema.
void functions.invoke("getUser", { userId: "usr_1" });

// @ts-expect-error input-backed functions require a payload.
void functions.invoke("getUser");

// @ts-expect-error zero-input functions only accept no payload or undefined.
void functions.invoke("health", {});

// @ts-expect-error route-only function placeholders are not invokable.
void functions.invoke("publicRoute");

const _sqsResult: Promise<SqsBatchResult> = functions.sendEvent(
  "processOrder",
  {
    messages: [{ body: { orderId: "ord_1" } }],
  }
);
void functions.sendEvent("processOrder", {
  messages: [{ body: { orderId: "ord_1" } }],
  source: "sqs",
});

// @ts-expect-error event message body shape is inferred from the sqs() message schema.
void functions.sendEvent("processOrder", { messages: [{ body: {} }] });

// A Function that keeps invalid messages accepts bodies of any shape.
const _includeInvalidResult: Promise<SqsBatchResult> = functions.sendEvent(
  "processOrderWithInvalidMessages",
  { messages: [{ body: "not json" }] }
);

// An Event Source authored by any Provider package: the event shape comes from its input schema,
// and the Event Invocation resolves to whatever its handler returns.
const customEventFunction: EventFunctionDefinition<
  string,
  StandardSchemaV1<{ ticks: number }>,
  Record<never, never>,
  { done: boolean }
> = {
  events: [{ properties: {}, source: "custom" }],
  handler: (event) => ({ done: event.ticks > 0 }),
  input: schema<{ ticks: number }>(),
  key: "",
  kind: "event",
};
const customFunctions = createFunctions({ tick: customEventFunction });
const _customResult: Promise<{ done: boolean }> = customFunctions.sendEvent(
  "tick",
  { ticks: 1 }
);

// @ts-expect-error the event shape comes from the Function's input schema.
void customFunctions.sendEvent("tick", { ticks: "1" });

// @ts-expect-error the result is the handler's, not an SQS batch result.
const _customAsSqs: Promise<SqsBatchResult> = customFunctions.sendEvent(
  "tick",
  {
    ticks: 1,
  }
);

// @ts-expect-error invokable functions are not event source functions.
void functions.sendEvent("getUser", { messages: [{ body: { id: "usr_1" } }] });

// @ts-expect-error event source functions are not invokable.
void functions.invoke("processOrder", { orderId: "ord_1" });

sqs({
  handler: (event) => event.ok(),
  message: schema<{ id: string }>(),
  // @ts-expect-error partial batch failure reporting is always enabled in v1.
  partialBatchFailure: false,
  queue: "ordersQueue",
});

fn({
  // @ts-expect-error invokable functions require an output schema.
  handler: () => ({ ok: true }),
});

sqs({
  handler: (event) => event.ok(),
  message: schema<{ id: string }>(),
  queue: "ordersQueue",
});

fn({
  handler: () => ({ ok: true }),
  output: schema<{ ok: boolean }>(),
  synthesis: {
    memory: 512,
    provider: { aws: { properties: {}, type: "lambda.function" } },
    timeout: 30,
  },
});

fn({
  handler: () => ({ ok: true }),
  output: schema<{ ok: boolean }>(),
  synthesis: {
    // @ts-expect-error The Lambda runtime moved to synthesis.provider (awsLambda from @voke/aws).
    runtime: "nodejs24.x",
  },
});
