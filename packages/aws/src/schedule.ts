import { InvokeError, VokeConfigError } from "voke";
import type {
  EventFunctionDefinition,
  EventSourceDefinition,
  FunctionSynthesisConfig,
  InvokeContext,
  RuntimeVariableCatalog,
  StandardSchemaV1,
} from "voke";

import type {
  CloudFormationResource,
  CloudFormationValue,
} from "./cloudformation-template";
import { toAwsEventTime } from "./event-payload";
import type { AwsEventSourceAdapter, VokeIssue } from "./event-sources";

/** A Schedule Event Source as `schedule()` stores it, defaults applied. */
export interface ScheduleEventSourceDefinition extends EventSourceDefinition {
  readonly properties: {
    readonly enabled: boolean;
    readonly expression: string;
    readonly timezone: string;
  };
  readonly resource?: undefined;
  readonly source: "schedule";
}

/**
 * The JSON payload the schedule sends to the Function. Voke sets it as the schedule target's
 * `Input`, and EventBridge Scheduler replaces each `<aws.scheduler.*>` placeholder; every value
 * arrives as a string.
 */
export interface ScheduleEnvelope {
  attempt: string;
  executionId: string;
  scheduledTime: string;
  voke: "schedule";
}

/** What a `schedule()` handler receives. */
export interface ScheduledEvent {
  /** 1 for the first attempt, higher when EventBridge Scheduler retries. */
  attempt: number;
  /** The id EventBridge Scheduler gives each attempted invocation. */
  executionId: string;
  /** The payload as the schedule sent it. */
  raw: ScheduleEnvelope;
  /** When the schedule was due, ISO 8601 in UTC, for example `2024-03-01T03:00:00Z`. */
  scheduledTime: string;
}

/** The input of `functions.sendEvent` for a `schedule()` Function; `{}` is enough. */
export interface ScheduleEventInvocationInput {
  attempt?: number;
  executionId?: string;
  /** The payload to read instead; the deployed handler passes the event it received. */
  raw?: ScheduleEnvelope;
  /** Defaults to now. */
  scheduledTime?: string;
}

export interface ScheduledEventSchema extends StandardSchemaV1<
  ScheduleEventInvocationInput,
  ScheduledEvent
> {
  readonly source: "schedule";
}

export interface ScheduleFunctionDefinitionInput<
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> {
  /** `false` creates the schedule turned off. Defaults to `true`. */
  readonly enabled?: boolean;
  /** A `rate(...)` or `cron(...)` expression, for example `"rate(5 minutes)"` or `"cron(0 9 * * ? *)"`. */
  readonly expression: string;
  readonly handler: (
    event: ScheduledEvent,
    context: InvokeContext<TVariables>
  ) => void | Promise<void>;
  readonly name?: string;
  readonly synthesis?: FunctionSynthesisConfig;
  /** The IANA time zone the expression is evaluated in, for example `"America/Sao_Paulo"`. Defaults to `"UTC"`. */
  readonly timezone?: string;
  readonly variables?: TVariables;
}

