import { toEnvKey } from "./aws";

type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

type RawObject = Record<string, YamlValue>;

export type ServerlessFunctionEvent =
  | { type: "httpApi"; method: string; path: string }
  | { type: "http"; method: string; path: string }
  | { type: "sqs"; arn?: string }
  | { type: "eventBridge"; eventBus?: string; pattern?: YamlValue }
  | { type: "unsupported"; name: string; value: YamlValue };

export interface ServerlessFunction {
  name: string;
  handler?: string;
  environment: Record<string, string>;
  events: ServerlessFunctionEvent[];
}

export interface ServerlessService {
  service: string;
  provider: {
    name?: string;
    runtime?: string;
    stage?: string;
    region?: string;
    environment: Record<string, string>;
    iamRoleStatements: YamlValue[];
  };
  package?: {
    patterns: string[];
  };
  plugins: string[];
  functions: Record<string, ServerlessFunction>;
}

export interface ServerlessMigrationReport {
  supported: string[];
  unsupported: string[];
  manualSteps: string[];
}

export interface ServerlessMigration {
  projectName: string;
  service: ServerlessService;
  report: ServerlessMigrationReport;
  files: Record<string, string>;
}

export interface ServerlessMigrationOptions {
  source: string;
  outDirectory?: string;
}

interface ParsedLine {
  indent: number;
  text: string;
}

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const kebabCase = (value: string): string =>
  value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replaceAll(/[^A-Za-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .toLowerCase();

const markdownList = (items: string[]): string =>
  items.map((item) => `- ${item}`).join("\n");

const asObject = (value: YamlValue | undefined): RawObject => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  return {};
};

const stringRecord = (value: YamlValue | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(asObject(value)).map(([key, entry]) => [key, String(entry)])
  );

const asOptionalString = (value: YamlValue | undefined): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  return String(value);
};

const asArray = (value: YamlValue | undefined): YamlValue[] =>
  Array.isArray(value) ? value : [];

const parseScalar = (value: string): YamlValue => {
  if (value === "null" || value === "~") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/u.test(value)) {
    return Number(value);
  }

  return value;
};

const isKeyValue = (value: string): boolean => /^[^:]+:(\s|$)/u.test(value);

const splitKeyValue = (text: string): [string, string] => {
  const separator = text.indexOf(":");

  if (separator === -1) {
    return [text, ""];
  }

  return [text.slice(0, separator).trim(), text.slice(separator + 1).trim()];
};

const stripComment = (line: string): string => {
  let quote: string | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if ((char === '"' || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? undefined : (quote ?? char);
    }

    if (char === "#" && quote === undefined) {
      return line.slice(0, index);
    }
  }

  return line;
};

const parseLine = (line: string): ParsedLine | undefined => {
  const withoutComment = stripComment(line);

  if (withoutComment.trim() === "") {
    return undefined;
  }

  return {
    indent: withoutComment.search(/\S/u),
    text: withoutComment.trim(),
  };
};

let parseBlock = (
  _lines: ParsedLine[],
  _index: number,
  _indent: number
): [YamlValue, number] => {
  throw new Error("YAML parser is not initialized");
};

let parseObject = (
  _lines: ParsedLine[],
  _index: number,
  _indent: number
): [RawObject, number] => {
  throw new Error("YAML parser is not initialized");
};

const parseArray = (
  lines: ParsedLine[],
  index: number,
  indent: number
): [YamlValue[], number] => {
  const array: YamlValue[] = [];
  let cursor = index;

  while (cursor < lines.length) {
    const line = lines[cursor];

    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      cursor += 1;
      continue;
    }
    if (!line.text.startsWith("- ")) {
      break;
    }

    const item = line.text.slice(2).trim();

    if (item === "") {
      const next = lines[cursor + 1];

      if (next === undefined) {
        array.push(null);
        cursor += 1;
        continue;
      }

      const [value, nextIndex] = parseBlock(lines, cursor + 1, next.indent);

      array.push(value);
      cursor = nextIndex;
      continue;
    }

    if (isKeyValue(item)) {
      const [key, rawValue] = splitKeyValue(item);
      const object: RawObject = {};

      if (rawValue === "") {
        const next = lines[cursor + 1];

        if (next !== undefined && next.indent > indent) {
          const [value, nextIndex] = parseBlock(lines, cursor + 1, next.indent);

          object[key] = value;
          cursor = nextIndex;
          array.push(object);
          continue;
        }

        object[key] = {};
        cursor += 1;
        array.push(object);
        continue;
      }

      object[key] = parseScalar(rawValue);

      const next = lines[cursor + 1];

      if (next !== undefined && next.indent > indent) {
        const [rest, nextIndex] = parseObject(lines, cursor + 1, next.indent);

        array.push({ ...object, ...rest });
        cursor = nextIndex;
        continue;
      }

      array.push(object);
      cursor += 1;
      continue;
    }

    array.push(parseScalar(item));
    cursor += 1;
  }

  return [array, cursor];
};

