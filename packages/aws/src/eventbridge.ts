import { VokeConfigError, VokeModelError } from "voke";
import type {
  EventFunctionDefinition,
  EventSourceDefinition,
  FunctionSynthesisConfig,
  InvokeContext,
  RuntimeVariableCatalog,
  StandardSchemaInput,
  StandardSchemaOutput,
  StandardSchemaV1,
  VokeModelRecord,
} from "voke";

import { toLogicalId } from "./cloudformation-template";
import type {
  CloudFormationResource,
  CloudFormationValue,
} from "./cloudformation-template";
import { toAwsEventTime, validateEventPayload } from "./event-payload";
import {
  eventSourceResourceKindIssue,
  lambdaInvokePermissionResource,
} from "./event-source-resources";
import type {
  AwsEventSourceAdapter,
  AwsEventSourceContext,
  VokeIssue,
} from "./event-sources";

type AnyStandardSchema = StandardSchemaV1<unknown, unknown>;

/**
 * Which events an `eventBridge()` Function receives. `source` and `detailType` list the accepted
 * values; `detail` is an EventBridge content filter, copied to the rule untouched. At least one of
 * `source` or `detailType` must have a value.
 */
export interface EventBridgePattern {
  readonly detail?: VokeModelRecord;
  readonly detailType?: readonly string[];
  readonly source?: readonly string[];
}

/** An EventBridge Event Source as `eventBridge()` stores it: the optional bus key and the pattern. */
export interface EventBridgeEventSourceDefinition extends EventSourceDefinition {
  readonly properties: {
    readonly pattern: {
      readonly detail?: VokeModelRecord;
      readonly detailType?: string[];
      readonly source?: string[];
    };
  };
  readonly resource?: string;
  readonly source: "eventBridge";
}

/** The EventBridge event Lambda receives. */
export interface EventBridgeAwsEvent {
  account: string;
  detail: unknown;
  "detail-type": string;
  id: string;
  region: string;
  resources: string[];
  source: string;
  time: string;
  version: string;
}

/** What an `eventBridge()` handler receives: one event with its parsed, validated `detail`. */
export interface EventBridgeEvent<TDetail> {
  account: string;
  detail: TDetail;
  detailType: string;
  id: string;
  /** The untouched EventBridge event. */
  raw: EventBridgeAwsEvent;
  region: string;
  resources: string[];
  source: string;
  time: string;
}

/**
 * The input of `functions.sendEvent` for an `eventBridge()` Function. Only `detail` is required.
 * `source` and `detailType` default to the first value of the Function's pattern; Voke fills in the
 * rest of the event.
 */
export interface EventBridgeEventInvocationInput<TDetail = unknown> {
  detail: TDetail;
  detailType?: string;
  id?: string;
  /** The EventBridge event to read instead; the deployed handler passes the event it received. */
  raw?: EventBridgeAwsEvent;
  source?: string;
  time?: string;
}

export interface EventBridgeEventSchema<
  TDetailSchema extends AnyStandardSchema = AnyStandardSchema,
> extends StandardSchemaV1<
  EventBridgeEventInvocationInput<StandardSchemaInput<TDetailSchema>>,
  EventBridgeEvent<StandardSchemaOutput<TDetailSchema>>
> {
  readonly detail: TDetailSchema;
  readonly source: "eventBridge";
}

export interface EventBridgeFunctionDefinitionInput<
  TDetailSchema extends AnyStandardSchema,
  TVariables extends RuntimeVariableCatalog = RuntimeVariableCatalog,
> {
  /** The key of an `eventBus()` resource. The account's default event bus when omitted. */
  readonly bus?: string;
  /** A Standard Schema for `event.detail`. */
  readonly detail: TDetailSchema;
  readonly handler: (
    event: EventBridgeEvent<StandardSchemaOutput<TDetailSchema>>,
    context: InvokeContext<TVariables>
  ) => void | Promise<void>;
  readonly name?: string;
  readonly pattern: EventBridgePattern;
  readonly synthesis?: FunctionSynthesisConfig;
  readonly variables?: TVariables;
}

