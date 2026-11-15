import type {
  VokeModel,
  VokeModelProviderExtensionRecord,
  VokeModelRecord,
} from "voke";

import type { VokeIssue } from "./event-sources";

const iamPolicyRecordType = "iam.policy";

/** One IAM statement a Plugin adds to every Function role. The effect is always Allow. */
export interface AwsPolicyStatement {
  actions: string[];
  resources: string[];
}

/**
 * The AWS Provider Extension Record for a Plugin's `contributions.provider`: IAM statements added
 * to every Function role.
 */
export const awsPolicy = (input: {
  statements: readonly AwsPolicyStatement[];
}): { aws: VokeModelProviderExtensionRecord } => ({
  aws: {
    properties: {
      statements: input.statements.map((statement) => ({
        actions: [...statement.actions],
        resources: [...statement.resources],
      })),
    },
    type: iamPolicyRecordType,
  },
});

const isNonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry) => typeof entry === "string");

const statementIssues = (statement: unknown, path: string): VokeIssue[] => {
  const record = (
    typeof statement === "object" && statement !== null ? statement : {}
  ) as Record<string, unknown>;

  return (["actions", "resources"] as const).flatMap((field) =>
    isNonEmptyStringArray(record[field])
      ? []
      : [
          {
            message: `expected a non-empty array of strings; received ${JSON.stringify(record[field] ?? null)}`,
            path: `${path}.${field}`,
          },
        ]
  );
};

const recordIssues = (
  plugin: string,
  record: VokeModelProviderExtensionRecord
): VokeIssue[] => {
  const path = `plugins.${plugin}.contributions.provider.aws`;

  if (record.type !== iamPolicyRecordType) {
    return [
      {
        message: `expected "${iamPolicyRecordType}" (use awsPolicy() from "@voke/aws"); received ${JSON.stringify(record.type)}`,
        path: `${path}.type`,
      },
    ];
  }

  const { statements } = record.properties;

  if (!Array.isArray(statements) || statements.length === 0) {
    return [
      {
        message: `expected a non-empty array of statements; received ${JSON.stringify(statements ?? null)}`,
        path: `${path}.properties.statements`,
      },
    ];
  }

  return statements.flatMap((statement, index) =>
    statementIssues(statement, `${path}.properties.statements.${index}`)
  );
};

/** Issues in the `aws` records of the model's Plugins; records for other Providers are ignored. */
export const pluginRecordIssues = (model: VokeModel): VokeIssue[] =>
  Object.entries(model.plugins ?? {}).flatMap(([plugin, { provider }]) =>
    provider.aws === undefined ? [] : recordIssues(plugin, provider.aws)
  );

/** The IAM statements every Function role gets from the model's Plugins. Validated first. */
export const pluginPolicyStatements = (model: VokeModel): VokeModelRecord[] =>
  Object.values(model.plugins ?? {}).flatMap(({ provider }) => {
    const statements = provider.aws?.properties.statements;

    if (!Array.isArray(statements)) {
      return [];
    }

    return (statements as unknown as AwsPolicyStatement[]).map((statement) => ({
      Action: statement.actions,
      Effect: "Allow",
      Resource: statement.resources,
    }));
  });
