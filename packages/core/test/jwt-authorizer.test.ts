import { describe, expect, test } from "bun:test";

import type { JwtAuthorizerDefinition } from "../src/authorizers";
import {
  evaluateJwt,
  readIdentityValue,
  toGatewayClaims,
} from "../src/jwt-authorizer";

const NOW = 1_800_000_000;

const authorizer: JwtAuthorizerDefinition = {
  audience: ["users-api", "admin-api"],
  identitySource: ["$request.header.Authorization"],
  issuer: "https://auth.example.com",
  kind: "jwt",
};

const PLUS = /\+/gu;
const SLASH = /\//gu;
const PADDING = /=+$/u;

const encodeSegment = (text: string): string =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(text)))
    .replace(PLUS, "-")
    .replace(SLASH, "_")
    .replace(PADDING, "");

const UNSECURED_HEADER = { alg: "none", typ: "JWT" };

const token = (
  payload: unknown,
  header: unknown = UNSECURED_HEADER,
  signature = ""
): string =>
  `${encodeSegment(JSON.stringify(header))}.${encodeSegment(JSON.stringify(payload))}.${signature}`;

const validClaims = {
  aud: "users-api",
  exp: NOW + 3600,
  iss: "https://auth.example.com",
  sub: "usr_1",
};

const reasonFor = (value?: string): string | undefined => {
  const result = evaluateJwt(authorizer, value, NOW);

  return result.ok ? undefined : result.reason;
};

describe("evaluateJwt", () => {
  test("accepts a token with matching iss, aud and a future exp", () => {
    const result = evaluateJwt(authorizer, token(validClaims), NOW);

    expect(result).toEqual({
      claims: {
        aud: "users-api",
        exp: String(NOW + 3600),
        iss: "https://auth.example.com",
        sub: "usr_1",
      },
      ok: true,
    });
  });

  test("accepts the token with a Bearer prefix in any case", () => {
    expect(reasonFor(`Bearer ${token(validClaims)}`)).toBeUndefined();
    expect(reasonFor(`bearer ${token(validClaims)}`)).toBeUndefined();
  });

  test("reports a missing token", () => {
    expect(reasonFor()).toBe("missing token");
    expect(reasonFor("")).toBe("missing token");
    expect(reasonFor("Bearer ")).toBe("missing token");
  });

  test("rejects values that are not a JWT", () => {
    const [header, payload] = token(validClaims).split(".");

    expect(reasonFor("abc")).toBe("token is not a JWT");
    expect(reasonFor(`${header}.${payload}`)).toBe("token is not a JWT");
    expect(reasonFor(`${header}.${payload}.sig.extra`)).toBe(
      "token is not a JWT"
    );
    expect(reasonFor(`${header}.!!!not-base64!!!.`)).toBe("token is not a JWT");
    expect(reasonFor(token(["a"]))).toBe("token is not a JWT");
    expect(reasonFor(token("a string"))).toBe("token is not a JWT");
  });

  test("requires the configured issuer exactly", () => {
    expect(reasonFor(token({ ...validClaims, iss: "https://other" }))).toBe(
      "issuer does not match"
    );
    expect(reasonFor(token({ ...validClaims, iss: undefined }))).toBe(
      "issuer does not match"
    );
    expect(
      reasonFor(token({ ...validClaims, iss: "https://auth.example.com/" }))
    ).toBe("issuer does not match");
    expect(reasonFor(token({ ...validClaims, iss: 7 }))).toBe(
      "issuer does not match"
    );
  });

  test("matches aud before client_id against the configured audience", () => {
    expect(
      reasonFor(token({ ...validClaims, aud: "admin-api" }))
    ).toBeUndefined();
    expect(
      reasonFor(token({ ...validClaims, aud: ["other", "admin-api"] }))
    ).toBeUndefined();
    expect(reasonFor(token({ ...validClaims, aud: "other" }))).toBe(
      "audience does not match"
    );
    expect(
      reasonFor(
        token({ ...validClaims, aud: undefined, client_id: "users-api" })
      )
    ).toBeUndefined();
    expect(
      reasonFor(token({ ...validClaims, aud: "other", client_id: "users-api" }))
    ).toBe("audience does not match");
    expect(reasonFor(token({ ...validClaims, aud: undefined }))).toBe(
      "audience does not match"
    );
  });

  test("requires exp to be after now", () => {
    expect(reasonFor(token({ ...validClaims, exp: NOW }))).toBe(
      "token has expired"
    );
    expect(reasonFor(token({ ...validClaims, exp: NOW + 1 }))).toBeUndefined();
    expect(reasonFor(token({ ...validClaims, exp: undefined }))).toBe(
      "exp claim is missing"
    );
    expect(reasonFor(token({ ...validClaims, exp: "soon" }))).toBe(
      "exp claim is missing"
    );
  });

  test("requires nbf and iat, when present, to be at or before now", () => {
    expect(reasonFor(token({ ...validClaims, nbf: NOW }))).toBeUndefined();
    expect(reasonFor(token({ ...validClaims, nbf: NOW + 1 }))).toBe(
      "token is not valid yet"
    );
    expect(reasonFor(token({ ...validClaims, nbf: "x" }))).toBe(
      "token is not valid yet"
    );
    expect(reasonFor(token({ ...validClaims, iat: NOW }))).toBeUndefined();
    expect(reasonFor(token({ ...validClaims, iat: NOW + 1 }))).toBe(
      "token is not valid yet"
    );
  });

  test("ignores the JOSE header and the signature", () => {
    expect(reasonFor(token(validClaims))).toBeUndefined();
    expect(
      reasonFor(
        token(validClaims, { alg: "RS256", kid: "key-1" }, "garbage-signature")
      )
    ).toBeUndefined();
  });
});

