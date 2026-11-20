import { CliUsageError } from "./cli-spec";
import { toEnvKey } from "./env-key";
import { projectPackageJson, tsconfig } from "./scaffold";

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

/**
 * `blocking`: the generated project differs from the Serverless service in who can call a route;
 * traffic must not move until the task is done.
 */
export type ServerlessMigrationRisk = "blocking" | "high" | "low" | "medium";

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
      private?: YamlValue;
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
  environment: Record<string, YamlValue>;
  events: ServerlessFunctionEvent[];
  layers: YamlValue[];
  package?: ServerlessPackageConfig;
  unknownFields: ServerlessUnknownField[];
}

export interface ServerlessHttpApiConfig {
  /** `provider.httpApi.authorizers`, one raw definition per authorizer name. */
  authorizers: RawObject;
  cors?: YamlValue;
}

export interface ServerlessService {
  service: string;
  provider: {
    name?: string;
    runtime?: string;
    stage?: YamlValue;
    region?: YamlValue;
    deploymentBucket?: YamlValue;
    environment: Record<string, YamlValue>;
    httpApi?: ServerlessHttpApiConfig;
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

// Only scalars become text; a mapping or a list is never stringified into "[object Object]".
const asOptionalString = (value: YamlValue | undefined): string | undefined => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return `${value}`;
  }

  return undefined;
};

const asArray = (value: YamlValue | undefined): YamlValue[] =>
  Array.isArray(value) ? value : [];

const asNumber = (value: YamlValue | undefined): number | undefined =>
  typeof value === "number" ? value : undefined;

const asBoolean = (value: YamlValue | undefined): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

// Bun.YAML resolves anchors, merge keys and block scalars, but drops custom tags without an
// error, so `!Ref X` would read as the string "X". Each CloudFormation short-form tag is first
// replaced by a marker the parser keeps; reviveYaml then turns markers into the long form.
const tagMarker = "";
const tagPattern = /^!([A-Za-z][A-Za-z0-9:]*)/u;
const valueIndicators = new Set([":", "-", "[", ",", "{"]);
const tagSeparators = new Set([" ", "\t", "[", ",", "{"]);
const blockScalarHeader = /(?:^|\s)[|>](?:[1-9][+-]?|[+-][1-9]?)?$/u;
const leadingSpaces = /^ */u;
const documentSeparator = /^---(?:\s|$)/mu;
const whitespace = /\s/u;

interface TagScanState {
  blockIndent?: number;
  flowDepth: number;
  quote?: string;
}

interface MarkedLine {
  code: string;
  comment: string;
  unreadable: boolean;
}

const indentOf = (line: string): number =>
  leadingSpaces.exec(line)?.[0].length ?? 0;

const isTagPosition = (
  line: string,
  index: number,
  lastSignificant: string | undefined
): boolean =>
  line[index + 1] !== "!" &&
  (index === 0 || tagSeparators.has(line[index - 1] ?? "")) &&
  (lastSignificant === undefined || valueIndicators.has(lastSignificant));

const nextNonSpace = (line: string, from: number): number => {
  let index = from;

  while (line[index] === " " || line[index] === "\t") {
    index += 1;
  }

  return index;
};

// Returns the source text consumed inside a quoted scalar: one character, or an escape pair.
const scanQuoted = (
  line: string,
  index: number,
  state: TagScanState
): string => {
  const char = line[index] ?? "";
  const next = line[index + 1];

  if (state.quote === '"' && char === "\\") {
    return `${char}${next ?? ""}`;
  }

  if (state.quote === "'" && char === "'" && next === "'") {
    return "''";
  }

  if (char === state.quote) {
    state.quote = undefined;
  }

  return char;
};

const blockValueStarts = new Set(["#", "|", ">", "*", "&"]);

interface TagReplacement {
  code: string;
  /** Index of the last source character the replacement consumed. */
  end: number;
  lastSignificant: string;
}

// Replaces the tag at `index` with a marker, or returns "unreadable" for a block-form tag.
const replaceTag = (
  line: string,
  index: number,
  name: string,
  state: TagScanState
): TagReplacement | "unreadable" => {
  const afterName = index + name.length + 1;
  const valueIndex = nextNonSpace(line, afterName);
  const next = line[valueIndex];
  const glued = valueIndex === afterName && !tagSeparators.has(next ?? "");

  if (next === undefined || glued || blockValueStarts.has(next)) {
    return "unreadable";
  }

  if (next === '"' || next === "'") {
    state.quote = next;

    return {
      code: `${next}${tagMarker}${name}${tagMarker}`,
      end: valueIndex,
      lastSignificant: next,
    };
  }

  if (next === "[" || next === "{") {
    state.flowDepth += 1;

    return {
      code:
        next === "["
          ? `[ "${tagMarker}${name}", `
          : `{ "${tagMarker}${name}": true, `,
      end: valueIndex,
      lastSignificant: ",",
    };
  }

  // A plain scalar follows: the marker becomes part of its text.
  return {
    code: `${tagMarker}${name}${tagMarker}`,
    end: valueIndex - 1,
    lastSignificant: tagMarker,
  };
};

const trackStructure = (
  char: string,
  atValueStart: boolean,
  state: TagScanState
): void => {
  if ((char === '"' || char === "'") && atValueStart) {
    state.quote = char;
  } else if ((char === "[" || char === "{") && atValueStart) {
    state.flowDepth += 1;
  } else if ((char === "]" || char === "}") && state.flowDepth > 0) {
    state.flowDepth -= 1;
  }
};

const startsComment = (line: string, index: number): boolean =>
  line[index] === "#" &&
  (index === 0 || whitespace.test(line[index - 1] ?? ""));

// Scans one line outside a block scalar; quote and flow state carry across lines.
const markLine = (line: string, state: TagScanState): MarkedLine => {
  let code = "";
  let lastSignificant: string | undefined;

  for (let index = 0; index < line.length; index += 1) {
    if (state.quote !== undefined) {
      const text = scanQuoted(line, index, state);

      code += text;
      index += text.length - 1;
      lastSignificant = text.at(-1);
      continue;
    }

    if (startsComment(line, index)) {
      return { code, comment: line.slice(index), unreadable: false };
    }

    const char = line[index] ?? "";
    const tagName =
      char === "!" && isTagPosition(line, index, lastSignificant)
        ? tagPattern.exec(line.slice(index))?.[1]
        : undefined;

    if (tagName !== undefined) {
      const replacement = replaceTag(line, index, tagName, state);

      if (replacement === "unreadable") {
        return { code: line, comment: "", unreadable: true };
      }

      code += replacement.code;
      index = replacement.end;
      ({ lastSignificant } = replacement);
      continue;
    }

    trackStructure(
      char,
      lastSignificant === undefined || valueIndicators.has(lastSignificant),
      state
    );
    code += char;

    if (char !== " " && char !== "\t") {
      lastSignificant = char;
    }
  }

  return { code, comment: "", unreadable: false };
};

const insideBlockScalar = (line: string, state: TagScanState): boolean => {
  if (state.blockIndent === undefined) {
    return false;
  }

  if (line.trim() === "" || indentOf(line) > state.blockIndent) {
    return true;
  }

  state.blockIndent = undefined;

  return false;
};

