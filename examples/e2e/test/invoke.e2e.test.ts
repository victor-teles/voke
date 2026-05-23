import { expect, test } from "bun:test";

import { createInvokeTestClient, defineFunctions } from "voke";

import { sendWelcomeEmail } from "../src/functions";

test("runs worker E2E flows through invoke helpers", async () => {
  const client = createInvokeTestClient(defineFunctions({ sendWelcomeEmail }));

  const result = await client.invoke("sendWelcomeEmail", {
    email: "victor@example.com",
    userId: "usr_1",
  });

  expect(result as unknown).toEqual({
    email: "victor@example.com",
    queued: true,
    userId: "usr_1",
  });
});
