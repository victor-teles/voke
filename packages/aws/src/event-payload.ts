// Reading one application payload out of an AWS event: parse it, validate it with the Function's
// schema, and report a bad payload as an `InvokeError` with code `INVALID_PAYLOAD`. Every Event
// Source adapter that validates a payload uses this, so the error shape is the same for all.
import { formatValidationIssue, InvokeError, readStandardResult } from "voke";
import type {
  StandardSchemaOutput,
  StandardSchemaV1,
  ValidationIssue,
} from "voke";

type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

const milliseconds = /\.\d{3}Z$/u;

/** A time as EventBridge and EventBridge Scheduler write it: ISO 8601 UTC, whole seconds. */
export const toAwsEventTime = (date: Date): string =>
  date.toISOString().replace(milliseconds, "Z");

/** Names the payload in the error message: "Invalid <description> for <id>: ...". */
export interface EventPayloadLabel {
  /** What the payload is, for example "SQS message body". */
  readonly description: string;
  /** The provider's id for the message or event that carried it. */
  readonly id: string;
}

export const invalidEventPayloadError = (
  label: EventPayloadLabel,
  detail: string,
  cause?: unknown,
  issues?: readonly ValidationIssue[]
): InvokeError =>
  new InvokeError(`Invalid ${label.description} for ${label.id}: ${detail}`, {
    cause,
    code: "INVALID_PAYLOAD",
    functionName: label.id,
    issues,
  });

const readEventPayload = async <TSchema extends AnyStandardSchema>(
  schema: TSchema,
  read: () => unknown,
  label: EventPayloadLabel
): Promise<StandardSchemaOutput<TSchema>> => {
  try {
    const result = readStandardResult(
      await schema["~standard"].validate(read())
    );

    if (result.ok) {
      return result.value as StandardSchemaOutput<TSchema>;
    }

    throw invalidEventPayloadError(
      label,
      result.issues.map(formatValidationIssue).join("; "),
      undefined,
      result.issues
    );
  } catch (error) {
    if (error instanceof InvokeError) {
      throw error;
    }

    throw invalidEventPayloadError(
      label,
      error instanceof Error ? error.message : String(error),
      error
    );
  }
};

/** Validates a payload the provider already delivers as a value, such as an EventBridge `detail`. */
export const validateEventPayload = async <TSchema extends AnyStandardSchema>(
  schema: TSchema,
  value: unknown,
  label: EventPayloadLabel
): Promise<StandardSchemaOutput<TSchema>> =>
  await readEventPayload(schema, () => value, label);

/** Parses a JSON string payload, such as an SQS or SNS message body, then validates it. */
export const parseJsonEventPayload = async <TSchema extends AnyStandardSchema>(
  schema: TSchema,
  text: string,
  label: EventPayloadLabel
): Promise<StandardSchemaOutput<TSchema>> =>
  await readEventPayload(schema, () => JSON.parse(text) as unknown, label);
