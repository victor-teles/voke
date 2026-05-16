import { expect, test } from "bun:test";

import { createFunctionRegistry, createInvokeTestClient } from "voke";

import { sendWelcomeEmail } from "../src/functions";

test("runs worker E2E flows through invoke helpers", async () => {
  const client = createInvokeTestClient(
    createFunctionRegistry({ sendWelcomeEmail })
  );

  await expect(
    client.invoke("sendWelcomeEmail", {
      email: "victor@example.com",
      userId: "usr_1",
    })
  ).resolves.toEqual({
    email: "victor@example.com",
    queued: true,
    userId: "usr_1",
  });
});
