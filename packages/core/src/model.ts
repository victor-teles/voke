import type {
  HttpAuthorizerDefinition,
  LambdaAuthorizerTarget,
} from "./authorizers";
import { createResourceBindingDefinition } from "./bindings";
import { createHandlerNameFromEntrypoint, defineConfig } from "./config";
import type { VokeConfig, VokeConfigInput, VokeCorsConfig } from "./config";
import { VokeConfigError, VokeModelError } from "./errors";
import type { VokeIssue } from "./errors";
import {
  assertUniqueHandlerExportNames,
  createHandlerExportName,
} from "./handler-names";
import type {
  AnyFunctionDefinition,
  FunctionRegistry,
  FunctionRegistryInput,
  FunctionSynthesisConfig,
} from "./invoke";
import { positiveIntegerIssue } from "./numbers";
import { projectFunctionEntries } from "./plugin";
import type { VokePlugin } from "./plugin";
import type { RuntimeVariableCatalog } from "./variables";

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
  /** Plugin Provider Extension Records, keyed by Plugin name. Absent when no Plugin has one. */
  plugins?: Record<string, VokeModelPlugin>;
}

export interface VokeModelPlugin {
  /** The Plugin's `contributions.provider`, copied untouched; each Provider reads its own key. */
  provider: Record<string, VokeModelProviderExtensionRecord>;
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
}

export interface VokeModelApi {
  authorizers?: Record<string, VokeModelHttpAuthorizer>;
  cors?: VokeCorsConfig;
  name: string;
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
  /**
   * The Function's Resource Links: the resource keys it declared in `resources`, in declaration
   * order, without duplicates. Its role gets each linked resource's access.
   */
  links: string[];
  /** Memory in MB: the Function's `synthesis.memory`, else `runtime.memory`. */
  memory: number;
  /** Provider Extension Records from `synthesis.provider`, copied untouched. */
  provider?: Record<string, VokeModelProviderExtensionRecord>;
  routes: string[];
  /** Maximum run time in seconds: the Function's `synthesis.timeout`, else `runtime.timeout`. */
  timeout: number;
  variables: RuntimeVariableCatalog;
  environment: Record<string, string>;
  /**
   * The resource bindings this Function's environment holds: one per Resource Link, then one per
   * resource a Runtime Variable reads (`fromResource`), without duplicates.
   */
  bindings: VokeModelBinding[];
}

