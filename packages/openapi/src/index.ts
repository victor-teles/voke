// Run-time module: `voke.config.ts` imports the Plugin, so this file is bundled into deployed
// Functions. File-system code is loaded inside the command's `run` only.
import { http, route, VokeConfigError } from "voke";
import type {
  AnyFunctionDefinition,
  PluginCommand,
  PluginRuntimeHooks,
  VokePlugin,
} from "voke";

import { countOperations, createOpenApiDocument } from "./document";
import type { OpenApiDocument, OpenApiDocumentOptions } from "./document";
import {
  renderScalarPage,
  scalarVersion,
  scalarVersionPattern,
} from "./scalar";

export { createOpenApiDocument } from "./document";
export type {
  OpenApiDocument,
  OpenApiDocumentInput,
  OpenApiDocumentOptions,
  OpenApiMediaType,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiResponse,
  OpenApiSecurityScheme,
} from "./document";

export interface OpenApiOptions extends OpenApiDocumentOptions {
  /** Where the document is served. Default: `"/openapi.json"`. */
  readonly documentPath?: string;
  /**
   * Serve the document and the page from the deployed API, as the public Plugin Function
   * `openapi-docs`. Default: `false`, which serves them under `voke dev` only.
   */
  readonly expose?: boolean;
  readonly scalar?: {
    /** The `@scalar/api-reference` version the page loads from jsDelivr. */
    readonly version?: string;
  };
  /** Where the API Reference Page is served; `false` serves the document only. Default: `"/docs"`. */
  readonly uiPath?: string | false;
}

type ConfigIssue = Parameters<typeof VokeConfigError.validation>[0][number];

