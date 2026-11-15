import { AsyncLocalStorage } from "node:async_hooks";

import type { DurableContext } from "@aws/durable-execution-sdk-js";
import type {
  DurableOperation,
  LocalDurableTestRunner,
  TestResult,
} from "@aws/durable-execution-sdk-js-testing";

/**
 * Local durable runs (Gateway, `voke dev`, tests) use the AWS durable execution testing runner:
 * an in-process checkpoint server that replays the handler as Lambda would. Both SDK packages are
 * loaded with `import()` so a Lambda bundle never evaluates the testing package; the AWS build
 * plan keeps it external.
 */
interface TestingSdk {
  LocalDurableTestRunner: typeof LocalDurableTestRunner;
}

const loadTestingSdk = (): Promise<TestingSdk> =>
  import("@aws/durable-execution-sdk-js-testing");

interface LocalDurableEnvironment {
  ready: Promise<void>;
  skipTime: boolean;
}

let environment: LocalDurableEnvironment | undefined;

const workerAlreadyRunning = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes("Worker thread is already running");

const setupTestEnvironment = async (skipTime: boolean): Promise<void> => {
  const sdk = await loadTestingSdk();

  try {
    await sdk.LocalDurableTestRunner.setupTestEnvironment({ skipTime });
  } catch (error) {
    // Someone called LocalDurableTestRunner.setupTestEnvironment directly; reuse it.
    if (!workerAlreadyRunning(error)) {
      throw error;
    }
  }
};

const startEnvironment = (skipTime: boolean): LocalDurableEnvironment => ({
  ready: setupTestEnvironment(skipTime),
  skipTime,
});

const stopEnvironment = async (): Promise<void> => {
  const current = environment;

  if (current === undefined) {
    return;
  }

  environment = undefined;
  await current.ready;
  const sdk = await loadTestingSdk();
  await sdk.LocalDurableTestRunner.teardownTestEnvironment();
};

/** Starts the local checkpoint server with real time on first use; tests opt into skipped time. */
const ensureEnvironment = async (): Promise<void> => {
  environment ??= startEnvironment(false);
  await environment.ready;
};

/**
 * Starts the local durable environment with skipped time: durable waits and step retry delays
 * complete at once, through a fake clock that also replaces `Date` and timers in the test.
 */
export const setupLocalDurableEnvironment = async (): Promise<void> => {
  if (environment?.skipTime === true) {
    await environment.ready;
    return;
  }

  await stopEnvironment();
  environment = startEnvironment(true);
  await environment.ready;
};

/** Stops the local checkpoint server and restores real timers. */
export const teardownLocalDurableEnvironment = async (): Promise<void> => {
  await stopEnvironment();
};

/** A finished local execution, kept for `runDurable`. */
export interface LocalDurableExecution {
  execution: TestResult<unknown>;
  operations: DurableOperation[];
}

const executionRecorder = new AsyncLocalStorage<LocalDurableExecution[]>();

/** Runs `run` and returns the local durable executions it started, in order. */
export const recordLocalDurableExecutions = async <TResult>(
  run: () => Promise<TResult>
): Promise<{ executions: LocalDurableExecution[]; result: TResult }> => {
  const executions: LocalDurableExecution[] = [];
  const result = await executionRecorder.run(executions, run);

  return { executions, result };
};

const failedExecutionError = (execution: TestResult<unknown>): Error => {
  const details = execution.getError();
  const error = new Error(
    details.errorMessage ?? "The durable execution failed"
  );

  error.name = details.errorType ?? "DurableExecutionError";

  return error;
};

/**
 * Runs `handler` as one local durable execution and returns its result. The handler receives the
 * already-parsed payload through the closure; replays call it again with a new DurableContext.
 * A failed execution rejects with the error the handler last threw.
 */
export const runLocalDurableExecution = async (
  payload: unknown,
  handler: (durable: DurableContext) => Promise<unknown>
): Promise<unknown> => {
  const [durableSdk, testingSdk] = await Promise.all([
    import("@aws/durable-execution-sdk-js"),
    loadTestingSdk(),
  ]);
  await ensureEnvironment();

  let lastError: unknown;
  const runner = new testingSdk.LocalDurableTestRunner({
    handlerFunction: durableSdk.withDurableExecution(
      async (_event, durableContext) => {
        try {
          return await handler(durableContext);
        } catch (error) {
          lastError = error;
          throw error;
        }
      }
    ),
  });
  const execution = await runner.run({ payload });

  executionRecorder
    .getStore()
    ?.push({ execution, operations: execution.getOperations() });

  if (execution.getStatus() === "SUCCEEDED") {
    return execution.getResult();
  }

  throw lastError instanceof Error
    ? lastError
    : failedExecutionError(execution);
};
