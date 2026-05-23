import { toEnvKey } from "./aws";

type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

type RawObject = Record<string, YamlValue>;

export interface ServerlessUnknownField {
  path: string;
  reason: string;
  value: YamlValue;
}

export type ServerlessMigrationArea =
  | "build"
  | "events"
  | "iam"
  | "plugins"
  | "resources"
  | "routing"
  | "unknown-fields";

export type ServerlessMigrationConfidence = "high" | "low" | "medium";

export type ServerlessMigrationRisk = "high" | "low" | "medium";

export interface ServerlessMigrationReportItem {
  area: ServerlessMigrationArea;
  confidence: ServerlessMigrationConfidence;
  file?: string;
  message: string;
  reason?: string;
}

export interface ServerlessMigrationManualTask extends ServerlessMigrationReportItem {
  risk: ServerlessMigrationRisk;
}

export interface ServerlessMigrationGeneratedFile {
  confidence: ServerlessMigrationConfidence;
  path: string;
  purpose: string;
}

export type ServerlessPluginCompatibilityStatus =
  | "inventory-only"
  | "manual"
  | "mapped"
  | "supported";

export interface ServerlessPluginCompatibility {
  name: string;
  status: ServerlessPluginCompatibilityStatus;
  summary: string;
  notes: string[];
  manualSteps: string[];
  mappedBehavior?: string;
}

export interface ServerlessPackageConfig {
  individually?: boolean;
  patterns: string[];
  raw: RawObject;
  unknownFields: ServerlessUnknownField[];
}

interface ServerlessEventMetadata {
  raw: YamlValue;
  unknownFields: ServerlessUnknownField[];
}

export type ServerlessFunctionEvent =
  | ({
      type: "httpApi";
      method: string;
      path: string;
      cors?: YamlValue;
      authorizer?: YamlValue;
    } & ServerlessEventMetadata)
  | ({
      type: "http";
      method: string;
      path: string;
      cors?: YamlValue;
      authorizer?: YamlValue;
    } & ServerlessEventMetadata)
  | ({
      type: "sqs";
      arn?: YamlValue;
      batchSize?: number;
      enabled?: boolean;
      maximumBatchingWindow?: number;
    } & ServerlessEventMetadata)
  | ({ type: "sns"; arn?: YamlValue } & ServerlessEventMetadata)
  | ({
      type: "eventBridge";
      eventBus?: string;
      pattern?: YamlValue;
      schedule?: YamlValue;
    } & ServerlessEventMetadata)
  | ({
      type: "s3";
      bucket?: string;
      event?: string;
      existing?: boolean;
    } & ServerlessEventMetadata)
  | ({
      type: "schedule";
      rate?: YamlValue;
      enabled?: boolean;
    } & ServerlessEventMetadata)
  | ({
      type: "stream";
      arn?: YamlValue;
      streamType?: string;
    } & ServerlessEventMetadata)
  | { type: "unsupported"; name: string; value: YamlValue };

export interface ServerlessFunction {
  name: string;
  handler?: string;
  runtime?: string;
  timeout?: number;
  memorySize?: number;
  environment: Record<string, string>;
  events: ServerlessFunctionEvent[];
  layers: YamlValue[];
  package?: ServerlessPackageConfig;
  unknownFields: ServerlessUnknownField[];
}

export interface ServerlessService {
  service: string;
  provider: {
    name?: string;
    runtime?: string;
    stage?: string;
    region?: string;
    deploymentBucket?: YamlValue;
    environment: Record<string, string>;
    iamRoleStatements: YamlValue[];
    unknownFields: ServerlessUnknownField[];
  };
  package?: ServerlessPackageConfig;
  plugins: string[];
  layers: RawObject;
  custom: RawObject;
  resources: RawObject;
  functions: Record<string, ServerlessFunction>;
  unknownFields: ServerlessUnknownField[];
}

export interface ServerlessMigrationReport {
  converted: ServerlessMigrationReportItem[];
  generatedFiles: ServerlessMigrationGeneratedFile[];
  manualTasks: ServerlessMigrationManualTask[];
  supported: string[];
  unsupported: string[];
  manualSteps: string[];
  unknownFields: ServerlessUnknownField[];
  pluginCompatibility: ServerlessPluginCompatibility[];
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

const reservedIdentifiers = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const toIdentifier = (value: string, fallback: string): string => {
  const trimmed = value.trim();

  if (/^[A-Za-z_$][\w$]*$/u.test(trimmed)) {
    return reservedIdentifiers.has(trimmed) ? `${trimmed}Value` : trimmed;
  }

  const words = trimmed
    .split(/[^A-Za-z0-9_$]+/u)
    .filter((word) => word.length > 0);
  const identifier =
    words.length === 0
      ? fallback
      : words
          .map((word, index) => {
            if (index === 0) {
              return word[0]?.toLowerCase() + word.slice(1);
            }

            return word[0]?.toUpperCase() + word.slice(1);
          })
          .join("");
  const safeIdentifier = /^[A-Za-z_$]/u.test(identifier)
    ? identifier
    : `${fallback}${identifier}`;

  return reservedIdentifiers.has(safeIdentifier)
    ? `${safeIdentifier}Value`
    : safeIdentifier;
};

const pascalCase = (value: string, fallback: string): string => {
  const identifier = toIdentifier(value, fallback);

  return `${identifier[0]?.toUpperCase() ?? ""}${identifier.slice(1)}`;
};

const tsString = (value: string): string => JSON.stringify(value);

const stringifyObject = (
  value: Record<string, YamlValue>,
  indent = 2
): string => JSON.stringify(value, null, indent);

const honoPath = (path: string): string =>
  path
    .replaceAll(/\{([A-Za-z0-9_]+)\+\}/gu, ":$1{.+}")
    .replaceAll(/\{([A-Za-z0-9_]+)\}/gu, ":$1");

const markdownList = (items: string[]): string =>
  items.map((item) => `- ${item}`).join("\n");

const markdownTable = (rows: string[][]): string => {
  const widths = rows[0]?.map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]?.length ?? 0), 3)
  );

  return rows
    .map((row, rowIndex) => {
      const cells = row.map((cell, columnIndex) => {
        const width = widths?.[columnIndex] ?? cell.length;
        const value = rowIndex === 1 ? "-".repeat(width) : cell;

        return value.padEnd(width, " ");
      });

      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
};

const noMarkdownRows = (message: string, columns: number): string =>
  `| ${[message, ...Array.from({ length: columns - 1 }, () => "-")].join(" | ")} |`;

const maybeMarkdownList = (items: string[], empty: string): string =>
  items.length === 0 ? `- ${empty}` : markdownList(items);

const markdownUnknownFields = (items: ServerlessUnknownField[]): string => {
  if (items.length === 0) {
    return "- No unknown fields detected.";
  }

  return items
    .map(
      (item) =>
        `- \`${item.path}\`: ${item.reason}\n\n  ${JSON.stringify(item.value, null, 2).replaceAll("\n", "\n  ")}`
    )
    .join("\n");
};

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

const asNumber = (value: YamlValue | undefined): number | undefined =>
  typeof value === "number" ? value : undefined;

const asBoolean = (value: YamlValue | undefined): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const splitInlineItems = (value: string): string[] => {
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? undefined : (quote ?? char);
    }

    if (quote === undefined) {
      if (char === "[" || char === "{") {
        depth += 1;
      }
      if (char === "]" || char === "}") {
        depth -= 1;
      }
      if (char === "," && depth === 0) {
        items.push(current.trim());
        current = "";
        continue;
      }
    }

    current += char;
  }

  if (current.trim() !== "") {
    items.push(current.trim());
  }

  return items;
};

const isKeyValue = (value: string): boolean =>
  /(?<!:):(?!:)(\s|$)/u.test(value);

const splitKeyValue = (text: string): [string, string] => {
  const separator = text.search(/(?<!:):(?!:)(\s|$)/u);

  if (separator === -1) {
    return [text, ""];
  }

  return [text.slice(0, separator).trim(), text.slice(separator + 1).trim()];
};

let parseScalar = (_value: string): YamlValue => {
  throw new Error("YAML scalar parser is not initialized");
};

const parseInlineArray = (value: string): YamlValue[] =>
  splitInlineItems(value.slice(1, -1)).map(parseScalar);

const parseInlineObject = (value: string): RawObject =>
  Object.fromEntries(
    splitInlineItems(value.slice(1, -1)).map((item) => {
      const [key, entry] = splitKeyValue(item);

      return [key, parseScalar(entry)];
    })
  );

