import { voke } from "../src/app";
import { fn, createFunctions } from "../src/invoke";
import type { RouteMeta, StandardSchemaV1 } from "../src/invoke";
import { Voke } from "../src/route-builder";

const schema = <TInput, TOutput = TInput>(): StandardSchemaV1<
  TInput,
  TOutput
> => ({
  "~standard": {
    validate: (value) => ({ value: value as unknown as TOutput }),
    vendor: "voke-test",
    version: 1,
  },
});

const app = new Voke();
const getUserRoute = app.get("/users/:id", {
  body: schema<unknown, { ignored?: true }>(),
  handler: (req) => ({
    id: req.params.id,
    includePosts: req.query.includePosts,
    requestId: req.headers["x-request-id"],
  }),
  headers: schema<Headers, { "x-request-id": string }>(),
  params: schema<{ id: string }>(),
  query: schema<Record<string, string>, { includePosts: boolean }>(),
});
const createUserRoute = app.post("/users", {
  body: schema<{ name: string }>(),
  handler: (req) => ({ id: "usr_1", name: req.body.name }),
  output: schema<{ id: string; name: string }>(),
});
const healthRoute = app.get("/health", {
  handler: () => ({ ok: true }),
  output: schema<{ ok: boolean }>(),
});

const functions = createFunctions({
  health: fn({
    handler: () => ({ ok: true }),
    output: schema<{ ok: boolean }>(),
  }),
  lookupUser: fn({
    handler: (payload) => ({ id: payload.id, name: "Victor" }),
    input: schema<{ id: string }>(),
    output: schema<{ id: string; name: string }>(),
  }),
  users: fn({
    routes: [getUserRoute, createUserRoute, healthRoute],
  }),
});

const _usersKind: "route" = functions.users.kind;

const _getUser: Promise<{
  id: string;
  includePosts: boolean;
  requestId: string;
}> = functions.route("GET", "/users/:id", {
  headers: new Headers({ "x-request-id": "req_1" }),
  params: { id: "usr_1" },
  query: { includePosts: "true" },
});

const _createUser: Promise<{ id: string; name: string }> = functions.route(
  "POST",
  "/users",
  {
    body: { name: "Victor" },
  }
);
const _health: Promise<{ ok: boolean }> = functions.route("GET", "/health");
const _lookupUser: Promise<{ id: string; name: string }> = functions.invoke(
  "lookupUser",
  { id: "usr_1" }
);
const gateway = voke(functions, { config: { name: "api" } });
const _gatewayResponse: Response | Promise<Response> =
  gateway.request("/health");

// @ts-expect-error route params are inferred from the params schema input.
void functions.route("GET", "/users/:id", { params: { userId: "usr_1" } });

// @ts-expect-error route body is inferred from the body schema input.
void functions.route("POST", "/users", { body: { fullName: "Victor" } });

// @ts-expect-error route-only functions are not accepted by functions.invoke.
void functions.invoke("users");

const _documentedRoute = app.get("/documented", {
  handler: () => ({ ok: true }),
  meta: {
    deprecated: false,
    description: "A documented route.",
    hidden: false,
    operationId: "getDocumented",
    summary: "Documented",
    tags: ["docs"],
  },
});
const _documentedMeta: RouteMeta | undefined = _documentedRoute.meta;

void app.get("/undocumented", {
  handler: () => ({ ok: true }),
  // @ts-expect-error meta accepts only the documented keys.
  meta: { title: "Unknown" },
});
