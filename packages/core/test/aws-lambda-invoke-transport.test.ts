import { expect, mock, test } from "bun:test";

import type { StandardSchemaV1 } from "../src/invoke";

const sdkCalls: unknown[] = [];
let sdkResponse: unknown;

const MockLambdaClient = function MockLambdaClient() {};

MockLambdaClient.prototype.send = (command: {
  input: unknown;
}): Promise<unknown> => {
  sdkCalls.push(command.input);
  return Promise.resolve(sdkResponse);
};

mock.module("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return { InvokeCommand, LambdaClient: MockLambdaClient };
});

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

test("default AWS runtime invokes Lambda with parsed payload and trace metadata", async () => {
  sdkCalls.length = 0;
  sdkResponse = {
    $metadata: { requestId: "aws_req_1" },
    Payload: new TextEncoder().encode(
      JSON.stringify({ data: { id: "usr_1", name: "Victor" } })
    ),
    StatusCode: 200,
  };

  const { defineFunction, defineFunctions, withInvokeTrace } =
    await import("../src/invoke");
  const functions = defineFunctions({
    getUser: defineFunction({
      handler: (payload) => ({
        id: payload.id,
        name: "local",
      }),
      input: userInputSchema,
      name: "deployed-get-user",
      output: userOutputSchema,
    }),
  });

  const result = await withInvokeTrace({ parentFunction: "api" }, () =>
    functions.invoke(
      "getUser",
      { id: "usr_1" },
      {
        runtime: "aws",
        trace: { requestId: "req_aws" },
      }
    )
  );

  expect(result).toEqual({ id: "usr_1", name: "Victor" });
  expect(sdkCalls).toEqual([
    {
      FunctionName: "deployed-get-user",
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(
        JSON.stringify({
          payload: { id: "usr_1" },
          trace: { parentFunction: "api", requestId: "req_aws" },
        })
      ),
    },
  ]);
});

test("default AWS runtime returns accepted shape for async Lambda invokes", async () => {
  sdkCalls.length = 0;
  sdkResponse = {
    $metadata: { requestId: "aws_async_req_1" },
    StatusCode: 202,
  };

  const { defineFunction, defineFunctions } = await import("../src/invoke");
  const functions = defineFunctions({
    getUser: defineFunction({
      handler: (payload) => ({
        id: payload.id,
        name: "local",
      }),
      input: userInputSchema,
      name: "deployed-get-user",
      output: userOutputSchema,
    }),
  });

  const result = await functions.invoke(
    "getUser",
    { id: "usr_1" },
    {
      mode: "async",
      runtime: "aws",
    }
  );

  expect(result).toEqual({ accepted: true, requestId: "aws_async_req_1" });
  expect(sdkCalls).toEqual([
    {
      FunctionName: "deployed-get-user",
      InvocationType: "Event",
      Payload: new TextEncoder().encode(
        JSON.stringify({
          payload: { id: "usr_1" },
          trace: {},
        })
      ),
    },
  ]);
});

test("default AWS runtime uses registry key when no deployed name is configured", async () => {
  sdkCalls.length = 0;
  sdkResponse = {
    $metadata: { requestId: "aws_req_2" },
    Payload: new TextEncoder().encode(
      JSON.stringify({ data: { id: "usr_2", name: "Ada" } })
    ),
    StatusCode: 200,
  };

  const { defineFunction, defineFunctions } = await import("../src/invoke");
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

  await expect(
    functions.invoke("getUser", { id: "usr_2" }, { runtime: "aws" })
  ).resolves.toEqual({ id: "usr_2", name: "Ada" });
  expect(sdkCalls).toEqual([
    {
      FunctionName: "getUser",
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(
        JSON.stringify({
          payload: { id: "usr_2" },
          trace: {},
        })
      ),
    },
  ]);
});

test("default AWS runtime converts SDK and Lambda failures into invoke errors", async () => {
  const { defineFunction, defineFunctions } = await import("../src/invoke");
  const functions = defineFunctions({
    getUser: defineFunction({
      handler: (payload) => ({
        id: payload.id,
        name: "local",
      }),
      input: userInputSchema,
      name: "deployed-get-user",
      output: userOutputSchema,
    }),
  });

  sdkResponse = Promise.reject(new Error("socket closed"));

  await expect(
    functions.invoke("getUser", { id: "usr_1" }, { runtime: "aws" })
  ).rejects.toMatchObject({
    code: "TRANSPORT_FAILED",
    functionName: "deployed-get-user",
    message: 'invoke("deployed-get-user") transport failed: socket closed',
  });

  sdkResponse = {
    $metadata: { requestId: "aws_failed_req_1" },
    FunctionError: "Unhandled",
    Payload: new TextEncoder().encode(JSON.stringify({ error: "boom" })),
    StatusCode: 200,
  };

  await expect(
    functions.invoke("getUser", { id: "usr_1" }, { runtime: "aws" })
  ).rejects.toMatchObject({
    code: "TRANSPORT_STATUS_ERROR",
    functionName: "deployed-get-user",
    message: 'invoke("deployed-get-user") failed with Unhandled',
    requestId: "aws_failed_req_1",
    statusCode: 200,
  });
});

test("default AWS runtime converts SDK timeouts into invoke errors", async () => {
  const { defineFunction, defineFunctions } = await import("../src/invoke");
  const functions = defineFunctions({
    getUser: defineFunction({
      handler: (payload) => ({
        id: payload.id,
        name: "local",
      }),
      input: userInputSchema,
      name: "deployed-get-user",
      output: userOutputSchema,
    }),
  });

  sdkResponse = Promise.race([]);

  await expect(
    functions.invoke(
      "getUser",
      { id: "usr_1" },
      {
        runtime: "aws",
        timeoutMs: 1,
      }
    )
  ).rejects.toMatchObject({
    code: "TIMEOUT",
    functionName: "deployed-get-user",
    message: 'invoke("deployed-get-user") timed out after 1ms',
  });
});