parseScalar = (value: string): YamlValue => {
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
  if (value.startsWith("[") && value.endsWith("]")) {
    return parseInlineArray(value);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    return parseInlineObject(value);
  }
  if (/^-?\d+(\.\d+)?$/u.test(value)) {
    return Number(value);
  }

  return value;
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

    if (
      (item.startsWith("[") && item.endsWith("]")) ||
      (item.startsWith("{") && item.endsWith("}"))
    ) {
      array.push(parseScalar(item));
      cursor += 1;
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

const collectUnknownFields = (
  value: RawObject,
  knownKeys: string[],
  basePath: string,
  reason: string
): ServerlessUnknownField[] =>
  Object.entries(value)
    .filter(([key]) => !knownKeys.includes(key))
    .map(([key, entry]) => ({
      path: `${basePath}.${key}`,
      reason,
      value: entry,
    }));

const parseHttpFunctionEvent = (
  type: "http" | "httpApi",
  rawValue: YamlValue | undefined,
  rawEvent: RawObject,
  basePath: string
): ServerlessFunctionEvent => {
  if (typeof rawValue === "string") {
    const [method, path] = rawValue.split(/\s+/u);

    return {
      method: (method || "GET").toUpperCase(),
      path: path || "/",
      raw: rawValue,
      type,
      unknownFields: [],
    };
  }

  const config = asObject(rawValue);

  return {
    authorizer: config.authorizer,
    cors: config.cors,
    method: (asOptionalString(config.method) ?? "GET").toUpperCase(),
    path: asOptionalString(config.path) ?? "/",
    raw: rawValue ?? rawEvent,
    type,
    unknownFields: collectUnknownFields(
      config,
      ["authorizer", "cors", "method", "path"],
      basePath,
      `${type} event field is not converted automatically`
    ),
  };
};

const parseArnFunctionEvent = (
  type: "sns" | "sqs",
  rawValue: YamlValue | undefined,
  rawEvent: RawObject,
  basePath: string
): ServerlessFunctionEvent => {
  if (typeof rawValue === "string") {
    return { arn: rawValue, raw: rawValue, type, unknownFields: [] };
  }

  const config = asObject(rawValue);
  const knownKeys =
    type === "sns"
      ? ["arn", "topicName"]
      : ["arn", "batchSize", "enabled", "maximumBatchingWindow"];

  if (type === "sqs") {
    const batchSize = asNumber(config.batchSize);
    const enabled = asBoolean(config.enabled);
    const maximumBatchingWindow = asNumber(config.maximumBatchingWindow);

    return {
      arn: config.arn,
      ...(batchSize === undefined ? {} : { batchSize }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(maximumBatchingWindow === undefined ? {} : { maximumBatchingWindow }),
      raw: rawValue ?? rawEvent,
      type,
      unknownFields: collectUnknownFields(
        config,
        knownKeys,
        basePath,
        `${type} event field is not converted automatically`
      ),
    };
  }

  return {
    arn: config.arn,
    raw: rawValue ?? rawEvent,
    type,
    unknownFields: collectUnknownFields(
      config,
      knownKeys,
      basePath,
      `${type} event field is not converted automatically`
    ),
  };
};

const parseEventBridgeFunctionEvent = (
  rawValue: YamlValue | undefined,
  rawEvent: RawObject,
  basePath: string
): ServerlessFunctionEvent => {
  const config = asObject(rawValue);

  return {
    eventBus: asOptionalString(config.eventBus),
    pattern: config.pattern,
    raw: rawValue ?? rawEvent,
    schedule: config.schedule,
    type: "eventBridge",
    unknownFields: collectUnknownFields(
      config,
      ["eventBus", "pattern", "schedule"],
      basePath,
      "eventBridge event field is not converted automatically"
    ),
  };
};

const parseS3FunctionEvent = (
  rawValue: YamlValue | undefined,
  rawEvent: RawObject,
  basePath: string
): ServerlessFunctionEvent => {
  const config = asObject(rawValue);

  return {
    bucket: asOptionalString(config.bucket),
    event: asOptionalString(config.event),
    existing: asBoolean(config.existing),
    raw: rawValue ?? rawEvent,
    type: "s3",
    unknownFields: collectUnknownFields(
      config,
      ["bucket", "event", "existing", "rules"],
      basePath,
      "s3 event field is not converted automatically"
    ),
  };
};

const parseScheduleFunctionEvent = (
  rawValue: YamlValue | undefined,
  rawEvent: RawObject,
  basePath: string
): ServerlessFunctionEvent => {
  if (typeof rawValue === "string") {
    return {
      rate: rawValue,
      raw: rawValue,
      type: "schedule",
      unknownFields: [],
    };
  }

  const config = asObject(rawValue);

  return {
    enabled: asBoolean(config.enabled),
    rate: config.rate,
    raw: rawValue ?? rawEvent,
    type: "schedule",
    unknownFields: collectUnknownFields(
      config,
      ["enabled", "rate", "input", "inputPath"],
      basePath,
      "schedule event field is not converted automatically"
    ),
  };
};

const parseStreamFunctionEvent = (
  rawValue: YamlValue | undefined,
  rawEvent: RawObject,
  basePath: string
): ServerlessFunctionEvent => {
  const config = asObject(rawValue);

  return {
    arn: config.arn,
    raw: rawValue ?? rawEvent,
    streamType: asOptionalString(config.type),
    type: "stream",
    unknownFields: collectUnknownFields(
      config,
      ["arn", "type", "batchSize", "startingPosition"],
      basePath,
      "stream event field is not converted automatically"
    ),
  };
};

const parseFunctionEvent = (
  event: YamlValue,
  eventIndex: number,
  functionName: string
): ServerlessFunctionEvent => {
  const rawEvent = asObject(event);
  const [name, rawValue] = Object.entries(rawEvent)[0] ?? [];
  const basePath = `functions.${functionName}.events[${eventIndex}].${name ?? "unknown"}`;

  switch (name) {
    case "http":
    case "httpApi": {
      return parseHttpFunctionEvent(name, rawValue, rawEvent, basePath);
    }
    case "sqs":
    case "sns": {
      return parseArnFunctionEvent(name, rawValue, rawEvent, basePath);
    }
    case "eventBridge": {
      return parseEventBridgeFunctionEvent(rawValue, rawEvent, basePath);
    }
    case "s3": {
      return parseS3FunctionEvent(rawValue, rawEvent, basePath);
    }
    case "schedule": {
      return parseScheduleFunctionEvent(rawValue, rawEvent, basePath);
    }
    case "stream": {
      return parseStreamFunctionEvent(rawValue, rawEvent, basePath);
    }
    default: {
      return {
        name: name ?? "unknown",
        type: "unsupported",
        value: rawValue ?? rawEvent,
      };
    }
  }
};

const parseFunctionEvents = (
  value: YamlValue | undefined,
  functionName: string
): ServerlessFunctionEvent[] =>
  asArray(value).map((event, eventIndex) =>
    parseFunctionEvent(event, eventIndex, functionName)
  );

const createPackageConfig = (
  value: YamlValue | undefined,
  path: string
): ServerlessPackageConfig | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const raw = asObject(value);

  return {
    individually: asBoolean(raw.individually),
    patterns: asArray(raw.patterns).map(String),
    raw,
    unknownFields: collectUnknownFields(
      raw,
      ["individually", "patterns"],
      path,
      "package field is not converted automatically"
    ),
  };
};

const eventTypeLabel = (event: ServerlessFunctionEvent): string => {
  if (event.type === "unsupported") {
    return event.name;
  }

  return event.type;
};

const eventReportValue = (event: ServerlessFunctionEvent): YamlValue => {
  if (event.type === "unsupported") {
    return event.value;
  }

  return event.raw;
};

const stringifyReportValue = (value: YamlValue): string =>
  JSON.stringify(value, null, 2).replaceAll(
    /\[\n\s+((?:"[^"]*")|(?:-?\d+(?:\.\d+)?)|true|false|null)\n\s+\]/gu,
    "[$1]"
  );

const createEventInventoryMarkdown = (service: ServerlessService): string =>
  Object.values(service.functions)
    .flatMap((fn) =>
      fn.events.map((event, index) => {
        const label = eventTypeLabel(event);
        const value = stringifyReportValue(eventReportValue(event));

        return `- \`${fn.name}.events[${index}].${label}\`\n\n\`\`\`json\n${value}\n\`\`\``;
      })
    )
    .join("\n\n");

const hasHttpEvent = (fn: ServerlessFunction): boolean =>
  fn.events.some((event) => event.type === "http" || event.type === "httpApi");

const hasWorkerEvent = (fn: ServerlessFunction): boolean =>
  fn.events.some(
    (event) => event.type === "sqs" || event.type === "eventBridge"
  );

interface GeneratedResourceDeclaration {
  expression: string;
  helper: string;
  name: string;
  type: string;
}

interface UnsupportedResourceDeclaration {
  name: string;
  reason: string;
  type: string;
}

interface ResourceDeclarations {
  generated: GeneratedResourceDeclaration[];
  unsupported: UnsupportedResourceDeclaration[];
}

interface SqsEventSourceResolution {
  queue?: string;
  reason?: string;
}

const literalString = (value: YamlValue | undefined): string | undefined => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  return undefined;
};

const literalOption = (
  name: string,
  value: string | undefined
): string | undefined =>
  value === undefined ? undefined : `${name}: ${tsString(value)}`;

const createDynamoDbResourceExpression = (
  properties: RawObject
): { expression: string; helper: string } | undefined => {
  const keySchema = asArray(properties.KeySchema).map(asObject);
  const hasKeySchema = keySchema.length > 0;
  const partitionKey = literalString(
    keySchema.find((entry) => entry.KeyType === "HASH")?.AttributeName
  );
  const sortKey = literalString(
    keySchema.find((entry) => entry.KeyType === "RANGE")?.AttributeName
  );
  const billingMode = literalString(properties.BillingMode);

  if (hasKeySchema && partitionKey === undefined) {
    return undefined;
  }

  if (
    billingMode !== undefined &&
    billingMode !== "PAY_PER_REQUEST" &&
    billingMode !== "PROVISIONED"
  ) {
    return undefined;
  }

  const options = [
    literalOption("partitionKey", partitionKey),
    literalOption("sortKey", sortKey),
    literalOption("billingMode", billingMode),
  ].filter((value): value is string => value !== undefined);

  return {
    expression:
      options.length === 0
        ? "dynamodbTable()"
        : `dynamodbTable({ ${options.join(", ")} })`,
    helper: "dynamodbTable",
  };
};

const createSsmParameterResourceExpression = (
  properties: RawObject
): { expression: string; helper: string } | undefined => {
  const value = literalString(properties.Value);
  const typeValue = literalString(properties.Type);

  if (
    value === undefined ||
    Object.keys(properties).some((key) => key !== "Type" && key !== "Value") ||
    (typeValue !== undefined &&
      typeValue !== "String" &&
      typeValue !== "StringList")
  ) {
    return undefined;
  }

  const typeOption = literalOption("type", typeValue);
  const options = [`value: ${tsString(value)}`, typeOption].filter(
    (entry): entry is string => entry !== undefined
  );

  return {
    expression: `ssmParameter({ ${options.join(", ")} })`,
    helper: "ssmParameter",
  };
};

const simpleResourceExpressions: Record<
  string,
  { expression: string; helper: string }
> = {
  "AWS::Events::EventBus": { expression: "eventBus()", helper: "eventBus" },
  "AWS::S3::Bucket": { expression: "s3Bucket()", helper: "s3Bucket" },
  "AWS::SNS::Topic": { expression: "snsTopic()", helper: "snsTopic" },
  "AWS::SQS::Queue": { expression: "sqsQueue()", helper: "sqsQueue" },
  "AWS::SecretsManager::Secret": { expression: "secret()", helper: "secret" },
};

const createResourceExpression = (
  type: string,
  properties: RawObject
): { expression: string; helper: string } | undefined => {
  if (type === "AWS::DynamoDB::Table") {
    return createDynamoDbResourceExpression(properties);
  }

  if (type === "AWS::SSM::Parameter") {
    return createSsmParameterResourceExpression(properties);
  }

  const simpleExpression = simpleResourceExpressions[type];

  if (simpleExpression === undefined || Object.keys(properties).length > 0) {
    return undefined;
  }

  return simpleExpression;
};

const createResourceDeclarations = (
  service: ServerlessService
): ResourceDeclarations => {
  const resources = asObject(service.resources.Resources);
  const generated: GeneratedResourceDeclaration[] = [];
  const unsupported: UnsupportedResourceDeclaration[] = [];

  for (const [name, rawResource] of Object.entries(resources)) {
    const resource = asObject(rawResource);
    const type = literalString(resource.Type) ?? "unknown";
    const properties = asObject(resource.Properties);
    const resourceExpression = createResourceExpression(type, properties);

    if (resourceExpression === undefined) {
      unsupported.push({
        name,
        reason: `CloudFormation resource ${name} (${type}) requires manual migration because Voke cannot safely generate an equivalent config helper.`,
        type,
      });
      continue;
    }

    generated.push({
      expression: resourceExpression.expression,
      helper: resourceExpression.helper,
      name,
      type,
    });
  }

  return { generated, unsupported };
};

const resolveGetAttResourceName = (
  value: YamlValue | undefined
): string | undefined => {
  const getAtt = asObject(value)["Fn::GetAtt"];

  if (Array.isArray(getAtt)) {
    const [resourceName, attribute] = getAtt;

    return typeof resourceName === "string" && attribute === "Arn"
      ? resourceName
      : undefined;
  }

  if (typeof getAtt === "string") {
    const [resourceName, attribute] = getAtt.split(".");

    return resourceName !== undefined && attribute === "Arn"
      ? resourceName
      : undefined;
  }

  return undefined;
};

const resolveSqsEventSource = (
  event: Extract<ServerlessFunctionEvent, { type: "sqs" }>,
  resourceDeclarations: ResourceDeclarations
): SqsEventSourceResolution => {
  const queueResource = resolveGetAttResourceName(event.arn);

  if (queueResource === undefined) {
    return {
      reason:
        "Queue source cannot be resolved to a migrated Voke SQS queue resource.",
    };
  }

  const generatedQueue = resourceDeclarations.generated.find(
    (resource) =>
      resource.name === queueResource && resource.helper === "sqsQueue"
  );

  if (generatedQueue === undefined) {
    return {
      reason: `Queue source ${queueResource} is not generated as a Voke SQS queue resource.`,
    };
  }

  return { queue: queueResource };
};

const isResolvedSqsEvent = (
  event: ServerlessFunctionEvent,
  resourceDeclarations: ResourceDeclarations
): event is Extract<ServerlessFunctionEvent, { type: "sqs" }> =>
  event.type === "sqs" &&
  resolveSqsEventSource(event, resourceDeclarations).queue !== undefined;

const areaLabels: Record<ServerlessMigrationArea, string> = {
  build: "Build",
  events: "Events",
  iam: "IAM",
  plugins: "Plugins",
  resources: "Resources",
  routing: "Routing",
  "unknown-fields": "Unknown fields",
};

const riskLabels: Record<ServerlessMigrationRisk, string> = {
  high: "High",
  low: "Low",
  medium: "Medium",
};

const createGeneratedFiles = (
  service: ServerlessService,
  outDirectory: string
): ServerlessMigrationGeneratedFile[] => {
  const files: ServerlessMigrationGeneratedFile[] = [
    {
      confidence: "high",
      path: `${outDirectory}/package.json`,
      purpose: "Bun-first project scripts and dependencies.",
    },
    {
      confidence: "high",
      path: `${outDirectory}/tsconfig.json`,
      purpose: "TypeScript project configuration.",
    },
    {
      confidence: "high",
      path: `${outDirectory}/voke.config.ts`,
      purpose: "Config-first Voke application and resource declarations.",
    },
    {
      confidence: "high",
      path: `${outDirectory}/src/index.ts`,
      purpose: "Generated Function-first Gateway entrypoint.",
    },
    {
      confidence: "high",
      path: `${outDirectory}/MIGRATION_REPORT.md`,
      purpose: "Actionable migration report.",
    },
    {
      confidence: "high",
      path: `${outDirectory}/SERVERLESS_COMPATIBILITY.md`,
      purpose: "Stable compatibility matrix.",
    },
  ];
  const workerFunctions = Object.values(service.functions).filter(
    hasWorkerEvent
  );

  if (workerFunctions.length > 0) {
    files.push({
      confidence: "high",
      path: `${outDirectory}/src/functions/index.ts`,
      purpose: "Generated worker Function Registry.",
    });
  }

  for (const fn of Object.values(service.functions)) {
    if (hasHttpEvent(fn)) {
      files.push({
        confidence: "high",
        path: `${outDirectory}/src/routes/${kebabCase(fn.name)}.ts`,
        purpose: `Route skeleton for ${fn.name}.`,
      });
    }

    if (hasWorkerEvent(fn)) {
      files.push({
        confidence: "medium",
        path: `${outDirectory}/src/functions/${kebabCase(fn.name)}.ts`,
        purpose: `Worker function skeleton for ${fn.name}.`,
      });
    }
  }

  return files;
};

const eventManualReason = (event: ServerlessFunctionEvent): string => {
  switch (event.type) {
    case "s3": {
      return "S3 notifications require bucket notification wiring and permissions that Voke does not generate in this migration phase.";
    }
    case "schedule": {
      return "Scheduled triggers require EventBridge rule infrastructure that must be reviewed before migration.";
    }
    case "sns": {
      return "SNS subscriptions and publish/subscribe permissions are inventory-only in this migration phase.";
    }
    case "stream": {
      return "Stream event source mappings need batching, starting position, and source permissions reviewed manually.";
    }
    case "unsupported": {
      return `${event.name} is not an automatic Voke migration target. Recreate the trigger, permissions, batching, and failure behavior manually before cutting over.`;
    }
    default: {
      return "This event requires manual review before migration.";
    }
  }
};

const eventManualMessage = (
  fn: ServerlessFunction,
  event: ServerlessFunctionEvent
): string => {
  if (event.type === "unsupported") {
    return `Unsupported Serverless event ${event.name} on function ${fn.name}:`;
  }

  return `${event.type} event on ${fn.name} requires manual implementation.`;
};

const addSqsManualTask = (
  tasks: ServerlessMigrationManualTask[],
  fn: ServerlessFunction,
  event: ServerlessFunctionEvent,
  resourceDeclarations: ResourceDeclarations
): void => {
  if (event.type !== "sqs") {
    return;
  }

  const { reason } = resolveSqsEventSource(event, resourceDeclarations);

  if (reason === undefined) {
    return;
  }

  tasks.push({
    area: "events",
    confidence: "high",
    message: eventManualMessage(fn, event),
    reason,
    risk: "medium",
  });
};

const eventNeedsManualTask = (event: ServerlessFunctionEvent): boolean =>
  event.type === "s3" ||
  event.type === "schedule" ||
  event.type === "sns" ||
  event.type === "stream" ||
  event.type === "unsupported";

const addInventoryEventManualTask = (
  tasks: ServerlessMigrationManualTask[],
  fn: ServerlessFunction,
  event: ServerlessFunctionEvent
): void => {
  if (eventNeedsManualTask(event)) {
    tasks.push({
      area: "events",
      confidence: "high",
      message: eventManualMessage(fn, event),
      reason: eventManualReason(event),
      risk: event.type === "unsupported" ? "high" : "medium",
    });
  }
};

const createConvertedItems = (
  service: ServerlessService,
  outDirectory: string,
  pluginCompatibility: ServerlessPluginCompatibility[],
  resourceDeclarations: ResourceDeclarations
): ServerlessMigrationReportItem[] => {
  const converted: ServerlessMigrationReportItem[] = [
    {
      area: "routing",
      confidence: "high",
      file: `${outDirectory}/voke.config.ts`,
      message: `Service ${service.service} is represented as a Voke config-first project.`,
    },
  ];

  if (
    service.provider.stage !== undefined ||
    service.provider.region !== undefined
  ) {
    converted.push({
      area: "routing",
      confidence: "high",
      file: `${outDirectory}/voke.config.ts`,
      message: "Provider stage and region are represented in Voke config.",
    });
  }

  if (Object.keys(service.provider.environment).length > 0) {
    converted.push({
      area: "build",
      confidence: "medium",
      file: `${outDirectory}/voke.config.ts`,
      message:
        "Provider environment variables are copied into CloudFormation environment settings.",
    });
  }

  for (const resource of resourceDeclarations.generated) {
    converted.push({
      area: "resources",
      confidence: "medium",
      file: `${outDirectory}/voke.config.ts`,
      message: `${resource.name} (${resource.type}) is generated with ${resource.helper}.`,
    });
  }

  for (const fn of Object.values(service.functions)) {
    for (const event of fn.events) {
      if (event.type === "httpApi" || event.type === "http") {
        converted.push({
          area: "routing",
          confidence: "high",
          file: `${outDirectory}/src/routes/${kebabCase(fn.name)}.ts`,
          message: `${event.type === "httpApi" ? "HTTP API" : "REST API"} route ${event.method} ${event.path} is generated for ${fn.name}.`,
        });
      }

      if (event.type === "sqs") {
        const resolution = resolveSqsEventSource(event, resourceDeclarations);

        if (resolution.queue !== undefined) {
          converted.push({
            area: "events",
            confidence: "medium",
            file: `${outDirectory}/src/functions/${kebabCase(fn.name)}.ts`,
            message: `SQS Event Source ${fn.name} -> ${resolution.queue} is generated for ${fn.name}.`,
          });
        }
      }

      if (event.type === "eventBridge") {
        converted.push({
          area: "events",
          confidence: "medium",
          file: `${outDirectory}/src/functions/${kebabCase(fn.name)}.ts`,
          message: `EventBridge worker skeleton is generated for ${fn.name}.`,
        });
      }
    }
  }

  for (const plugin of pluginCompatibility) {
    if (plugin.status === "supported" || plugin.status === "mapped") {
      converted.push({
        area: "plugins",
        confidence: plugin.status === "supported" ? "high" : "medium",
        file: `${outDirectory}/SERVERLESS_COMPATIBILITY.md`,
        message: `Plugin ${plugin.name} is ${plugin.status}: ${plugin.summary}`,
        reason: plugin.mappedBehavior,
      });
    }
  }

  return converted;
};

const createManualTasks = (
  service: ServerlessService,
  outDirectory: string,
  pluginCompatibility: ServerlessPluginCompatibility[],
  resourceDeclarations: ResourceDeclarations,
  unknownFields: ServerlessUnknownField[]
): ServerlessMigrationManualTask[] => {
  const tasks: ServerlessMigrationManualTask[] = [
    {
      area: "routing",
      confidence: "high",
      file: `${outDirectory}/src/index.ts`,
      message:
        "Move one Serverless function at a time by routing migrated HTTP paths to Voke while the original service keeps the remaining functions.",
      reason:
        "This keeps the migration reversible while generated skeletons are reviewed.",
      risk: "low",
    },
    {
      area: "routing",
      confidence: "high",
      message:
        "Review generated route and worker handlers before deleting the matching Serverless Framework function.",
      reason:
        "Generated skeletons are starter code and do not migrate business logic.",
      risk: "medium",
    },
  ];

  if (service.provider.iamRoleStatements.length > 0) {
    tasks.push({
      area: "iam",
      confidence: "high",
      message:
        "Review provider IAM statements and translate required permissions into Voke resource bindings or CloudFormation policy configuration.",
      reason:
        "IAM statements can be security-sensitive and are reported rather than rewritten automatically.",
      risk: "high",
    });
  }

  if ((service.package?.patterns.length ?? 0) > 0) {
    tasks.push({
      area: "build",
      confidence: "medium",
      file: `${outDirectory}/package.json`,
      message:
        "Review Serverless package patterns against the generated Bun build workflow.",
      reason:
        "Voke builds with Bun and does not execute Serverless packaging filters.",
      risk: "medium",
    });
  }

  for (const resource of resourceDeclarations.unsupported) {
    tasks.push({
      area: "resources",
      confidence: "high",
      file: `${outDirectory}/voke.config.ts`,
      message: resource.reason,
      reason: `Resource type ${resource.type} or its properties are not safe to map automatically.`,
      risk: "high",
    });
  }

  for (const plugin of pluginCompatibility) {
    for (const step of plugin.manualSteps) {
      tasks.push({
        area: plugin.status === "mapped" ? "build" : "plugins",
        confidence: plugin.status === "manual" ? "high" : "medium",
        file: `${outDirectory}/SERVERLESS_COMPATIBILITY.md`,
        message: step,
        reason: `${plugin.name}: ${plugin.summary}`,
        risk: plugin.status === "manual" ? "high" : "medium",
      });
    }
  }

  for (const fn of Object.values(service.functions)) {
    for (const event of fn.events) {
      addSqsManualTask(tasks, fn, event, resourceDeclarations);
      addInventoryEventManualTask(tasks, fn, event);
    }
  }

  for (const field of unknownFields) {
    tasks.push({
      area: "unknown-fields",
      confidence: "high",
      message: `Review unknown Serverless field ${field.path}.`,
      reason: field.reason,
      risk: "medium",
    });
  }

  return tasks;
};

const markdownGeneratedFiles = (
  files: ServerlessMigrationGeneratedFile[]
): string =>
  markdownTable([
    ["Path", "Purpose", "Confidence"],
    ["---", "---", "---"],
    ...files.map((file) => [`\`${file.path}\``, file.purpose, file.confidence]),
  ]);

const markdownConvertedItems = (
  items: ServerlessMigrationReportItem[]
): string => {
  if (items.length === 0) {
    return noMarkdownRows("No converted behavior detected.", 4);
  }

  return markdownTable([
    ["Area", "Behavior", "Generated output", "Confidence"],
    ["---", "---", "---", "---"],
    ...items.map((item) => [
      areaLabels[item.area],
      item.reason === undefined
        ? item.message
        : `${item.message} Reason: ${item.reason}`,
      item.file === undefined ? "-" : `\`${item.file}\``,
      item.confidence,
    ]),
  ]);
};

const markdownManualTasksByRisk = (
  tasks: ServerlessMigrationManualTask[]
): string => {
  if (tasks.length === 0) {
    return "- No manual work detected.";
  }

  return (["high", "medium", "low"] as const)
    .map((risk) => {
      const rows = tasks.filter((task) => task.risk === risk);

      if (rows.length === 0) {
        return `### ${riskLabels[risk]} risk\n\n- No ${risk} risk manual work.`;
      }

      return `### ${riskLabels[risk]} risk\n\n${markdownTable([
        ["Area", "Task", "Reason", "Generated output", "Confidence"],
        ["---", "---", "---", "---", "---"],
        ...rows.map((task) => [
          areaLabels[task.area],
          task.message,
          task.reason ?? "-",
          task.file === undefined ? "-" : `\`${task.file}\``,
          task.confidence,
        ]),
      ])}`;
    })
    .join("\n\n");
};

const markdownPluginNotes = (
  plugins: ServerlessPluginCompatibility[]
): string => {
  if (plugins.length === 0) {
    return "- No plugins detected.";
  }

  return markdownTable([
    ["Plugin", "Status", "Notes", "Manual work"],
    ["---", "---", "---", "---"],
    ...plugins.map((plugin) => [
      `\`${plugin.name}\``,
      plugin.status,
      [...plugin.notes, plugin.mappedBehavior ?? ""].filter(Boolean).join(" "),
      plugin.manualSteps.length === 0 ? "-" : plugin.manualSteps.join(" "),
    ]),
  ]);
};

