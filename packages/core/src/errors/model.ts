import { VokeError } from "./base";
import { formatIssues } from "./shared";
import type { VokeErrorOptions, VokeIssue } from "./shared";

export type VokeModelErrorOptions = Omit<VokeErrorOptions, "code">;

export class VokeModelError extends VokeError {
  constructor(message: string, options: VokeModelErrorOptions = {}) {
    super(message, { ...options, code: "MODEL_ERROR" });
    this.name = "VokeModelError";
  }

  static validation(issues: VokeIssue[], cause?: unknown): VokeModelError {
    return new VokeModelError(formatIssues("Invalid Voke model", issues), {
      cause,
      issues,
    });
  }
}
