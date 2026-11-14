import { createVokeModel, VokeModelError } from "voke";
import type {
  VokeConfigInput,
  VokeCorsConfig,
  VokeModel,
  VokeModelInput,
  VokeModelHttpAuthorizer,
  VokeModelResource,
} from "voke";

import {
  defaultAwsLambdaSettings,
  derivedVisibilityTimeout,
  explicitVisibilityTimeout,
  resolveFunctionLambdaSettings,
} from "./lambda-settings";
import type { AwsLambdaSettings } from "./lambda-settings";

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
  provider: {
    aws: {
      properties: {
        bindingValue: "ref" | "getAttArn" | "getAttId";
        cloudFormationType: string;
        outputName: string;
        policyResource:
          | "ref"
          | "getAttArn"
          | "getAttId"
          | "parameterArn"
          | "s3ArnWithObjects";
      };
      type: "cloudformation.resource";
    };
  };
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

type VokeModelSqsEventSource = Extract<
  VokeModel["functions"][string]["eventSources"][number],
  { type: "sqs" }
>;

const awsCloudFormationResource = (definition: {
  actions: string[];
  bindingAttribute: string;
  bindingValue: AwsResourceBindingValue;
  cloudFormationType: string;
  outputName: string;
  policyResource: AwsResourcePolicyResource;
  properties: Record<string, CloudFormationValue>;
}): StackResourceDefinition => ({
  ...definition,
  provider: {
    aws: {
      properties: {
        bindingValue: definition.bindingValue,
        cloudFormationType: definition.cloudFormationType,
        outputName: definition.outputName,
        policyResource: definition.policyResource,
      },
      type: "cloudformation.resource",
    },
  },
});

export type SynthesizeCloudFormationOptions = VokeConfigInput & {
  /** The Function Registry discovered from the project entrypoint. */
  functions?: VokeModelInput["functions"];
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

  return awsCloudFormationResource({
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
  });
};

export interface SqsQueueOptions {
  /**
   * How long a received message stays hidden from other consumers, in seconds. When unset, Voke
   * derives it from the Functions that consume the queue (six times the timeout plus the batching
   * window), as AWS recommends.
   */
  visibilityTimeoutSeconds?: number;
}

export const sqsQueue = (
  options: SqsQueueOptions = {}
): StackResourceDefinition =>
  awsCloudFormationResource({
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
    properties:
      options.visibilityTimeoutSeconds === undefined
        ? {}
        : { VisibilityTimeout: options.visibilityTimeoutSeconds },
  });

export const snsTopic = (): StackResourceDefinition =>
  awsCloudFormationResource({
    actions: ["sns:Publish"],
    bindingAttribute: "arn",
    bindingValue: "ref",
    cloudFormationType: "AWS::SNS::Topic",
    outputName: "Arn",
    policyResource: "ref",
    properties: {},
  });

export const eventBus = (): StackResourceDefinition =>
  awsCloudFormationResource({
    actions: ["events:PutEvents"],
    bindingAttribute: "name",
    bindingValue: "ref",
    cloudFormationType: "AWS::Events::EventBus",
    outputName: "Name",
    policyResource: "getAttArn",
    properties: {},
  });

export const s3Bucket = (): StackResourceDefinition =>
  awsCloudFormationResource({
    actions: [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ],
    bindingAttribute: "name",
    bindingValue: "ref",
    cloudFormationType: "AWS::S3::Bucket",
    outputName: "Name",
    policyResource: "s3ArnWithObjects",
    properties: {},
  });

