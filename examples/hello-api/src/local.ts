import {
  createLocalAwsEnvironment,
  createLocalBootstrapPlan,
  floci,
} from "@voke/aws/local";
import { createVokeModel } from "voke";

import config from "../voke.config";

const provider = floci();

export const flociCompose = provider.composeConfig({
  dataDirectory: ".voke/local/data",
  region: "us-east-1",
});

export const localEnvironment = createLocalAwsEnvironment({ provider });

export const createHelloApiLocalBootstrapPlan = () =>
  createLocalBootstrapPlan({
    model: createVokeModel(config),
    name: config.name,
    provider,
    region: config.region ?? "us-east-1",
    stage: config.stage ?? "local",
    templatePath: ".voke/local/cloudformation.json",
  });
