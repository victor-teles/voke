// Run-time module: the Plugin builds the document inside deployed Functions, so it must not use
// the `Bun` global or import file-system code.
import { readJsonSchema, VokeConfigError } from "voke";
import type {
  AnyFunctionDefinition,
  HttpAuthorizerDefinition,
  RouteMeta,
  StandardSchemaV1,
} from "voke";

type JsonSchemaObject = Record<string, unknown>;

type OpenApiMethod =
  | "delete"
  | "get"
  | "head"
  | "options"
  | "patch"
  | "post"
  | "put";

export interface OpenApiParameter {
  readonly in: "header" | "path" | "query";
  readonly name: string;
  readonly required: boolean;
  readonly schema: JsonSchemaObject;
}

export interface OpenApiMediaType {
  readonly schema: JsonSchemaObject;
}

export interface OpenApiResponse {
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
  readonly description: string;
}

export interface OpenApiOperation {
  readonly deprecated?: true;
  readonly description?: string;
  readonly operationId: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly content: Readonly<Record<string, OpenApiMediaType>>;
    readonly required: true;
  };
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
  /** `[]` marks a public route; otherwise the route's authorizer. */
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
  readonly summary?: string;
  readonly tags: readonly string[];
}

export type OpenApiSecurityScheme =
  | {
      readonly bearerFormat: "JWT";
      readonly description: string;
      readonly scheme: "bearer";
      readonly type: "http";
    }
  | {
      readonly description: string;
      readonly in: "header" | "query";
      readonly name: string;
      readonly type: "apiKey";
    };

/** An OpenAPI 3.1 document, whose schemas use JSON Schema draft 2020-12. */
export interface OpenApiDocument {
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonSchemaObject>>;
    readonly securitySchemes?: Readonly<Record<string, OpenApiSecurityScheme>>;
  };
  readonly info: {
    readonly description?: string;
    readonly title: string;
    readonly version: string;
  };
  readonly openapi: "3.1.0";
  readonly paths: Readonly<
    Record<string, Partial<Record<OpenApiMethod, OpenApiOperation>>>
  >;
  readonly servers?: readonly { readonly url: string }[];
}

/** What the document reads from the `openapi()` options. */
export interface OpenApiDocumentOptions {
  readonly description?: string;
  /** Server URLs, such as `https://api.example.com`. */
  readonly servers?: readonly string[];
  /** Default: the project name. */
  readonly title?: string;
  /** Default: `"0.0.0"`. */
  readonly version?: string;
}

export interface OpenApiDocumentInput {
  /** Every Function of the Gateway, as `runtime.setup` and `loadFunctions()` list them. */
  readonly functions: readonly (readonly [string, AnyFunctionDefinition])[];
  /** The project name. */
  readonly name: string;
  readonly options?: OpenApiDocumentOptions;
}

type RouteDefinition = NonNullable<AnyFunctionDefinition["routes"]>[number];

/** The Functions the Plugin contributes itself are not part of the API it describes. */
const ownFunctionKeyPrefix = "openapi-";
const defaultVersion = "0.0.0";
const routeParamPattern = /^:([A-Za-z_][A-Za-z0-9_]*)$/u;
const identitySourcePattern = /^\$request\.(header|querystring)\.([^.\s]+)$/iu;
const wordPattern = /[A-Za-z0-9]+/gu;

const errorSchemaRef = { $ref: "#/components/schemas/Error" } as const;

// Mirrors `ErrorBody` from @voke/http: every `{ error }` response the Gateway sends.
const errorSchema: JsonSchemaObject = {
  properties: {
    error: {
      properties: {
        code: { type: "string" },
        details: {},
        issues: {
          items: {
            properties: {
              message: { type: "string" },
              path: { items: { type: ["string", "integer"] }, type: "array" },
            },
            required: ["message"],
            type: "object",
          },
          type: "array",
        },
        message: { type: "string" },
      },
      required: ["message"],
      type: "object",
    },
  },
  required: ["error"],
  type: "object",
};

const errorResponse = (description: string): OpenApiResponse => ({
  content: { "application/json": { schema: errorSchemaRef } },
  description,
});

const routeName = (route: RouteDefinition): string =>
  `${route.method} ${route.path}`;

const routeError = (
  route: RouteDefinition,
  functionKey: string,
  message: string
): VokeConfigError =>
  new VokeConfigError(
    `Route "${routeName(route)}" of Function "${functionKey}" ${message}`
  );

interface PathTemplate {
  readonly parameters: readonly string[];
  readonly path: string;
}

