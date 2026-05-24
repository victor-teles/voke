import { expect, test } from "bun:test";

import { createFunctions } from "voke";
import { createInvokeTestClient } from "voke/testing";

import { sendWelcomeEmail } from "../src/functions";

test("runs worker E2E flows through invoke helpers", async () => {
  const client = createInvokeTestClient(createFunctions({ sendWelcomeEmail }));

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
