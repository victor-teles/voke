export const toEnvKey = (value: string): string =>
  value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll(/[^A-Za-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .toUpperCase();