const compatibilityManualWork = (
  tasks: ServerlessMigrationManualTask[],
  area: ServerlessMigrationArea,
  fallback = "-"
): string => {
  const matchingTasks = tasks
    .filter((task) => task.area === area)
    .map((task) => task.message);

  return matchingTasks.length === 0 ? fallback : matchingTasks.join(" ");
};

const compatibilityEventManualWork = (
  tasks: ServerlessMigrationManualTask[],
  eventType: string
): string => {
  const matchingTasks = tasks
    .filter(
      (task) =>
        task.area === "events" && task.message.startsWith(`${eventType} event`)
    )
    .map((task) => task.message);

  return matchingTasks.length === 0 ? "-" : matchingTasks.join(" ");
};

const sqsCompatibilityStatus = (
  hasSqs: boolean,
  hasSupportedSqs: boolean
): string => {
  if (hasSupportedSqs) {
    return "Supported";
  }

  if (hasSqs) {
    return "Manual work";
  }

  return "Not present";
};

const sqsCompatibilityOutput = (hasSupportedSqs: boolean): string =>
  hasSupportedSqs ? "Generated Voke SQS Event Source definitions." : "-";

const createCompatibilityMarkdown = (
  service: ServerlessService,
  report: ServerlessMigrationReport
): string => {
  const hasHttpApi = Object.values(service.functions).some((fn) =>
    fn.events.some((event) => event.type === "httpApi")
  );
  const hasHttp = Object.values(service.functions).some((fn) =>
    fn.events.some((event) => event.type === "http")
  );
  const hasSqs = Object.values(service.functions).some((fn) =>
    fn.events.some((event) => event.type === "sqs")
  );
  const hasSupportedSqs = report.converted.some((item) =>
    item.message.startsWith("SQS Event Source ")
  );
  const hasEventBridge = Object.values(service.functions).some((fn) =>
    fn.events.some((event) => event.type === "eventBridge")
  );
  const hasInventoryEvent = (type: ServerlessFunctionEvent["type"]): boolean =>
    Object.values(service.functions).some((fn) =>
      fn.events.some((event) => event.type === type)
    );
  const generatedResourceSummary = report.converted
    .filter((item) => item.area === "resources")
    .map((item) => item.message)
    .join(" ");
  const rows = [
    [
      "Service name",
      "Supported",
      "high",
      "`voke.config.ts`",
      "Review naming before replacing production service.",
    ],
    [
      "Provider stage and region",
      service.provider.stage !== undefined ||
      service.provider.region !== undefined
        ? "Supported"
        : "Defaulted",
      "high",
      "`voke.config.ts`",
      "-",
    ],
    [
      "Provider environment",
      Object.keys(service.provider.environment).length > 0
        ? "Supported"
        : "Not present",
      "medium",
      "`voke.config.ts`",
      "Review deployment-time secrets and environment sources.",
    ],
    [
      "Provider IAM statements",
      service.provider.iamRoleStatements.length > 0
        ? "Reported"
        : "Not present",
      "high",
      "-",
      compatibilityManualWork(report.manualTasks, "iam"),
    ],
    [
      "Package patterns",
      (service.package?.patterns.length ?? 0) > 0 ? "Reported" : "Not present",
      "medium",
      "`package.json`",
      compatibilityManualWork(report.manualTasks, "build"),
    ],
    [
      "HTTP API event",
      hasHttpApi ? "Supported" : "Not present",
      "high",
      "Generated Route Builder files.",
      "-",
    ],
    [
      "REST API event",
      hasHttp ? "Supported" : "Not present",
      "high",
      "Generated Route Builder files.",
      "-",
    ],
    [
      "SQS Event Source",
      sqsCompatibilityStatus(hasSqs, hasSupportedSqs),
      "medium",
      sqsCompatibilityOutput(hasSupportedSqs),
      compatibilityEventManualWork(report.manualTasks, "sqs"),
    ],
    [
      "EventBridge worker",
      hasEventBridge ? "Supported skeleton" : "Not present",
      "medium",
      "Generated Voke Function files.",
      "Review EventBridge rules before production cutover.",
    ],
    [
      "Native CloudFormation resources",
      generatedResourceSummary === "" ? "Not present" : "Supported skeleton",
      "medium",
      "`voke.config.ts`",
      compatibilityManualWork(report.manualTasks, "resources"),
    ],
    [
      "SNS event",
      hasInventoryEvent("sns") ? "Inventory only" : "Not present",
      "high",
      "-",
      compatibilityEventManualWork(report.manualTasks, "sns"),
    ],
    [
      "S3 event",
      hasInventoryEvent("s3") ? "Inventory only" : "Not present",
      "high",
      "-",
      compatibilityEventManualWork(report.manualTasks, "s3"),
    ],
    [
      "Schedule event",
      hasInventoryEvent("schedule") ? "Inventory only" : "Not present",
      "high",
      "-",
      compatibilityEventManualWork(report.manualTasks, "schedule"),
    ],
    [
      "Stream event",
      hasInventoryEvent("stream") ? "Inventory only" : "Not present",
      "high",
      "-",
      compatibilityEventManualWork(report.manualTasks, "stream"),
    ],
    [
      "Plugins",
      service.plugins.length > 0 ? "Reported" : "Not present",
      "medium",
      "`SERVERLESS_COMPATIBILITY.md`",
      compatibilityManualWork(report.manualTasks, "plugins"),
    ],
  ];

  return `# Serverless Framework Compatibility Matrix

Detected service: \`${service.service}\`

${markdownTable([
  ["Pattern", "Status", "Confidence", "Generated output", "Manual work"],
  ["---", "---", "---", "---", "---"],
  ...rows,
])}

## Plugin compatibility

${markdownPluginNotes(report.pluginCompatibility)}
`;
};

