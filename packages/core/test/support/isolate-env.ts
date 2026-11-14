// Preloaded before every test file (see packages/core/bunfig.toml). Voke reads stage, region,
// endpoints, and dev settings from the environment, so a developer's shell (an AWS profile,
// STAGE=prod, a local endpoint) must not change test results. Tests that need a value set it
// themselves through ./env.ts. PWD is kept because config loading resolves paths from it.
const ambientPrefixes = ["AWS_", "VOKE_"] as const;
const ambientNames = new Set(["HOST", "PORT", "STAGE"]);

for (const name of Object.keys(process.env)) {
  const isAmbient =
    ambientNames.has(name) ||
    ambientPrefixes.some((prefix) => name.startsWith(prefix));

  if (isAmbient) {
    Reflect.deleteProperty(process.env, name);
  }
}