const pluginName = "openapi";
const defaultDocumentPath = "/openapi.json";
const defaultUiPath = "/docs";
const defaultOutFile = "openapi.json";
// Parameters, wildcards, a query or a fragment: the document and the page live at fixed paths.
const nonFixedPathPattern = /[*:?#]/u;

interface OpenApiSettings {
  readonly documentPath: string;
  readonly expose: boolean;
  readonly scalarVersion: string;
  readonly uiPath: string | undefined;
}

const pathIssue = (
  field: "documentPath" | "uiPath",
  path: string
): ConfigIssue | undefined => {
  if (!path.startsWith("/") || nonFixedPathPattern.test(path)) {
    return {
      message: `expected a fixed path that starts with "/"; received ${JSON.stringify(path)}`,
      path: `plugins.${pluginName}.${field}`,
    };
  }

  return undefined;
};

const resolveSettings = (options: OpenApiOptions): OpenApiSettings => {
  const documentPath = options.documentPath ?? defaultDocumentPath;
  const uiPath =
    options.uiPath === false ? undefined : (options.uiPath ?? defaultUiPath);
  const version = options.scalar?.version ?? scalarVersion;
  const issues: ConfigIssue[] = [];

  for (const issue of [
    pathIssue("documentPath", documentPath),
    uiPath === undefined ? undefined : pathIssue("uiPath", uiPath),
  ]) {
    if (issue !== undefined) {
      issues.push(issue);
    }
  }

  if (uiPath === documentPath) {
    issues.push({
      message: `expected a path other than documentPath; received ${JSON.stringify(uiPath)}`,
      path: `plugins.${pluginName}.uiPath`,
    });
  }

  if (!scalarVersionPattern.test(version)) {
    issues.push({
      message: `expected an npm version such as "${scalarVersion}"; received ${JSON.stringify(version)}`,
      path: `plugins.${pluginName}.scalar.version`,
    });
  }

  if (issues.length > 0) {
    throw VokeConfigError.validation(issues);
  }

  return {
    documentPath,
    expose: options.expose === true,
    scalarVersion: version,
    uiPath,
  };
};

/** What one Gateway serves: its document, built on the first request and then reused. */
interface ServedApi {
  readonly document: () => OpenApiDocument;
  readonly title: string;
}

const servedApi = (
  name: string,
  functions: readonly (readonly [string, AnyFunctionDefinition])[],
  options: OpenApiDocumentOptions
): ServedApi => {
  let document: OpenApiDocument | undefined;

  return {
    // Built lazily: a route contract the document cannot describe fails this request only,
    // and Functions that never serve the document do not pay for it at cold start.
    document: () => {
      document ??= createOpenApiDocument({ functions, name, options });

      return document;
    },
    title: options.title ?? name,
  };
};

const documentResponse = (api: ServedApi, requestUrl: string): Response => {
  const document = api.document();
  const served =
    document.servers === undefined
      ? { ...document, servers: [{ url: new URL(requestUrl).origin }] }
      : document;

  return Response.json(served);
};

const pageResponse = (api: ServedApi, settings: OpenApiSettings): Response =>
  new Response(
    renderScalarPage({
      documentUrl: settings.documentPath,
      title: api.title,
      version: settings.scalarVersion,
    }),
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );

type GatewayMiddleware = NonNullable<PluginRuntimeHooks["middleware"]>[number];

const devMiddleware =
  (api: ServedApi, settings: OpenApiSettings): GatewayMiddleware =>
  async (c, next) => {
    if (c.req.method === "GET" && c.req.path === settings.documentPath) {
      return documentResponse(api, c.req.url);
    }

    if (c.req.method === "GET" && c.req.path === settings.uiPath) {
      return pageResponse(api, settings);
    }

    await next();
  };

const generateCommand = (options: OpenApiOptions): PluginCommand => ({
  description: "Write the OpenAPI document of the project's HTTP API.",
  flags: {
    out: { description: `Output file. Default: ${defaultOutFile}` },
    server: { description: "A server URL to list in the document" },
  },
  run: async ({ config, cwd, flags, loadFunctions, output }) => {
    const [{ mkdir, writeFile }, { dirname, resolve }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const out = flags.out ?? defaultOutFile;
    const document = createOpenApiDocument({
      functions: await loadFunctions(),
      name: config.name,
      options: {
        ...options,
        ...(flags.server === undefined ? {} : { servers: [flags.server] }),
      },
    });
    const path = resolve(cwd, out);
    const operations = countOperations(document);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
    output(
      `Wrote ${out} (${operations} ${operations === 1 ? "operation" : "operations"})`
    );
  },
  usage: "voke openapi generate [--out openapi.json] [--server <url>]",
});

/**
 * The OpenAPI Plugin: an OpenAPI 3.1 document of the Gateway's HTTP API and an API Reference
 * Page, served under `voke dev`, or by the deployed API with `expose: true`, and written by
 * `voke openapi generate`.
 */
export const openapi = (options: OpenApiOptions = {}): VokePlugin => {
  const settings = resolveSettings(options);
  // The exposed routes are static contributions, so they read the API of the Gateway that set
  // the Plugin up last; a deployed Function composes exactly one Gateway.
  let exposedApi: ServedApi | undefined;

  const requireExposedApi = (): ServedApi => {
    if (exposedApi === undefined) {
      throw new VokeConfigError(
        `The ${pluginName} Plugin serves ${settings.documentPath} only from a Gateway created with a config that declares it: voke(functions, { config }).`
      );
    }

    return exposedApi;
  };

  const exposedRoutes = [
    route.get(settings.documentPath, {
      authorizer: "none",
      handler: (request) =>
        documentResponse(requireExposedApi(), request.request.url),
    }),
    ...(settings.uiPath === undefined
      ? []
      : [
          route.get(settings.uiPath, {
            authorizer: "none",
            handler: () => pageResponse(requireExposedApi(), settings),
          }),
        ]),
  ];

  return {
    cli: {
      commands: { generate: generateCommand(options) },
      description: "Generate the OpenAPI document of the HTTP API.",
    },
    ...(settings.expose
      ? {
          contributions: {
            functions: { docs: http({ routes: exposedRoutes }) },
          },
        }
      : {}),
    name: pluginName,
    runtime: {
      setup: ({ config, dev, functions }) => {
        const api = servedApi(config.name, functions, options);

        if (settings.expose) {
          exposedApi = api;
          return {};
        }

        // Without `expose`, only `voke dev` serves the document: nothing reaches the deployed API.
        return dev ? { middleware: [devMiddleware(api, settings)] } : {};
      },
    },
  };
};
