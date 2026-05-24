import { VokeError } from "./base";
import type { VokeErrorOptions } from "./shared";

export type VokeRuntimeVariableErrorOptions = Omit<VokeErrorOptions, "code">;

export class VokeRuntimeVariableError extends VokeError {
  constructor(message: string, options: VokeRuntimeVariableErrorOptions = {}) {
    super(message, { ...options, code: "RUNTIME_VARIABLE_ERROR" });
    this.name = "VokeRuntimeVariableError";
  }
}