const markYamlTags = (source: string): string => {
  if (source.includes(tagMarker)) {
    throw new CliUsageError(
      "Cannot read serverless.yml: it contains the private-use character U+E000, which the migrator reserves."
    );
  }

  const state: TagScanState = { flowDepth: 0 };
  const unreadableLines: number[] = [];
  const lines = source.split("\n").map((line, index) => {
    if (insideBlockScalar(line, state)) {
      return line;
    }

    const marked = markLine(line, state);

    if (marked.unreadable) {
      unreadableLines.push(index + 1);
    }

    if (
      state.quote === undefined &&
      state.flowDepth === 0 &&
      blockScalarHeader.test(marked.code.trimEnd())
    ) {
      state.blockIndent = indentOf(line);
    }

    return `${marked.code}${marked.comment}`;
  });

  if (unreadableLines.length > 0) {
    throw new CliUsageError(
      `Cannot read serverless.yml: the migrator cannot read the tag on line ${unreadableLines.join(", line ")}, because a block value follows it or no space separates it from its value. Write the value in the long form instead, for example "Fn::Join:" in place of "!Join".`
    );
  }

  return lines.join("\n");
};

const longTagName = (name: string): string =>
  name === "Ref" || name === "Condition" ? name : `Fn::${name}`;

const markedTagName = (value: string): string | undefined => {
  if (!value.startsWith(tagMarker)) {
    return undefined;
  }

  const end = value.indexOf(tagMarker, 1);

  return end === -1 ? value.slice(1) : value.slice(1, end);
};

const assertNoMarker = (value: string): void => {
  if (value.includes(tagMarker)) {
    throw new CliUsageError(
      `Cannot read serverless.yml: the CloudFormation tag in ${JSON.stringify(value.replaceAll(tagMarker, "!"))} is in a position the migrator cannot read. Write it in the long form.`
    );
  }
};

const reviveTaggedScalar = (value: string): YamlValue => {
  const end = value.indexOf(tagMarker, 1);

  if (end === -1) {
    assertNoMarker(value);
  }

  const name = value.slice(1, end);
  const rest = value.slice(end + 1);

  assertNoMarker(rest);

  if (name === "GetAtt") {
    const dot = rest.indexOf(".");

    return {
      "Fn::GetAtt":
        dot === -1 ? [rest] : [rest.slice(0, dot), rest.slice(dot + 1)],
    };
  }

  return { [longTagName(name)]: rest };
};

// Returns a fresh tree: aliases share objects in Bun.YAML's output, and a self-referencing alias
// is a cycle that no Serverless value can mean.
const reviveYaml = (
  value: unknown,
  ancestors = new Set<object>()
): YamlValue => {
  if (typeof value === "string") {
    if (value.startsWith(tagMarker)) {
      return reviveTaggedScalar(value);
    }

    assertNoMarker(value);

    return value;
  }

  if (value === null || typeof value !== "object") {
    return value as YamlValue;
  }

  if (ancestors.has(value)) {
    throw new CliUsageError(
      "Cannot read serverless.yml: an alias refers to itself, so the value has no end."
    );
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const [first, ...rest] = value;
      const tag = typeof first === "string" ? markedTagName(first) : undefined;

      if (tag !== undefined && first === `${tagMarker}${tag}`) {
        return {
          [longTagName(tag)]: rest.map((item) => reviveYaml(item, ancestors)),
        };
      }

      return value.map((item) => reviveYaml(item, ancestors));
    }

    const entries = Object.entries(value);
    const tagKey = entries.find(([key]) => key.startsWith(tagMarker))?.[0];
    const revived: RawObject = {};

    for (const [key, entry] of entries) {
      if (key !== tagKey) {
        assertNoMarker(key);
        revived[key] = reviveYaml(entry, ancestors);
      }
    }

    if (tagKey === undefined) {
      return revived;
    }

    return { [longTagName(tagKey.slice(1))]: revived };
  } finally {
    ancestors.delete(value);
  }
};

const rootShape = (value: YamlValue, source: string): string => {
  if (value === null) {
    return "the file is empty";
  }

  if (Array.isArray(value)) {
    return documentSeparator.test(source)
      ? "the file holds several YAML documents"
      : "the root is a list";
  }

  return `the root is a ${typeof value}`;
};