/** One Event Source of a Function. The Provider that authored the source validates and synthesizes it. */
export interface VokeModelEventSource {
  type: string;
  /** The Voke resource key the source reads from, when it has one. */
  resource?: string;
  properties: VokeModelRecord;
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
    ? `index.${createHandlerExportName(name)}`
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

const runtimeVariableResourceKind = (
  source: Record<string, unknown>
): string | undefined => {
  if (source.kind === "secretsManagerSecretResource") {
    return "AWS::SecretsManager::Secret";
  }

  if (source.kind === "ssmParameterResource") {
    return "AWS::SSM::Parameter";
  }

  return undefined;
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
  resource: VokeConfig["resources"][string]
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

const assertFunctionSynthesis = (
  name: string,
  synthesis: FunctionSynthesisConfig | undefined
): void => {
  if (synthesis === undefined) {
    return;
  }

  const path = `functions.${name}.synthesis`;
  const issues: VokeIssue[] = [];

  if ("runtime" in synthesis) {
    issues.push({
      message: '"synthesis.runtime" moved; use synthesis.provider.aws',
      path: `${path}.runtime`,
    });
  }

  for (const [field, unit] of [
    ["memory", "MB"],
    ["timeout", "seconds"],
  ] as const) {
    const issue =
      synthesis[field] === undefined
        ? undefined
        : positiveIntegerIssue(synthesis[field], `${path}.${field}`, unit);

    if (issue !== undefined) {
      issues.push(issue);
    }
  }

  if (issues.length > 0) {
    throw VokeConfigError.validation(issues);
  }
};

const missingEventSourceResourceMessage = (
  source: string,
  resource: string
): string =>
  `"${source}" Event Source references resource "${resource}", but no matching resource is defined.`;

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
      if (
        eventSource.resource !== undefined &&
        model.resources[eventSource.resource] === undefined
      ) {
        issues.push({
          message: missingEventSourceResourceMessage(
            eventSource.type,
            eventSource.resource
          ),
          path: `functions.${functionName}.eventSources.${eventSourceIndex}.resource`,
        });
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

/** The resource keys a Function's resource-backed Runtime Variables (`fromResource`) read. */
const runtimeVariableResourceKeys = (
  definition: AnyFunctionDefinition
): string[] =>
  Object.values(definition.variables ?? {}).flatMap((variable) =>
    runtimeVariableResourceKind(variable.source) !== undefined &&
    typeof variable.source.resource === "string"
      ? [variable.source.resource]
      : []
  );

const missingResourceLinkMessage = (
  functionName: string,
  resource: string
): string =>
  `Function "${functionName}" links resource "${resource}", but no matching resource is defined.`;

/** The Function's Resource Links without duplicates; an unknown or malformed key is a config error. */
const toResourceLinks = (
  functionName: string,
  definition: AnyFunctionDefinition,
  resources: Record<string, VokeModelResource>
): string[] => {
  const links: string[] = [];
  const issues: VokeIssue[] = [];

  for (const [index, resource] of (
    (definition.resources ?? []) as readonly unknown[]
  ).entries()) {
    const path = `functions.${functionName}.resources.${index}`;

    if (typeof resource !== "string" || resource.trim() === "") {
      issues.push({
        message: `expected a resource key; received ${JSON.stringify(resource)}`,
        path,
      });
      continue;
    }

    if (resources[resource] === undefined) {
      issues.push({
        message: missingResourceLinkMessage(functionName, resource),
        path,
      });
      continue;
    }

    if (!links.includes(resource)) {
      links.push(resource);
    }
  }

  if (issues.length > 0) {
    throw VokeConfigError.validation(issues);
  }

  return links;
};

const toFunctionBindings = (
  links: readonly string[],
  definition: AnyFunctionDefinition,
  resources: Record<string, VokeModelResource>
): VokeModelBinding[] =>
  [...new Set([...links, ...runtimeVariableResourceKeys(definition)])].flatMap(
    (resource) => {
      const modelResource = resources[resource];

      return modelResource === undefined
        ? []
        : [
            {
              attribute: modelResource.binding.attribute,
              env: modelResource.binding.env,
              resource,
            },
          ];
    }
  );

const validateRuntimeVariableResources = (
  functionName: string,
  definition: AnyFunctionDefinition,
  resources: Record<string, VokeModelResource>
): void => {
  const variableIssues: VokeIssue[] = [];

  for (const [variableKey, variable] of Object.entries(
    definition.variables ?? {}
  )) {
    const expectedKind = runtimeVariableResourceKind(variable.source);

    if (expectedKind === undefined) {
      continue;
    }

    const resourceKey = variable.source.resource;

    if (typeof resourceKey !== "string") {
      continue;
    }

    const resource = resources[resourceKey];

    if (resource === undefined) {
      variableIssues.push({
        message: `Runtime Variable "${variableKey}" references resource "${resourceKey}", but no matching resource is defined.`,
        path: `functions.${functionName}.variables.${variableKey}`,
      });
      continue;
    }

    const cloudFormationType =
      resource.provider?.aws?.properties.cloudFormationType;

    if (cloudFormationType !== expectedKind) {
      variableIssues.push({
        message: `Runtime Variable "${variableKey}" references resource "${resourceKey}", but it is a ${JSON.stringify(cloudFormationType)} resource instead of an "${expectedKind}".`,
        path: `functions.${functionName}.variables.${variableKey}`,
      });
    }
  }

  if (variableIssues.length > 0) {
    throw VokeConfigError.validation(variableIssues);
  }
};

const toModelPlugins = (
  plugins: readonly VokePlugin[]
): Record<string, VokeModelPlugin> | undefined => {
  const entries = plugins.flatMap((plugin) =>
    plugin.contributions?.provider === undefined
      ? []
      : [[plugin.name, { provider: { ...plugin.contributions.provider } }]]
  );

  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

export type VokeModelInput = (VokeConfig | VokeConfigInput) & {
  /** The Function Registry discovered from the project entrypoint. */
  readonly functions?: FunctionRegistry | FunctionRegistryInput;
};

export const createInternalModel = (input: VokeModelInput): VokeModel => {
  const { functions: registry = {}, ...configInput } = input;
  const config = defineConfig(configInput as VokeConfigInput);
  const resources = Object.fromEntries(
    Object.entries(config.resources).map(([name, resource]) => [
      name,
      toModelResource(name, resource),
    ])
  );
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
  const registryEntries = projectFunctionEntries(registry, config);
  assertUniqueHandlerExportNames(registryEntries.map(([name]) => name));
  const generatedFunctionName = (name: string): string =>
    `${config.name}-${config.stage}-${name}`;
  const toModelFunction = (
    name: string,
    definition: AnyFunctionDefinition
  ): VokeModelFunction => {
    const eventSources: VokeModelEventSource[] = [];
    const eventSourceIssues: VokeIssue[] = [];

    for (const [eventSourceIndex, eventSource] of (
      definition.events ?? []
    ).entries()) {
      if (
        eventSource.resource !== undefined &&
        resources[eventSource.resource] === undefined
      ) {
        eventSourceIssues.push({
          message: missingEventSourceResourceMessage(
            eventSource.source,
            eventSource.resource
          ),
          path: `functions.${name}.events.${eventSourceIndex}.resource`,
        });
        continue;
      }

      eventSources.push({
        properties: { ...eventSource.properties },
        ...(eventSource.resource === undefined
          ? {}
          : { resource: eventSource.resource }),
        type: eventSource.source,
      });
    }

    if (eventSourceIssues.length > 0) {
      throw VokeConfigError.validation(eventSourceIssues);
    }

    const links = toResourceLinks(name, definition, resources);
    validateRuntimeVariableResources(name, definition, resources);
    assertFunctionSynthesis(name, definition.synthesis);

    const provider = definition.synthesis?.provider;

    return {
      bindings: toFunctionBindings(links, definition, resources),
      deployedName: definition.name ?? generatedFunctionName(name),
      entrypoint: definition.synthesis?.entrypoint ?? config.entrypoint,
      environment: {
        ...config.environment,
        ...definition.synthesis?.environment,
      },
      eventSources,
      handler: toFunctionHandler(name, definition),
      invokable: definition.kind === "invokable",
      links,
      memory: definition.synthesis?.memory ?? config.runtime.memory,
      ...(provider === undefined ? {} : { provider: { ...provider } }),
      routes: definition.routes?.map(toRouteKey) ?? [],
      timeout: definition.synthesis?.timeout ?? config.runtime.timeout,
      variables: definition.variables ?? {},
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
  const modelFunctions: Record<string, VokeModelFunction> = functions;
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
  const hasHttpApi = apiRoutes.length > 0;
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

  const plugins = toModelPlugins(config.plugins);
  const model: VokeModel = {
    apis: hasHttpApi
      ? {
          http: {
            ...(hasApiAuthorizers ? { authorizers: apiAuthorizers } : {}),
            ...(config.api.cors === undefined ? {} : { cors: config.api.cors }),
            name: config.api.name,
            routes: apiRoutes,
          },
        }
      : {},
    build: {
      entrypoint: config.entrypoint,
      entrypoints: config.build.entrypoints,
      outdir: config.build.outdir,
    },
    functions: modelFunctions,
    outputs: {
      ...apiOutputs,
      ...functionOutputs,
      ...resourceOutputs,
    },
    ...(plugins === undefined ? {} : { plugins }),
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
