import { expect, test } from "bun:test";

import { createFunctions, createVokeModel, fn, http, route } from "voke";
import type { StandardSchemaV1 } from "voke";

import { sqsQueue } from "../src/cloudformation";
import type { CloudFormationResource } from "../src/cloudformation";
import { synthesizeCloudFormationFromModel } from "../src/cloudformation-synthesis";
import { aws, awsLambda } from "../src/index";
import { sqs } from "../src/sqs";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

const worker = (synthesis?: Parameters<typeof fn>[0]["synthesis"]) =>
  fn({
    handler: () => ({ ok: true }),
    output: schema<{ ok: boolean }>(),
    ...(synthesis === undefined ? {} : { synthesis }),
  });

const api = (synthesis?: Parameters<typeof http>[0]["synthesis"]) =>
  http({
    routes: [route.get("/health", { handler: () => ({ ok: true }) })],
    ...(synthesis === undefined ? {} : { synthesis }),
  });

type ModelInput = Omit<Parameters<typeof createVokeModel>[0], "provider">;

const modelFor = (input: ModelInput, provider = aws()) =>
  createVokeModel({ ...input, provider });

const synthesize = (
  input: ModelInput,
  provider = aws()
): Record<string, CloudFormationResource> => {
  const template = provider.synthesis?.synthesize?.({
    config: undefined as never,
    model: modelFor(input, provider),
  }) as { Resources: Record<string, CloudFormationResource> };

  return template.Resources;
};

const functionsOf = (resources: Record<string, CloudFormationResource>) =>
  Object.entries(resources).filter(
    ([, resource]) => resource.Type === "AWS::Lambda::Function"
  );

test("every Function gets production-safe Lambda defaults and its own log group", () => {
  const resources = synthesize({
    functions: createFunctions({ http: api(), worker: worker() }),
    name: "defaults-api",
    stage: "prod",
  });
  const lambdas = functionsOf(resources);

  expect(lambdas).toHaveLength(2);

  for (const [logicalId, lambda] of lambdas) {
    expect(lambda.Properties).toMatchObject({
      Architectures: ["arm64"],
      LoggingConfig: { LogGroup: { Ref: `${logicalId}LogGroup` } },
      MemorySize: 1024,
      Runtime: "nodejs22.x",
      Timeout: 15,
    });
    expect(resources[`${logicalId}LogGroup`]).toEqual({
      Properties: {
        LogGroupName: `/aws/lambda/${String(lambda.Properties?.FunctionName)}`,
        RetentionInDays: 14,
      },
      Type: "AWS::Logs::LogGroup",
    });
  }
});

test("aws({ lambda }) options override the defaults and awsLambda() overrides the options", () => {
  const resources = synthesize(
    {
      functions: createFunctions({
        tuned: worker({
          memory: 2048,
          provider: awsLambda({
            architecture: "x86_64",
            runtime: "nodejs22.x",
          }),
          timeout: 120,
        }),
        worker: worker(),
      }),
      name: "options-api",
      runtime: { memory: 512, timeout: 60 },
    },
    aws({
      lambda: {
        architecture: "arm64",
        logRetentionDays: 30,
        runtime: "nodejs24.x",
      },
    })
  );

  expect(resources.WorkerFunction?.Properties).toMatchObject({
    Architectures: ["arm64"],
    MemorySize: 512,
    Runtime: "nodejs24.x",
    Timeout: 60,
  });
  expect(resources.TunedFunction?.Properties).toMatchObject({
    Architectures: ["x86_64"],
    MemorySize: 2048,
    Runtime: "nodejs22.x",
    Timeout: 120,
  });
  expect(resources.WorkerFunctionLogGroup?.Properties?.RetentionInDays).toBe(
    30
  );
});

test("the HTTP API gets CorsConfiguration only when api.cors is set", () => {
  const withoutCors = synthesize({
    functions: createFunctions({ http: api() }),
    name: "no-cors-api",
  });
  const openCors = synthesize({
    api: { cors: true },
    functions: createFunctions({ http: api() }),
    name: "open-cors-api",
  });
  const explicitCors = synthesize({
    api: {
      cors: {
        credentials: true,
        headers: ["authorization", "content-type"],
        maxAgeSeconds: 600,
        methods: ["GET", "POST"],
        origins: ["https://app.example"],
      },
    },
    functions: createFunctions({ http: api() }),
    name: "explicit-cors-api",
  });

  expect(withoutCors.Api?.Properties?.CorsConfiguration).toBeUndefined();
  expect(openCors.Api?.Properties?.CorsConfiguration).toEqual({
    AllowCredentials: false,
    AllowHeaders: ["*"],
    AllowMethods: ["*"],
    AllowOrigins: ["*"],
  });
  expect(explicitCors.Api?.Properties?.CorsConfiguration).toEqual({
    AllowCredentials: true,
    AllowHeaders: ["authorization", "content-type"],
    AllowMethods: ["GET", "POST"],
    AllowOrigins: ["https://app.example"],
    MaxAge: 600,
  });
});

const consumer = (timeout?: number, maxBatchingWindowSeconds?: number) =>
  sqs({
    handler: (batch) => batch.ok(),
    message: schema<{ id: string }>(),
    queue: "jobsQueue",
    ...(maxBatchingWindowSeconds === undefined
      ? {}
      : { maxBatchingWindowSeconds }),
    ...(timeout === undefined ? {} : { synthesis: { timeout } }),
  });

