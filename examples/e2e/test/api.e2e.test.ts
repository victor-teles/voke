import { expect, test } from "bun:test";

import { createTestClient } from "@voke/testing";

import service from "../src/index";

test("runs API E2E requests locally through API Gateway semantics", async () => {
  const client = createTestClient(service);

  const health = await client.get("/health");
  const created = await client.post("/users", {
    json: {
      email: "victor@example.com",
      id: "usr_1",
    },
  });

  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ data: { ok: true } });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({
    data: {
      id: "usr_1",
      welcome: {
        email: "victor@example.com",
        queued: true,
        userId: "usr_1",
      },
    },
  });
});