describe("toGatewayClaims", () => {
  test("renders every claim as the string API Gateway passes", () => {
    expect(
      toGatewayClaims({
        admin: true,
        exp: 1_700_000_000,
        groups: ["admin", "editor"],
        name: "Zoë 名前",
        nested: { a: 1 },
        nothing: null,
      })
    ).toEqual({
      admin: "true",
      exp: "1700000000",
      groups: "[admin editor]",
      name: "Zoë 名前",
      nested: '{"a":1}',
      nothing: "null",
    });
  });

  test("decodes non-ASCII claims from a token", () => {
    const result = evaluateJwt(
      authorizer,
      token({ ...validClaims, name: "Zoë 名前" }),
      NOW
    );

    expect(result.ok && result.claims.name).toBe("Zoë 名前");
  });
});

describe("readIdentityValue", () => {
  const request = new Request(
    "https://localhost/me?access_token=abc&blank=%20"
  );
  const headers = new Headers({ authorization: "Bearer x", "x-empty": " " });

  test("reads a header in any case", () => {
    expect(
      readIdentityValue("$request.header.AUTHORIZATION", request, headers)
    ).toEqual({ kind: "value", value: "Bearer x" });
  });

  test("reads a query string parameter by its exact name", () => {
    expect(
      readIdentityValue("$request.querystring.access_token", request, headers)
    ).toEqual({ kind: "value", value: "abc" });
    expect(
      readIdentityValue("$request.querystring.Access_Token", request, headers)
    ).toEqual({ kind: "value", value: undefined });
  });

  test("treats a blank value as missing", () => {
    expect(
      readIdentityValue("$request.header.x-empty", request, headers)
    ).toEqual({ kind: "value", value: undefined });
    expect(
      readIdentityValue("$request.querystring.blank", request, headers)
    ).toEqual({ kind: "value", value: undefined });
  });

  test("counts context variables as present and stage variables as missing", () => {
    expect(readIdentityValue("$context.routeKey", request, headers)).toEqual({
      kind: "context",
    });
    expect(readIdentityValue("$stageVariables.x", request, headers)).toEqual({
      kind: "value",
      value: undefined,
    });
  });

  test("reports other expressions as unsupported", () => {
    expect(readIdentityValue("$request.cookie.x", request, headers)).toEqual({
      kind: "unsupported",
    });
  });
});
