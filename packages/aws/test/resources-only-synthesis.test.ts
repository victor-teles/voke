import { expect, test } from "bun:test";

import { createFunctions, createVokeModel, http, route } from "voke";
import type { StandardSchemaV1 } from "voke";

import { dynamodbTable, sqsQueue } from "../src/cloudformation";
import {
  resourceOutputBindings,
  synthesizeCloudFormationFromModel,
} from "../src/cloudformation-synthesis";
import { aws } from "../src/index";
import { sqs } from "../src/sqs";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ data: value as TValue, success: true }),
    vendor: "voke-test",
    version: 1,
  },
});

const model = () =>
  createVokeModel({
    functions: createFunctions({
      http: http({
        routes: [route.get("/health", { handler: () => ({ ok: true }) })],
      }),
      worker: sqs({
        handler: (batch) => batch.ok(),
        message: schema<{ id: string }>(),
        queue: "eventsQueue",
      }),
    }),
    name: "local-api",
    provider: aws(),
    resources: {
      eventsQueue: sqsQueue(),
      usersTable: dynamodbTable({ partitionKey: "id" }),
    },
    stage: "local",
  });

test("resources scope keeps only the declared resources and their outputs", () => {
  const template = synthesizeCloudFormationFromModel(model(), {
    scope: "resources",
  });

  expect(Object.keys(template.Resources).toSorted()).toEqual([
    "EventsQueue",
    "UsersTable",
  ]);
  expect(template.Resources.UsersTable?.Metadata).toEqual({
    VokeBinding: { Attribute: "name", Resource: "usersTable" },
  });
  expect(Object.keys(template.Outputs).toSorted()).toEqual([
    "EventsQueueUrl",
    "UsersTableName",
  ]);
});

test("maps each resource output to its binding variable", () => {
  expect(resourceOutputBindings(model())).toEqual({
    EventsQueueUrl: "VOKE_RESOURCE_EVENTS_QUEUE_URL",
    UsersTableName: "VOKE_RESOURCE_USERS_TABLE_NAME",
  });
});

test("the full model is still validated, so a bad queue reference fails locally too", () => {
  expect(() =>
    createVokeModel({
      functions: createFunctions({
        worker: sqs({
          handler: (batch) => batch.ok(),
          message: schema<{ id: string }>(),
          queue: "missingQueue",
        }),
      }),
      name: "local-api",
      provider: aws(),
    })
  ).toThrow('SQS event source references resource "missingQueue"');
});