const readServerlessYaml = (source: string): RawObject => {
  const marked = markYamlTags(source);
  let parsed: unknown;

  try {
    parsed = Bun.YAML.parse(marked);
  } catch (error) {
    throw new CliUsageError(
      `Cannot read serverless.yml: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const root = reviveYaml(parsed);

  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new CliUsageError(
      `Cannot read serverless.yml: ${rootShape(root, source)}. It must hold one mapping with a service, a provider and functions.`
    );
  }

  return root;
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
  const knownKeys =
    type === "http"
      ? ["authorizer", "cors", "method", "path", "private"]
      : ["authorizer", "cors", "method", "path"];

  return {
    ...(config.authorizer === undefined
      ? {}
      : { authorizer: config.authorizer }),
    ...(config.cors === undefined ? {} : { cors: config.cors }),
    ...(type === "http" && config.private !== undefined
      ? { private: config.private }
      : {}),
    method: (asOptionalString(config.method) ?? "GET").toUpperCase(),
    path: asOptionalString(config.path) ?? "/",
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

type ValueClass =
  | { kind: "literal"; text: string }
  | { kind: "variable" }
  | { kind: "intrinsic" }
  | { kind: "structure" };

const intrinsicKeyPattern = /^(?:Ref|Condition|Fn::.+)$/u;

/** The one gate between a parsed value and generated code: only literals are copied. */
const classifyValue = (value: YamlValue | undefined): ValueClass => {
  if (typeof value === "string") {
    return value.includes("${")
      ? { kind: "variable" }
      : { kind: "literal", text: value };
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "literal", text: `${value}` };
  }

  const keys = Object.keys(asObject(value));

  if (keys.length === 1 && intrinsicKeyPattern.test(keys[0] ?? "")) {
    return { kind: "intrinsic" };
  }

  return { kind: "structure" };
};

/** The original expression, for a report; the migrator resolves nothing. */
const describeValue = (value: YamlValue | undefined): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);

const literalString = (value: YamlValue | undefined): string | undefined => {
  const classified = classifyValue(value);

  return classified.kind === "literal" ? classified.text : undefined;
};

const literalOption = (
  name: string,
  value: string | undefined
): string | undefined =>
  value === undefined ? undefined : `${name}: ${tsString(value)}`;

const dynamoDbTableKeys = new Set([
  "AttributeDefinitions",
  "BillingMode",
  "KeySchema",
]);

// dynamodbTable types every key as a string, and has no table name, index or stream options.
const isLosslessDynamoDbTable = (properties: RawObject): boolean =>
  Object.keys(properties).every((key) => dynamoDbTableKeys.has(key)) &&
  (properties.KeySchema === undefined || Array.isArray(properties.KeySchema)) &&
  (properties.AttributeDefinitions === undefined ||
    Array.isArray(properties.AttributeDefinitions)) &&
  asArray(properties.AttributeDefinitions).every(
    (definition) => asObject(definition).AttributeType === "S"
  );

const createDynamoDbResourceExpression = (
  properties: RawObject
): { expression: string; helper: string } | undefined => {
  if (!isLosslessDynamoDbTable(properties)) {
    return undefined;
  }

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

const supportedLambdaRuntime = (
  runtime: string | undefined
): string | undefined =>
  runtime === "nodejs22.x" || runtime === "nodejs24.x" ? runtime : undefined;

interface ProviderValuePlan {
  /** Literal environment values, provider first, then function values under prefixed keys. */
  environment: Record<string, string>;
  providerEnvironmentCopied: boolean;
  region?: string;
  /** Function name to `KEY → FUNCTION_KEY` renames of copied function environment values. */
  renamedKeys: Map<string, string[]>;
  stage?: string;
  tasks: PlannedTask[];
}

const environmentReason = (value: YamlValue): string => {
  const { kind } = classifyValue(value);

  if (kind === "variable") {
    return "Serverless variables are not resolved. Read secrets and parameters with Runtime Variables (see the Runtime Variables guide), or compute the value in voke.config.ts.";
  }

  if (kind === "intrinsic") {
    return "CloudFormation references are not copied. Declare the resource in voke.config.ts and read it through a resource binding (see the Resources guide).";
  }

  return "Only strings, numbers and booleans are copied. Compute the value in voke.config.ts.";
};

/** A manual task before the output directory is known; `file` is relative to it. */
interface PlannedTask {
  area: ServerlessMigrationArea;
  file?: string;
  message: string;
  reason: string;
  risk: ServerlessMigrationRisk;
}

const toManualTask = (
  task: PlannedTask,
  outDirectory: string
): ServerlessMigrationManualTask => ({
  area: task.area,
  confidence: "high",
  ...(task.file === undefined ? {} : { file: `${outDirectory}/${task.file}` }),
  message: task.message,
  reason: task.reason,
  risk: task.risk,
});

const configFile = "voke.config.ts";
const stageNamePattern = /^[A-Za-z0-9-]+$/u;

const createProviderValuePlan = (
  service: ServerlessService
): ProviderValuePlan => {
  const tasks: PlannedTask[] = [];
  const { region, stage } = service.provider;
  const stageText = literalString(stage);
  const acceptedStage =
    stageText !== undefined && stageNamePattern.test(stageText)
      ? stageText
      : undefined;
  const regionText = literalString(region);
  const environment: Record<string, string> = {};
  const renamedKeys = new Map<string, string[]>();
  let providerEnvironmentCopied = false;

  if (stage !== undefined && acceptedStage === undefined) {
    tasks.push({
      area: "routing",
      file: configFile,
      message: `Provider stage ${describeValue(stage)} is not copied to voke.config.ts.`,
      reason:
        "It is not a literal stage name. Voke takes the stage from `voke deploy --stage <name>` or `VOKE_STAGE`.",
      risk: "medium",
    });
  }

  if (region !== undefined && regionText === undefined) {
    tasks.push({
      area: "routing",
      file: configFile,
      message: `Provider region ${describeValue(region)} is not copied to voke.config.ts.`,
      reason:
        "It is not a literal. Without a region Voke uses `AWS_REGION`, then `us-east-1`; set `region` in voke.config.ts.",
      risk: "high",
    });
  }

  const copy = (path: string, key: string, value: YamlValue): boolean => {
    const text = literalString(value);

    if (text === undefined) {
      tasks.push({
        area: "build",
        file: configFile,
        message: `Environment variable ${key} is not copied to voke.config.ts; ${path} is ${describeValue(value)}.`,
        reason: environmentReason(value),
        risk: "high",
      });

      return false;
    }

    environment[key] = text;

    return true;
  };

  for (const [key, value] of Object.entries(service.provider.environment)) {
    providerEnvironmentCopied =
      copy(`provider.environment.${key}`, key, value) ||
      providerEnvironmentCopied;
  }

  for (const fn of Object.values(service.functions)) {
    for (const [key, value] of Object.entries(fn.environment)) {
      const target = `${toEnvKey(fn.name)}_${key}`;

      if (copy(`functions.${fn.name}.environment.${key}`, target, value)) {
        renamedKeys.set(fn.name, [
          ...(renamedKeys.get(fn.name) ?? []),
          `${key} → ${target}`,
        ]);
      }
    }
  }

  return {
    environment,
    providerEnvironmentCopied,
    region: regionText,
    renamedKeys,
    stage: acceptedStage,
    tasks,
  };
};

type HttpEvent = Extract<ServerlessFunctionEvent, { type: "http" | "httpApi" }>;

const blockedAuthorizerName = "migrationBlocked";
const reservedAuthorizerNames = new Set(["none", blockedAuthorizerName]);
// Request Authorizer Function keys that would collide with generated registry entries.
const reservedFunctionKeys = new Set([blockedAuthorizerName, "http"]);
const reservedExportNames = new Set([
  "authorizers",
  "createAuthorizers",
  "jwtAuthorizer",
  "lambdaAuthorizer",
  blockedAuthorizerName,
  "requestAuthorizer",
]);
const jwtAuthorizerKeys = new Set([
  "audience",
  "identitySource",
  "issuerUrl",
  "name",
  "type",
]);
const requestAuthorizerKeys = new Set([
  "enableSimpleResponses",
  "functionArn",
  "functionName",
  "identitySource",
  "managedExternally",
  "name",
  "payloadVersion",
  "resultTtlInSeconds",
  "type",
]);
const eventReferenceKeys = new Set(["name", "scopes"]);

type RouteAuthorization =
  | { kind: "public" }
  | { kind: "converted"; name: string }
  | { kind: "blocked"; reason: string };

interface RouteAuthorizerPlan {
  authorization: RouteAuthorization;
  event: HttpEvent;
  fn: ServerlessFunction;
  /** Every task this route depends on, including those of its authorizer. */
  tasks: PlannedTask[];
}

type AuthorizerConversion =
  | {
      kind: "converted";
      expression: string;
      helper: "jwtAuthorizer" | "lambdaAuthorizer";
      requestFunction?: string;
      tasks: PlannedTask[];
    }
  | { kind: "blocked"; reason: string };

interface AuthorizerPlan {
  hasProtectedRoutes: boolean;
  helpers: Set<string>;
  needsBlocked: boolean;
  registry: { expression: string; helper: string; name: string }[];
  requestFunctions: { exportName: string; fn: ServerlessFunction }[];
  routes: Map<HttpEvent, RouteAuthorizerPlan>;
  tasks: PlannedTask[];
}

const authorizersFile = "src/authorizers.ts";

const literalStrings = (
  value: YamlValue | undefined
): string | string[] | undefined => {
  if (typeof value === "string") {
    return literalString(value);
  }

  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const items = value.map((item) =>
    typeof item === "string" ? literalString(item) : undefined
  );

  return items.every((item) => item !== undefined)
    ? (items as string[])
    : undefined;
};

const tsLiteral = (value: string | string[]): string =>
  typeof value === "string" ? tsString(value) : JSON.stringify(value);

const unknownKeysReason = (
  name: string,
  config: RawObject,
  known: Set<string>
): string | undefined => {
  const unknown = Object.keys(config).filter((key) => !known.has(key));

  return unknown.length === 0
    ? undefined
    : `Authorizer ${name} sets ${unknown.join(", ")}, which the migrator does not convert.`;
};

const identitySourceOption = (
  name: string,
  config: RawObject
): { option?: string; reason?: string } => {
  if (config.identitySource === undefined) {
    return {};
  }

  const identitySource = literalStrings(config.identitySource);

  return identitySource === undefined
    ? {
        reason: `Authorizer ${name} has identitySource ${describeValue(config.identitySource)}; only literal values are converted.`,
      }
    : { option: `identitySource: ${tsLiteral(identitySource)}` };
};

const authorizerExpression = (helper: string, options: string[]): string =>
  `${helper}({\n${options.map((option) => `    ${option},`).join("\n")}\n  })`;

const convertJwtAuthorizer = (
  name: string,
  config: RawObject
): AuthorizerConversion => {
  const unknown = unknownKeysReason(name, config, jwtAuthorizerKeys);

  if (unknown !== undefined) {
    return { kind: "blocked", reason: unknown };
  }

  const issuer = literalString(config.issuerUrl);
  const audience = literalStrings(config.audience);

  if (issuer === undefined || audience === undefined) {
    return {
      kind: "blocked",
      reason: `JWT Authorizer ${name} has issuerUrl ${describeValue(config.issuerUrl)} and audience ${describeValue(config.audience)}; only literal values are converted.`,
    };
  }

  const identitySource = identitySourceOption(name, config);

  if (identitySource.reason !== undefined) {
    return { kind: "blocked", reason: identitySource.reason };
  }

  return {
    expression: authorizerExpression("jwtAuthorizer", [
      `issuer: ${tsString(issuer)}`,
      `audience: ${tsLiteral(audience)}`,
      ...(identitySource.option === undefined ? [] : [identitySource.option]),
    ]),
    helper: "jwtAuthorizer",
    kind: "converted",
    tasks: [],
  };
};

const requestAuthorizerTarget = (
  service: ServerlessService,
  name: string,
  config: RawObject
):
  | { kind: "blocked"; reason: string }
  | { kind: "function"; functionName: string }
  | { kind: "arn"; arn: string } => {
  if (config.functionName !== undefined && config.functionArn !== undefined) {
    return {
      kind: "blocked",
      reason: `Authorizer ${name} sets both functionName and functionArn.`,
    };
  }

  if (config.functionName !== undefined) {
    const functionName = literalString(config.functionName);
    const target =
      functionName === undefined ? undefined : service.functions[functionName];

    if (functionName === undefined || target === undefined) {
      return {
        kind: "blocked",
        reason: `Authorizer ${name} uses functionName ${describeValue(config.functionName)}, which is not a function of this service.`,
      };
    }

    if (target.events.length > 0 || reservedFunctionKeys.has(functionName)) {
      return {
        kind: "blocked",
        reason: `Authorizer ${name} uses function ${functionName}, which cannot become a Request Authorizer Function because it also has events or its name is reserved.`,
      };
    }

    return { functionName, kind: "function" };
  }

  const arn = literalString(config.functionArn);

  if (arn === undefined) {
    return {
      kind: "blocked",
      reason: `Authorizer ${name} has functionArn ${describeValue(config.functionArn)}; only a literal ARN is converted.`,
    };
  }

  if (config.enableSimpleResponses !== true) {
    return {
      kind: "blocked",
      reason: `Authorizer ${name} returns IAM policy responses (enableSimpleResponses is not true); Voke Lambda Authorizers accept only simple responses.`,
    };
  }

  return { arn, kind: "arn" };
};

const convertRequestAuthorizer = (
  service: ServerlessService,
  name: string,
  config: RawObject
): AuthorizerConversion => {
  const unknown = unknownKeysReason(name, config, requestAuthorizerKeys);
  const { payloadVersion } = config;

  if (unknown !== undefined) {
    return { kind: "blocked", reason: unknown };
  }

  if (
    payloadVersion !== undefined &&
    payloadVersion !== "2.0" &&
    payloadVersion !== 2
  ) {
    return {
      kind: "blocked",
      reason: `Authorizer ${name} uses payloadVersion ${describeValue(payloadVersion)}; Voke Lambda Authorizers use payload format 2.0.`,
    };
  }

  const identitySource = identitySourceOption(name, config);

  if (identitySource.reason !== undefined) {
    return { kind: "blocked", reason: identitySource.reason };
  }

  const target = requestAuthorizerTarget(service, name, config);

  if (target.kind === "blocked") {
    return target;
  }

  const options = [
    target.kind === "function"
      ? `function: ${tsString(target.functionName)}`
      : `function: { arn: ${tsString(target.arn)} }`,
    ...(identitySource.option === undefined ? [] : [identitySource.option]),
    ...(typeof config.resultTtlInSeconds === "number"
      ? [`cacheTtlSeconds: ${config.resultTtlInSeconds}`]
      : []),
  ];
  const expression = authorizerExpression("lambdaAuthorizer", options);

  if (target.kind === "function") {
    const handler = service.functions[target.functionName]?.handler;

    return {
      expression,
      helper: "lambdaAuthorizer",
      kind: "converted",
      requestFunction: target.functionName,
      tasks: [
        {
          area: "routing",
          file: authorizersFile,
          message: `Port the logic of Request Authorizer Function ${target.functionName} (${handler ?? "no handler"}) into its generated skeleton.`,
          reason:
            "The skeleton denies every request until then. It must return a Voke Authorizer Result (`{ authorized, context }`), not an IAM policy.",
          risk: "blocking",
        },
      ],
    };
  }

  return {
    expression,
    helper: "lambdaAuthorizer",
    kind: "converted",
    tasks: [
      {
        area: "routing",
        file: authorizersFile,
        message: `Allow the new HTTP API to invoke the external authorizer ${target.arn} (Lambda Authorizer ${name}).`,
        reason:
          "Voke does not add invoke permissions for a Lambda Authorizer outside the Function Registry; until then API Gateway cannot call it.",
        risk: "high",
      },
    ],
  };
};

const convertAuthorizer = (
  service: ServerlessService,
  name: string
): AuthorizerConversion => {
  const definition = service.provider.httpApi?.authorizers[name];

  if (definition === undefined) {
    return {
      kind: "blocked",
      reason: `Authorizer ${name} is not declared in provider.httpApi.authorizers.`,
    };
  }

  const config = asObject(definition);
  const { type } = config;

  if (type === undefined || type === "jwt") {
    return convertJwtAuthorizer(name, config);
  }

  if (type === "request") {
    return convertRequestAuthorizer(service, name, config);
  }

  return {
    kind: "blocked",
    reason: `Authorizer ${name} has type ${describeValue(type)}, which the migrator does not convert.`,
  };
};

const authorizerReference = (
  value: YamlValue
): { name: string; scopes?: YamlValue } | { reason: string } => {
  if (typeof value === "string") {
    const name = literalString(value);

    return name === undefined
      ? { reason: `The authorizer ${value} is not a literal name.` }
      : { name };
  }

  const config = asObject(value);

  if (
    typeof config.type === "string" &&
    config.type.toLowerCase() === "aws_iam"
  ) {
    return { reason: "Voke has no IAM authorization for routes." };
  }

  if (config.id !== undefined) {
    return {
      reason:
        "Authorizers referenced by id belong to an API outside this service and are not converted.",
    };
  }

  const name =
    typeof config.name === "string" ? literalString(config.name) : undefined;
  const keys = Object.keys(config);

  if (
    name === undefined ||
    keys.length === 0 ||
    keys.some((key) => !eventReferenceKeys.has(key))
  ) {
    return {
      reason: `The authorizer setting ${describeValue(value)} is not a shape the migrator converts.`,
    };
  }

  return config.scopes === undefined
    ? { name }
    : { name, scopes: config.scopes };
};

const routeLabel = (event: HttpEvent): string =>
  event.type === "httpApi" ? "HTTP API" : "REST API";

const routeFile = (fn: ServerlessFunction): string =>
  `src/routes/${kebabCase(fn.name)}.ts`;

const resolveRouteAuthorizer = (
  event: HttpEvent,
  conversionOf: (name: string) => AuthorizerConversion
): { authorization: RouteAuthorization; tasks: PlannedTask[] } => {
  if (event.type === "http") {
    const isProtected =
      event.authorizer !== undefined ||
      (event.private !== undefined && event.private !== false);

    return isProtected
      ? {
          authorization: {
            kind: "blocked",
            reason: "REST API authorizers and API keys are not converted.",
          },
          tasks: [],
        }
      : { authorization: { kind: "public" }, tasks: [] };
  }

  if (event.authorizer === undefined) {
    return { authorization: { kind: "public" }, tasks: [] };
  }

  const reference = authorizerReference(event.authorizer);

  if ("reason" in reference) {
    return {
      authorization: { kind: "blocked", reason: reference.reason },
      tasks: [],
    };
  }

  if (reservedAuthorizerNames.has(reference.name)) {
    return {
      authorization: {
        kind: "blocked",
        reason: `The authorizer name ${reference.name} is reserved in Voke.`,
      },
      tasks: [],
    };
  }

  const conversion = conversionOf(reference.name);

  if (conversion.kind === "blocked") {
    return { authorization: conversion, tasks: [] };
  }

  if (reference.scopes === undefined) {
    return {
      authorization: { kind: "converted", name: reference.name },
      tasks: conversion.tasks,
    };
  }

  if (conversion.helper !== "jwtAuthorizer") {
    return {
      authorization: {
        kind: "blocked",
        reason: `Authorizer ${reference.name} is not a JWT Authorizer, so its scopes ${describeValue(reference.scopes)} have no equivalent.`,
      },
      tasks: [],
    };
  }

  return {
    authorization: { kind: "converted", name: reference.name },
    tasks: [
      ...conversion.tasks,
      {
        area: "routing",
        message: `${routeLabel(event)} route ${event.method} ${event.path} requires scopes ${describeValue(reference.scopes)} on JWT Authorizer ${reference.name}.`,
        reason:
          "Voke does not enforce JWT scopes; any valid token passes. Check the `scope` claim in the handler.",
        risk: "blocking",
      },
    ],
  };
};

const requestFunctionExportName = (functionName: string): string => {
  const identifier = toIdentifier(functionName, "authorizerFunction");

  return reservedExportNames.has(identifier)
    ? `${identifier}Function`
    : identifier;
};

const httpEventsOf = (fn: ServerlessFunction): HttpEvent[] =>
  fn.events.filter(
    (event): event is HttpEvent =>
      event.type === "http" || event.type === "httpApi"
  );

const pushUniqueTask = (tasks: PlannedTask[], task: PlannedTask): void => {
  if (!tasks.some((existing) => existing.message === task.message)) {
    tasks.push(task);
  }
};

const unusedAuthorizersTask = (
  service: ServerlessService,
  used: Set<string>
): PlannedTask | undefined => {
  const unused = Object.keys(
    service.provider.httpApi?.authorizers ?? {}
  ).filter((name) => !used.has(name));

  return unused.length === 0
    ? undefined
    : {
        area: "routing",
        message: `Authorizers ${unused.join(", ")} are declared in provider.httpApi.authorizers but no route uses them; they are not generated.`,
        reason: "Voke registers only the HTTP Authorizers that routes name.",
        risk: "low",
      };
};

// The single reader of `event.authorizer`: every generated file and report row derives from it.
const createAuthorizerPlan = (service: ServerlessService): AuthorizerPlan => {
  const conversions = new Map<string, AuthorizerConversion>();
  const conversionOf = (name: string): AuthorizerConversion => {
    const cached = conversions.get(name) ?? convertAuthorizer(service, name);

    conversions.set(name, cached);

    return cached;
  };
  const routes = new Map<HttpEvent, RouteAuthorizerPlan>();
  const used = new Set<string>();
  const tasks: PlannedTask[] = [];
  let needsBlocked = false;

  for (const fn of Object.values(service.functions)) {
    for (const event of httpEventsOf(fn)) {
      const resolved = resolveRouteAuthorizer(event, conversionOf);
      const routeTasks = [...resolved.tasks];

      if (resolved.authorization.kind === "converted") {
        used.add(resolved.authorization.name);
      }

      if (resolved.authorization.kind === "blocked") {
        needsBlocked = true;
        routeTasks.push({
          area: "routing",
          file: routeFile(fn),
          message: `${routeLabel(event)} route ${event.method} ${event.path} on ${fn.name} is generated behind migrationBlocked and denies every request.`,
          reason: `${resolved.authorization.reason} Protect the route with an equivalent Voke HTTP Authorizer, then remove migrationBlocked.`,
          risk: "blocking",
        });
      }

      for (const task of routeTasks) {
        pushUniqueTask(tasks, task);
      }

      routes.set(event, { ...resolved, event, fn, tasks: routeTasks });
    }
  }

  const registry: AuthorizerPlan["registry"] = [];
  const requestFunctions: AuthorizerPlan["requestFunctions"] = [];

  for (const name of Object.keys(service.provider.httpApi?.authorizers ?? {})) {
    const conversion = conversions.get(name);

    if (!used.has(name) || conversion?.kind !== "converted") {
      continue;
    }

    registry.push({
      expression: conversion.expression,
      helper: conversion.helper,
      name,
    });

    const target =
      conversion.requestFunction === undefined
        ? undefined
        : service.functions[conversion.requestFunction];

    if (
      target !== undefined &&
      !requestFunctions.some((entry) => entry.fn === target)
    ) {
      requestFunctions.push({
        exportName: requestFunctionExportName(target.name),
        fn: target,
      });
    }
  }

  if (needsBlocked) {
    registry.push({
      expression: `lambdaAuthorizer({ function: ${tsString(blockedAuthorizerName)} })`,
      helper: "lambdaAuthorizer",
      name: blockedAuthorizerName,
    });
  }

  const unusedTask = unusedAuthorizersTask(service, used);

  if (unusedTask !== undefined) {
    tasks.push(unusedTask);
  }

  return {
    hasProtectedRoutes: [...routes.values()].some(
      (route) => route.authorization.kind !== "public"
    ),
    helpers: new Set([
      ...registry.map((entry) => entry.helper),
      ...(requestFunctions.length > 0 || needsBlocked
        ? ["requestAuthorizer"]
        : []),
    ]),
    needsBlocked,
    registry,
    requestFunctions,
    routes,
    tasks,
  };
};

const routeIsEquivalent = (route: RouteAuthorizerPlan): boolean =>
  route.authorization.kind !== "blocked" && route.tasks.length === 0;

const corsTasks = (service: ServerlessService): PlannedTask[] => {
  const tasks: PlannedTask[] = [];
  const cors = service.provider.httpApi?.cors;

  if (cors !== undefined && cors !== true && cors !== false) {
    tasks.push({
      area: "routing",
      file: configFile,
      message: `provider.httpApi.cors ${describeValue(cors)} is not converted (CORS).`,
      reason:
        "Set origins, methods and headers in `api.cors` of voke.config.ts. Until then browsers block cross-origin calls.",
      risk: "medium",
    });
  }

  for (const fn of Object.values(service.functions)) {
    for (const event of httpEventsOf(fn)) {
      if (event.cors !== undefined && event.cors !== false) {
        tasks.push({
          area: "routing",
          file: configFile,
          message: `CORS of ${routeLabel(event)} route ${event.method} ${event.path} on ${fn.name} is not converted.`,
          reason:
            "Voke sets CORS once for the API in `api.cors` of voke.config.ts. Until then browsers block cross-origin calls.",
          risk: "medium",
        });
      }
    }
  }

  return tasks;
};

const droppedFunctionSettings = (
  fn: ServerlessFunction,
  renamedKeys: string[]
): PlannedTask | undefined => {
  const runtimeKept =
    supportedLambdaRuntime(fn.runtime) !== undefined && hasWorkerEvent(fn);
  const settings = [
    fn.timeout === undefined ? undefined : `timeout ${fn.timeout}`,
    fn.memorySize === undefined ? undefined : `memorySize ${fn.memorySize}`,
    fn.runtime === undefined || runtimeKept
      ? undefined
      : `runtime ${fn.runtime}`,
    fn.layers.length === 0 ? undefined : `layers (${fn.layers.length})`,
  ].filter((setting): setting is string => setting !== undefined);

  if (settings.length === 0 && renamedKeys.length === 0) {
    return undefined;
  }

  const parts = [
    settings.length === 0 ? undefined : settings.join(", "),
    renamedKeys.length === 0
      ? undefined
      : `environment ${renamedKeys.join(", ")}`,
  ].filter((part): part is string => part !== undefined);

  return {
    area: "build",
    file: "src/index.ts",
    message: `Function ${fn.name} settings are not carried to the generated project: ${parts.join("; ")}.`,
    reason:
      "All migrated routes share one http(...) Function, so per-function settings have no single target. Set them on the Voke Function that needs them, and update code that reads renamed environment keys.",
    risk: "medium",
  };
};

const droppedSettingsTasks = (
  service: ServerlessService,
  values: ProviderValuePlan
): PlannedTask[] => {
  const tasks: PlannedTask[] = [];
  const providerRuntime = service.provider.runtime;

  if (
    providerRuntime !== undefined &&
    supportedLambdaRuntime(providerRuntime) === undefined
  ) {
    tasks.push({
      area: "build",
      file: configFile,
      message: `Provider runtime ${providerRuntime} is not carried to the generated project.`,
      reason:
        "Voke deploys nodejs22.x or nodejs24.x; test the handlers on the runtime of the generated project.",
      risk: "medium",
    });
  }

  if (service.provider.deploymentBucket !== undefined) {
    tasks.push({
      area: "build",
      file: configFile,
      message: "provider.deploymentBucket is not converted.",
      reason:
        "Voke deploys with its own CloudFormation workflow and does not use the Serverless deployment bucket.",
      risk: "low",
    });
  }

  if (service.package?.individually !== undefined) {
    tasks.push({
      area: "build",
      file: "package.json",
      message: "package.individually is not converted.",
      reason:
        "`voke build` bundles every Function from the entrypoint; Serverless packaging flags do not apply.",
      risk: "low",
    });
  }

  for (const fn of Object.values(service.functions)) {
    const task = droppedFunctionSettings(
      fn,
      values.renamedKeys.get(fn.name) ?? []
    );

    if (task !== undefined) {
      tasks.push(task);
    }
  }

  return tasks;
};

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
  blocking: "Blocking",
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
      purpose: "Project scripts and dependencies.",
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
      purpose: "Generated Gateway entrypoint.",
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

  if (createAuthorizerPlan(service).registry.length > 0) {
    files.push({
      confidence: "high",
      path: `${outDirectory}/${authorizersFile}`,
      purpose:
        "HTTP Authorizer Registry and Request Authorizer Function skeletons.",
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
      return "Rewrite it with `s3()` from `@vokejs/aws`; the bucket must be a Voke resource declared with `s3Bucket()`.";
    }
    case "schedule": {
      return "Rewrite it with `schedule()` from `@vokejs/aws`; review the expression and time zone.";
    }
    case "sns": {
      return "Rewrite it with `sns()` from `@vokejs/aws` and declare the topic with `snsTopic()`; review the filter policy.";
    }
    case "stream": {
      return "Rewrite it with kinesis() or dynamodbStream() from @vokejs/aws, then review the starting position, batching and retry settings.";
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

const convertedRouteItem = (
  route: RouteAuthorizerPlan,
  outDirectory: string
): ServerlessMigrationReportItem => {
  const { authorization, event, fn } = route;
  const prefix = `${routeLabel(event)} route ${event.method} ${event.path} is generated for ${fn.name}`;
  const file = `${outDirectory}/${routeFile(fn)}`;

  if (authorization.kind === "blocked") {
    return {
      area: "routing",
      confidence: "low",
      file,
      message: `${prefix} behind migrationBlocked, which denies every request.`,
    };
  }

  return {
    area: "routing",
    confidence: "high",
    file,
    message:
      authorization.kind === "converted"
        ? `${prefix}, protected by HTTP Authorizer ${authorization.name}.`
        : `${prefix}.`,
  };
};

const providerConvertedItems = (
  service: ServerlessService,
  outDirectory: string
): ServerlessMigrationReportItem[] => {
  const values = createProviderValuePlan(service);
  const file = `${outDirectory}/voke.config.ts`;
  const items: ServerlessMigrationReportItem[] = [];

  if (values.stage !== undefined || values.region !== undefined) {
    items.push({
      area: "routing",
      confidence: "high",
      file,
      message: "Provider stage and region are represented in Voke config.",
    });
  }

  if (values.providerEnvironmentCopied) {
    items.push({
      area: "build",
      confidence: "medium",
      file,
      message:
        "Provider environment variables are copied into CloudFormation environment settings.",
    });
  }

  if (service.provider.httpApi?.cors === true) {
    items.push({
      area: "routing",
      confidence: "medium",
      file,
      message:
        "provider.httpApi.cors: true is generated as api: { cors: true } (CORS for any origin, method and header, without credentials).",
    });
  }

  return items;
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

  const authorizerPlan = createAuthorizerPlan(service);

  converted.push(...providerConvertedItems(service, outDirectory));

  for (const entry of authorizerPlan.registry) {
    if (entry.name !== blockedAuthorizerName) {
      converted.push({
        area: "routing",
        confidence: "high",
        file: `${outDirectory}/${authorizersFile}`,
        message: `HTTP Authorizer ${entry.name} is generated with ${entry.helper}.`,
      });
    }
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
      const route =
        event.type === "httpApi" || event.type === "http"
          ? authorizerPlan.routes.get(event)
          : undefined;

      if (route !== undefined) {
        converted.push(convertedRouteItem(route, outDirectory));
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

  const values = createProviderValuePlan(service);
  const plannedTasks = [
    ...createAuthorizerPlan(service).tasks,
    ...corsTasks(service),
    ...values.tasks,
    ...droppedSettingsTasks(service, values),
  ];

  for (const task of plannedTasks) {
    tasks.push(toManualTask(task, outDirectory));
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

  return (["blocking", "high", "medium", "low"] as const)
    .map((risk) => {
      const rows = tasks.filter((task) => task.risk === risk);
      const heading =
        risk === "blocking" ? "### Blocking" : `### ${riskLabels[risk]} risk`;

      if (rows.length === 0) {
        return risk === "blocking"
          ? `${heading}\n\n- No blocking manual work.`
          : `${heading}\n\n- No ${risk} risk manual work.`;
      }

      return `${heading}\n\n${markdownTable([
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

const plannedTaskMessages = (tasks: PlannedTask[], fallback: string): string =>
  tasks.length === 0 ? fallback : tasks.map((task) => task.message).join(" ");

const providerValueStatus = (
  tasks: PlannedTask[],
  present: boolean,
  absent: string
): string => {
  if (tasks.length > 0) {
    return "Manual work";
  }

  return present ? "Supported" : absent;
};

// The package row lists packaging work only: the package.json task and bundler plugin steps.
const isPackagingTask = (task: ServerlessMigrationManualTask): boolean =>
  task.file?.endsWith("/package.json") === true ||
  task.file?.endsWith("/SERVERLESS_COMPATIBILITY.md") === true;

const httpEventRow = (
  label: string,
  type: HttpEvent["type"],
  present: boolean,
  plan: AuthorizerPlan
): string[] => {
  const blocked = [...plan.routes.values()].filter(
    (route) =>
      route.event.type === type && route.authorization.kind === "blocked"
  );
  let status = "Not present";

  if (blocked.length > 0) {
    status = "Manual work";
  } else if (present) {
    status = "Supported";
  }

  return [
    label,
    status,
    "high",
    "Generated Route Builder files.",
    plannedTaskMessages(
      blocked.flatMap((route) =>
        route.tasks.filter((task) => task.risk === "blocking")
      ),
      "-"
    ),
  ];
};

const authorizerStatus = (
  service: ServerlessService,
  plan: AuthorizerPlan
): string => {
  const declared =
    Object.keys(service.provider.httpApi?.authorizers ?? {}).length > 0;

  if (!(plan.hasProtectedRoutes || declared)) {
    return "Not present";
  }

  return plan.tasks.some((task) => task.risk !== "low")
    ? "Manual work"
    : "Supported";
};

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
  const values = createProviderValuePlan(service);
  const stageAndRegionTasks = values.tasks.filter(
    (task) => task.area === "routing"
  );
  const environmentTasks = values.tasks.filter((task) => task.area === "build");
  const hasEnvironment =
    Object.keys(service.provider.environment).length > 0 ||
    Object.values(service.functions).some(
      (fn) => Object.keys(fn.environment).length > 0
    );
  const authorizerPlan = createAuthorizerPlan(service);
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
      providerValueStatus(
        stageAndRegionTasks,
        values.stage !== undefined || values.region !== undefined,
        "Defaulted"
      ),
      "high",
      "`voke.config.ts`",
      plannedTaskMessages(stageAndRegionTasks, "-"),
    ],
    [
      "Provider environment",
      providerValueStatus(environmentTasks, hasEnvironment, "Not present"),
      "medium",
      "`voke.config.ts`",
      plannedTaskMessages(
        environmentTasks,
        "Review deployment-time secrets and environment sources."
      ),
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
      compatibilityManualWork(
        report.manualTasks.filter(isPackagingTask),
        "build"
      ),
    ],
    httpEventRow("HTTP API event", "httpApi", hasHttpApi, authorizerPlan),
    httpEventRow("REST API event", "http", hasHttp, authorizerPlan),
    [
      "HTTP authorizers",
      authorizerStatus(service, authorizerPlan),
      "high",
      authorizerPlan.registry.length > 0 ? "`src/authorizers.ts`" : "-",
      plannedTaskMessages(authorizerPlan.tasks, "-"),
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
    [
      "Blocking tasks",
      String(
        report.manualTasks.filter((task) => task.risk === "blocking").length
      ),
    ],
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

const sqsQueueExpression = (
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
    ? tsString(queue)
    : `{ queue: ${tsString(queue)}, ${options.join(", ")} }`;
};

// voke build generates the Lambda entry for every Function, so only an explicit runtime carries
// over from the Serverless service, as an AWS Provider Extension Record.
const functionSynthesisBlock = (fn: ServerlessFunction): string => {
  const runtime = supportedLambdaRuntime(fn.runtime);

  return runtime === undefined
    ? ""
    : `\n  synthesis: {\n    provider: awsLambda({ runtime: ${tsString(runtime)} }),\n  },`;
};

const awsProviderExpression = (service: ServerlessService): string => {
  const runtime = supportedLambdaRuntime(service.provider.runtime);

  return runtime === undefined
    ? "aws()"
    : `aws({ lambda: { runtime: ${tsString(runtime)} } })`;
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
  const synthesisBlock = functionSynthesisBlock(fn);
  const eventSources = sqsEvents.map((event) => {
    const { queue } = resolveSqsEventSource(event, resourceDeclarations);

    if (queue === undefined) {
      throw new Error(`Expected resolved SQS event for ${fn.name}`);
    }

    return sqsQueueExpression(event, queue);
  });

  return `import { ${synthesisBlock === "" ? "sqs" : "awsLambda, sqs"} } from "@vokejs/aws";
import type { StandardSchemaV1 } from "voke";

const messageSchema: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    validate: (value: unknown) => ({ value }),
    vendor: "voke-migration",
    version: 1,
  },
} as const;

// Original Serverless handler: ${fn.handler ?? "not specified"}
export const ${exportName} = sqs({
  name: ${tsString(fn.name)},${synthesisBlock}
  message: messageSchema,
  ${eventSources.length === 1 ? `queue: ${eventSources[0] ?? '""'}` : `queues: [${eventSources.join(", ")}]`},
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
  const synthesisBlock = functionSynthesisBlock(fn);
  const eventTypes = fn.events
    .filter((event) => event.type === "sqs" || event.type === "eventBridge")
    .map((event) => event.type);

  return `${synthesisBlock === "" ? "" : 'import { awsLambda } from "@vokejs/aws";\n'}import { fn } from "voke";
import type { StandardSchemaV1 } from "voke";

const outputSchema: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    validate: (value: unknown) => ({ value }),
    vendor: "voke-migration",
    version: 1,
  },
};

// Original Serverless handler: ${fn.handler ?? "not specified"}
export const ${exportName} = fn({
  name: ${tsString(fn.name)},${synthesisBlock}
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
  output: outputSchema,
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

  return `import { createFunctions } from "voke";
${imports.join("\n")}

export const functions = createFunctions({
${registryEntries.join("\n")}
});
`;
};

// Every protected Serverless event names an authorizer here; a blocked one names migrationBlocked.
const routeAuthorizerLine = (
  authorization: RouteAuthorization | undefined
): string => {
  if (authorization === undefined || authorization.kind === "public") {
    return "";
  }

  const name =
    authorization.kind === "converted"
      ? authorization.name
      : blockedAuthorizerName;

  return `\n    authorizer: ${tsString(name)},`;
};

const createRouteTemplate = (
  fn: ServerlessFunction,
  plan: AuthorizerPlan
): string => {
  const exportName = `create${pascalCase(fn.name, "Migrated")}Routes`;
  const routes = httpEventsOf(fn).map((event) => {
    const method = event.method.toLowerCase();
    const routePath = honoPath(event.path);
    const authorizerLine = routeAuthorizerLine(
      plan.routes.get(event)?.authorization
    );

    return `route.${method}(${tsString(routePath)}, {${authorizerLine}
    handler: () => ({
    functionName: ${tsString(fn.name)},
    method: ${tsString(event.method)},
    migrated: true,
    originalHandler: ${tsString(fn.handler ?? "not specified")},
    path: ${tsString(event.path)},
  }),
  })`;
  });

  return `import { route } from "voke";

export const ${exportName} = () => [
  ${routes.join(",\n  ")},
] as const;
`;
};

const createConfigTemplate = (service: ServerlessService): string => {
  const values = createProviderValuePlan(service);
  const { environment } = values;
  const providerLines = [
    values.stage === undefined
      ? undefined
      : `  stage: ${tsString(values.stage)},`,
    values.region === undefined
      ? undefined
      : `  region: ${tsString(values.region)},`,
    '  entrypoint: "./src/index.ts",',
    service.provider.httpApi?.cors === true
      ? "  api: { cors: true },"
      : undefined,
  ].filter((line): line is string => line !== undefined);
  const resources = createResourceDeclarations(service).generated;
  const resourceImports =
    resources.length === 0
      ? ""
      : `\nimport { ${[...new Set(resources.map((resource) => resource.helper))]
          .toSorted()
          .join(", ")} } from "@vokejs/aws/cloudformation";`;
  const resourceEntries = resources.map(
    (resource) => `    ${tsString(resource.name)}: ${resource.expression},`
  );
  const resourceBlock =
    resourceEntries.length === 0
      ? ""
      : `\n  resources: {\n${resourceEntries.join("\n")}\n  },`;

  // Functions live in the entrypoint (src/index.ts); the config holds project metadata,
  // the Provider, and infrastructure resources.
  return `import { aws } from "@vokejs/aws";
import { defineConfig } from "voke";${resourceImports}

export default defineConfig({
  name: ${tsString(service.service)},
  provider: ${awsProviderExpression(service)},
${providerLines.join("\n")}
  environment: ${stringifyObject(environment, 2).replaceAll("\n", "\n  ")},${resourceBlock}
});
`;
};

const createAuthorizersTemplate = (plan: AuthorizerPlan): string => {
  const helpers = ["createAuthorizers", ...plan.helpers].toSorted();
  const registry = plan.registry.map(
    (entry) => `  ${tsString(entry.name)}: ${entry.expression},`
  );
  const requestFunctions = plan.requestFunctions.map(
    ({
      exportName,
      fn,
    }) => `// Original Serverless handler: ${fn.handler ?? "not specified"}
// Denies every request until the original authorizer logic is ported. See MIGRATION_REPORT.md.
export const ${exportName} = requestAuthorizer({
  name: ${tsString(fn.name)},
  handler: () => ({ authorized: false }),
});
`
  );
  const blocked = plan.needsBlocked
    ? [
        `// Routes whose authorizer could not be migrated use this. See MIGRATION_REPORT.md.
export const ${blockedAuthorizerName} = requestAuthorizer({
  handler: () => ({ authorized: false }),
});
`,
      ]
    : [];

  return `import {
${helpers.map((helper) => `  ${helper},`).join("\n")}
} from "@vokejs/aws";

export const authorizers = createAuthorizers({
${registry.join("\n")}
});
${[...requestFunctions, ...blocked].map((block) => `\n${block}`).join("")}`;
};

const createIndexTemplate = (service: ServerlessService): string => {
  const authorizerPlan = createAuthorizerPlan(service);
  const hasAuthorizers = authorizerPlan.registry.length > 0;
  const authorizerFunctions = [
    ...authorizerPlan.requestFunctions.map(({ exportName, fn }) => ({
      exportName,
      key: fn.name,
    })),
    ...(authorizerPlan.needsBlocked
      ? [{ exportName: blockedAuthorizerName, key: blockedAuthorizerName }]
      : []),
  ];
  const authorizerImport = hasAuthorizers
    ? `import { ${[
        "authorizers",
        ...authorizerFunctions.map((entry) => entry.exportName),
      ]
        .toSorted()
        .join(", ")} } from "./authorizers";\n`
    : "";
  const authorizerEntries = authorizerFunctions.map(
    (entry) => `  ${tsString(entry.key)}: ${entry.exportName},\n`
  );
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
    routeCalls.push(`      ...${exportName}(),`);
  }

  const functionImport =
    workerFunctions.length === 0
      ? ""
      : 'import { functions as workerFunctions } from "./functions";\n';
  const routeFunctionBlock =
    routeCalls.length === 0
      ? ""
      : `  http: http({${hasAuthorizers ? "\n    authorizers," : ""}
    routes: [
${routeCalls.join("\n")}
    ],
  }),\n`;

  return `import { createFunctions, http, voke } from "voke";
import config from "../voke.config";
${authorizerImport}${functionImport}${routeImports.join("\n")}

const functions = createFunctions({
  ...${workerFunctions.length === 0 ? "{}" : "workerFunctions"},
${authorizerEntries.join("")}${routeFunctionBlock}});

const service = voke(functions, { config });

export default service;
`;
};

// The scaffold's name rules: lowercase, no scope.
const migrationPackageName = (service: string): string =>
  kebabCase(service) || "voke-migration";

const createMigrationFiles = (
  service: ServerlessService,
  report: ServerlessMigrationReport,
  outDirectory: string
): Record<string, string> => {
  const resourceDeclarations = createResourceDeclarations(service);
  const authorizerPlan = createAuthorizerPlan(service);
  const files: Record<string, string> = {
    [`${outDirectory}/package.json`]: `${JSON.stringify(projectPackageJson(migrationPackageName(service.service)), null, 2)}\n`,
    [`${outDirectory}/tsconfig.json`]: `${JSON.stringify(tsconfig, null, 2)}\n`,
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

  if (authorizerPlan.registry.length > 0) {
    files[`${outDirectory}/${authorizersFile}`] =
      createAuthorizersTemplate(authorizerPlan);
  }

  for (const fn of Object.values(service.functions)) {
    if (hasHttpEvent(fn)) {
      files[`${outDirectory}/${routeFile(fn)}`] = createRouteTemplate(
        fn,
        authorizerPlan
      );
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

// "Supported" means the setting reached the generated code; reported-only settings are manual tasks.
const createBaseSupportedFeatures = (service: ServerlessService): string[] => {
  const supported = ["service name"];
  const values = createProviderValuePlan(service);

  addSupportedIf(supported, values.stage !== undefined, "provider stage");
  addSupportedIf(supported, values.region !== undefined, "provider region");
  addSupportedIf(
    supported,
    values.providerEnvironmentCopied,
    "provider environment"
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
        "Voke scopes each Function role to the resources that Function links; per-function IAM statements are still not converted automatically.",
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
        "Rewrite Lambda-centric workflows as durable() Functions from @vokejs/aws: steps, waits and callbacks become TypeScript in the Function's handler.",
        "Declare state machines you keep as raw CloudFormation resources in voke.config.ts, with their IAM roles and permissions.",
      ],
      notes: [
        "Voke does not synthesize Step Functions state machines; AWS Lambda durable functions are its orchestration model.",
      ],
      status: "manual",
      summary:
        "Step Functions workflows move to durable Functions or raw CloudFormation resources.",
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

const addRouteReport = (
  route: RouteAuthorizerPlan | undefined,
  supported: string[],
  unsupported: string[]
): void => {
  if (route === undefined) {
    return;
  }

  const { authorization, event, fn } = route;
  const label = `${routeLabel(event)} event: ${fn.name} ${event.method} ${event.path}`;

  if (routeIsEquivalent(route)) {
    supported.push(label);
  } else if (authorization.kind === "blocked") {
    unsupported.push(
      `${label} is generated behind migrationBlocked. ${authorization.reason}`
    );
  } else {
    unsupported.push(
      `${label} needs manual work before traffic moves: ${route.tasks.map((task) => task.message).join(" ")}`
    );
  }
};

const addEventReport = (
  fn: ServerlessFunction,
  event: ServerlessFunctionEvent,
  resourceDeclarations: ResourceDeclarations,
  authorizerPlan: AuthorizerPlan,
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
    case "httpApi":
    case "http": {
      addRouteReport(authorizerPlan.routes.get(event), supported, unsupported);
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

  const authorizerPlan = createAuthorizerPlan(service);

  for (const fn of Object.values(service.functions)) {
    for (const event of fn.events) {
      addEventReport(
        fn,
        event,
        resourceDeclarations,
        authorizerPlan,
        supported,
        unsupported
      );
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

const parseHttpApiConfig = (value: YamlValue): ServerlessHttpApiConfig => {
  const config = asObject(value);

  return {
    authorizers: asObject(config.authorizers),
    ...(config.cors === undefined ? {} : { cors: config.cors }),
  };
};

export const parseServerlessYaml = (source: string): ServerlessService => {
  const root = readServerlessYaml(source);
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
    "httpApi",
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
      environment: asObject(rawFunction.environment),
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
      environment: asObject(provider.environment),
      ...(provider.httpApi === undefined
        ? {}
        : { httpApi: parseHttpApiConfig(provider.httpApi) }),
      iamRoleStatements: asArray(
        provider.iamRoleStatements ?? providerIamRole.statements
      ),
      name: asOptionalString(provider.name),
      region: provider.region,
      runtime: asOptionalString(provider.runtime),
      stage: provider.stage,
      unknownFields: [
        ...collectUnknownFields(
          provider,
          providerKnownKeys,
          "provider",
          "provider field is not converted automatically"
        ),
        ...collectUnknownFields(
          asObject(provider.httpApi),
          ["authorizers", "cors"],
          "provider.httpApi",
          "provider.httpApi field is not converted automatically"
        ),
      ],
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