const localAccountId = "000000000000";
const localEventSource = "voke.local";
const createEventBridgeEvent = (
  input: EventBridgeEventInvocationInput,
  pattern: EventBridgePattern
): EventBridgeAwsEvent => {
  if (input.raw !== undefined) {
    return input.raw;
  }

  return {
    account: localAccountId,
    detail: input.detail,
    "detail-type":
      input.detailType ?? pattern.detailType?.[0] ?? localEventSource,
    id: input.id ?? "evt_1",
    region: "local",
    resources: [],
    source: input.source ?? pattern.source?.[0] ?? localEventSource,
    time: input.time ?? toAwsEventTime(new Date()),
    version: "0",
  };
};

const eventBridgeEventSchema = <const TDetailSchema extends AnyStandardSchema>(
  detail: TDetailSchema,
  pattern: EventBridgePattern
): EventBridgeEventSchema<TDetailSchema> => ({
  detail,
  source: "eventBridge",
  "~standard": {
    validate: async (value) => {
      const raw = createEventBridgeEvent(
        value as EventBridgeEventInvocationInput,
        pattern
      );

      return {
        value: {
          account: raw.account,
          detail: await validateEventPayload(detail, raw.detail, {
            description: "EventBridge event detail",
            id: raw.id,
          }),
          detailType: raw["detail-type"],
          id: raw.id,
          raw,
          region: raw.region,
          resources: raw.resources,
          source: raw.source,
          time: raw.time,
        },
      };
    },
    vendor: "voke",
    version: 1,
  },
});

const hasValues = (values: readonly string[] | undefined): boolean =>
  values !== undefined && values.length > 0;

/** The pattern as the model stores it: only the keys that were set, with plain arrays. */
const storedPattern = (
  pattern: EventBridgePattern
): EventBridgeEventSourceDefinition["properties"]["pattern"] => {
  const stored: {
    detail?: VokeModelRecord;
    detailType?: string[];
    source?: string[];
  } = {};

  if (pattern.detail !== undefined) {
    stored.detail = pattern.detail;
  }

  if (pattern.detailType !== undefined) {
    stored.detailType = [...pattern.detailType];
  }

  if (pattern.source !== undefined) {
    stored.source = [...pattern.source];
  }

  return stored;
};

const eventBridgeEventSource = (
  bus: string | undefined,
  pattern: EventBridgePattern
): EventBridgeEventSourceDefinition => ({
  properties: { pattern: storedPattern(pattern) },
  ...(bus === undefined ? {} : { resource: bus }),
  source: "eventBridge",
});

/** A Function that an EventBridge rule invokes with each event that matches `pattern`. */
export const eventBridge = <
  const TDetailSchema extends AnyStandardSchema,
  const TVariables extends RuntimeVariableCatalog = Record<never, never>,
>(
  definition: EventBridgeFunctionDefinitionInput<TDetailSchema, TVariables>
): EventFunctionDefinition<
  string,
  EventBridgeEventSchema<TDetailSchema>,
  TVariables,
  void
> => {
  const { bus, pattern } = definition;

  if (
    pattern === undefined ||
    (!hasValues(pattern.source) && !hasValues(pattern.detailType))
  ) {
    throw new VokeConfigError(
      "eventBridge() requires a pattern with at least one source or detailType value"
    );
  }

  if (bus !== undefined && (typeof bus !== "string" || bus === "")) {
    throw new VokeConfigError(
      "eventBridge() bus must be the key of an eventBus() resource; omit it for the default event bus"
    );
  }

  return Object.freeze({
    events: Object.freeze([eventBridgeEventSource(bus, pattern)]),
    handler: definition.handler,
    input: eventBridgeEventSchema(definition.detail, pattern),
    key: "",
    kind: "event",
    name: definition.name,
    routes: [],
    synthesis: definition.synthesis,
    variables: definition.variables,
  }) as unknown as EventFunctionDefinition<
    string,
    EventBridgeEventSchema<TDetailSchema>,
    TVariables,
    void
  >;
};

