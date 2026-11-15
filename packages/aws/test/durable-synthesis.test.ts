import { expect, test } from "bun:test";

import {
  createFunctions,
  createVokeModel,
  fn,
  http,
  route,
  VokeModelError,
} from "voke";
import type { StandardSchemaV1, VokeModelProviderExtensionRecord } from "voke";

import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "../src/cloudformation";
import { synthesizeCloudFormationFromModel } from "../src/cloudformation-synthesis";
import { aws, durable } from "../src/index";

const schema = <TValue>(): StandardSchemaV1<TValue, TValue> => ({
  "~standard": {
    validate: (value) => ({ value: value as TValue }),
    vendor: "voke-test",
    version: 1,
  },
});

const shopFunctions = () =>
  createFunctions({
    fulfilOrder: durable({
      executionTimeout: { hours: 24 },
      handler: () => "done",
      output: schema<string>(),
      retentionDays: 30,
    }),
    http: http({
      routes: [route.get("/health", { handler: () => ({ ok: true }) })],
    }),
  });

const modelOf = (functions: ReturnType<typeof createFunctions>) =>
  createVokeModel({
    functions,
    name: "shop",
    provider: aws(),
    stage: "prod",
  });

const synthesize = (
  functions: ReturnType<typeof createFunctions>,
  artifactKey?: string
): CloudFormationTemplate =>
  synthesizeCloudFormationFromModel(
    modelOf(functions),
    artifactKey === undefined
      ? {}
      : { artifact: { bucket: "artifacts", key: artifactKey } }
  );

const resourcesOfType = (template: CloudFormationTemplate, type: string) =>
  Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === type
  );

const statementsOf = (role: CloudFormationResource | undefined) =>
  (
    role?.Properties?.Policies as
      | { PolicyDocument: { Statement: unknown[] } }[]
      | undefined
  )?.[0]?.PolicyDocument.Statement ?? [];

const deployedName = (template: CloudFormationTemplate) =>
  template.Resources.FulfilOrderFunction?.Properties?.FunctionName as string;

test("a durable Function gets DurableConfig and a role that can checkpoint its executions", () => {
  const template = synthesize(shopFunctions(), "bundles/abc.zip");
  const name = deployedName(template);

  expect(
    template.Resources.FulfilOrderFunction?.Properties?.DurableConfig
  ).toEqual({
    ExecutionTimeout: 86_400,
    RetentionPeriodInDays: 30,
  });
  expect(
    template.Resources.Function?.Properties?.DurableConfig
  ).toBeUndefined();
  expect(
    statementsOf(template.Resources.FulfilOrderFunctionRole)
  ).toContainEqual({
    Action: [
      "lambda:CheckpointDurableExecution",
      "lambda:GetDurableExecutionState",
    ],
    Effect: "Allow",
    Resource: {
      "Fn::Sub": [
        `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${name}:*`,
        {},
      ],
    },
  });
  expect(
    JSON.stringify(statementsOf(template.Resources.FunctionRole))
  ).not.toContain("CheckpointDurableExecution");
});

test("a durable Function is published as a retained version behind the live alias", () => {
  const template = synthesize(shopFunctions(), "bundles/abc.zip");
  const versions = resourcesOfType(template, "AWS::Lambda::Version");
  const aliases = resourcesOfType(template, "AWS::Lambda::Alias");

  expect(versions).toHaveLength(1);
  const [versionId = "", version] = versions[0] ?? [];

  expect(versionId).toMatch(/^FulfilOrderFunctionVersion[0-9a-f]{10}$/u);
  expect(version).toEqual({
    DeletionPolicy: "Retain",
    Properties: { FunctionName: { Ref: "FulfilOrderFunction" } },
    Type: "AWS::Lambda::Version",
    UpdateReplacePolicy: "Retain",
  });
  expect(aliases).toEqual([
    [
      "FulfilOrderFunctionLiveAlias",
      {
        Properties: {
          FunctionName: { Ref: "FulfilOrderFunction" },
          FunctionVersion: { "Fn::GetAtt": [versionId, "Version"] },
          Name: "live",
        },
        Type: "AWS::Lambda::Alias",
      },
    ],
  ]);
});