test("an SQS queue's visibility timeout follows its consumers unless set explicitly", () => {
  const derived = synthesize({
    functions: createFunctions({ fast: consumer(), slow: consumer(40) }),
    name: "sqs-api",
    resources: { jobsQueue: sqsQueue() },
  });
  const batched = synthesize({
    functions: createFunctions({ batched: consumer(20, 10) }),
    name: "sqs-api",
    resources: { jobsQueue: sqsQueue() },
  });
  const explicit = synthesize({
    functions: createFunctions({ fast: consumer() }),
    name: "sqs-api",
    resources: { jobsQueue: sqsQueue({ visibilityTimeoutSeconds: 90 }) },
  });
  const unused = synthesize({
    name: "sqs-api",
    resources: { jobsQueue: sqsQueue() },
  });

  // AWS: at least six times the Function timeout, plus the batching window.
  expect(derived.JobsQueue?.Properties?.VisibilityTimeout).toBe(240);
  expect(batched.JobsQueue?.Properties?.VisibilityTimeout).toBe(130);
  expect(explicit.JobsQueue?.Properties?.VisibilityTimeout).toBe(90);
  expect(unused.JobsQueue?.Properties?.VisibilityTimeout).toBeUndefined();
});

test("rejects an explicit visibility timeout lower than a consumer's timeout", () => {
  expect(() =>
    modelFor({
      functions: createFunctions({ slow: consumer(60) }),
      name: "sqs-api",
      resources: { jobsQueue: sqsQueue({ visibilityTimeoutSeconds: 30 }) },
    })
  ).toThrow(
    'Invalid Voke model at resources.jobsQueue.properties.VisibilityTimeout: queue visibility timeout 30s is lower than Function "slow" timeout 60s; set sqsQueue({ visibilityTimeoutSeconds }) to at least 60, or leave it unset so Voke derives it'
  );
});

test("validates Function memory and timeout against Lambda limits", () => {
  expect(() =>
    modelFor({
      functions: createFunctions({ worker: worker({ memory: 64 }) }),
      name: "limits-api",
    })
  ).toThrow(
    'Invalid Voke model at functions.worker.synthesis.memory: Function "worker" memory 64 MB is outside the Lambda range 128-10240 MB'
  );
  expect(() =>
    modelFor({
      functions: createFunctions({ worker: worker() }),
      name: "limits-api",
      runtime: { timeout: 901 },
    })
  ).toThrow(
    'Invalid Voke model at functions.worker.synthesis.timeout: Function "worker" timeout 901s is outside the Lambda range 1-900s'
  );
});

test("rejects an HTTP-routed Function whose timeout exceeds the HTTP API limit", () => {
  expect(() =>
    modelFor({
      functions: createFunctions({ http: api({ timeout: 31 }) }),
      name: "slow-api",
    })
  ).toThrow(
    'Invalid Voke model at functions.http.synthesis.timeout: Function "http" timeout 31s exceeds the 30s API Gateway HTTP API integration limit; lower synthesis.timeout to 30 or less, or move the work to an SQS Function'
  );
  expect(() =>
    modelFor({
      functions: createFunctions({ worker: worker({ timeout: 300 }) }),
      name: "slow-worker",
    })
  ).not.toThrow();
});

test("validates awsLambda() records and aws({ lambda }) options", () => {
  expect(() =>
    modelFor({
      functions: createFunctions({
        worker: worker({
          provider: {
            aws: {
              properties: { runtime: "python3.12" },
              type: "lambda.function",
            },
          },
        }),
      }),
      name: "record-api",
    })
  ).toThrow(
    'Invalid Voke model at functions.worker.synthesis.provider.aws.properties.runtime: expected one of "nodejs22.x", "nodejs24.x"; received "python3.12"'
  );
  expect(() =>
    modelFor({
      functions: createFunctions({
        worker: worker({
          provider: {
            aws: { properties: {}, type: "cloudformation.resource" },
          },
        }),
      }),
      name: "record-api",
    })
  ).toThrow(
    'Invalid Voke model at functions.worker.synthesis.provider.aws.type: expected "lambda.function" (use awsLambda() from "@voke/aws"); received "cloudformation.resource"'
  );
  expect(() => aws({ lambda: { logRetentionDays: 10 as never } })).toThrow(
    "Invalid Voke config at aws.lambda.logRetentionDays: expected a CloudWatch Logs retention period such as 7 or 14; received 10"
  );
  expect(() => aws({ lambda: { architecture: "arm32" as never } })).toThrow(
    'Invalid Voke config at aws.lambda.architecture: expected one of "arm64", "x86_64"; received "arm32"'
  );
});

test("synthesis without the aws() closure applies the same defaults", () => {
  const template = synthesizeCloudFormationFromModel(
    createVokeModel({
      functions: createFunctions({ worker: worker() }),
      name: "plain-synthesis",
    })
  );

  expect(template.Resources.WorkerFunction?.Properties).toMatchObject({
    Architectures: ["arm64"],
    MemorySize: 1024,
    Runtime: "nodejs22.x",
    Timeout: 15,
  });
  expect(
    template.Resources.WorkerFunctionLogGroup?.Properties?.RetentionInDays
  ).toBe(14);
});
