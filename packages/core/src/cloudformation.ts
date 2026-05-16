import { defineConfig } from "./config";
import type { VokeConfigInput } from "./config";
import { toEnvKey } from "./env-key";

type CloudFormationValue =
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

export interface CloudFormationResource {
  Type: string;
  Properties: Record<string, CloudFormationValue>;
  Metadata?: Record<string, CloudFormationValue>;
}

export interface CloudFormationOutput {
  Description: string;
  Value: CloudFormationValue;
}

export interface StackResourceDefinition {
  cloudFormationType: string;
  bindingAttribute: string;
  bindingValue: "ref" | "getAttArn" | "getAttId";
  policyResource:
    | "ref"
    | "getAttArn"
    | "getAttId"
    | "parameterArn"
    | "s3ArnWithObjects";
  actions: string[];
  outputName: string;
  properties: Record<string, CloudFormationValue>;
}

export type SynthesizeCloudFormationOptions = VokeConfigInput & {
  entrypoint?: string;
  handler?: string;
  environment?: Record<string, string>;
  resources?: Record<string, StackResourceDefinition>;
};

export const dynamodbTable = (
  options: {
    partitionKey?: string;
    sortKey?: string;
    billingMode?: "PAY_PER_REQUEST" | "PROVISIONED";
  } = {}
): StackResourceDefinition => {
  const partitionKey = options.partitionKey ?? "id";
  const attributes = [{ AttributeName: partitionKey, AttributeType: "S" }];
  const keySchema = [{ AttributeName: partitionKey, KeyType: "HASH" }];

  if (options.sortKey !== undefined) {
    attributes.push({ AttributeName: options.sortKey, AttributeType: "S" });
    keySchema.push({ AttributeName: options.sortKey, KeyType: "RANGE" });
  }

  return {
    actions: [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ],
    bindingAttribute: "name",
    bindingValue: "ref",
    cloudFormationType: "AWS::DynamoDB::Table",
    outputName: "Name",
    policyResource: "getAttArn",
    properties: {
      AttributeDefinitions: attributes,
      BillingMode: options.billingMode ?? "PAY_PER_REQUEST",
      KeySchema: keySchema,
    },
  };
};

export const sqsQueue = (): StackResourceDefinition => ({
  actions: [
    "sqs:SendMessage",
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:GetQueueAttributes",
  ],
  bindingAttribute: "url",
  bindingValue: "ref",
  cloudFormationType: "AWS::SQS::Queue",
  outputName: "Url",
  policyResource: "getAttArn",
  properties: {},
});

export const snsTopic = (): StackResourceDefinition => ({
  actions: ["sns:Publish"],
  bindingAttribute: "arn",
  bindingValue: "ref",
  cloudFormationType: "AWS::SNS::Topic",
  outputName: "Arn",
  policyResource: "ref",
  properties: {},
});

export const eventBus = (): StackResourceDefinition => ({
  actions: ["events:PutEvents"],
  bindingAttribute: "name",
  bindingValue: "ref",
  cloudFormationType: "AWS::Events::EventBus",
  outputName: "Name",
  policyResource: "getAttArn",
  properties: {},
});

export const s3Bucket = (): StackResourceDefinition => ({
  actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
  bindingAttribute: "name",
  bindingValue: "ref",
  cloudFormationType: "AWS::S3::Bucket",
  outputName: "Name",
  policyResource: "s3ArnWithObjects",
  properties: {},
});

export const secret = (): StackResourceDefinition => ({
  actions: ["secretsmanager:GetSecretValue"],
  bindingAttribute: "arn",
  bindingValue: "getAttId",
  cloudFormationType: "AWS::SecretsManager::Secret",
  outputName: "Arn",
  policyResource: "getAttId",
  properties: {
    GenerateSecretString: {},
  },
});

export const ssmParameter = (options: {
  value: string;
  type?: "String" | "StringList";
}): StackResourceDefinition => ({
  actions: ["ssm:GetParameter", "ssm:GetParameters"],
  bindingAttribute: "name",
  bindingValue: "ref",
  cloudFormationType: "AWS::SSM::Parameter",
  outputName: "Name",
  policyResource: "parameterArn",
  properties: {
    Type: options.type ?? "String",
    Value: options.value,
  },
});

const toLogicalId = (value: string): string => {
  const words = value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean);

  return words
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join("");
};

const resourceValue = (
  logicalId: string,
  bindingValue: StackResourceDefinition["bindingValue"]
): CloudFormationValue => {
  if (bindingValue === "getAttArn") {
    return { "Fn::GetAtt": [logicalId, "Arn"] };
  }

  if (bindingValue === "getAttId") {
    return { "Fn::GetAtt": [logicalId, "Id"] };
  }

  return { Ref: logicalId };
};

