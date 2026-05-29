import type { VokeConfigInput } from "./config";
import { VokeModelError } from "./errors";
import { createInternalModel } from "./model";
import type {
  VokeModel,
  VokeModelHttpAuthorizer,
  VokeModelResource,
  VokeModelSqsEventSource,
} from "./model";

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

type AwsResourceBindingValue = "ref" | "getAttArn" | "getAttId";

type AwsResourcePolicyResource =
  | "ref"
  | "getAttArn"
  | "getAttId"
  | "parameterArn"
  | "s3ArnWithObjects";

interface AwsCloudFormationResourceProvider {
  cloudFormationType: string;
  bindingValue: AwsResourceBindingValue;
  policyResource: AwsResourcePolicyResource;
  outputName: string;
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
    // Voke does not model per-operation table access yet, so these practical
    // defaults stay table-scoped instead of wildcarding all DynamoDB resources.
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
  bindingAttribute: "id",
  bindingValue: "getAttId",
  cloudFormationType: "AWS::SecretsManager::Secret",
  outputName: "Id",
  policyResource: "getAttArn",
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

const authorizerLogicalId = (name: string): string =>
  `${toLogicalId(name)}Authorizer`;

const resourceValue = (
  logicalId: string,
  bindingValue: AwsCloudFormationResourceProvider["bindingValue"]
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
  policyResource: AwsCloudFormationResourceProvider["policyResource"]
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

const toResourcePolicyStatements = (
  logicalId: string,
  resource: VokeModelResource,
  provider: AwsCloudFormationResourceProvider
): CloudFormationValue[] => {
  if (resource.access.actions.length === 0) {
    return [];
  }

  if (provider.policyResource !== "s3ArnWithObjects") {
    return [
      {
        Action: resource.access.actions,
        Effect: "Allow",
        Resource: resourceArn(logicalId, provider.policyResource),
      },
    ];
  }

  const bucketActions = resource.access.actions.filter(
    (action) => action === "s3:ListBucket"
  );
  const objectActions = resource.access.actions.filter(
    (action) => action !== "s3:ListBucket"
  );
  const statements: CloudFormationValue[] = [];

  if (bucketActions.length > 0) {
    statements.push({
      Action: bucketActions,
      Effect: "Allow",
      Resource: { "Fn::GetAtt": [logicalId, "Arn"] },
    });
  }

  if (objectActions.length > 0) {
    statements.push({
      Action: objectActions,
      Effect: "Allow",
      Resource: { "Fn::Sub": [`\${${logicalId}.Arn}/*`, {}] },
    });
  }

  return statements;
};

const resourceProvider = (
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

const functionLogicalId = (name: string, apiFunctionName: string): string =>
  name === apiFunctionName ? "Function" : `${toLogicalId(name)}Function`;

const eventSourceMappingLogicalId = (
  functionId: string,
  queueId: string
): string => `${functionId}${queueId}EventSourceMapping`;

const toSqsEventSourceMappingResource = (options: {
  eventSource: VokeModelSqsEventSource;
  eventSourceIndex: number;
  functionName: string;
  lambdaLogicalId: string;
  model: VokeModel;
}): [string, CloudFormationResource] => {
  const {
    eventSource,
    eventSourceIndex,
    functionName,
    lambdaLogicalId,
    model,
  } = options;
  const resource = model.resources[eventSource.queue];

  if (resource === undefined) {
    throw VokeModelError.validation([
      {
        message: `Function "${functionName}" SQS event source references resource "${eventSource.queue}", but no matching resource is defined.`,
        path: `functions.${functionName}.eventSources.${eventSourceIndex}.queue`,
      },
    ]);
  }

  const provider = resourceProvider(resource);

  if (provider.cloudFormationType !== "AWS::SQS::Queue") {
    throw VokeModelError.validation([
      {
        message: `Function "${functionName}" SQS event source references resource "${eventSource.queue}", but it is an ${JSON.stringify(provider.cloudFormationType)} resource instead of an "AWS::SQS::Queue".`,
        path: `functions.${functionName}.eventSources.${eventSourceIndex}.queue`,
      },
    ]);
  }

  const queueLogicalId = toLogicalId(eventSource.queue);

  return [
    eventSourceMappingLogicalId(lambdaLogicalId, queueLogicalId),
    {
      Properties: {
        BatchSize: eventSource.batchSize ?? 10,
        Enabled: eventSource.enabled ?? true,
        EventSourceArn: { "Fn::GetAtt": [queueLogicalId, "Arn"] },
        FunctionName: { Ref: lambdaLogicalId },
        FunctionResponseTypes: ["ReportBatchItemFailures"],
        MaximumBatchingWindowInSeconds:
          eventSource.maxBatchingWindowSeconds ?? 0,
      },
      Type: "AWS::Lambda::EventSourceMapping",
    },
  ];
};

const toAuthorizerFunctionArn = (
  authorizer: Extract<VokeModelHttpAuthorizer, { type: "lambda" }>,
  apiFunctionName: string
): string => {
  if (typeof authorizer.function === "string") {
    return `\${${functionLogicalId(authorizer.function, apiFunctionName)}.Arn}`;
  }

  if ("arn" in authorizer.function) {
    return authorizer.function.arn;
  }

  return `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${authorizer.function.deployedName}`;
};

const toHttpAuthorizerResource = (
  name: string,
  authorizer: VokeModelHttpAuthorizer,
  apiFunctionName: string
): CloudFormationResource => {
  if (authorizer.type === "lambda") {
    const authorizerFunctionArn = toAuthorizerFunctionArn(
      authorizer,
      apiFunctionName
    );

    return {
      Properties: {
        ApiId: { Ref: "Api" },
        AuthorizerPayloadFormatVersion: "2.0",
        AuthorizerResultTtlInSeconds: authorizer.cacheTtlSeconds,
        AuthorizerType: "REQUEST",
        AuthorizerUri: {
          "Fn::Sub": `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/${authorizerFunctionArn}/invocations`,
        },
        EnableSimpleResponses: true,
        IdentitySource: [...authorizer.identitySource],
        Name: name,
      },
      Type: "AWS::ApiGatewayV2::Authorizer",
    };
  }

  return {
    Properties: {
      ApiId: { Ref: "Api" },
      AuthorizerType: "JWT",
      IdentitySource: [...authorizer.identitySource],
      JwtConfiguration: {
        Audience: [...authorizer.audience],
        Issuer: authorizer.issuer,
      },
      Name: name,
    },
    Type: "AWS::ApiGatewayV2::Authorizer",
  };
};

const toHttpRouteResource = (options: {
  apiRoute: VokeModel["apis"][string]["routes"][number];
  authorizer?: VokeModelHttpAuthorizer;
  integrationLogicalId: string;
}): CloudFormationResource => {
  const { apiRoute, authorizer, integrationLogicalId } = options;
  const routeProperties: Record<string, CloudFormationValue> = {
    ApiId: { Ref: "Api" },
    RouteKey: apiRoute.route,
    Target: { "Fn::Sub": `integrations/\${${integrationLogicalId}}` },
  };

  if (apiRoute.authorizer !== undefined && authorizer !== undefined) {
    routeProperties.AuthorizationType =
      authorizer.type === "lambda" ? "CUSTOM" : "JWT";
    routeProperties.AuthorizerId = {
      Ref: authorizerLogicalId(apiRoute.authorizer),
    };
  }

  return {
    Properties: routeProperties,
    Type: "AWS::ApiGatewayV2::Route",
  };
};

const toHttpIntegrationResource = (
  apiFunctionName: string,
  apiRoute: VokeModel["apis"][string]["routes"][number]
): CloudFormationResource => ({
  Properties: {
    ApiId: { Ref: "Api" },
    IntegrationType: "AWS_PROXY",
    IntegrationUri: {
      "Fn::GetAtt": [
        functionLogicalId(apiRoute.function, apiFunctionName),
        "Arn",
      ],
    },
    PayloadFormatVersion: "2.0",
  },
  Type: "AWS::ApiGatewayV2::Integration",
});

const toApiGatewayPermissionResource = (
  functionName: string,
  apiFunctionName: string
): CloudFormationResource => ({
  Properties: {
    Action: "lambda:InvokeFunction",
    FunctionName: {
      Ref: functionLogicalId(functionName, apiFunctionName),
    },
    Principal: "apigateway.amazonaws.com",
    SourceArn: {
      "Fn::Sub": `arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${Api}/*/*`,
    },
  },
  Type: "AWS::Lambda::Permission",
});

const addHttpApiResources = (options: {
  apiFunctionName: string;
  apiRoutes: VokeModel["apis"][string]["routes"];
  model: VokeModel;
  templateResources: Record<string, CloudFormationResource>;
}): void => {
  const { apiFunctionName, apiRoutes, model, templateResources } = options;

  templateResources.Api = {
    Properties: {
      Name: `${model.service.name}-${model.service.stage}`,
      ProtocolType: "HTTP",
    },
    Type: "AWS::ApiGatewayV2::Api",
  };

  for (const [name, authorizer] of Object.entries(
    model.apis.http?.authorizers ?? {}
  )) {
    templateResources[authorizerLogicalId(name)] = toHttpAuthorizerResource(
      name,
      authorizer,
      apiFunctionName
    );

    if (
      authorizer.type === "lambda" &&
      typeof authorizer.function === "string" &&
      model.functions[authorizer.function] !== undefined
    ) {
      templateResources[`${authorizerLogicalId(name)}Permission`] =
        toApiGatewayPermissionResource(authorizer.function, apiFunctionName);
    }
  }

  for (const [index, apiRoute] of apiRoutes.entries()) {
    const suffix =
      index === 0 ? "" : toLogicalId(`${apiRoute.function}-${apiRoute.route}`);
    const integrationLogicalId = `${suffix}Integration`;
    const routeLogicalId = `${suffix}Route`;

    templateResources[integrationLogicalId] = toHttpIntegrationResource(
      apiFunctionName,
      apiRoute
    );
    templateResources[routeLogicalId] = toHttpRouteResource({
      apiRoute,
      authorizer:
        apiRoute.authorizer === undefined
          ? undefined
          : model.apis.http?.authorizers?.[apiRoute.authorizer],
      integrationLogicalId,
    });
  }

  templateResources.Stage = {
    Properties: {
      ApiId: { Ref: "Api" },
      AutoDeploy: true,
      StageName: model.service.stage,
    },
    Type: "AWS::ApiGatewayV2::Stage",
  };

  for (const functionName of new Set(
    apiRoutes.map((route) => route.function)
  )) {
    const suffix =
      functionName === apiFunctionName ? "" : toLogicalId(functionName);

    templateResources[`${suffix}Permission`] = toApiGatewayPermissionResource(
      functionName,
      apiFunctionName
    );
  }
};

const outputName = (
  model: VokeModel,
  key: string,
  output: VokeModel["outputs"][string],
  apiFunctionName: string
): string => {
  if ("api" in output.source) {
    return "ApiUrl";
  }

  if ("function" in output.source) {
    return `${functionLogicalId(output.source.function, apiFunctionName)}Name`;
  }

  const resource = model.resources[output.source.resource];

  if (resource === undefined) {
    throw new Error(`Missing resource model for output: ${key}`);
  }

  return `${toLogicalId(output.source.resource)}${resourceProvider(resource).outputName}`;
};

const outputValue = (
  model: VokeModel,
  key: string,
  output: VokeModel["outputs"][string],
  apiFunctionName: string
): CloudFormationValue => {
  if ("api" in output.source) {
    return {
      "Fn::Sub": `https://\${Api}.execute-api.\${AWS::Region}.amazonaws.com/${model.service.stage}`,
    };
  }

  if ("function" in output.source) {
    return { Ref: functionLogicalId(output.source.function, apiFunctionName) };
  }

  const resource = model.resources[output.source.resource];

  if (resource === undefined) {
    throw new Error(`Missing resource model for output: ${key}`);
  }

  return resourceValue(
    toLogicalId(output.source.resource),
    resourceProvider(resource).bindingValue
  );
};

export const synthesizeCloudFormationFromModel = (
  model: VokeModel
): CloudFormationTemplate => {
  const apiRoutes = model.apis.http?.routes ?? [];
  const apiFunctionName =
    apiRoutes[0]?.function ?? Object.keys(model.functions).at(0) ?? "api";
  const templateResources: Record<string, CloudFormationResource> = {};
  const outputs: Record<string, CloudFormationOutput> = {};
  const policyStatements: CloudFormationValue[] = [];

  for (const [name, resource] of Object.entries(model.resources)) {
    const logicalId = toLogicalId(name);
    const provider = resourceProvider(resource);

    templateResources[logicalId] = {
      Metadata: {
        VokeBinding: {
          Attribute: resource.binding.attribute,
          Resource: name,
        },
      },
      Properties: resource.properties,
      Type: provider.cloudFormationType,
    };
    policyStatements.push(
      ...toResourcePolicyStatements(logicalId, resource, provider)
    );
  }

  const functionRoleProperties: Record<string, CloudFormationValue> = {
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
  };

  if (policyStatements.length > 0) {
    functionRoleProperties.Policies = [
      {
        PolicyDocument: {
          Statement: policyStatements,
          Version: "2012-10-17",
        },
        PolicyName: "VokeResourceAccess",
      },
    ];
  }

  templateResources.FunctionRole = {
    Properties: functionRoleProperties,
    Type: "AWS::IAM::Role",
  };
  for (const [name, definition] of Object.entries(model.functions).toSorted(
    ([leftName], [rightName]) => {
      if (leftName === apiFunctionName) {
        return -1;
      }

      if (rightName === apiFunctionName) {
        return 1;
      }

      return leftName.localeCompare(rightName);
    }
  )) {
    const logicalId = functionLogicalId(name, apiFunctionName);
    const environmentVariables: Record<string, CloudFormationValue> = {
      ...definition.environment,
    };

    for (const binding of definition.bindings) {
      const resource = model.resources[binding.resource];

      if (resource === undefined) {
        throw new Error(
          `Missing resource model for binding: ${binding.resource}`
        );
      }

      environmentVariables[binding.env] = resourceValue(
        toLogicalId(binding.resource),
        resourceProvider(resource).bindingValue
      );
    }

    templateResources[logicalId] = {
      Metadata: {
        VokeDeployedName: definition.deployedName,
        VokeEntrypoint: definition.entrypoint,
        VokeFunction: name,
        VokeInvokable: definition.invokable,
        VokeRoutes: definition.routes,
      },
      Properties: {
        Code: {
          ZipFile:
            "export const handler = async () => ({ statusCode: 501, body: 'Build and upload this Voke function before deploying.' });",
        },
        Environment: {
          Variables: environmentVariables,
        },
        FunctionName: definition.deployedName,
        Handler: definition.handler,
        Role: { "Fn::GetAtt": ["FunctionRole", "Arn"] },
        Runtime: definition.runtime,
      },
      Type: "AWS::Lambda::Function",
    };

    for (const [
      eventSourceIndex,
      eventSource,
    ] of definition.eventSources.entries()) {
      if (eventSource.type !== "sqs") {
        continue;
      }

      const [mappingLogicalId, mappingResource] =
        toSqsEventSourceMappingResource({
          eventSource,
          eventSourceIndex,
          functionName: name,
          lambdaLogicalId: logicalId,
          model,
        });

      templateResources[mappingLogicalId] = mappingResource;
    }
  }
  if (apiRoutes.length > 0) {
    addHttpApiResources({
      apiFunctionName,
      apiRoutes,
      model,
      templateResources,
    });
  }
  for (const [key, output] of Object.entries(model.outputs)) {
    outputs[outputName(model, key, output, apiFunctionName)] = {
      Description: output.description,
      Value: outputValue(model, key, output, apiFunctionName),
    };
  }

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Voke stack for ${model.service.name} (${model.service.stage})`,
    Outputs: outputs,
    Resources: templateResources,
  };
};

export const synthesizeCloudFormation = (
  options: SynthesizeCloudFormationOptions
): CloudFormationTemplate =>
  synthesizeCloudFormationFromModel(createInternalModel(options));
