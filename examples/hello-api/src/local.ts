import { awsEmulator, readLocalStackOutputs } from "@vokejs/aws/local";

import config from "../voke.config";

// `provider: aws()` in voke.config.ts uses the AWS Emulator as its Local AWS Provider.
export const localProvider = awsEmulator();

/**
 * The resource bindings `voke local bootstrap` wrote for this stack, or undefined when the local
 * resources are not provisioned (run `voke local start && voke local bootstrap`).
 */
export const readLocalBindings = () =>
  readLocalStackOutputs({
    endpoint: localProvider.defaults.endpoint,
    provider: localProvider.name,
    stack: `${config.name}-${config.stage}`,
  });
