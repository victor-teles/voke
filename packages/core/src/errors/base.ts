import type { VokeErrorCode, VokeErrorOptions, VokeIssue } from "./shared";

export class VokeError extends Error {
  code: VokeErrorCode;
  issues: VokeIssue[];

  constructor(message: string, options: VokeErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "VokeError";
    this.code = options.code;
    this.issues = options.issues ?? [];
  }
}