const reportSummary = (
  service: ServerlessService,
  report: ServerlessMigrationReport
): string =>
  markdownTable([
    ["Metric", "Value"],
    ["---", "---"],
    ["Service", `\`${service.service}\``],
    ["Generated files", String(report.generatedFiles.length)],
    ["Converted behavior", String(report.converted.length)],
    ["Manual tasks", String(report.manualTasks.length)],
    ["Unknown fields", String(report.unknownFields.length)],
  ]);

const createReportMarkdown = (
  service: ServerlessService,
  report: ServerlessMigrationReport
): string => `# Serverless Framework Migration Report

## Summary

${reportSummary(service, report)}

## Generated files

${markdownGeneratedFiles(report.generatedFiles)}

## Converted behavior

${markdownConvertedItems(report.converted)}

## Manual work by risk

${markdownManualTasksByRisk(report.manualTasks)}

## Plugin notes

${markdownPluginNotes(report.pluginCompatibility)}

## Unknown fields

${markdownUnknownFields(report.unknownFields)}

## Compatibility projections

### Supported features

${maybeMarkdownList(report.supported, "No supported features detected.")}

### Unsupported features

${maybeMarkdownList(report.unsupported, "No unsupported features detected.")}

### Manual steps

${maybeMarkdownList(report.manualSteps, "No manual steps detected.")}

## Function inventory

${markdownList(
  Object.values(service.functions).map((fn) => {
    const events = fn.events.map(eventTypeLabel).join(", ") || "no events";

    return `${fn.name}: ${fn.handler ?? "no handler"} (${events})`;
  })
)}

## Event inventory

${createEventInventoryMarkdown(service)}
`;

