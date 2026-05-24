import {
  createFlociComposeConfig,
  createLocalAwsEnvironment,
  createLocalBootstrapPlan,
} from "voke/local";

import config from "../voke.config";

export const flociCompose = createFlociComposeConfig({
  dataDirectory: ".voke/local/data",
  region: "us-east-1",
});

export const localEnvironment = createLocalAwsEnvironment();

export const createHelloApiLocalBootstrapPlan = () =>
  createLocalBootstrapPlan({
    config,
    templatePath: ".voke/local/cloudformation.json",
  });
