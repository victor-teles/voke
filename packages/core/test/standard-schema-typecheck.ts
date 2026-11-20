import { z } from "zod";

import { createFunctions, fn } from "../src/invoke";
import { route } from "../src/route-builder";
import type {
  StandardSchemaInput,
  StandardSchemaOutput,
  StandardSchemaV1,
} from "../src/standard-schema";

declare const expectType: <TExpected>(value: TExpected) => void;

// A library schema is read from its declared `types`.
const user = z.object({ id: z.string() });
const zodInput: StandardSchemaInput<typeof user> = { id: "usr_1" };
const zodOutput: StandardSchemaOutput<typeof user> = { id: "usr_1" };
// @ts-expect-error A Zod input is typed, not unknown.
const zodWrongInput: StandardSchemaInput<typeof user> = { id: 1 };

// A hand-written schema without `types` is read from `validate`.
const handWritten = {
  "~standard": {
    validate: (value: unknown) =>
      typeof value === "string"
        ? { value }
        : { issues: [{ message: "expected string" }] },
    vendor: "voke-typecheck",
    version: 1 as const,
  },
};
const handWrittenOutput: StandardSchemaOutput<typeof handWritten> = "text";
// @ts-expect-error The hand-written output is a string.
const handWrittenWrongOutput: StandardSchemaOutput<typeof handWritten> = 1;

// An annotated schema keeps both sides.
declare const annotated: StandardSchemaV1<{ id: string }, { id: number }>;
const annotatedInput: StandardSchemaInput<typeof annotated> = { id: "1" };
const annotatedOutput: StandardSchemaOutput<typeof annotated> = { id: 1 };

const functions = createFunctions({
  getUser: fn({
    handler: (payload) => {
      expectType<{ id: string }>(payload);
      return { id: payload.id };
    },
    input: user,
    output: user,
  }),
});

void functions.invoke("getUser", { id: "usr_1" });
// @ts-expect-error The payload is checked against the Zod schema.
void functions.invoke("getUser", { id: 1 });

void [
  zodInput,
  zodOutput,
  zodWrongInput,
  handWrittenOutput,
  handWrittenWrongOutput,
  annotatedInput,
  annotatedOutput,
];

// A route handler is checked against its `output` schema, whatever the validator.
void route.post("/users", {
  body: user,
  handler: (request) => ({ id: request.body.id }),
  output: user,
});
void route.get("/users/:id", {
  // @ts-expect-error A route handler returns what its Zod output schema accepts.
  handler: () => ({ id: 1 }),
  output: user,
});
// A `Response` is always allowed; the `output` schema does not apply to it.
void route.get("/users/:id/avatar", {
  handler: (request) =>
    request.params.id === "usr_1"
      ? { id: "usr_1" }
      : new Response(null, { status: 404 }),
  output: user,
});

fn({
  // @ts-expect-error An invokable handler returns what its Zod output schema accepts.
  handler: () => ({ id: 1 }),
  output: user,
});