const sqsEventSourceExpression = (
  event: Extract<ServerlessFunctionEvent, { type: "sqs" }>,
  queue: string
): string => {
  const options = [
    event.batchSize === undefined ? undefined : `batchSize: ${event.batchSize}`,
    event.enabled === undefined ? undefined : `enabled: ${event.enabled}`,
    event.maximumBatchingWindow === undefined
      ? undefined
      : `maxBatchingWindowSeconds: ${event.maximumBatchingWindow}`,
  ].filter((option): option is string => option !== undefined);

  return options.length === 0
    ? `sqsEventSource(${tsString(queue)})`
    : `sqsEventSource(${tsString(queue)}, { ${options.join(", ")} })`;
};

const createSqsFunctionTemplate = (
  fn: ServerlessFunction,
  resourceDeclarations: ResourceDeclarations
): string | undefined => {
  const sqsEvents = fn.events.filter((event) =>
    isResolvedSqsEvent(event, resourceDeclarations)
  );

  if (sqsEvents.length === 0) {
    return undefined;
  }

  const exportName = toIdentifier(fn.name, "migratedFunction");
  const runtime = fn.runtime ?? undefined;
  const supportedRuntime =
    runtime === "nodejs22.x" || runtime === "nodejs24.x" ? runtime : undefined;
  const runtimeLine =
    supportedRuntime === undefined
      ? ""
      : `\n    runtime: ${tsString(supportedRuntime)},`;
  const eventSources = sqsEvents.map((event) => {
    const { queue } = resolveSqsEventSource(event, resourceDeclarations);

    if (queue === undefined) {
      throw new Error(`Expected resolved SQS event for ${fn.name}`);
    }

    return sqsEventSourceExpression(event, queue);
  });

  return `import { defineFunction, sqsEventSource, sqsMessageBatch } from "voke";

const messageSchema = {
  "~standard": {
    validate: (value: unknown) => ({ data: value, success: true }),
    vendor: "voke-migration",
    version: 1,
  },
} as const;

// Original Serverless handler: ${fn.handler ?? "not specified"}
export const ${exportName} = defineFunction({
  name: ${tsString(fn.name)},
  synthesis: {
    entrypoint: ${tsString(`./src/functions/${kebabCase(fn.name)}.ts`)},
    handler: ${tsString(`${exportName}.handler`)},${runtimeLine}
  },
  events: [${eventSources.join(", ")}],
  input: sqsMessageBatch(messageSchema),
  handler: async (payload) => {
    return payload.ok();
  },
});
`;
};

