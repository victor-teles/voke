import { sqsQueue } from "../src/aws";
import { defineConfig } from "../src/config";
import {
  defineFunction,
  defineFunctions,
  sqsEventSource,
  sqsMessageBatch,
} from "../src/invoke";
import type { SqsMessageBatch, StandardSchemaV1 } from "../src/invoke";
import { createInternalModel } from "../src/model";
import type {
  VokeModel,
  VokeModelSqsEventSource,
  VokeModelValue,
} from "../src/model";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ data: value, success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

const value: VokeModelValue = {
  enabled: true,
  limits: [1, 2, 3],
  name: "users",
};

const getUser = defineFunction({
  handler: (payload) => ({
    id: payload.id,
  }),
  input: schema<{ id: string }>(),
  name: "getUser",
  output: schema<{ id: string }>(),
  synthesis: {
    runtime: "nodejs24.x",
  },
});

const model: VokeModel = createInternalModel(
  defineConfig({
    api: {
      function: "getUser",
    },
    functions: {
      getUser,
    },
    name: "typed-model",
  })
);

const modelFunction = model.functions.getUser;

if (modelFunction === undefined) {
  throw new Error("typecheck fixture is missing getUser");
}

const { runtime }: { runtime: "nodejs22.x" | "nodejs24.x" } = modelFunction;

const processOrder = defineFunction({
  events: [sqsEventSource("ordersQueue", { batchSize: 5 })],
  handler: (batch: SqsMessageBatch<{ id: string }>) => batch.ok(),
  input: sqsMessageBatch(schema<{ id: string }>()),
});
const eventSourceModel = createInternalModel({
  functions: defineFunctions({ processOrder }),
  name: "typed-events",
  resources: {
    ordersQueue: sqsQueue(),
  },
});
const eventSource: VokeModelSqsEventSource | undefined =
  eventSourceModel.functions.processOrder?.eventSources[0];

// @ts-expect-error model values are serializable and do not support functions.
const invalidValue: VokeModelValue = () => "nope";

void value;
void runtime;
void eventSource;
void invalidValue;