/** `/users/:id/*` → `/users/{id}/{proxy}`, with the same rules as API Gateway HTTP APIs. */
const toPathTemplate = (
  route: RouteDefinition,
  functionKey: string
): PathTemplate => {
  const segments = route.path.split("/");
  const parameters: string[] = [];
  const converted = segments.map((segment, index) => {
    if (segment === "*") {
      if (index !== segments.length - 1) {
        throw routeError(
          route,
          functionKey,
          'has a "*" before the last path segment; use a trailing "*" only'
        );
      }

      parameters.push("proxy");
      return "{proxy}";
    }

    if (!segment.startsWith(":")) {
      return segment;
    }

    const name = routeParamPattern.exec(segment)?.[1];

    if (name === undefined) {
      throw routeError(
        route,
        functionKey,
        `uses the path parameter "${segment}", which has no OpenAPI equivalent; use a plain ":name" parameter`
      );
    }

    parameters.push(name);
    return `{${name}}`;
  });

  return { parameters, path: converted.join("/") };
};

const withoutDialect = (schema: JsonSchemaObject): JsonSchemaObject => {
  const { $schema: _dialect, ...rest } = schema;

  return rest;
};

const isJsonObject = (value: unknown): value is JsonSchemaObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The request side of a schema, or `undefined` when it has no readable JSON Schema. */
const inputSchema = (
  schema: StandardSchemaV1 | undefined
): JsonSchemaObject | undefined => {
  const jsonSchema = readJsonSchema(schema, "input");

  return jsonSchema === undefined ? undefined : withoutDialect(jsonSchema);
};

interface ObjectSchemaProperties {
  readonly properties: Readonly<Record<string, JsonSchemaObject>>;
  readonly required: ReadonlySet<string>;
}

const objectProperties = (
  schema: StandardSchemaV1 | undefined
): ObjectSchemaProperties => {
  const jsonSchema = inputSchema(schema);
  const properties = isJsonObject(jsonSchema?.properties)
    ? jsonSchema.properties
    : {};
  const required = Array.isArray(jsonSchema?.required)
    ? jsonSchema.required.filter((key) => typeof key === "string")
    : [];

  return {
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        isJsonObject(value) ? value : {},
      ])
    ),
    required: new Set(required),
  };
};

const routeParameters = (
  route: RouteDefinition,
  template: PathTemplate
): OpenApiParameter[] => {
  const params = objectProperties(route.params);
  const pathParameters = template.parameters.map(
    (name): OpenApiParameter => ({
      in: "path",
      name,
      required: true,
      schema: params.properties[name] ?? { type: "string" },
    })
  );
  const namedParameters = (
    location: "header" | "query",
    schema: StandardSchemaV1 | undefined
  ): OpenApiParameter[] => {
    const { properties, required } = objectProperties(schema);

    return Object.entries(properties).map(([name, propertySchema]) => ({
      in: location,
      name,
      required: required.has(name),
      schema: propertySchema,
    }));
  };

  return [
    ...pathParameters,
    ...namedParameters("query", route.query),
    ...namedParameters("header", route.headers),
  ];
};

const successResponse = (route: RouteDefinition): OpenApiResponse => {
  const output = readJsonSchema(route.output, "output");

  return {
    content: {
      "application/json": {
        schema: {
          properties: {
            data: output === undefined ? {} : withoutDialect(output),
          },
          required: ["data"],
          type: "object",
        },
      },
    },
    description: "Success",
  };
};

const validatesRequest = (route: RouteDefinition): boolean =>
  route.body !== undefined ||
  route.headers !== undefined ||
  route.params !== undefined ||
  route.query !== undefined;

const routeResponses = (
  route: RouteDefinition,
  secured: boolean
): Record<string, OpenApiResponse> => {
  const responses: Record<string, OpenApiResponse> = {
    "200": successResponse(route),
  };

  if (validatesRequest(route)) {
    responses["400"] = errorResponse("Invalid request");
  }

  // A `body` schema means a JSON body; any other content type is answered with 415.
  if (route.body !== undefined) {
    responses["415"] = errorResponse("Unsupported content type");
  }

  // API Gateway answers these itself with its own body, so only the status is documented.
  if (secured) {
    responses["401"] = { description: "Unauthorized" };
    responses["403"] = { description: "Forbidden" };
  }

  responses["500"] = errorResponse("Internal server error");

  return responses;
};

const securityScheme = (
  authorizer: HttpAuthorizerDefinition
): OpenApiSecurityScheme => {
  if (authorizer.kind === "jwt") {
    return {
      bearerFormat: "JWT",
      description: `JWT issued by ${authorizer.issuer}`,
      scheme: "bearer",
      type: "http",
    };
  }

  const description = `Lambda authorizer. Identity sources: ${authorizer.identitySource.join(", ")}`;

  for (const source of authorizer.identitySource) {
    const match = identitySourcePattern.exec(source);

    if (match?.[1] !== undefined && match[2] !== undefined) {
      return {
        description,
        in: match[1].toLowerCase() === "header" ? "header" : "query",
        name: match[2],
        type: "apiKey",
      };
    }
  }

  // An identity source from the request context has no OpenAPI location; Lambda authorizers
  // default to the Authorization header.
  return { description, in: "header", name: "Authorization", type: "apiKey" };
};

const toWords = (text: string): string[] => text.match(wordPattern) ?? [];