const createFunctionTemplate = (
  fn: ServerlessFunction,
  resourceDeclarations: ResourceDeclarations
): string => {
  const sqsTemplate = createSqsFunctionTemplate(fn, resourceDeclarations);

  if (sqsTemplate !== undefined) {
    return sqsTemplate;
  }

  const exportName = toIdentifier(fn.name, "migratedFunction");
  const runtime = fn.runtime ?? undefined;
  const supportedRuntime =
    runtime === "nodejs22.x" || runtime === "nodejs24.x" ? runtime : undefined;
  const runtimeLine =
    supportedRuntime === undefined
      ? ""
      : `\n    runtime: ${tsString(supportedRuntime)},`;
  const eventTypes = fn.events
    .filter((event) => event.type === "sqs" || event.type === "eventBridge")
    .map((event) => event.type);

  return `import { defineFunction } from "voke";

// Original Serverless handler: ${fn.handler ?? "not specified"}
export const ${exportName} = defineFunction({
  name: ${tsString(fn.name)},
  synthesis: {
    entrypoint: ${tsString(`./src/functions/${kebabCase(fn.name)}.ts`)},
    handler: ${tsString(`${exportName}.handler`)},${runtimeLine}
  },
  handler: async (payload: unknown) => {
    return {
      data: {
        eventTypes: ${JSON.stringify(eventTypes)},
        functionName: ${tsString(fn.name)},
        migrated: true,
        originalHandler: ${tsString(fn.handler ?? "not specified")},
        payload,
      },
    };
  },
});
`;
};

const createFunctionsTemplate = (functions: ServerlessFunction[]): string => {
  const imports = functions.map((fn) => {
    const exportName = toIdentifier(fn.name, "migratedFunction");

    return `import { ${exportName} } from "./${kebabCase(fn.name)}";`;
  });
  const registryEntries = functions.map((fn) => {
    const exportName = toIdentifier(fn.name, "migratedFunction");

    return `  ${tsString(fn.name)}: ${exportName},`;
  });

  return `import { defineFunctions } from "voke";
${imports.join("\n")}

export const functions = defineFunctions({
${registryEntries.join("\n")}
});
`;
};

const createRouteTemplate = (fn: ServerlessFunction): string => {
  const exportName = `create${pascalCase(fn.name, "Migrated")}Routes`;
  const routes = fn.events
    .filter((event) => event.type === "http" || event.type === "httpApi")
    .map((event) => {
      const method = event.method.toLowerCase();
      const routePath = honoPath(event.path);

      return `app.${method}(${tsString(routePath)}, {
    handler: () => ({
    functionName: ${tsString(fn.name)},
    method: ${tsString(event.method)},
    migrated: true,
    originalHandler: ${tsString(fn.handler ?? "not specified")},
    path: ${tsString(event.path)},
  }),
  })`;
    });

  return `import type { Voke } from "voke";

export const ${exportName} = (app: Voke) => [
  ${routes.join(",\n  ")},
] as const;
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
  const workerFunctions = Object.values(service.functions).filter(
    hasWorkerEvent
  );
  const resources = createResourceDeclarations(service).generated;
  const vokeImports = ["defineConfig"];
  const functionImport =
    workerFunctions.length === 0
      ? ""
      : '\nimport { functions } from "./src/functions";';
  const resourceImports =
    resources.length === 0
      ? ""
      : `\nimport { ${[...new Set(resources.map((resource) => resource.helper))]
          .toSorted()
          .join(", ")} } from "voke/aws";`;
  const resourceEntries = resources.map(
    (resource) => `      ${tsString(resource.name)}: ${resource.expression},`
  );
  const resourceBlock =
    resourceEntries.length === 0
      ? ""
      : `\n    resources: {\n${resourceEntries.join("\n")}\n    },`;
  const functionsBlock = workerFunctions.length === 0 ? "" : "  functions,\n";

  return `import { ${vokeImports.join(", ")} } from "voke";${functionImport}${resourceImports}

export default defineConfig({
  name: ${tsString(service.service)},
  stage: ${tsString(service.provider.stage ?? "local")},
  region: ${tsString(service.provider.region ?? "us-east-1")},
  entrypoint: "./src/index.ts",
${functionsBlock}  cloudFormation: {
    environment: ${stringifyObject(environment, 4).replaceAll("\n", "\n    ")},${resourceBlock}
  },
});
`;
};

const createIndexTemplate = (service: ServerlessService): string => {
  const routeImports: string[] = [];
  const routeCalls: string[] = [];
  const workerFunctions = Object.values(service.functions).filter(
    hasWorkerEvent
  );

  for (const fn of Object.values(service.functions)) {
    if (!hasHttpEvent(fn)) {
      continue;
    }

    const exportName = `create${pascalCase(fn.name, "Migrated")}Routes`;

    routeImports.push(
      `import { ${exportName} } from "./routes/${kebabCase(fn.name)}";`
    );
    routeCalls.push(`    ...${exportName}(app),`);
  }

  const functionImport =
    workerFunctions.length === 0
      ? ""
      : 'import { functions as workerFunctions } from "./functions";\n';
  const routeFunctionBlock =
    routeCalls.length === 0
      ? ""
      : `  routes: defineFunction({
    routes: [
${routeCalls.join("\n")}
    ],
  }),\n`;

  return `import { api, createGateway, defineFunction, defineFunctions, Voke } from "voke";
import config from "../voke.config";
${functionImport}${routeImports.join("\n")}

const app = new Voke();
const functions = defineFunctions({
  ...${workerFunctions.length === 0 ? "{}" : "workerFunctions"},
${routeFunctionBlock}});

const gateway = createGateway({
  config: { ...config, functions },
});

const service = api(gateway, { config });

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
    "@typescript/native-preview": "^7.0.0-dev.20260516.1",
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
  const resourceDeclarations = createResourceDeclarations(service);
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
      createCompatibilityMarkdown(service, report),
  };

  const workerFunctions = Object.values(service.functions).filter(
    hasWorkerEvent
  );

  if (workerFunctions.length > 0) {
    files[`${outDirectory}/src/functions/index.ts`] =
      createFunctionsTemplate(workerFunctions);
  }

  for (const fn of Object.values(service.functions)) {
    if (hasHttpEvent(fn)) {
      files[`${outDirectory}/src/routes/${kebabCase(fn.name)}.ts`] =
        createRouteTemplate(fn);
    }

    if (hasWorkerEvent(fn)) {
      files[`${outDirectory}/src/functions/${kebabCase(fn.name)}.ts`] =
        createFunctionTemplate(fn, resourceDeclarations);
    }
  }

  return files;
};

