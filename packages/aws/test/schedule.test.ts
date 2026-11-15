import { expect, test } from "bun:test";

import { createFunctions, InvokeError, VokeConfigError } from "voke";

import { createLambdaHandlers, schedule } from "../src/index";
import type { ScheduledEvent, ScheduleEnvelope } from "../src/index";

const isoSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

const recordingFunctions = () => {
  const seen: ScheduledEvent[] = [];
  const functions = createFunctions({
    nightly: schedule({
      expression: "cron(0 3 * * ? *)",
      handler: (event) => {
        seen.push(event);
      },
    }),
  });

  return { functions, seen };
};

test("schedule() accepts rate and cron expressions only", () => {
  for (const expression of ["0 3 * * *", "every day", "rate 5 minutes", ""]) {
    expect(() => schedule({ expression, handler: () => {} })).toThrow(
      VokeConfigError
    );
  }

  expect(() =>
    schedule({ expression: "rate(5 minutes)", handler: () => {} })
  ).not.toThrow();
});

test("schedule() says one-time at() schedules are not supported yet", () => {
  expect(() =>
    schedule({
      expression: "at(2030-01-01T00:00:00)",
      handler: () => {},
    })
  ).toThrow("one-time schedules (at(...)) are not supported yet");
});

test("schedule() rejects a time zone that is not an IANA name", () => {
  expect(() =>
    schedule({
      expression: "rate(1 hour)",
      handler: () => {},
      timezone: "Mars/Olympus_Mons",
    })
  ).toThrow(VokeConfigError);
});

test("schedule() stores the expression with UTC and enabled as defaults", () => {
  expect(
    schedule({ expression: "rate(5 minutes)", handler: () => {} }).events
  ).toEqual([
    {
      properties: {
        enabled: true,
        expression: "rate(5 minutes)",
        timezone: "UTC",
      },
      source: "schedule",
    },
  ]);
  expect(
    schedule({
      enabled: false,
      expression: "cron(0 9 * * ? *)",
      handler: () => {},
      timezone: "America/Sao_Paulo",
    }).events[0]?.properties
  ).toEqual({
    enabled: false,
    expression: "cron(0 9 * * ? *)",
    timezone: "America/Sao_Paulo",
  });
});

test("sendEvent with an empty object calls the handler with an ISO scheduled time", async () => {
  const { functions, seen } = recordingFunctions();

  await expect(functions.sendEvent("nightly", {})).resolves.toBeUndefined();
  expect(seen[0]?.scheduledTime).toMatch(isoSeconds);
  expect(seen[0]).toMatchObject({ attempt: 1, executionId: "exec_1" });
  expect(seen[0]?.raw.voke).toBe("schedule");
});

test("sendEvent passes an explicit scheduled time through", async () => {
  const { functions, seen } = recordingFunctions();

  await functions.sendEvent("nightly", {
    scheduledTime: "2024-03-01T03:00:00Z",
  });
  expect(seen[0]?.scheduledTime).toBe("2024-03-01T03:00:00Z");
});

test("the deployed handler reads the Voke envelope and converts attempt to a number", async () => {
  const { functions, seen } = recordingFunctions();
  const envelope: ScheduleEnvelope = {
    attempt: "2",
    executionId: "d32c5kddcf5bb8c3",
    scheduledTime: "2022-03-22T18:59:43Z",
    voke: "schedule",
  };

  await expect(
    createLambdaHandlers({ functions }).nightly?.(envelope)
  ).resolves.toBeUndefined();
  expect(seen).toEqual([
    {
      attempt: 2,
      executionId: "d32c5kddcf5bb8c3",
      raw: envelope,
      scheduledTime: "2022-03-22T18:59:43Z",
    },
  ]);
});

test("the deployed handler rejects an event without the Voke schedule marker", async () => {
  const { functions, seen } = recordingFunctions();
  const rejection = await createLambdaHandlers({ functions })
    .nightly?.({
      "detail-type": "Scheduled Event",
      source: "aws.events",
    })
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(InvokeError);
  expect(rejection).toMatchObject({ code: "INVALID_PAYLOAD" });
  expect((rejection as Error).message).toContain(
    "is not the Voke schedule envelope"
  );
  expect(seen).toEqual([]);
});

test("the deployed handler rejects an envelope whose attempt is not a positive integer", async () => {
  const { functions } = recordingFunctions();

  await expect(
    createLambdaHandlers({ functions }).nightly?.({
      attempt: "<aws.scheduler.attempt-number>",
      executionId: "d32c5kddcf5bb8c3",
      scheduledTime: "2022-03-22T18:59:43Z",
      voke: "schedule",
    })
  ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
});
