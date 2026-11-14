import type { VokeIssue } from "./errors";

export const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value > 0;

/** An issue for `value` at `path` unless it is a positive integer of `unit`. */
export const positiveIntegerIssue = (
  value: unknown,
  path: string,
  unit: "MB" | "seconds"
): VokeIssue | undefined =>
  isPositiveInteger(value)
    ? undefined
    : {
        message: `expected a positive integer number of ${unit}; received ${JSON.stringify(value)}`,
        path,
      };
