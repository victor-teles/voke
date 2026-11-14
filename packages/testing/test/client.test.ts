import { expect, test } from "bun:test";

import { createTestClient } from "../src/index";

test("keeps the base URL stage path for absolute and relative request paths", async () => {
  const urls: string[] = [];
  const client = createTestClient({
    baseUrl: "https://api.example.com/prod/",
    fetch: (request) => {
      urls.push(request.url);

      return new Response(null, { status: 204 });
    },
  });

  await client.get("/users?limit=1");
  await client.get("users");

  expect(urls).toEqual([
    "https://api.example.com/prod/users?limit=1",
    "https://api.example.com/prod/users",
  ]);
});
