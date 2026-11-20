// Which resources hold data, whether a template retains them, and the messages `voke deploy` and
// `voke remove` print when a change would remove, replace or leave one behind.
import type { ChangeSetChange } from "./deploy-clients";

/** A data-bearing resource, as `aws({ retainData })` sees it. */
export interface AwsDataResource {
  /** The Voke resource key in `voke.config.ts`. */
  key: string;
  /** The resolved stage, including the `--stage` flag. */
  stage: string;
  /** The CloudFormation resource type, for example `AWS::DynamoDB::Table`. */
  type: string;
}

/**
 * Whether tables, buckets and generated secrets survive their removal from the stack: `true`
 * (the default) keeps them, `false` lets CloudFormation delete them, and a predicate decides per
 * resource and stage.
 */
export type AwsRetainData = boolean | ((resource: AwsDataResource) => boolean);

/** The CloudFormation types whose stored state exists nowhere else. */
export const dataBearingTypes: ReadonlySet<string> = new Set([
  "AWS::DynamoDB::Table",
  "AWS::S3::Bucket",
  "AWS::SecretsManager::Secret",
]);

export const isRetained = (
  retainData: AwsRetainData | undefined,
  resource: AwsDataResource
): boolean => {
  if (retainData === undefined) {
    return true;
  }

  if (typeof retainData === "boolean") {
    return retainData;
  }

  return retainData(resource);
};

const keptPolicyActions = new Set(["Retain", "ReplaceAndRetain"]);
const replacingValues = new Set(["True", "Conditional"]);

/** Changes that remove or replace a data-bearing resource, whether it is kept or deleted. */
export const dataResourceChanges = (
  changes: readonly ChangeSetChange[]
): ChangeSetChange[] =>
  changes.filter((change) => {
    if (!dataBearingTypes.has(change.resourceType)) {
      return false;
    }

    if (change.action === "Remove") {
      return true;
    }

    return (
      change.action === "Modify" &&
      replacingValues.has(change.replacement ?? "")
    );
  });

/** Without a `PolicyAction` the worst case, deletion, is assumed. */
export const isKeptChange = (change: ChangeSetChange): boolean =>
  keptPolicyActions.has(change.policyAction ?? "");

const changeOutcome = (change: ChangeSetChange): string => {
  const kept = isKeptChange(change);

  if (change.action === "Remove") {
    return kept
      ? "would leave the stack. It is kept with its data, but no Function is bound to it afterwards."
      : "would be DELETED with its data.";
  }

  return kept
    ? "would be replaced by a new, empty resource. The old one is kept with its data, outside the stack."
    : "would be replaced by a new, empty resource. The old one is DELETED with its data.";
};

export const describeDataChange = (change: ChangeSetChange): string => {
  const identity =
    change.physicalId === undefined
      ? change.resourceType
      : `${change.resourceType}, ${change.physicalId}`;

  return `${change.logicalId} (${identity}) ${changeOutcome(change)}`;
};

export const dataLossMessage = (
  stackName: string,
  changes: readonly ChangeSetChange[]
): string =>
  [
    `Deploying ${stackName} would remove or replace ${changes.length} resource(s) that hold data:`,
    ...changes.map((change) => `  ${describeDataChange(change)}`),
    "Nothing was changed. A resource key, and a table's partitionKey and sortKey, identify the resource: undo the rename or key change to keep using it.",
    "To go ahead anyway, run voke deploy again with --accept-data-loss.",
  ].join("\n");

export interface KeptResource {
  physicalId: string;
  type: string;
}

const deleteCommand = (resource: KeptResource, region: string): string => {
  if (resource.type === "AWS::DynamoDB::Table") {
    return `aws dynamodb delete-table --table-name ${resource.physicalId} --region ${region}`;
  }

  if (resource.type === "AWS::S3::Bucket") {
    return `aws s3 rb s3://${resource.physicalId} --force --region ${region}`;
  }

  return `aws secretsmanager delete-secret --secret-id ${resource.physicalId} --region ${region}`;
};

/** The kept block; empty when nothing was kept. */
export const keptResourceLines = (
  resources: readonly KeptResource[],
  region: string
): string[] => {
  const unique = [
    ...new Map(
      resources.map((resource) => [resource.physicalId, resource])
    ).values(),
  ];

  if (unique.length === 0) {
    return [];
  }

  return [
    `Kept ${unique.length} resource(s) that hold data. No stack manages them and AWS still bills them:`,
    ...unique.flatMap((resource) => [
      `  ${resource.type}  ${resource.physicalId}`,
      `    delete with: ${deleteCommand(resource, region)}`,
    ]),
  ];
};
