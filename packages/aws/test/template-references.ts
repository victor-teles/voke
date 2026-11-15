// Walks a CloudFormation template's references (`Ref`, `Fn::GetAtt`, `Fn::Sub` and `DependsOn`)
// so a test can prove that no resource depends on itself, directly or through other resources.
import type { CloudFormationTemplate } from "../src/cloudformation";

const subReference = /\$\{([^}!][^}]*)\}/gu;

const subReferences = (text: string): string[] =>
  [...text.matchAll(subReference)].map(([, name]) => name?.split(".")[0] ?? "");

const getAttTarget = (value: unknown): string | undefined => {
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }

  if (typeof value === "string") {
    return value.split(".")[0];
  }

  return undefined;
};

/** Every logical id or parameter that `value` references, at any depth. */
const referencesIn = (value: unknown, found: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      referencesIn(item, found);
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, inner] of Object.entries(value)) {
    if (key === "Ref" && typeof inner === "string") {
      found.add(inner);
    } else if (key === "Fn::GetAtt") {
      const target = getAttTarget(inner);

      if (target !== undefined) {
        found.add(target);
      }
    } else if (key === "Fn::Sub") {
      const text = Array.isArray(inner) ? inner[0] : inner;

      if (typeof text === "string") {
        for (const name of subReferences(text)) {
          found.add(name);
        }
      }

      referencesIn(Array.isArray(inner) ? inner[1] : undefined, found);
    } else {
      referencesIn(inner, found);
    }
  }
};

/** Logical id → the template resources it depends on. */
export const resourceDependencies = (
  template: CloudFormationTemplate
): Map<string, Set<string>> => {
  const dependencies = new Map<string, Set<string>>();

  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    const found = new Set<string>();
    const { DependsOn: dependsOn } = resource as { DependsOn?: unknown };

    referencesIn(resource.Properties, found);
    for (const name of [dependsOn ?? []].flat()) {
      if (typeof name === "string") {
        found.add(name);
      }
    }

    dependencies.set(
      logicalId,
      new Set([...found].filter((name) => name in template.Resources))
    );
  }

  return dependencies;
};

/** The first dependency cycle, as a path that starts and ends at the same id; `undefined` if none. */
export const findReferenceCycle = (
  template: CloudFormationTemplate
): string[] | undefined => {
  const dependencies = resourceDependencies(template);
  const done = new Set<string>();

  const visit = (id: string, path: string[]): string[] | undefined => {
    const start = path.indexOf(id);

    if (start !== -1) {
      return [...path.slice(start), id];
    }

    if (done.has(id)) {
      return undefined;
    }

    for (const next of dependencies.get(id) ?? []) {
      const cycle = visit(next, [...path, id]);

      if (cycle !== undefined) {
        return cycle;
      }
    }

    done.add(id);
    return undefined;
  };

  for (const id of dependencies.keys()) {
    const cycle = visit(id, []);

    if (cycle !== undefined) {
      return cycle;
    }
  }

  return undefined;
};