const resourceArn = (
  logicalId: string,
  policyResource: StackResourceDefinition["policyResource"]
): CloudFormationValue => {
  if (policyResource === "ref") {
    return { Ref: logicalId };
  }

  if (policyResource === "parameterArn") {
    return {
      "Fn::Sub": [
        `arn:aws:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter/\${${logicalId}}`,
        {},
      ],
    };
  }

  if (policyResource === "s3ArnWithObjects") {
    return [
      { "Fn::GetAtt": [logicalId, "Arn"] },
      { "Fn::Sub": [`\${${logicalId}.Arn}/*`, {}] },
    ];
  }

  if (policyResource === "getAttId") {
    return { "Fn::GetAtt": [logicalId, "Id"] };
  }

  return { "Fn::GetAtt": [logicalId, "Arn"] };
};

export const synthesizeCloudFormation = (
  options: SynthesizeCloudFormationOptions
): CloudFormationTemplate => {
  const config = defineConfig(options);
  const { resources } = config.cloudFormation;
  const templateResources: Record<string, CloudFormationResource> = {};
  const outputs: Record<string, CloudFormationOutput> = {};
  const environmentVariables: Record<string, CloudFormationValue> = {
    ...config.cloudFormation.environment,
  };
  const policyStatements: CloudFormationValue[] = [];

  for (const [name, resource] of Object.entries(resources)) {
    const logicalId = toLogicalId(name);

    templateResources[logicalId] = {
      Properties: resource.properties,
      Type: resource.cloudFormationType,
    };
    environmentVariables[
      `VOKE_RESOURCE_${toEnvKey(name)}_${toEnvKey(resource.bindingAttribute)}`
    ] = resourceValue(logicalId, resource.bindingValue);
    outputs[`${logicalId}${resource.outputName}`] = {
      Description: `${name} ${resource.bindingAttribute}`,
      Value: resourceValue(logicalId, resource.bindingValue),
    };
    policyStatements.push({
      Action: resource.actions,
      Effect: "Allow",
      Resource: resourceArn(logicalId, resource.policyResource),
    });
  }

  templateResources.FunctionRole = {
    Properties: {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
          },
        ],
        Version: "2012-10-17",
      },
      ManagedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      ],
      Policies: [
        {
          PolicyDocument: {
            Statement: policyStatements,
            Version: "2012-10-17",
          },
          PolicyName: "VokeResourceAccess",
        },
      ],
    },
    Type: "AWS::IAM::Role",
  };
  templateResources.Function = {
    Metadata: {
      VokeEntrypoint: config.entrypoint,
    },
    Properties: {
      Code: {
        ZipFile:
          "export const handler = async () => ({ statusCode: 501, body: 'Build and upload this Voke function before deploying.' });",
      },
      Environment: {
        Variables: environmentVariables,
      },
      FunctionName: `${config.name}-${config.stage}`,
      Handler: config.cloudFormation.handler,
      Role: { "Fn::GetAtt": ["FunctionRole", "Arn"] },
      Runtime: "nodejs22.x",
    },
    Type: "AWS::Lambda::Function",
  };
  templateResources.Api = {
    Properties: {
      Name: `${config.name}-${config.stage}`,
      ProtocolType: "HTTP",
    },
    Type: "AWS::ApiGatewayV2::Api",
  };
  templateResources.Integration = {
    Properties: {
      ApiId: { Ref: "Api" },
      IntegrationType: "AWS_PROXY",
      IntegrationUri: { "Fn::GetAtt": ["Function", "Arn"] },
      PayloadFormatVersion: "2.0",
    },
    Type: "AWS::ApiGatewayV2::Integration",
  };
  templateResources.Route = {
    Properties: {
      ApiId: { Ref: "Api" },
      RouteKey: "$default",
      Target: { "Fn::Sub": `integrations/\${Integration}` },
    },
    Type: "AWS::ApiGatewayV2::Route",
  };
  templateResources.Stage = {
    Properties: {
      ApiId: { Ref: "Api" },
      AutoDeploy: true,
      StageName: config.stage,
    },
    Type: "AWS::ApiGatewayV2::Stage",
  };
  templateResources.Permission = {
    Properties: {
      Action: "lambda:InvokeFunction",
      FunctionName: { Ref: "Function" },
      Principal: "apigateway.amazonaws.com",
      SourceArn: {
        "Fn::Sub": `arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${Api}/*/*`,
      },
    },
    Type: "AWS::Lambda::Permission",
  };
  outputs.ApiUrl = {
    Description: "HTTP API URL",
    Value: {
      "Fn::Sub": `https://\${Api}.execute-api.\${AWS::Region}.amazonaws.com/${config.stage}`,
    },
  };
  outputs.FunctionName = {
    Description: "Lambda function name",
    Value: { Ref: "Function" },
  };

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Voke stack for ${config.name} (${config.stage})`,
    Outputs: outputs,
    Resources: templateResources,
  };
};
