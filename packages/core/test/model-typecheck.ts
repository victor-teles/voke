import { sqs } from "@voke/aws";
import { sqsQueue } from "@voke/aws/cloudformation";

import { fn, createFunctions } from "../src/invoke";
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

const getUser = fn({
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

const model: VokeModel = createInternalModel({
  functions: {
    getUser,
  },
  name: "typed-model",
});

const modelFunction = model.functions.getUser;

if (modelFunction === undefined) {
  throw new Error("typecheck fixture is missing getUser");
}

const { runtime }: { runtime: "nodejs22.x" | "nodejs24.x" } = modelFunction;

const processOrder = sqs({
  batchSize: 5,
  handler: (
    batch: SqsMessageBatch<{
      id: string;
    }>
  ) => batch.ok(),
  message: schema<{
    id: string;
  }>(),
  queue: "ordersQueue",
});
const eventSourceModel = createInternalModel({
  functions: createFunctions({ processOrder }),
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