/** The rule's `EventPattern`, in EventBridge's own key names. */
const toEventPattern = (
  pattern: EventBridgeEventSourceDefinition["properties"]["pattern"]
): Record<string, CloudFormationValue> => {
  const eventPattern: Record<string, CloudFormationValue> = {};

  if (pattern.source !== undefined) {
    eventPattern.source = pattern.source;
  }

  if (pattern.detailType !== undefined) {
    eventPattern["detail-type"] = pattern.detailType;
  }

  if (pattern.detail !== undefined) {
    eventPattern.detail = pattern.detail;
  }

  return eventPattern;
};

export interface EventBridgeRuleInput {
  /** The logical id of the `AWS::Events::EventBus`; the default event bus when omitted. */
  readonly busLogicalId?: string;
  /** The logical id of the target Function's `AWS::Lambda::Function`. */
  readonly lambdaLogicalId: string;
  readonly pattern: EventBridgeEventSourceDefinition["properties"]["pattern"];
  readonly ruleLogicalId: string;
}

/** An enabled rule that sends matching events to one Function, and the permission it needs. */
export const eventBridgeRuleResources = ({
  busLogicalId,
  lambdaLogicalId,
  pattern,
  ruleLogicalId,
}: EventBridgeRuleInput): Record<string, CloudFormationResource> => {
  const properties: Record<string, CloudFormationValue> = {
    EventPattern: toEventPattern(pattern),
    State: "ENABLED",
    Targets: [
      {
        Arn: { "Fn::GetAtt": [lambdaLogicalId, "Arn"] },
        Id: "VokeFunction",
      },
    ],
  };

  if (busLogicalId !== undefined) {
    properties.EventBusName = { Ref: busLogicalId };
  }

  return {
    [ruleLogicalId]: { Properties: properties, Type: "AWS::Events::Rule" },
    [`${ruleLogicalId}Permission`]: lambdaInvokePermissionResource(
      lambdaLogicalId,
      "events.amazonaws.com",
      { "Fn::GetAtt": [ruleLogicalId, "Arn"] }
    ),
  };
};

const busKind = {
  cloudFormationType: "AWS::Events::EventBus",
  label: "EventBridge",
} as const;

const busIssues = (context: AwsEventSourceContext): VokeIssue[] => {
  if (context.eventSource.resource === undefined) {
    return [];
  }

  const issue = eventSourceResourceKindIssue(context, busKind);

  return issue === undefined ? [] : [issue];
};

/** How an EventBridge Event Source runs on Lambda and synthesizes to a rule and a permission. */
export const eventBridgeEventSourceAdapter: AwsEventSourceAdapter = {
  source: "eventBridge",
  synthesize: (context) => {
    const issues = busIssues(context);

    if (issues.length > 0) {
      throw VokeModelError.validation(issues);
    }

    const { eventSource, lambdaLogicalId } = context;
    const busLogicalId =
      eventSource.resource === undefined
        ? undefined
        : toLogicalId(eventSource.resource);

    return {
      resources: eventBridgeRuleResources({
        busLogicalId,
        lambdaLogicalId,
        pattern: eventSource.properties
          .pattern as EventBridgeRuleInput["pattern"],
        ruleLogicalId: `${lambdaLogicalId}${busLogicalId ?? "DefaultBus"}Rule`,
      }),
    };
  },
  // The whole event is the raw input; the schema validates its `detail`, as for local events.
  toInvocation: (event) => {
    const raw = event as EventBridgeAwsEvent;

    return {
      detail: raw.detail,
      raw,
    } satisfies EventBridgeEventInvocationInput;
  },
  toResponse: () => {
    // EventBridge invokes asynchronously and ignores the result.
  },
  validate: busIssues,
};
