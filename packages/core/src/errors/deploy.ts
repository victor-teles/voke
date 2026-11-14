import { VokeError } from "./base";
import type { VokeErrorOptions } from "./shared";

export type VokeDeployErrorOptions = Omit<VokeErrorOptions, "code">;

/** A deployment or removal failed in the Provider (stack, artifact, or credentials). */
export class VokeDeployError extends VokeError {
  constructor(message: string, options: VokeDeployErrorOptions = {}) {
    super(message, { ...options, code: "DEPLOY_ERROR" });
    this.name = "VokeDeployError";
  }
}
