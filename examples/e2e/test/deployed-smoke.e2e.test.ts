import { expect, test } from "bun:test";

import { createTestClient } from "voke/testing";

const apiUrl = Bun.env.VOKE_E2E_API_URL;
const smoke = apiUrl === undefined ? test.skip : test;

smoke("runs the same E2E suite against a deployed stack", async () => {
  if (apiUrl === undefined) {
    throw new Error("VOKE_E2E_API_URL is required for deployed smoke tests");
  }

  const client = createTestClient({ baseUrl: apiUrl });
  const response = await client.get("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { ok: true } });
});