const capitalize = (word: string): string =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** `http`, `GET /users/:id` → `httpGetUsersById`. */
const defaultOperationId = (
  functionKey: string,
  route: RouteDefinition
): string => {
  const pathWords = route.path.split("/").flatMap((segment) => {
    if (segment === "*") {
      return ["proxy"];
    }

    return segment.startsWith(":")
      ? ["by", ...toWords(segment)]
      : toWords(segment);
  });
  const [first = "", ...rest] = toWords(functionKey);

  return [
    first,
    ...rest.map(capitalize),
    capitalize(route.method.toLowerCase()),
    ...pathWords.map(capitalize),
  ].join("");
};

const describedOperation = (
  meta: RouteMeta | undefined,
  functionKey: string,
  route: RouteDefinition
): Pick<
  OpenApiOperation,
  "deprecated" | "description" | "operationId" | "summary" | "tags"
> => ({
  operationId: meta?.operationId ?? defaultOperationId(functionKey, route),
  ...(meta?.summary === undefined ? {} : { summary: meta.summary }),
  ...(meta?.description === undefined ? {} : { description: meta.description }),
  tags: [...(meta?.tags ?? [functionKey])],
  ...(meta?.deprecated === true ? { deprecated: true } : {}),
});

const requestBody = (
  route: RouteDefinition
): Pick<OpenApiOperation, "requestBody"> => {
  if (route.body === undefined) {
    return {};
  }

  return {
    requestBody: {
      content: {
        "application/json": { schema: inputSchema(route.body) ?? {} },
      },
      required: true,
    },
  };
};

interface RouteSecurity {
  readonly name: string;
  readonly scheme: OpenApiSecurityScheme;
}

/** The route's effective authorizer (`route.authorizer ?? definition.authorizer`); `"none"` is public. */
const routeSecurity = (
  route: RouteDefinition,
  definition: AnyFunctionDefinition,
  functionKey: string
): RouteSecurity | undefined => {
  const name = route.authorizer ?? definition.authorizer;

  if (name === undefined || name === "none") {
    return undefined;
  }

  const authorizer = definition.authorizers?.[name];

  if (authorizer === undefined) {
    throw routeError(
      route,
      functionKey,
      `uses the authorizer "${name}", which its Function does not declare in authorizers`
    );
  }

  return { name, scheme: securityScheme(authorizer) };
};

const documentInfo = (
  name: string,
  options: OpenApiDocumentOptions
): OpenApiDocument["info"] => ({
  ...(options.description === undefined
    ? {}
    : { description: options.description }),
  title: options.title ?? name,
  version: options.version ?? defaultVersion,
});

/**
 * Builds the OpenAPI 3.1 document of a Gateway's HTTP API from its route contracts. Routes appear
 * in declaration order, so the same Functions always give the same document.
 */
export const createOpenApiDocument = ({
  functions,
  name,
  options = {},
}: OpenApiDocumentInput): OpenApiDocument => {
  const paths: Record<
    string,
    Partial<Record<OpenApiMethod, OpenApiOperation>>
  > = {};
  const securitySchemes: Record<string, OpenApiSecurityScheme> = {};
  const operationRoutes = new Map<string, string>();

  for (const [functionKey, definition] of functions) {
    if (
      definition.kind !== "route" ||
      functionKey.startsWith(ownFunctionKeyPrefix)
    ) {
      continue;
    }

    for (const route of definition.routes ?? []) {
      if (route.meta?.hidden === true) {
        continue;
      }

      const template = toPathTemplate(route, functionKey);
      const security = routeSecurity(route, definition, functionKey);

      if (security !== undefined) {
        securitySchemes[security.name] ??= security.scheme;
      }

      const described = describedOperation(route.meta, functionKey, route);
      const previous = operationRoutes.get(described.operationId);

      if (previous !== undefined) {
        throw routeError(
          route,
          functionKey,
          `uses the operationId "${described.operationId}", which route "${previous}" already uses; set meta.operationId`
        );
      }

      operationRoutes.set(described.operationId, routeName(route));

      const parameters = routeParameters(route, template);
      const pathItem = (paths[template.path] ??= {});

      pathItem[route.method.toLowerCase() as OpenApiMethod] = {
        ...described,
        ...(parameters.length === 0 ? {} : { parameters }),
        ...requestBody(route),
        responses: routeResponses(route, security !== undefined),
        security: security === undefined ? [] : [{ [security.name]: [] }],
      };
    }
  }

  return {
    components: {
      schemas: { Error: errorSchema },
      ...(Object.keys(securitySchemes).length === 0 ? {} : { securitySchemes }),
    },
    info: documentInfo(name, options),
    openapi: "3.1.0",
    paths,
    ...(options.servers === undefined || options.servers.length === 0
      ? {}
      : { servers: options.servers.map((url) => ({ url })) }),
  };
};

/** The number of operations in a document. */
export const countOperations = (document: OpenApiDocument): number =>
  Object.values(document.paths).reduce(
    (count, pathItem) => count + Object.keys(pathItem).length,
    0
  );
