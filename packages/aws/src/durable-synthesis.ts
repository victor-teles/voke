import { createHash } from "node:crypto";

import type { VokeModel } from "voke";

import type {
  CloudFormationResource,
  CloudFormationValue,
} from "./cloudformation-template";
import { durableAliasName, durableInvokeTargetVariable } from "./durable";
import { resolveFunctionDurableSettings } from "./lambda-settings";

type VokeModelFunction = VokeModel["functions"][string];

/**
 * A Lambda ARN built from the deployed name, not `Fn::GetAtt`: Function roles must not depend on
 * Functions, because every Function already depends on its role.
 */
const lambdaArn = (
  deployedName: string,
  qualifier: string
): CloudFormationValue => ({
  "Fn::Sub": [
    `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${deployedName}:${qualifier}`,
    {},
  ],
});

/** The Durable Functions of the model, sorted by key so the template is stable. */
const durableFunctions = (model: VokeModel): [string, VokeModelFunction][] =>
  Object.entries(model.functions)
    .filter(
      ([, definition]) =>
        resolveFunctionDurableSettings(definition) !== undefined
    )
    .toSorted(([left], [right]) => left.localeCompare(right));

/**
 * What every Function in the stack gets so it can start the stack's Durable Functions: one
 * `VOKE_INVOKE_TARGET_<KEY>` variable each, and `lambda:InvokeFunction` on their `live` aliases.
 * Empty for a stack without Durable Functions.
 */
export const durableInvokeAccess = (
  model: VokeModel
): {
  environment: Record<string, string>;
  statements: CloudFormationValue[];
} => {
  const targets = durableFunctions(model);

  if (targets.length === 0) {
    return { environment: {}, statements: [] };
  }

  return {
    environment: Object.fromEntries(
      targets.map(([key, definition]) => [
        durableInvokeTargetVariable(key),
        `${definition.deployedName}:${durableAliasName}`,
      ])
    ),
    statements: [
      {
        Action: "lambda:InvokeFunction",
        Effect: "Allow",
        Resource: targets.map(([, definition]) =>
          lambdaArn(definition.deployedName, durableAliasName)
        ),
      },
    ],
  };
};

/** The statement a Durable Function's own role needs to checkpoint and replay its executions. */
export const durableExecutionRoleStatements = (
  definition: VokeModelFunction
): CloudFormationValue[] =>
  resolveFunctionDurableSettings(definition) === undefined
    ? []
    : [
        {
          Action: [
            "lambda:CheckpointDurableExecution",
            "lambda:GetDurableExecutionState",
          ],
          Effect: "Allow",
          // Executions belong to a version, so only a qualified ARN pattern matches them.
          Resource: lambdaArn(definition.deployedName, "*"),
        },
      ];

/** `DurableConfig` for the `AWS::Lambda::Function`, or undefined for a Function not durable. */
export const durableConfig = (
  definition: VokeModelFunction
): CloudFormationValue | undefined => {
  const settings = resolveFunctionDurableSettings(definition);

  if (settings === undefined) {
    return undefined;
  }

  return {
    ExecutionTimeout: settings.executionTimeoutSeconds,
    ...(settings.retentionDays === undefined
      ? {}
      : { RetentionPeriodInDays: settings.retentionDays }),
  };
};

const versionHashLength = 10;

/**
 * A retained `AWS::Lambda::Version` and the `live` alias that points at it. The version's logical
 * id hashes the Function's properties, which include the bundle key, so every code or
 * configuration change publishes a new version; old versions stay so the executions pinned to
 * them can finish.
 */
export const durableVersionResources = (
  functionLogicalId: string,
  functionResource: CloudFormationResource
): Record<string, CloudFormationResource> => {
  const hash = createHash("sha256")
    .update(JSON.stringify(functionResource.Properties))
    .digest("hex")
    .slice(0, versionHashLength);
  const versionLogicalId = `${functionLogicalId}Version${hash}`;

  return {
    [`${functionLogicalId}LiveAlias`]: {
      Properties: {
        FunctionName: { Ref: functionLogicalId },
        FunctionVersion: { "Fn::GetAtt": [versionLogicalId, "Version"] },
        Name: durableAliasName,
      },
      Type: "AWS::Lambda::Alias",
    },
    [versionLogicalId]: {
      DeletionPolicy: "Retain",
      Properties: { FunctionName: { Ref: functionLogicalId } },
      Type: "AWS::Lambda::Version",
      UpdateReplacePolicy: "Retain",
    },
  };
};
