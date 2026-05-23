import { VokeError } from "./base";
import { formatIssues } from "./shared";
import type { VokeErrorOptions, VokeIssue } from "./shared";

export type VokeConfigErrorOptions = Omit<VokeErrorOptions, "code">;

export class VokeConfigError extends VokeError {
  constructor(message: string, options: VokeConfigErrorOptions = {}) {
    super(message, { ...options, code: "CONFIG_ERROR" });
    this.name = "VokeConfigError";
  }

  static validation(issues: VokeIssue[], cause?: unknown): VokeConfigError {
    return new VokeConfigError(formatIssues("Invalid Voke config", issues), {
      cause,
      issues,
    });
  }
}