export const secret = (): StackResourceDefinition =>
  awsCloudFormationResource({
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
}): StackResourceDefinition =>
  awsCloudFormationResource({
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

const secretArn = (secretId: string): CloudFormationValue => {
  if (secretId.startsWith("arn:")) {
    return secretId;
  }

  return {
    "Fn::Sub": [
      `arn:aws:secretsmanager:\${AWS::Region}:\${AWS::AccountId}:secret:${secretId}-*`,
      {},
    ],
  };
};

const parameterArn = (name: string): CloudFormationValue => ({
  "Fn::Sub": [
    `arn:aws:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter/${name.replace(/^\/+/u, "")}`,
    {},
  ],
});

const toRuntimeVariablePolicyStatements = (
  variables: VokeModel["functions"][string]["variables"],
  resources: VokeModel["resources"]
): CloudFormationValue[] => {
  const statements: CloudFormationValue[] = [];

  for (const variable of Object.values(variables)) {
    if (variable.provider !== "aws") {
      continue;
    }

    const { source } = variable;

    if (source.kind === "secretsManagerSecret") {
      statements.push({
        Action: ["secretsmanager:GetSecretValue"],
        Effect: "Allow",
        Resource: secretArn(String(source.secretId)),
      });
      continue;
    }

    if (source.kind === "ssmParameter") {
      statements.push({
        Action: ["ssm:GetParameter", "ssm:GetParameters"],
        Effect: "Allow",
        Resource: parameterArn(String(source.name)),
      });
      continue;
    }

    if (
      source.kind !== "secretsManagerSecretResource" &&
      source.kind !== "ssmParameterResource"
    ) {
      continue;
    }

    const resourceKey = String(source.resource);
    const resource = resources[resourceKey];

    if (resource === undefined) {
      throw new Error(
        `Missing resource model for Runtime Variable: ${resourceKey}`
      );
    }

    statements.push(
      ...toResourcePolicyStatements(
        toLogicalId(resourceKey),
        resource,
        resourceProvider(resource)
      )
    );
  }

  return statements;
};

const functionRoleLogicalId = (
  functionName: string,
  apiFunctionName: string
): string =>
  functionName === apiFunctionName
    ? "FunctionRole"
    : `${toLogicalId(functionName)}FunctionRole`;

const functionRoleResource = (
  statements: CloudFormationValue[]
): CloudFormationResource => {
  const properties: Record<string, CloudFormationValue> = {
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

  if (statements.length > 0) {
    properties.Policies = [
      {
        PolicyDocument: {
          Statement: statements,
          Version: "2012-10-17",
        },
        PolicyName: "VokeResourceAccess",
      },
    ];
  }

  return {
    Properties: properties,
    Type: "AWS::IAM::Role",
  };
};

const primaryFunctionName = "http";

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

const routeParamPattern = /^:([A-Za-z_][A-Za-z0-9_]*)$/u;

/**
 * Converts a Route Builder route ("GET /users/:id") to an API Gateway HTTP API route key
 * ("GET /users/{id}"). A trailing "*" becomes "{proxy+}". Forms API Gateway cannot express
 * (optional or regex-constrained params, a wildcard before the end) fail synthesis.
 */
export const toApiGatewayRouteKey = (route: string): string => {
  const [method = "", path = ""] = route.split(" ");

  if (method === "$default") {
    return route;
  }

  const segments = path.split("/");
  const converted = segments.map((segment, index) => {
    if (segment === "*") {
      if (index !== segments.length - 1) {
        throw VokeModelError.validation([
          {
            message: `Route "${route}" has a "*" before the last path segment, which API Gateway HTTP APIs cannot route. Use a trailing "*" only.`,
            path: "apis.http.routes",
          },
        ]);
      }

      return "{proxy+}";
    }

    if (!segment.startsWith(":")) {
      return segment;
    }

    const param = routeParamPattern.exec(segment)?.[1];

    if (param === undefined) {
      throw VokeModelError.validation([
        {
          message: `Route "${route}" uses the path parameter "${segment}", which has no API Gateway equivalent. Use a plain ":name" parameter.`,
          path: "apis.http.routes",
        },
      ]);
    }

    return `{${param}}`;
  });

  return `${method} ${converted.join("/")}`;
};

/** "GET /users/{id}" -> "GetUsersById"; independent of route order. */
const routeKeyLogicalName = (routeKey: string): string =>
  toLogicalId(
    routeKey
      .replaceAll("{proxy+}", "proxy")
      .replaceAll(/\{([^}]+)\}/gu, "by-$1")
  );

const toHttpRouteResource = (options: {
  apiRoute: VokeModel["apis"][string]["routes"][number];
  authorizer?: VokeModelHttpAuthorizer;
  integrationLogicalId: string;
}): CloudFormationResource => {
  const { apiRoute, authorizer, integrationLogicalId } = options;
  const routeProperties: Record<string, CloudFormationValue> = {
    ApiId: { Ref: "Api" },
    RouteKey: toApiGatewayRouteKey(apiRoute.route),
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
  functionName: string
): CloudFormationResource => ({
  Properties: {
    ApiId: { Ref: "Api" },
    IntegrationType: "AWS_PROXY",
    IntegrationUri: {
      "Fn::GetAtt": [functionLogicalId(functionName, apiFunctionName), "Arn"],
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

const toCorsConfiguration = (cors: VokeCorsConfig): CloudFormationValue => ({
  AllowCredentials: cors.credentials,
  AllowHeaders: cors.headers,
  AllowMethods: cors.methods,
  AllowOrigins: cors.origins,
  ...(cors.maxAgeSeconds === undefined ? {} : { MaxAge: cors.maxAgeSeconds }),
});

const addHttpApiResources = (options: {
  apiFunctionName: string;
  apiRoutes: VokeModel["apis"][string]["routes"];
  model: VokeModel;
  templateResources: Record<string, CloudFormationResource>;
}): void => {
  const { apiFunctionName, apiRoutes, model, templateResources } = options;

  const cors = model.apis.http?.cors;

  templateResources.Api = {
    Properties: {
      ...(cors === undefined
        ? {}
        : { CorsConfiguration: toCorsConfiguration(cors) }),
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

  const routeOwners = new Map<string, string>();

  for (const apiRoute of apiRoutes) {
    // Ids derive from the Function and the route itself, so reordering routes or Functions in
    // code never renames (and so never replaces) a deployed resource.
    const integrationLogicalId = `${toLogicalId(apiRoute.function)}Integration`;
    const routeLogicalId = `${toLogicalId(apiRoute.function)}${routeKeyLogicalName(toApiGatewayRouteKey(apiRoute.route))}Route`;
    const owner = routeOwners.get(routeLogicalId);

    if (owner !== undefined) {
      throw VokeModelError.validation([
        {
          message: `Routes "${owner}" and "${apiRoute.route}" of Function "${apiRoute.function}" map to the same CloudFormation logical id "${routeLogicalId}". Rename one of the paths.`,
          path: `functions.${apiRoute.function}.routes`,
        },
      ]);
    }

    routeOwners.set(routeLogicalId, apiRoute.route);
    templateResources[integrationLogicalId] ??= toHttpIntegrationResource(
      apiFunctionName,
      apiRoute.function
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
      // One stack per Voke stage already isolates environments. The $default stage keeps the
      // stage name out of the URL and out of rawPath, so Gateway routes match as declared.
      StageName: "$default",
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
      "Fn::Sub": `https://\${Api}.execute-api.\${AWS::Region}.amazonaws.com`,
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

const withDerivedVisibilityTimeout = (
  model: VokeModel,
  name: string,
  resource: VokeModelResource
): VokeModelResource["properties"] => {
  const isQueue =
    resource.provider?.aws?.properties.cloudFormationType === "AWS::SQS::Queue";
  const derived = isQueue ? derivedVisibilityTimeout(model, name) : undefined;

  return derived === undefined ||
    explicitVisibilityTimeout(model, name) !== undefined
    ? resource.properties
    : { ...resource.properties, VisibilityTimeout: derived };
};

export interface SynthesisArtifact {
  bucket: string;
  key: string;
}

export interface SynthesisOptions {
  /** The uploaded deployment bundle; without it each Function gets a 501 placeholder. */
  artifact?: SynthesisArtifact;
  /** `aws({ lambda })` settings. Defaults to `defaultAwsLambdaSettings`. */
  lambda?: AwsLambdaSettings;
}

export const synthesizeCloudFormationFromModel = (
  model: VokeModel,
  options: SynthesisOptions = {}
): CloudFormationTemplate => {
  const apiRoutes = model.apis.http?.routes ?? [];
  const lambdaSettings = options.lambda ?? defaultAwsLambdaSettings;
  // The Function keyed "http" owns the bare Function/FunctionRole/Permission logical ids; every
  // other Function is prefixed with its key. Keyed by name, not by route order, so ids are stable.
  const apiFunctionName = primaryFunctionName;
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
      Properties: withDerivedVisibilityTimeout(model, name, resource),
      Type: provider.cloudFormationType,
    };
    policyStatements.push(
      ...toResourcePolicyStatements(logicalId, resource, provider)
    );
  }

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
    const roleLogicalId = functionRoleLogicalId(name, apiFunctionName);
    const logGroupLogicalId = `${logicalId}LogGroup`;
    const lambda = resolveFunctionLambdaSettings(definition, lambdaSettings);
    templateResources[roleLogicalId] = functionRoleResource([
      ...policyStatements,
      ...toRuntimeVariablePolicyStatements(
        definition.variables,
        model.resources
      ),
    ]);
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
        VokeRoutes: definition.routes.map(toApiGatewayRouteKey),
      },
      Properties: {
        Architectures: [lambda.architecture],
        Code:
          options.artifact === undefined
            ? {
                // Inline code runs as CommonJS index.js, so the placeholder uses exports.
                ZipFile:
                  'exports.handler = async () => ({ statusCode: 501, body: "Build and upload this Voke function before deploying." });',
              }
            : {
                S3Bucket: options.artifact.bucket,
                S3Key: options.artifact.key,
              },
        Environment: {
          Variables: environmentVariables,
        },
        FunctionName: definition.deployedName,
        Handler: definition.handler,
        LoggingConfig: { LogGroup: { Ref: logGroupLogicalId } },
        MemorySize: definition.memory,
        Role: { "Fn::GetAtt": [roleLogicalId, "Arn"] },
        Runtime: lambda.runtime,
        Timeout: definition.timeout,
      },
      Type: "AWS::Lambda::Function",
    };
    // An explicit log group gives the logs a retention period and removes them with the stack.
    templateResources[logGroupLogicalId] = {
      Properties: {
        LogGroupName: `/aws/lambda/${definition.deployedName}`,
        RetentionInDays: lambdaSettings.logRetentionDays,
      },
      Type: "AWS::Logs::LogGroup",
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
  synthesizeCloudFormationFromModel(createVokeModel(options));
