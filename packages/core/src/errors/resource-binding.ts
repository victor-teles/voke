import { VokeError } from "./base";
import type { VokeErrorOptions } from "./shared";

export type VokeResourceBindingErrorOptions = Omit<VokeErrorOptions, "code">;

export class VokeResourceBindingError extends VokeError {
  constructor(message: string, options: VokeResourceBindingErrorOptions = {}) {
    super(message, { ...options, code: "RESOURCE_BINDING_ERROR" });
    this.name = "VokeResourceBindingError";
  }
}