parseObject = (
  lines: ParsedLine[],
  index: number,
  indent: number
): [RawObject, number] => {
  const object: RawObject = {};
  let cursor = index;

  while (cursor < lines.length) {
    const line = lines[cursor];

    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      cursor += 1;
      continue;
    }
    if (line.text.startsWith("- ")) {
      break;
    }

    const [key, rawValue] = splitKeyValue(line.text);

    if (rawValue === "") {
      const next = lines[cursor + 1];

      if (next === undefined || next.indent <= indent) {
        object[key] = {};
        cursor += 1;
        continue;
      }

      const [value, nextIndex] = parseBlock(lines, cursor + 1, next.indent);

      object[key] = value;
      cursor = nextIndex;
      continue;
    }

    object[key] = parseScalar(rawValue);
    cursor += 1;
  }

  return [object, cursor];
};

parseBlock = (
  lines: ParsedLine[],
  index: number,
  indent: number
): [YamlValue, number] => {
  const line = lines[index];

  if (line?.text.startsWith("- ") === true && line.indent === indent) {
    return parseArray(lines, index, indent);
  }

  return parseObject(lines, index, indent);
};

const parseYaml = (source: string): YamlValue => {
  const lines = source
    .split(/\r?\n/u)
    .map(parseLine)
    .filter((line): line is ParsedLine => line !== undefined);
  const [value] = parseBlock(lines, 0, 0);

  return value;
};

const parseFunctionEvents = (
  value: YamlValue | undefined
): ServerlessFunctionEvent[] =>
  asArray(value).map((event) => {
    const rawEvent = asObject(event);
    const [name, rawValue] = Object.entries(rawEvent)[0] ?? [];
    const config = asObject(rawValue);

    if (name === "httpApi" || name === "http") {
      return {
        method: (asOptionalString(config.method) ?? "GET").toUpperCase(),
        path: asOptionalString(config.path) ?? "/",
        type: name,
      };
    }

    if (name === "sqs") {
      if (typeof rawValue === "string") {
        return { arn: rawValue, type: "sqs" };
      }

      return { arn: asOptionalString(config.arn), type: "sqs" };
    }

    if (name === "eventBridge") {
      return {
        eventBus: asOptionalString(config.eventBus),
        pattern: config.pattern,
        type: "eventBridge",
      };
    }

    return {
      name: name ?? "unknown",
      type: "unsupported",
      value: rawValue ?? rawEvent,
    };
  });

const createCompatibilityMarkdown = (
  service: ServerlessService
): string => `# Serverless Framework Compatibility Matrix

| Pattern | Status | Notes |
| --- | --- | --- |
| Service name | Supported | Migrated to Voke app config. |
| Provider stage and region | Supported | Migrated to Voke app config and CloudFormation synth options. |
| Provider environment | Supported | Migrated to generated stack environment variables. |
| Provider IAM statements | Reported | Included in the report for manual CloudFormation review. |
| Package patterns | Reported | Included in the report because Voke builds with Bun. |
| Plugins | Reported | Plugin behavior is not executed by Voke. |
| HTTP API event | Supported | Generated as Hono routes. |
| REST API event | Supported | Generated as Hono routes for incremental API migration. |
| SQS worker | Supported skeleton | Generated as Voke function skeletons. |
| EventBridge worker | Supported skeleton | Generated as Voke function skeletons. |

Detected service: \`${service.service}\`
`;

const createReportMarkdown = (
  service: ServerlessService,
  report: ServerlessMigrationReport
): string => `# Serverless Framework Migration Report

Service: \`${service.service}\`

## Supported features

${markdownList(report.supported)}

## Unsupported features

${markdownList(report.unsupported.length === 0 ? ["No unsupported features detected."] : report.unsupported)}

## Manual steps

${markdownList(report.manualSteps)}

## Function inventory

${markdownList(
  Object.values(service.functions).map((fn) => {
    const events =
      fn.events.map((event) => event.type).join(", ") || "no events";

    return `${fn.name}: ${fn.handler ?? "no handler"} (${events})`;
  })
)}
`;

