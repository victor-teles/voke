import { toEnvKey } from "./env-key";

export type ResourceBindingAttribute = "arn" | "id" | "name" | "url";

export interface ResourceBindingNameInput {
  resource: string;
  attribute: ResourceBindingAttribute | string;
}

export interface ResourceBindingDefinition extends ResourceBindingNameInput {
  env: string;
}

export const createResourceBindingName = (
  resource: string,
  attribute: ResourceBindingAttribute | string
): string => `VOKE_RESOURCE_${toEnvKey(resource)}_${toEnvKey(attribute)}`;

export const createResourceBindingDefinition = (
  input: ResourceBindingNameInput
): ResourceBindingDefinition => ({
  attribute: input.attribute,
  env: createResourceBindingName(input.resource, input.attribute),
  resource: input.resource,
});
