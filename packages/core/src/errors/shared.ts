export type VokeErrorCode =
  | "CLI_USAGE_ERROR"
  | "CONFIG_ERROR"
  | "MODEL_ERROR"
  | "RESOURCE_BINDING_ERROR"
  | "RUNTIME_VARIABLE_ERROR";

export interface VokeIssue {
  path: string;
  message: string;
}

export interface VokeErrorOptions {
  cause?: unknown;
  code: VokeErrorCode;
  issues?: VokeIssue[];
}

export const formatIssues = (prefix: string, issues: VokeIssue[]): string => {
  if (issues.length === 0) {
    return prefix;
  }

  return `${prefix} at ${issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ")}`;
};
