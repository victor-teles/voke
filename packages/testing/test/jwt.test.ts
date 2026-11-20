import { expect, setSystemTime, test } from "bun:test";

import { createTestJwt } from "../src/index";

const authorizer = {
  audience: ["users-api", "admin-api"],
  issuer: "https://auth.example.com",
};

const DASH = /-/gu;
const UNDERSCORE = /_/gu;

const decode = (segment: string | undefined): unknown =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob((segment ?? "").replace(DASH, "+").replace(UNDERSCORE, "/")),
        (char) => char.codePointAt(0) ?? 0
      )
    )
  );

const payloadOf = (token: string): Record<string, unknown> =>
  decode(token.split(".")[1]) as Record<string, unknown>;

test("mints an unsecured JWT: three segments, alg none, empty signature", () => {
  const segments = createTestJwt(authorizer).split(".");

  expect(segments).toHaveLength(3);
  expect(decode(segments[0])).toEqual({ alg: "none", typ: "JWT" });
  expect(segments[2]).toBe("");
});

test("takes iss and the first audience from the authorizer", () => {
  expect(payloadOf(createTestJwt(authorizer))).toMatchObject({
    aud: "users-api",
    iss: "https://auth.example.com",
    sub: "test-user",
  });
});

test("lets claims override and add to the defaults", () => {
  expect(
    payloadOf(
      createTestJwt(authorizer, {
        aud: "admin-api",
        "cognito:groups": ["admin"],
        sub: "usr_1",
      })
    )
  ).toMatchObject({
    aud: "admin-api",
    "cognito:groups": ["admin"],
    sub: "usr_1",
  });
});

test("leaves out a claim set to undefined", () => {
  const payload = payloadOf(createTestJwt(authorizer, { exp: undefined }));

  expect("exp" in payload).toBe(false);
});

test("sets iat to now and exp one hour later", () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));

  try {
    expect(payloadOf(createTestJwt(authorizer))).toMatchObject({
      exp: 1_767_229_200,
      iat: 1_767_225_600,
    });
  } finally {
    setSystemTime();
  }
});

test("encodes non-ASCII claims as UTF-8", () => {
  expect(
    payloadOf(createTestJwt(authorizer, { name: "Zoë 名前" }))
  ).toMatchObject({ name: "Zoë 名前" });
});