test("the version logical id changes with the bundle and the Function settings", () => {
  const versionId = (template: CloudFormationTemplate) =>
    resourcesOfType(template, "AWS::Lambda::Version")[0]?.[0];
  const first = versionId(synthesize(shopFunctions(), "bundles/abc.zip"));

  expect(versionId(synthesize(shopFunctions(), "bundles/abc.zip"))).toBe(first);
  expect(versionId(synthesize(shopFunctions(), "bundles/def.zip"))).not.toBe(
    first
  );
  expect(
    versionId(
      synthesize(
        createFunctions({
          fulfilOrder: durable({
            executionTimeout: { hours: 12 },
            handler: () => "done",
            output: schema<string>(),
          }),
        }),
        "bundles/abc.zip"
      )
    )
  ).not.toBe(first);
});

test("every Function can start the durable Function through its live alias", () => {
  const template = synthesize(shopFunctions(), "bundles/abc.zip");
  const name = deployedName(template);
  const invokeStatement = {
    Action: "lambda:InvokeFunction",
    Effect: "Allow",
    Resource: [
      {
        "Fn::Sub": [
          `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${name}:live`,
          {},
        ],
      },
    ],
  };

  for (const logicalId of ["Function", "FulfilOrderFunction"]) {
    const environment = template.Resources[logicalId]?.Properties
      ?.Environment as { Variables: Record<string, unknown> };

    expect(environment.Variables.VOKE_INVOKE_TARGET_FULFIL_ORDER).toBe(
      `${name}:live`
    );
    expect(statementsOf(template.Resources[`${logicalId}Role`])).toContainEqual(
      invokeStatement
    );
  }
});

test("a project without durable Functions gets no durable resources, variables or grants", () => {
  const template = synthesize(
    createFunctions({
      worker: fn({ handler: () => "ok", output: schema<string>() }),
    }),
    "bundles/abc.zip"
  );
  const serialized = JSON.stringify(template);

  expect(resourcesOfType(template, "AWS::Lambda::Version")).toEqual([]);
  expect(resourcesOfType(template, "AWS::Lambda::Alias")).toEqual([]);
  expect(serialized).not.toContain("DurableConfig");
  expect(serialized).not.toContain("VOKE_INVOKE_TARGET");
  expect(serialized).not.toContain("lambda:InvokeFunction");
});

const withDurableRecord = (durableRecord: unknown) =>
  createFunctions({
    worker: fn({
      handler: () => "ok",
      output: schema<string>(),
      synthesis: {
        provider: {
          aws: {
            properties: { durable: durableRecord },
            type: "lambda.function",
          } as VokeModelProviderExtensionRecord,
        },
      },
    }),
  });

const validationMessages = (functions: ReturnType<typeof createFunctions>) => {
  try {
    aws().validate?.(modelOf(functions));
  } catch (error) {
    if (error instanceof VokeModelError) {
      return error.message;
    }

    throw error;
  }

  return "";
};

test("model validation enforces the DurableConfig limits", () => {
  expect(
    validationMessages(
      withDurableRecord({ executionTimeoutSeconds: 31_622_401 })
    )
  ).toContain(
    "functions.worker.synthesis.provider.aws.properties.durable.executionTimeoutSeconds"
  );
  expect(
    validationMessages(
      withDurableRecord({ executionTimeoutSeconds: 60, retentionDays: 91 })
    )
  ).toContain("durable.retentionDays");
  expect(
    validationMessages(
      withDurableRecord({ executionTimeoutSeconds: 60, kmsKeyArn: "arn" })
    )
  ).toContain('unknown durable setting "kmsKeyArn"');
  expect(validationMessages(withDurableRecord(true))).toContain(
    "declare the Function with durable()"
  );
  expect(
    validationMessages(
      withDurableRecord({
        executionTimeoutSeconds: 31_622_400,
        retentionDays: 90,
      })
    )
  ).toBe("");
});
