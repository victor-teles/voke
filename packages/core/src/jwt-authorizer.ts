// Local Authorizer Evaluation of JWT Authorizers. Web-standard globals only: core is bundled into
// deployed Functions, which run on Node.js with no Bun global.
import type { JwtAuthorizerDefinition } from "./authorizers";

export type JwtRejection =
  | "missing token"
  | "token is not a JWT"
  | "issuer does not match"
  | "audience does not match"
  | "exp claim is missing"
  | "token has expired"
  | "token is not valid yet";

export type JwtEvaluation =
  | { readonly ok: true; readonly claims: Record<string, string> }
  | { readonly ok: false; readonly reason: JwtRejection };

export type IdentityValue =
  | { readonly kind: "value"; readonly value: string | undefined }
  // $context.<name>: API Gateway always has it.
  | { readonly kind: "context" }
  | { readonly kind: "unsupported" };

const HEADER_SOURCE = /^\$request\.header\.([^.\s]+)$/iu;
const QUERY_SOURCE = /^\$request\.querystring\.([^.\s]+)$/u;
const CONTEXT_SOURCE = /^\$context\.\S+$/u;
const STAGE_VARIABLE_SOURCE = /^\$stageVariables\.\S+$/u;
const BEARER_PREFIX = /^\s*bearer(?:\s+|$)/iu;
const BASE64URL_DASH = /-/gu;
const BASE64URL_UNDERSCORE = /_/gu;

const present = (value: string | null): string | undefined =>
  value === null || value.trim() === "" ? undefined : value;

/** Reads one Authorizer Identity Source expression from a local request. */
export const readIdentityValue = (
  source: string,
  request: Request,
  headers: Headers
): IdentityValue => {
  const header = HEADER_SOURCE.exec(source)?.[1];

  if (header !== undefined) {
    return { kind: "value", value: present(headers.get(header)) };
  }

  const query = QUERY_SOURCE.exec(source)?.[1];

  if (query !== undefined) {
    return {
      kind: "value",
      value: present(new URL(request.url).searchParams.get(query)),
    };
  }

  if (CONTEXT_SOURCE.test(source)) {
    return { kind: "context" };
  }

  if (STAGE_VARIABLE_SOURCE.test(source)) {
    return { kind: "value", value: undefined };
  }

  return { kind: "unsupported" };
};

const renderClaim = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(renderClaim).join(" ")}]`;
  }

  return JSON.stringify(value) ?? String(value);
};

/** Renders decoded claims the way API Gateway passes them to a Function: all strings. */
export const toGatewayClaims = (
  payload: Record<string, unknown>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(payload).map(([name, value]) => [name, renderClaim(value)])
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeSegment = (
  segment: string
): Record<string, unknown> | undefined => {
  try {
    const binary = atob(
      segment.replace(BASE64URL_DASH, "+").replace(BASE64URL_UNDERSCORE, "/")
    );
    const bytes = Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));

    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const decodePayload = (token: string): Record<string, unknown> | undefined => {
  const segments = token.split(".");

  if (segments.length !== 3) {
    return undefined;
  }

  const [header, payload] = segments;

  if (header === undefined || payload === undefined) {
    return undefined;
  }

  return decodeSegment(header) === undefined
    ? undefined
    : decodeSegment(payload);
};

const matchesAudience = (
  authorizer: JwtAuthorizerDefinition,
  payload: Record<string, unknown>
): boolean => {
  // API Gateway evaluates client_id only when aud is absent.
  const claim = "aud" in payload ? payload.aud : payload.client_id;
  const values = Array.isArray(claim) ? claim : [claim];

  return values.some(
    (value) => typeof value === "string" && authorizer.audience.includes(value)
  );
};

const notAfter = (claim: unknown, nowSeconds: number): boolean =>
  claim === undefined || (typeof claim === "number" && claim <= nowSeconds);

const checkClaims = (
  authorizer: JwtAuthorizerDefinition,
  payload: Record<string, unknown>,
  nowSeconds: number
): JwtRejection | undefined => {
  if (payload.iss !== authorizer.issuer) {
    return "issuer does not match";
  }

  if (!matchesAudience(authorizer, payload)) {
    return "audience does not match";
  }

  if (typeof payload.exp !== "number") {
    return "exp claim is missing";
  }

  if (payload.exp <= nowSeconds) {
    return "token has expired";
  }

  if (
    !(notAfter(payload.nbf, nowSeconds) && notAfter(payload.iat, nowSeconds))
  ) {
    return "token is not valid yet";
  }

  return undefined;
};

/**
 * Local Authorizer Evaluation of a JWT Authorizer. It checks the token's shape and its iss,
 * aud or client_id, exp, nbf and iat claims. It does NOT verify the signature, so it never
 * proves that a token is genuine.
 */
export const evaluateJwt = (
  authorizer: JwtAuthorizerDefinition,
  token: string | undefined,
  nowSeconds: number
): JwtEvaluation => {
  const raw = (token ?? "").replace(BEARER_PREFIX, "").trim();

  if (raw === "") {
    return { ok: false, reason: "missing token" };
  }

  const payload = decodePayload(raw);

  if (payload === undefined) {
    return { ok: false, reason: "token is not a JWT" };
  }

  const rejection = checkClaims(authorizer, payload, nowSeconds);

  return rejection === undefined
    ? { claims: toGatewayClaims(payload), ok: true }
    : { ok: false, reason: rejection };
};