const addSupportedIf = (
  supported: string[],
  condition: boolean,
  label: string
): void => {
  if (condition) {
    supported.push(label);
  }
};

const createBaseSupportedFeatures = (service: ServerlessService): string[] => {
  const supported = ["service name"];

  addSupportedIf(
    supported,
    service.provider.stage !== undefined,
    "provider stage"
  );
  addSupportedIf(
    supported,
    service.provider.region !== undefined,
    "provider region"
  );
  addSupportedIf(
    supported,
    Object.keys(service.provider.environment).length > 0,
    "provider environment"
  );
  addSupportedIf(
    supported,
    service.provider.iamRoleStatements.length > 0,
    "provider IAM statements"
  );
  addSupportedIf(
    supported,
    service.provider.deploymentBucket !== undefined,
    "provider deployment bucket"
  );
  addSupportedIf(
    supported,
    (service.package?.patterns.length ?? 0) > 0,
    "package patterns"
  );
  addSupportedIf(
    supported,
    service.package?.individually !== undefined,
    "package individually flag"
  );
  addSupportedIf(supported, service.plugins.length > 0, "plugins inventory");
  addSupportedIf(
    supported,
    Object.keys(service.layers).length > 0,
    "layers inventory"
  );
  addSupportedIf(
    supported,
    Object.keys(service.custom).length > 0,
    "custom fields inventory"
  );
  addSupportedIf(
    supported,
    Object.keys(service.resources).length > 0,
    "resources inventory"
  );

  return supported;
};

const buildPluginCompatibility = (
  name: string,
  options: Omit<ServerlessPluginCompatibility, "name">
): ServerlessPluginCompatibility => ({
  manualSteps: options.manualSteps,
  mappedBehavior: options.mappedBehavior,
  name,
  notes: options.notes,
  status: options.status,
  summary: options.summary,
});

const buildBundlerPluginCompatibility = (
  name: string,
  configKey: string,
  toolName: string
): ServerlessPluginCompatibility =>
  buildPluginCompatibility(name, {
    manualSteps: [
      `Review \`custom.${configKey}\` options and port any required aliases, loaders, externals, or minification settings into the Voke build workflow.`,
    ],
    mappedBehavior:
      "Generated projects use `voke build`, which bundles with Bun.",
    notes: [
      `Voke uses Bun for builds, so ${toolName} plugin execution is not carried forward.`,
    ],
    status: "mapped",
    summary: "Build behavior maps to the Voke Bun build pipeline.",
  });

const pluginCompatibilityCatalog: Record<
  string,
  ServerlessPluginCompatibility
> = {
  "serverless-appsync-plugin": buildPluginCompatibility(
    "serverless-appsync-plugin",
    {
      manualSteps: [
        "Rebuild AppSync schema, resolvers, data sources, and permissions manually outside the generated Voke API skeleton.",
      ],
      notes: [
        "AppSync is a separate API surface from Hono HTTP routes and is not converted automatically.",
      ],
      status: "manual",
      summary: "AppSync configuration requires manual migration.",
    }
  ),
  "serverless-domain-manager": buildPluginCompatibility(
    "serverless-domain-manager",
    {
      manualSteps: [
        "Recreate custom domains, certificates, and DNS records manually in infrastructure after the generated API shape is reviewed.",
      ],
      notes: [
        "Custom domain resources are environment-specific and are not inferred safely.",
      ],
      status: "manual",
      summary:
        "Custom API domain management requires manual infrastructure migration.",
    }
  ),
  "serverless-dotenv-plugin": buildPluginCompatibility(
    "serverless-dotenv-plugin",
    {
      manualSteps: [
        "Review required environment variables for local, synth, and eventual deployment because Voke will not copy dotenv plugin injection rules.",
      ],
      mappedBehavior: "Bun loads `.env` automatically for local commands.",
      notes: [
        "Bun provides local `.env` loading, but deployment-time environment wiring still needs review.",
      ],
      status: "mapped",
      summary: "Local dotenv behavior maps to Bun environment loading.",
    }
  ),
  "serverless-esbuild": buildBundlerPluginCompatibility(
    "serverless-esbuild",
    "esbuild",
    "Serverless esbuild"
  ),
  "serverless-iam-roles-per-function": buildPluginCompatibility(
    "serverless-iam-roles-per-function",
    {
      manualSteps: [
        "Review every per-function IAM statement and translate the required permissions into Voke resource bindings or CloudFormation policy configuration.",
      ],
      notes: [
        "Voke generates one function role policy surface today; per-function IAM isolation is not converted automatically.",
      ],
      status: "manual",
      summary: "Per-function IAM behavior requires explicit security review.",
    }
  ),
  "serverless-offline": buildPluginCompatibility("serverless-offline", {
    manualSteps: [],
    mappedBehavior:
      "Use `voke dev` for local API feedback and `voke local start` for the configured local AWS provider.",
    notes: [
      "Voke does not run the Serverless Offline plugin, but the stable local workflow covers the same development loop.",
    ],
    status: "supported",
    summary:
      "Local development workflow is covered by Voke dev/local commands.",
  }),
  "serverless-plugin-aws-alerts": buildPluginCompatibility(
    "serverless-plugin-aws-alerts",
    {
      manualSteps: [
        "Recreate alarms, topics, and notification policies manually in CloudFormation or the chosen operations tooling.",
      ],
      notes: [
        "Alerting behavior is operational infrastructure and is not generated in this phase.",
      ],
      status: "manual",
      summary: "AWS alerting resources require manual migration.",
    }
  ),
  "serverless-plugin-datadog": buildPluginCompatibility(
    "serverless-plugin-datadog",
    {
      manualSteps: [
        "Reapply Datadog layers, environment variables, tracing configuration, and monitors manually after handlers are migrated.",
      ],
      notes: [
        "Observability plugins often inject layers and environment variables that Voke does not execute during migration.",
      ],
      status: "manual",
      summary: "Datadog instrumentation requires manual migration.",
    }
  ),
  "serverless-plugin-typescript": buildPluginCompatibility(
    "serverless-plugin-typescript",
    {
      manualSteps: [
        "Review TypeScript build hooks and generated artifacts; Voke expects source-first Bun builds and explicit handler exports.",
      ],
      mappedBehavior:
        "Generated projects use TypeScript source files with `voke build` and `bunx tsgo` typechecking.",
      notes: [
        "Voke does not execute Serverless TypeScript hooks during migration.",
      ],
      status: "mapped",
      summary:
        "TypeScript workflow maps to the Voke Bun build and typecheck workflow.",
    }
  ),
  "serverless-plugin-warmup": buildPluginCompatibility(
    "serverless-plugin-warmup",
    {
      manualSteps: [
        "Decide whether warmup is still needed; if it is, model the warmer as explicit infrastructure outside this stable migration phase.",
      ],
      notes: [
        "Warmup scheduling changes runtime behavior and is not generated automatically.",
      ],
      status: "manual",
      summary: "Lambda warmup behavior requires manual migration.",
    }
  ),
  "serverless-prune-plugin": buildPluginCompatibility(
    "serverless-prune-plugin",
    {
      manualSteps: [
        "Keep existing deployment pruning outside Voke stable commands until deployment lifecycle support becomes stable.",
      ],
      notes: [
        "Voke stable scope currently covers local/dev/build/synth, not deployment pruning.",
      ],
      status: "manual",
      summary: "Deployment pruning is outside the stable migration scope.",
    }
  ),
  "serverless-step-functions": buildPluginCompatibility(
    "serverless-step-functions",
    {
      manualSteps: [
        "Move Step Functions definitions and IAM permissions manually; Voke does not synthesize state machines in the stable local/dev/build/synth scope.",
      ],
      notes: [
        "State machines are application workflow infrastructure and are not converted automatically.",
      ],
      status: "manual",
      summary: "Step Functions definitions require manual migration.",
    }
  ),
  "serverless-webpack": buildBundlerPluginCompatibility(
    "serverless-webpack",
    "webpack",
    "Webpack"
  ),
};