const recurringExpression = /^(?:rate|cron)\(.+\)$/u;
const oneTimeExpression = /^at\(/u;
const positiveInteger = /^[1-9]\d*$/u;

/** The logical id of the IAM role EventBridge Scheduler assumes to invoke every scheduled Function. */
export const schedulerRoleLogicalId = "VokeSchedulerRole";

const expressionError = (expression: unknown): string | undefined => {
  if (typeof expression !== "string") {
    return "schedule() requires expression, a rate(...) or cron(...) expression";
  }

  if (oneTimeExpression.test(expression)) {
    return `schedule() expression ${JSON.stringify(expression)}: one-time schedules (at(...)) are not supported yet; use rate(...) or cron(...)`;
  }

  if (!recurringExpression.test(expression)) {
    return `schedule() expression ${JSON.stringify(expression)} must be a rate(...) or cron(...) expression, for example "rate(5 minutes)" or "cron(0 9 * * ? *)"`;
  }

  return undefined;
};

const isTimeZone = (timezone: string): boolean => {
  try {
    const format = new Intl.DateTimeFormat("en-US", { timeZone: timezone });

    return format.resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

const invalidScheduleEvent = (detail: string): InvokeError =>
  new InvokeError(
    `Invalid schedule event: ${detail}. A schedule() Function runs from its EventBridge Scheduler schedule, which sends {"voke":"schedule",...}.`,
    { code: "INVALID_PAYLOAD" }
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readEnvelope = (value: unknown): ScheduleEnvelope => {
  if (!isRecord(value) || value.voke !== "schedule") {
    throw invalidScheduleEvent("the payload is not the Voke schedule envelope");
  }

  const { attempt, executionId, scheduledTime } = value;

  if (
    typeof attempt !== "string" ||
    typeof executionId !== "string" ||
    typeof scheduledTime !== "string"
  ) {
    throw invalidScheduleEvent(
      "attempt, executionId and scheduledTime must be strings"
    );
  }

  if (!positiveInteger.test(attempt)) {
    throw invalidScheduleEvent(
      `attempt ${JSON.stringify(attempt)} is not a positive integer`
    );
  }

  return { attempt, executionId, scheduledTime, voke: "schedule" };
};

const createEnvelope = (input: ScheduleEventInvocationInput): unknown =>
  input.raw ?? {
    attempt: String(input.attempt ?? 1),
    executionId: input.executionId ?? "exec_1",
    scheduledTime: input.scheduledTime ?? toAwsEventTime(new Date()),
    voke: "schedule",
  };

const scheduledEventSchema: ScheduledEventSchema = {
  source: "schedule",
  "~standard": {
    validate: (value) => {
      const raw = readEnvelope(
        createEnvelope((value ?? {}) as ScheduleEventInvocationInput)
      );

      return {
        value: {
          attempt: Number(raw.attempt),
          executionId: raw.executionId,
          raw,
          scheduledTime: raw.scheduledTime,
        },
      };
    },
    vendor: "voke",
    version: 1,
  },
};

/** A Function that EventBridge Scheduler invokes on a recurring `rate(...)` or `cron(...)` schedule. */
export const schedule = <
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
>(
  definition: ScheduleFunctionDefinitionInput<TVariables>
): EventFunctionDefinition<string, ScheduledEventSchema, TVariables, void> => {
  const error = expressionError(definition.expression);

  if (error !== undefined) {
    throw new VokeConfigError(error);
  }

  const timezone = definition.timezone ?? "UTC";

  if (timezone === "" || !isTimeZone(timezone)) {
    throw new VokeConfigError(
      `schedule() timezone ${JSON.stringify(timezone)} is not an IANA time zone name, for example "America/Sao_Paulo"`
    );
  }

  const eventSource: ScheduleEventSourceDefinition = {
    properties: {
      enabled: definition.enabled ?? true,
      expression: definition.expression,
      timezone,
    },
    source: "schedule",
  };

  return Object.freeze({
    events: Object.freeze([eventSource]),
    handler: definition.handler,
    input: scheduledEventSchema,
    key: "",
    kind: "event",
    name: definition.name,
    routes: [],
    synthesis: definition.synthesis,
    variables: definition.variables,
  }) as unknown as EventFunctionDefinition<
    string,
    ScheduledEventSchema,
    TVariables,
    void
  >;
};

// Scheduler substitutes the placeholders inside the JSON `Input`, so the Function always receives
// this envelope rather than Scheduler's default payload.
const scheduleTargetInput = JSON.stringify({
  attempt: "<aws.scheduler.attempt-number>",
  executionId: "<aws.scheduler.execution-id>",
  scheduledTime: "<aws.scheduler.scheduled-time>",
  voke: "schedule",
});

const scheduleIssues = ({
  eventSource,
  eventSourceIndex,
  functionKey,
}: Parameters<AwsEventSourceAdapter["validate"]>[0]): VokeIssue[] => {
  const error = expressionError(eventSource.properties.expression);

  return error === undefined
    ? []
    : [
        {
          message: `Function "${functionKey}" ${error}`,
          path: `functions.${functionKey}.eventSources.${eventSourceIndex}.properties.expression`,
        },
      ];
};

const schedulerRole = (
  lambdaLogicalIds: readonly string[]
): CloudFormationResource => ({
  Properties: {
    AssumeRolePolicyDocument: {
      Statement: [
        {
          Action: "sts:AssumeRole",
          // Only schedules in this account's default schedule group may use the role.
          Condition: {
            ArnLike: {
              "aws:SourceArn": {
                "Fn::Sub": `arn:\${AWS::Partition}:scheduler:\${AWS::Region}:\${AWS::AccountId}:schedule-group/default`,
              },
            },
            StringEquals: {
              "aws:SourceAccount": { Ref: "AWS::AccountId" },
            },
          },
          Effect: "Allow",
          Principal: { Service: "scheduler.amazonaws.com" },
        },
      ],
      Version: "2012-10-17",
    },
    Policies: [
      {
        PolicyDocument: {
          Statement: [
            {
              Action: "lambda:InvokeFunction",
              Effect: "Allow",
              Resource: lambdaLogicalIds.map(
                (logicalId): CloudFormationValue => ({
                  "Fn::GetAtt": [logicalId, "Arn"],
                })
              ),
            },
          ],
          Version: "2012-10-17",
        },
        PolicyName: "VokeInvokeScheduledFunctions",
      },
    ],
  },
  Type: "AWS::IAM::Role",
});

/** How a Schedule Event Source runs on Lambda and synthesizes to an EventBridge Scheduler schedule. */
export const scheduleEventSourceAdapter: AwsEventSourceAdapter = {
  source: "schedule",
  synthesize: ({ eventSource, lambdaLogicalId }) => {
    const { enabled, expression, timezone } = eventSource.properties;

    return {
      resources: {
        [`${lambdaLogicalId}Schedule`]: {
          Properties: {
            FlexibleTimeWindow: { Mode: "OFF" },
            ScheduleExpression: expression ?? "",
            ScheduleExpressionTimezone: timezone ?? "UTC",
            State: enabled === false ? "DISABLED" : "ENABLED",
            // Scheduler invokes through the shared role, so no Lambda permission is needed.
            Target: {
              Arn: { "Fn::GetAtt": [lambdaLogicalId, "Arn"] },
              Input: scheduleTargetInput,
              RoleArn: { "Fn::GetAtt": [schedulerRoleLogicalId, "Arn"] },
            },
          },
          Type: "AWS::Scheduler::Schedule",
        },
      },
    };
  },
  // One role per stack, allowed to invoke exactly the scheduled Functions.
  synthesizeStack: (contexts) => ({
    resources: {
      [schedulerRoleLogicalId]: schedulerRole([
        ...new Set(contexts.map(({ lambdaLogicalId }) => lambdaLogicalId)),
      ]),
    },
  }),
  // The schema checks the envelope, so a stray event fails the same way locally and on Lambda.
  toInvocation: (event) => ({ raw: event }),
  toResponse: () => {
    // Scheduler invokes asynchronously and ignores the result.
  },
  validate: scheduleIssues,
};
