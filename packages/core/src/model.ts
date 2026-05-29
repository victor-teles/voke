import type {
  HttpAuthorizerDefinition,
  LambdaAuthorizerTarget,
} from "./authorizers";
import { createResourceBindingDefinition } from "./bindings";
import { createHandlerNameFromEntrypoint, defineConfig } from "./config";
import type { VokeConfig, VokeConfigInput, VokeNodeRuntime } from "./config";
import { VokeConfigError, VokeModelError } from "./errors";
import type { VokeIssue } from "./errors";
import type { AnyFunctionDefinition } from "./invoke";

export type VokeModelScalar = string | number | boolean | null;

export type VokeModelValue =
  | VokeModelScalar
  | VokeModelValue[]
  | { [key: string]: VokeModelValue };

export type VokeModelRecord = Record<string, VokeModelValue>;

export type VokeResourceKind = "resource";

export interface VokeModel {
  schemaVersion: "1";
  service: VokeModelService;
  build: VokeModelBuild;
  apis: Record<string, VokeModelApi>;
  functions: Record<string, VokeModelFunction>;
  resources: Record<string, VokeModelResource>;
  outputs: Record<string, VokeModelOutput>;
  local: VokeModelLocal;
}

export interface VokeModelService {
  name: string;
  stage: string;
  region: string;
}

export interface VokeModelBuild {
  entrypoints: string[];
  entrypoint: string;
  outdir: string;
  target: "bun";
}

export interface VokeModelApi {
  authorizers?: Record<string, VokeModelHttpAuthorizer>;
  name: string;
  protocol: "http";
  routes: VokeModelApiRoute[];
}

export interface VokeModelApiRoute {
  authorizer?: string;
  function: string;
  route: string;
}

export type VokeModelHttpAuthorizer =
  | VokeModelJwtAuthorizer
  | VokeModelLambdaAuthorizer;

export interface VokeModelJwtAuthorizer {
  audience: readonly string[];
  identitySource: readonly string[];
  issuer: string;
  type: "jwt";
}

export interface VokeModelLambdaAuthorizer {
  cacheTtlSeconds: number;
  function: LambdaAuthorizerTarget;
  identitySource: readonly string[];
  type: "lambda";
}

export interface VokeModelFunction {
  deployedName: string;
  entrypoint: string;
  eventSources: VokeModelEventSource[];
  handler: string;
  invokable: boolean;
  runtime: VokeNodeRuntime;
  routes: string[];
  environment: Record<string, string>;
  bindings: VokeModelBinding[];
}

export type VokeModelEventSource = VokeModelSqsEventSource;

export interface VokeModelSqsEventSource {
  type: "sqs";
  queue: string;
  batchSize?: number;
  maxBatchingWindowSeconds?: number;
  enabled?: boolean;
}

export interface VokeModelBinding {
  resource: string;
  attribute: string;
  env: string;
}

export interface VokeModelResource {
  kind: VokeResourceKind;
  properties: VokeModelRecord;
  binding: VokeModelResourceBinding;
  access: VokeModelResourceAccess;
  provider?: Record<string, VokeModelProviderExtensionRecord>;
}

export interface VokeModelResourceBinding {
  attribute: string;
  env: string;
}

export interface VokeModelResourceAccess {
  level: "read" | "readWrite";
  actions: string[];
}

export interface VokeModelProviderExtensionRecord {
  type: string;
  properties: VokeModelRecord;
}

export interface VokeModelOutput {
  description: string;
  source:
    | {
        api: string;
        attribute: "url";
      }
    | {
        function: string;
        attribute: "name";
      }
    | {
        resource: string;
        attribute: string;
      };
}

export interface VokeModelLocal {
  provider: VokeModelLocalProvider;
}

export interface VokeModelLocalProvider {
  adapter: string;
  optional: boolean;
}

const toOutputKey = (name: string, attribute: string): string =>
  `${name}${attribute[0]?.toUpperCase() ?? ""}${attribute.slice(1)}`;

