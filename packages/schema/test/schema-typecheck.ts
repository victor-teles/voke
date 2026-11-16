import { createFunctions, fn, http, route } from "voke";
import type {
  StandardSchemaInput,
  StandardSchemaOutput,
  StandardSchemaV1,
} from "voke";

import { schema } from "../src/index";

const order = schema.object({
  deletedAt: schema.null(),
  id: schema.string().min(1),
  kind: schema.literal("order"),
  note: schema.optional(schema.string()),
  paid: schema.boolean(),
  quantity: schema.coerce.number().int(),
  status: schema.enum(["pending", "paid"]),
  tags: schema.array(schema.string()),
});
const orderId = schema.object({ id: schema.string() });

// The input side is typed: an optional key may be left out, a coercing number accepts a string.
const orderInput: StandardSchemaInput<typeof order> = {
  deletedAt: null,
  id: "ord_1",
  kind: "order",
  paid: false,
  quantity: "2",
  status: "pending",
  tags: ["gift"],
};
// @ts-expect-error The input of a @voke/schema object is typed, not unknown.
const numberAsInput: StandardSchemaInput<typeof order> = 42;
// @ts-expect-error A field of the input is typed.
const wrongField: StandardSchemaInput<typeof orderId> = { id: 1 };
// @ts-expect-error A required key cannot be left out.
const missingKey: StandardSchemaInput<typeof orderId> = {};
// @ts-expect-error An enum input is one of its values.
const wrongStatus: StandardSchemaInput<typeof order>["status"] = "shipped";

// The output side keeps its types: a coercing number always returns a number.
const quantity: StandardSchemaOutput<typeof order>["quantity"] = 2;
// @ts-expect-error The coerced output is a number.
const quantityText: StandardSchemaOutput<typeof order>["quantity"] = "2";

// `validate` accepts any value, as the specification requires.
void order["~standard"].validate("untrusted");
const anySchema: StandardSchemaV1<unknown, unknown> = order;

const functions = createFunctions({
  createOrder: fn({
    handler: (payload) => ({ id: payload.id }),
    input: order,
    output: orderId,
  }),
  orders: http({
    routes: [
      route.post("/orders", {
        body: orderId,
        handler: (request) => ({ id: request.body.id }),
        output: orderId,
      }),
    ],
  }),
});

void functions.invoke("createOrder", orderInput);
// @ts-expect-error The payload is checked against the @voke/schema input schema.
void functions.invoke("createOrder", 42);

const routed: Promise<{ readonly id: string }> = functions.route(
  "POST",
  "/orders",
  { body: { id: "ord_1" } }
);
// @ts-expect-error The route body is checked against the @voke/schema body schema.
void functions.route("POST", "/orders", { body: { id: 1 } });

fn({
  // @ts-expect-error An invokable handler returns what its output schema accepts.
  handler: () => ({ id: 1 }),
  output: orderId,
});

void route.get("/orders/:id", {
  // @ts-expect-error A route handler returns what its output schema accepts.
  handler: () => ({ id: 1 }),
  output: orderId,
});

void [
  orderInput,
  numberAsInput,
  wrongField,
  missingKey,
  wrongStatus,
  quantity,
  quantityText,
  anySchema,
  routed,
];
