import { VokeConfigError } from "./errors";

// Words that cannot be used as `export const <name>` in an ES module.
const reservedWords = new Set([
  "arguments",
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
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const wordSeparatorPattern = /[^A-Za-z0-9]+/u;
const leadingDigitPattern = /^[0-9]/u;

const isUsableIdentifier = (value: string): boolean =>
  identifierPattern.test(value) && !reservedWords.has(value);

const toCamelCase = (value: string): string =>
  value
    .split(wordSeparatorPattern)
    .filter(Boolean)
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join("");

/**
 * The name of the generated Lambda handler export for a Function Registry key. Keys that are
 * already usable identifiers keep their spelling, so the deployed handler is `index.<key>`.
 * Renaming a registry key renames its Lambda handler.
 */
export const createHandlerExportName = (key: string): string => {
  if (isUsableIdentifier(key)) {
    return key;
  }

  const camelCase = toCamelCase(key);
  const name = leadingDigitPattern.test(camelCase)
    ? `fn_${camelCase}`
    : camelCase;

  if (name === "" || reservedWords.has(name)) {
    return `fn_${name}`;
  }

  return name;
};

export const assertUniqueHandlerExportNames = (
  keys: readonly string[]
): void => {
  const owners = new Map<string, string>();

  for (const key of keys) {
    const exportName = createHandlerExportName(key);
    const owner = owners.get(exportName);

    if (owner !== undefined) {
      throw VokeConfigError.validation([
        {
          message: `Functions "${owner}" and "${key}" both map to the Lambda handler export "${exportName}". Rename one of the registry keys.`,
          path: `functions.${key}`,
        },
      ]);
    }

    owners.set(exportName, key);
  }
};