const toReadLevel = (actions: string[]): VokeModelResourceAccess["level"] =>
  actions.some((action) => {
    const operation = action.split(":").at(1) ?? "";

    return /^(Put|Update|Delete|Send|Publish|Create|Write)/u.test(operation);
  })
    ? "readWrite"
    : "read";

const toFunctionHandler = (
  name: string,
  definition: AnyFunctionDefinition
): string =>
  definition.synthesis?.handler ??
  (definition.synthesis?.entrypoint === undefined
    ? `${name}.handler`
    : createHandlerNameFromEntrypoint(definition.synthesis.entrypoint));

const toRouteKey = (
  route: NonNullable<AnyFunctionDefinition["routes"]>[number]
): string => `${route.method} ${route.path}`;

const toRouteAuthorizer = (
  route: NonNullable<AnyFunctionDefinition["routes"]>[number],
  definition: AnyFunctionDefinition
): string | undefined => {
  const authorizer = route.authorizer ?? definition.authorizer;

  return authorizer === "none" ? undefined : authorizer;
};

const toModelAuthorizer = (
  authorizer: HttpAuthorizerDefinition
): VokeModelHttpAuthorizer => {
  if (authorizer.kind === "lambda") {
    return {
      cacheTtlSeconds: authorizer.cacheTtlSeconds,
      function: authorizer.function,
      identitySource: [...authorizer.identitySource],
      type: "lambda",
    };
  }

  return {
    audience: [...authorizer.audience],
    identitySource: [...authorizer.identitySource],
    issuer: authorizer.issuer,
    type: "jwt",
  };
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const collectHttpAuthorizers = (
  registryEntries: readonly [string, AnyFunctionDefinition][]
): Record<string, VokeModelHttpAuthorizer> => {
  const authorizers: Record<string, VokeModelHttpAuthorizer> = {};

  for (const [, definition] of registryEntries) {
    for (const [name, authorizer] of Object.entries(
      definition.authorizers ?? {}
    )) {
      const modelAuthorizer = toModelAuthorizer(authorizer);
      const existing = authorizers[name];

      if (
        existing !== undefined &&
        stableStringify(existing) !== stableStringify(modelAuthorizer)
      ) {
        throw new VokeConfigError(
          `HTTP Authorizer "${name}" has conflicting definitions`
        );
      }

      authorizers[name] = modelAuthorizer;
    }
  }

  return authorizers;
};

const assertHttpAuthorizerReference = (
  authorizer: string | undefined,
  availableAuthorizers: Record<string, unknown>,
  route: string
): void => {
  if (
    authorizer === undefined ||
    availableAuthorizers[authorizer] !== undefined
  ) {
    return;
  }

  throw new VokeConfigError(
    `Route ${route} references unknown HTTP Authorizer "${authorizer}"`
  );
};

const toModelResource = (
  name: string,
  resource: VokeConfig["cloudFormation"]["resources"][string]
): VokeModelResource => {
  const binding = createResourceBindingDefinition({
    attribute: resource.bindingAttribute,
    resource: name,
  });
  const modelResource: VokeModelResource = {
    access: {
      actions: [...resource.actions],
      level: toReadLevel(resource.actions),
    },
    binding: {
      attribute: binding.attribute,
      env: binding.env,
    },
    kind: "resource",
    properties: resource.properties,
    provider: resource.provider ?? {
      aws: {
        properties: {
          bindingValue: resource.bindingValue,
          cloudFormationType: resource.cloudFormationType,
          outputName: resource.outputName,
          policyResource: resource.policyResource,
        },
        type: "cloudformation.resource",
      },
    },
  };

  return modelResource;
};

const validateModel = (model: VokeModel): void => {
  const issues: VokeIssue[] = [];

  for (const [apiName, api] of Object.entries(model.apis)) {
    for (const [routeIndex, route] of api.routes.entries()) {
      if (model.functions[route.function] === undefined) {
        issues.push({
          message: `API "${apiName}" route "${route.route}" references function "${route.function}", but no matching function is defined.`,
          path: `apis.${apiName}.routes.${routeIndex}.function`,
        });
      }
    }
  }

  for (const [resourceName, resource] of Object.entries(model.resources)) {
    if (resource.binding.attribute.trim() === "") {
      issues.push({
        message: "resource binding attribute must be a non-empty string.",
        path: `resources.${resourceName}.binding.attribute`,
      });
    }

    if (resource.access.actions.length === 0) {
      issues.push({
        message: "resource access actions must include at least one action.",
        path: `resources.${resourceName}.access.actions`,
      });
    }
  }

  for (const [functionName, fn] of Object.entries(model.functions)) {
    for (const binding of fn.bindings) {
      if (model.resources[binding.resource] === undefined) {
        issues.push({
          message: `Function "${functionName}" references resource "${binding.resource}", but no matching resource is defined.`,
          path: `functions.${functionName}.bindings`,
        });
      }
    }

    for (const [eventSourceIndex, eventSource] of fn.eventSources.entries()) {
      if (eventSource.type !== "sqs") {
        continue;
      }

      const resource = model.resources[eventSource.queue];

      if (resource === undefined) {
        issues.push({
          message: `Function "${functionName}" SQS event source references resource "${eventSource.queue}", but no matching resource is defined.`,
          path: `functions.${functionName}.eventSources.${eventSourceIndex}.queue`,
        });
        continue;
      }
    }
  }

  for (const [outputName, output] of Object.entries(model.outputs)) {
    if ("function" in output.source) {
      const functionName = output.source.function;

      if (model.functions[functionName] === undefined) {
        issues.push({
          message: `Output "${outputName}" references function "${functionName}", but no matching function is defined.`,
          path: `outputs.${outputName}.source.function`,
        });
      }
    }

    if ("resource" in output.source) {
      const resourceName = output.source.resource;

      if (model.resources[resourceName] === undefined) {
        issues.push({
          message: `Output "${outputName}" references resource "${resourceName}", but no matching resource is defined.`,
          path: `outputs.${outputName}.source.resource`,
        });
      }
    }
  }

  if (issues.length > 0) {
    throw VokeModelError.validation(issues);
  }
};

export const createInternalModel = (
  input: VokeConfig | VokeConfigInput
): VokeModel => {
  const config = defineConfig(input);
  const resources = Object.fromEntries(
    Object.entries(config.cloudFormation.resources).map(([name, resource]) => [
      name,
      toModelResource(name, resource),
    ])
  );
  const bindings = Object.entries(resources).map(([resource, definition]) => ({
    attribute: definition.binding.attribute,
    env: definition.binding.env,
    resource,
  }));
  const resourceOutputs = Object.fromEntries(
    Object.entries(resources).map(([name, resource]) => [
      toOutputKey(name, resource.binding.attribute),
      {
        description: `${name} ${resource.binding.attribute}`,
        source: {
          attribute: resource.binding.attribute,
          resource: name,
        },
      },
    ])
  );
  const registryEntries = Object.entries(config.functions).filter(
    ([name]) => name !== "invoke" && name !== "route"
  ) as [string, AnyFunctionDefinition][];
  const hasRegistryFunctions = registryEntries.length > 0;
  const generatedFunctionName = (name: string): string =>
    name === config.api.function
      ? `${config.name}-${config.stage}`
      : `${config.name}-${config.stage}-${name}`;
  const toModelFunction = (
    name: string,
    definition: AnyFunctionDefinition
  ): VokeModelFunction => {
    const eventSources: VokeModelEventSource[] = [];
    const eventSourceIssues: VokeIssue[] = [];

    for (const [eventSourceIndex, eventSource] of (
      definition.events ?? []
    ).entries()) {
      if (eventSource.source !== "sqs") {
        continue;
      }

      const resource = resources[eventSource.queue];

      if (resource === undefined) {
        eventSourceIssues.push({
          message: `SQS event source references resource "${eventSource.queue}", but no matching resource is defined.`,
          path: `functions.${name}.events.${eventSourceIndex}.queue`,
        });
        continue;
      }

      eventSources.push({
        batchSize: eventSource.options.batchSize,
        enabled: eventSource.options.enabled,
        maxBatchingWindowSeconds: eventSource.options.maxBatchingWindowSeconds,
        queue: eventSource.queue,
        type: "sqs",
      });
    }

    if (eventSourceIssues.length > 0) {
      throw VokeConfigError.validation(eventSourceIssues);
    }

    return {
      bindings,
      deployedName: definition.name ?? generatedFunctionName(name),
      entrypoint: definition.synthesis?.entrypoint ?? config.entrypoint,
      environment: {
        ...config.cloudFormation.environment,
        ...definition.synthesis?.environment,
      },
      eventSources,
      handler: toFunctionHandler(name, definition),
      invokable: definition.kind === "invokable",
      routes: definition.routes?.map(toRouteKey) ?? [],
      runtime: definition.synthesis?.runtime ?? config.runtime.lambda,
    };
  };
  const functions = Object.fromEntries(
    registryEntries.map(([name, definition]) => [
      name,
      toModelFunction(name, definition),
    ])
  );
  const apiAuthorizers = collectHttpAuthorizers(registryEntries);
  const apiRoutes = registryEntries.flatMap(([name, definition]) =>
    (definition.routes ?? []).map((route) => {
      const authorizer = toRouteAuthorizer(route, definition);
      const routeKey = toRouteKey(route);

      assertHttpAuthorizerReference(
        authorizer,
        definition.authorizers ?? {},
        routeKey
      );

      return {
        ...(authorizer === undefined ? {} : { authorizer }),
        function: name,
        route: routeKey,
      };
    })
  );
  const legacyApiRoutes =
    apiRoutes.length === 0 && !hasRegistryFunctions
      ? config.api.routes.map((route) => ({
          function: config.api.function,
          route,
        }))
      : [];
  const modelFunctions: Record<string, VokeModelFunction> = {
    ...functions,
  };

  if (
    legacyApiRoutes.length > 0 &&
    modelFunctions[config.api.function] === undefined
  ) {
    modelFunctions[config.api.function] = {
      bindings,
      deployedName: generatedFunctionName(config.api.function),
      entrypoint: config.entrypoint,
      environment: config.cloudFormation.environment,
      eventSources: [],
      handler: config.cloudFormation.handler,
      invokable: false,
      routes: config.api.routes,
      runtime: config.runtime.lambda,
    };
  }
  const functionOutputs = Object.fromEntries(
    Object.keys(modelFunctions).map((name) => [
      `${name}FunctionName`,
      {
        description: `${name} Lambda function name`,
        source: {
          attribute: "name" as const,
          function: name,
        },
      },
    ])
  );
  const hasHttpApi = apiRoutes.length > 0 || legacyApiRoutes.length > 0;
  const hasApiAuthorizers = Object.keys(apiAuthorizers).length > 0;
  const apiOutputs: Record<string, VokeModelOutput> = hasHttpApi
    ? {
        apiUrl: {
          description: "HTTP API URL",
          source: {
            api: "http" as const,
            attribute: "url" as const,
          },
        },
      }
    : {};

  const model: VokeModel = {
    apis: hasHttpApi
      ? {
          http: {
            ...(hasApiAuthorizers ? { authorizers: apiAuthorizers } : {}),
            name: config.api.name,
            protocol: config.api.protocol,
            routes: apiRoutes.length > 0 ? apiRoutes : legacyApiRoutes,
          },
        }
      : {},
    build: {
      entrypoint: config.entrypoint,
      entrypoints: config.build.entrypoints,
      outdir: config.build.outdir,
      target: config.build.target,
    },
    functions: modelFunctions,
    local: {
      provider: {
        adapter: config.local.provider.name,
        optional: config.local.providerOptional,
      },
    },
    outputs: {
      ...apiOutputs,
      ...functionOutputs,
      ...resourceOutputs,
    },
    resources,
    schemaVersion: "1",
    service: {
      name: config.name,
      region: config.region,
      stage: config.stage,
    },
  };

  validateModel(model);
  config.provider?.validate?.(model);

  return model;
};