const createFunctionTemplate = (
  fn: ServerlessFunction
): string => `import { defineFunction } from "voke";

export const ${fn.name} = defineFunction({
  name: "${fn.name}",
  handler: async (payload: unknown) => {
    return {
      migrated: true,
      payload,
      originalHandler: "${fn.handler ?? "not specified"}",
    };
  },
});
`;

const createRouteTemplate = (fn: ServerlessFunction): string => {
  const routes = fn.events
    .filter((event) => event.type === "http" || event.type === "httpApi")
    .map((event) => {
      const method = event.method.toLowerCase();

      return `${fn.name}Routes.${method}("${event.path}", () => json({
  migrated: true,
  functionName: "${fn.name}",
  originalHandler: "${fn.handler ?? "not specified"}",
}));`;
    });

  return `import { Hono } from "hono";
import { json } from "voke";

export const ${fn.name}Routes = new Hono();

${routes.join("\n\n")}
`;
};

const createConfigTemplate = (service: ServerlessService): string => {
  const environment = {
    ...service.provider.environment,
    ...Object.fromEntries(
      Object.values(service.functions).flatMap((fn) =>
        Object.entries(fn.environment).map(([key, value]) => [
          `${toEnvKey(fn.name)}_${key}`,
          value,
        ])
      )
    ),
  };

  return `import { defineConfig } from "voke";

export default defineConfig({
  name: "${service.service}",
  stage: "${service.provider.stage ?? "local"}",
  region: "${service.provider.region ?? "us-east-1"}",
  entrypoint: "./src/index.ts",
  cloudFormation: {
    environment: ${JSON.stringify(environment, null, 4).replaceAll("\n", "\n    ")},
  },
});
`;
};

const createIndexTemplate = (service: ServerlessService): string => {
  const routeImports: string[] = [];
  const routeMounts: string[] = [];

  for (const fn of Object.values(service.functions)) {
    if (
      !fn.events.some(
        (event) => event.type === "http" || event.type === "httpApi"
      )
    ) {
      continue;
    }

    const exportName = `${fn.name}Routes`;

    routeImports.push(
      `import { ${exportName} } from "./routes/${kebabCase(fn.name)}";`
    );
    routeMounts.push(`app.route("/", ${exportName});`);
  }

  return `import { api, createApiApp } from "voke";
import config from "../voke.config";
${routeImports.join("\n")}

const app = createApiApp({
  config,
});

${routeMounts.join("\n")}

const service = api(app, { config });

export const handler = service.handler;
export default service;
`;
};

const createTsconfig = (): Record<string, YamlValue> => ({
  extends: "../../tsconfig.json",
  include: ["voke.config.ts", "src/**/*.ts", "test/**/*.ts"],
});

const createPackageJson = (name: string): Record<string, YamlValue> => ({
  dependencies: {
    hono: "^4.0.0",
    voke: "workspace:*",
  },
  devDependencies: {
    "@types/bun": "latest",
    "@typescript/native-preview": "^7.0.0-dev.20260516.1"
  },
  name: `@voke/${name}`,
  private: true,
  scripts: {
    build: "voke build",
    clean: "rm -rf dist coverage",
    dev: "voke dev",
    synth: "voke synth",
    test: "bun test",
    typecheck: "bunx tsgo --project tsconfig.json --noEmit",
  },
  type: "module",
  version: "0.0.0",
});

const createMigrationFiles = (
  service: ServerlessService,
  report: ServerlessMigrationReport,
  outDirectory: string
): Record<string, string> => {
  const files: Record<string, string> = {
    [`${outDirectory}/package.json`]: `${JSON.stringify(createPackageJson(service.service), null, 2)}\n`,
    [`${outDirectory}/tsconfig.json`]: `${JSON.stringify(createTsconfig(), null, 2)}\n`,
    [`${outDirectory}/voke.config.ts`]: createConfigTemplate(service),
    [`${outDirectory}/src/index.ts`]: createIndexTemplate(service),
    [`${outDirectory}/MIGRATION_REPORT.md`]: createReportMarkdown(
      service,
      report
    ),
    [`${outDirectory}/SERVERLESS_COMPATIBILITY.md`]:
      createCompatibilityMarkdown(service),
  };

  for (const fn of Object.values(service.functions)) {
    if (
      fn.events.some(
        (event) => event.type === "http" || event.type === "httpApi"
      )
    ) {
      files[`${outDirectory}/src/routes/${kebabCase(fn.name)}.ts`] =
        createRouteTemplate(fn);
    }

    if (
      fn.events.some(
        (event) => event.type === "sqs" || event.type === "eventBridge"
      )
    ) {
      files[`${outDirectory}/src/functions/${kebabCase(fn.name)}.ts`] =
        createFunctionTemplate(fn);
    }
  }

  return files;
};