const createUnknownPluginCompatibility = (
  name: string
): ServerlessPluginCompatibility =>
  buildPluginCompatibility(name, {
    manualSteps: [
      "Inspect the plugin documentation and migrate any generated resources, hooks, or packaging behavior manually.",
    ],
    notes: ["Unknown plugin behavior is preserved as manual migration work."],
    status: "manual",
    summary: "Unknown plugin behavior requires manual migration.",
  });

const createPluginCompatibility = (
  plugins: string[]
): ServerlessPluginCompatibility[] =>
  plugins.map(
    (plugin) =>
      pluginCompatibilityCatalog[plugin] ??
      createUnknownPluginCompatibility(plugin)
  );

const pluginUnsupportedMessage = (
  plugin: ServerlessPluginCompatibility
): string | undefined => {
  if (plugin.status === "supported" || plugin.status === "inventory-only") {
    return undefined;
  }

  if (
    plugin.name === "serverless-esbuild" ||
    plugin.name === "serverless-webpack"
  ) {
    return `plugin ${plugin.name} maps to Voke Bun build but requires bundler option review`;
  }

  if (plugin.name === "serverless-plugin-typescript") {
    return "plugin serverless-plugin-typescript maps to Voke build/typecheck but requires TypeScript hook review";
  }

  if (plugin.name === "serverless-dotenv-plugin") {
    return "plugin serverless-dotenv-plugin maps to Bun env loading but requires environment review";
  }

  if (plugin.name === "serverless-iam-roles-per-function") {
    return "plugin serverless-iam-roles-per-function requires per-function IAM review before migration";
  }

  if (plugin.summary === "Unknown plugin behavior requires manual migration.") {
    return `Unsupported Serverless plugin ${plugin.name}: behavior is unknown to Voke. Review the plugin documentation, then migrate any generated resources, hooks, or packaging behavior manually.`;
  }

  return `plugin ${plugin.name} requires manual migration: ${plugin.summary}`;
};

const addEventReport = (
  fn: ServerlessFunction,
  event: ServerlessFunctionEvent,
  resourceDeclarations: ResourceDeclarations,
  supported: string[],
  unsupported: string[]
): void => {
  const inventoryLabels = {
    s3: "S3",
    schedule: "Schedule",
    sns: "SNS",
    stream: "Stream",
  } as const;

  switch (event.type) {
    case "httpApi": {
      supported.push(
        `HTTP API event: ${fn.name} ${event.method} ${event.path}`
      );
      break;
    }
    case "http": {
      supported.push(
        `REST API event: ${fn.name} ${event.method} ${event.path}`
      );
      break;
    }
    case "sqs": {
      const { queue, reason } = resolveSqsEventSource(
        event,
        resourceDeclarations
      );

      if (queue === undefined) {
        unsupported.push(`${eventManualMessage(fn, event)} ${reason}`);
      } else {
        supported.push(`SQS Event Source: ${fn.name} -> ${queue}`);
      }
      break;
    }
    case "eventBridge": {
      supported.push(`EventBridge event: ${fn.name}`);
      break;
    }
    case "sns":
    case "s3":
    case "schedule":
    case "stream": {
      supported.push(
        `${inventoryLabels[event.type]} event inventory: ${fn.name}`
      );
      unsupported.push(
        `${eventManualMessage(fn, event)} ${eventManualReason(event)}`
      );
      break;
    }
    case "unsupported": {
      unsupported.push(
        `${eventManualMessage(fn, event)} ${eventManualReason(event)}`
      );
      break;
    }
    default: {
      break;
    }
  }
};

const collectReportUnknownFields = (
  service: ServerlessService
): ServerlessUnknownField[] => [
  ...service.unknownFields,
  ...service.provider.unknownFields,
  ...Object.values(service.functions).flatMap((fn) => [
    ...fn.unknownFields,
    ...(fn.package?.unknownFields ?? []),
    ...fn.events.flatMap((event) =>
      event.type === "unsupported" ? [] : event.unknownFields
    ),
  ]),
  ...(service.package?.unknownFields ?? []),
];

const createMigrationReport = (
  service: ServerlessService,
  outDirectory: string
): ServerlessMigrationReport => {
  const pluginCompatibility = createPluginCompatibility(service.plugins);
  const resourceDeclarations = createResourceDeclarations(service);
  const unknownFields = collectReportUnknownFields(service);
  const supported = createBaseSupportedFeatures(service);
  const unsupported: string[] = [];
  const generatedFiles = createGeneratedFiles(service, outDirectory);
  const converted = createConvertedItems(
    service,
    outDirectory,
    pluginCompatibility,
    resourceDeclarations
  );
  const manualTasks = createManualTasks(
    service,
    outDirectory,
    pluginCompatibility,
    resourceDeclarations,
    unknownFields
  );
  const manualSteps = manualTasks.map((task) => task.message);

  for (const resource of resourceDeclarations.generated) {
    supported.push(
      `CloudFormation resource: ${resource.name} ${resource.type}`
    );
  }

  for (const resource of resourceDeclarations.unsupported) {
    unsupported.push(resource.reason);
  }

  for (const plugin of pluginCompatibility) {
    const message = pluginUnsupportedMessage(plugin);

    if (message !== undefined) {
      unsupported.push(message);
    }
  }

  for (const fn of Object.values(service.functions)) {
    for (const event of fn.events) {
      addEventReport(fn, event, resourceDeclarations, supported, unsupported);
    }
  }

  return {
    converted,
    generatedFiles,
    manualSteps,
    manualTasks,
    pluginCompatibility,
    supported,
    unknownFields,
    unsupported,
  };
};

export const parseServerlessYaml = (source: string): ServerlessService => {
  const raw = parseYaml(source);
  const root = asObject(raw);
  const provider = asObject(root.provider);
  const providerIam = asObject(provider.iam);
  const providerIamRole = asObject(providerIam.role);
  const rawFunctions = asObject(root.functions);
  const functions: Record<string, ServerlessFunction> = {};
  const rootKnownKeys = [
    "custom",
    "functions",
    "layers",
    "package",
    "plugins",
    "provider",
    "resources",
    "service",
  ];
  const providerKnownKeys = [
    "deploymentBucket",
    "environment",
    "iam",
    "iamRoleStatements",
    "name",
    "region",
    "runtime",
    "stage",
  ];
  const functionKnownKeys = [
    "environment",
    "events",
    "handler",
    "layers",
    "memorySize",
    "package",
    "runtime",
    "timeout",
  ];

  for (const [name, value] of Object.entries(rawFunctions)) {
    const rawFunction = asObject(value);

    functions[name] = {
      environment: stringRecord(rawFunction.environment),
      events: parseFunctionEvents(rawFunction.events, name),
      handler: asOptionalString(rawFunction.handler),
      layers: asArray(rawFunction.layers),
      memorySize: asNumber(rawFunction.memorySize),
      name,
      package: createPackageConfig(
        rawFunction.package,
        `functions.${name}.package`
      ),
      runtime: asOptionalString(rawFunction.runtime),
      timeout: asNumber(rawFunction.timeout),
      unknownFields: collectUnknownFields(
        rawFunction,
        functionKnownKeys,
        `functions.${name}`,
        "function field is not converted automatically"
      ),
    };
  }

  return {
    custom: asObject(root.custom),
    functions,
    layers: asObject(root.layers),
    package: createPackageConfig(root.package, "package"),
    plugins: asArray(root.plugins).map(String),
    provider: {
      deploymentBucket: provider.deploymentBucket,
      environment: stringRecord(provider.environment),
      iamRoleStatements: asArray(
        provider.iamRoleStatements ?? providerIamRole.statements
      ),
      name: asOptionalString(provider.name),
      region: asOptionalString(provider.region),
      runtime: asOptionalString(provider.runtime),
      stage: asOptionalString(provider.stage),
      unknownFields: collectUnknownFields(
        provider,
        providerKnownKeys,
        "provider",
        "provider field is not converted automatically"
      ),
    },
    resources: asObject(root.resources),
    service: asOptionalString(root.service) ?? "api",
    unknownFields: collectUnknownFields(
      root,
      rootKnownKeys,
      "",
      "root field is not converted automatically"
    ).map((field) => ({
      ...field,
      path: field.path.slice(1),
    })),
  };
};

export const createServerlessMigration = (
  options: ServerlessMigrationOptions
): ServerlessMigration => {
  const service = parseServerlessYaml(options.source);
  const outDirectory = trimTrailingSlash(
    options.outDirectory ?? `./${service.service}-voke`
  );
  const report = createMigrationReport(service, outDirectory);
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
