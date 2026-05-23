import { expect, test } from "bun:test";

import { createTestClient } from "voke";

import service from "../src/index";

test("routes API requests through a local function invoke", async () => {
  const client = createTestClient(service);
  const response = await client.get("/users/usr_1", {
    headers: {
      "x-request-id": "req_cross",
    },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: {
      id: "usr_1",
      name: "Victor",
      requestId: "req_cross",
    },
  });
});