const createMigrationReport = (
  service: ServerlessService
): ServerlessMigrationReport => {
  const supported = ["service name"];
  const unsupported: string[] = [];
  const manualSteps = [
    "Move one Serverless function at a time by routing migrated HTTP paths to Voke while the original service keeps the remaining functions.",
    "Review generated route and worker handlers before deleting the matching Serverless Framework function.",
    "Translate unsupported plugins and events manually, then update the compatibility matrix for the service.",
  ];

  if (service.provider.stage !== undefined) {
    supported.push("provider stage");
  }
  if (service.provider.region !== undefined) {
    supported.push("provider region");
  }
  if (Object.keys(service.provider.environment).length > 0) {
    supported.push("provider environment");
  }
  if (service.provider.iamRoleStatements.length > 0) {
    supported.push("provider IAM statements");
  }
  if ((service.package?.patterns.length ?? 0) > 0) {
    supported.push("package patterns");
  }
  if (service.plugins.length > 0) {
    supported.push("plugins inventory");
  }

  for (const plugin of service.plugins) {
    if (plugin !== "serverless-offline") {
      unsupported.push(`plugin ${plugin} requires manual migration`);
    }
  }

  for (const fn of Object.values(service.functions)) {
    for (const event of fn.events) {
      if (event.type === "httpApi") {
        supported.push(
          `HTTP API event: ${fn.name} ${event.method} ${event.path}`
        );
        continue;
      }
      if (event.type === "http") {
        supported.push(
          `REST API event: ${fn.name} ${event.method} ${event.path}`
        );
        continue;
      }
      if (event.type === "sqs") {
        supported.push(`SQS event: ${fn.name}`);
        continue;
      }
      if (event.type === "eventBridge") {
        supported.push(`EventBridge event: ${fn.name}`);
        continue;
      }

      unsupported.push(
        `${event.name} event on ${fn.name} requires manual migration`
      );
    }
  }

  return { manualSteps, supported, unsupported };
};

export const parseServerlessYaml = (source: string): ServerlessService => {
  const raw = parseYaml(source);
  const root = asObject(raw);
  const provider = asObject(root.provider);
  const providerIam = asObject(provider.iam);
  const providerIamRole = asObject(providerIam.role);
  const packageConfig = asObject(root.package);
  const rawFunctions = asObject(root.functions);
  const functions: Record<string, ServerlessFunction> = {};

  for (const [name, value] of Object.entries(rawFunctions)) {
    const rawFunction = asObject(value);

    functions[name] = {
      environment: stringRecord(rawFunction.environment),
      events: parseFunctionEvents(rawFunction.events),
      handler: asOptionalString(rawFunction.handler),
      name,
    };
  }

  return {
    functions,
    package:
      root.package === undefined
        ? undefined
        : {
            patterns: asArray(packageConfig.patterns).map(String),
          },
    plugins: asArray(root.plugins).map(String),
    provider: {
      environment: stringRecord(provider.environment),
      iamRoleStatements: asArray(
        provider.iamRoleStatements ?? providerIamRole.statements
      ),
      name: asOptionalString(provider.name),
      region: asOptionalString(provider.region),
      runtime: asOptionalString(provider.runtime),
      stage: asOptionalString(provider.stage),
    },
    service: asOptionalString(root.service) ?? "api",
  };
};

export const createServerlessMigration = (
  options: ServerlessMigrationOptions
): ServerlessMigration => {
  const service = parseServerlessYaml(options.source);
  const outDirectory = trimTrailingSlash(
    options.outDirectory ?? `./${service.service}-voke`
  );
  const report = createMigrationReport(service);
  const files = createMigrationFiles(service, report, outDirectory);

  return {
    files,
    projectName: service.service,
    report,
    service,
  };
};

export const writeServerlessMigration = async (
  options: ServerlessMigrationOptions
): Promise<ServerlessMigration> => {
  const migration = createServerlessMigration(options);

  for (const [path, content] of Object.entries(migration.files)) {
    const directory = path.split("/").slice(0, -1).join("/");

    if (directory !== "") {
      await Bun.$`mkdir -p ${directory}`;
    }

    await Bun.write(path, content);
  }

  return migration;
};
