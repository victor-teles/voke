// The CloudFormation template vocabulary and the AWS resource metadata reader that synthesis and
// the Event Source adapters both use. Kept apart so neither imports the other.
import type { VokeModelResource } from "voke";

export type CloudFormationValue =
  | string
  | number
  | boolean
  | null
  | CloudFormationValue[]
  | { [key: string]: CloudFormationValue };

export interface CloudFormationTemplate {
  AWSTemplateFormatVersion: "2010-09-09";
  Description: string;
  Resources: Record<string, CloudFormationResource>;
  Outputs: Record<string, CloudFormationOutput>;
}

export interface CloudFormationOutput {
  Description: string;
  Value: CloudFormationValue;
}

export interface CloudFormationResource {
  Type: string;
  Properties: Record<string, CloudFormationValue>;
  Metadata?: Record<string, CloudFormationValue>;
  DeletionPolicy?: "Delete" | "Retain";
  UpdateReplacePolicy?: "Delete" | "Retain";
}

export type AwsResourceBindingValue = "ref" | "getAttArn" | "getAttId";

export type AwsResourcePolicyResource =
  | "ref"
  | "getAttArn"
  | "getAttId"
  | "parameterArn"
  | "s3ArnWithObjects";

export interface AwsCloudFormationResourceProvider {
  cloudFormationType: string;
  bindingValue: AwsResourceBindingValue;
  policyResource: AwsResourcePolicyResource;
  outputName: string;
}

export const toLogicalId = (value: string): string => {
  const words = value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean);

  return words
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join("");
};

/** The AWS metadata every resource builder in `@voke/aws/cloudformation` records. */
export const resourceProvider = (
  resource: VokeModelResource
): AwsCloudFormationResourceProvider => {
  const extension = resource.provider?.aws;

  if (extension !== undefined) {
    if (extension.type !== "cloudformation.resource") {
      throw new Error("AWS resource provider metadata is required");
    }

    return extension.properties as unknown as AwsCloudFormationResourceProvider;
  }

  throw new Error("AWS resource provider metadata is required");
};
