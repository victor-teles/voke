import { requestAuthorizer } from "../src/authorizers";
import {
  defineFunction,
  defineFunctions,
  http,
  sqs,
  sqsEventSource,
  sqsMessageBatch,
} from "../src/invoke";
import type {
  AsyncInvokeResult,
  SqsBatchResult,
  StandardSchemaV1,
} from "../src/invoke";
import { createVariableSource } from "../src/variables";

const schema = <TInput, TOutput = TInput>(): StandardSchemaV1<
  TInput,
  TOutput
> => ({
  "~standard": {
    validate: (value) => ({ data: value as unknown as TOutput, success: true }),
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

const functions = defineFunctions({
  authorizeRequest: requestAuthorizer({
    handler: async (_request, context) => {
      const _apiKeyText: string = await context.variables.apiKey.text();
      // @ts-expect-error only this Function's declared Runtime Variable keys are visible.
      void context.variables.missingKey;

      return { authorized: true };
    },
    variables: { apiKey },
  }),
  getUser: defineFunction({
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
  health: defineFunction({
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
  publicRoute: defineFunction({
    synthesis: {
      runtime: "nodejs24.x",
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

// @ts-expect-error event message body shape is inferred from sqsMessageBatch.
void functions.sendEvent("processOrder", { messages: [{ body: {} }] });

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

defineFunction({
  // @ts-expect-error invokable functions require an output schema.
  handler: () => ({ ok: true }),
});

defineFunction({
  events: [sqsEventSource("ordersQueue")],
  handler: (event) => event.ok(),
  input: sqsMessageBatch(schema<{ id: string }>()),
});

defineFunction({
  handler: () => ({ ok: true }),
  output: schema<{ ok: boolean }>(),
  synthesis: {
    runtime: "nodejs24.x",
  },
});
