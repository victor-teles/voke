import { createRemoteFunctions } from "../src/index";

// Compiled by this package's typecheck: a Remote Function Registry accepts only the invoke
// options the Dev Function Invoke Endpoint can honour.
const users = createRemoteFunctions("users", {
  fingerprint: "sha256:test",
  functions: {
    getUser: {
      input: {
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      output: true,
    },
  },
  project: "users",
  version: 1,
} as const);

export const checkRemoteInvokeOptions = async (): Promise<void> => {
  await users.invoke(
    "getUser",
    { id: "usr_1" },
    { retries: 1, timeoutMs: 100, trace: {} }
  );
  // @ts-expect-error A Remote Function Registry has no asynchronous mode.
  await users.invoke("getUser", { id: "usr_1" }, { mode: "async" });
  // @ts-expect-error Execution names belong to Provider invocations, not remote calls.
  await users.invoke("getUser", { id: "usr_1" }, { executionName: "x" });
};
