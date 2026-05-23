# Voke

Voke is a framework for creating, testing, building, and synthesizing Hono APIs and related serverless functions from a config-first project model.

## Language

**Voke Project**:
A source-controlled application whose framework workflows are driven by `voke.config.ts`.
_Avoid_: Generated app, scaffold

**Project Starter**:
The initial files created by `voke create api` for a new **Voke Project**.
_Avoid_: Template output, boilerplate

**Route Module**:
A Hono route group with an optional base path that can be composed into a **Voke Project** API.
_Avoid_: Router file, endpoint file

**Function**:
A named serverless compute unit in a **Voke Project** that can be invoked by other project code, optionally exposed over HTTP, and deployed independently.
_Avoid_: Worker, callback, handler-only function

**Function Registry**:
The typed catalog of **Functions** available inside a **Voke Project**.
_Avoid_: Function map, worker list

**Function Contract**:
The input and output schemas that define what a **Function** accepts and returns.
_Avoid_: Validation callbacks, TypeScript-only shape

**Gateway**:
The API Gateway-facing assembly that exposes HTTP-backed **Functions**.
_Avoid_: API app, route module as primary API

**Route Builder**:
The JavaScript-friendly builder used to define HTTP routes for a **Function**.
_Avoid_: Hono app as primary API, route module as primary API

**Event Source**:
A trigger relationship where an external event provider invokes a **Function**.
_Avoid_: Worker, background route, queue handler as a separate concept

**SQS Event Source**:
An **Event Source** where an SQS queue invokes a **Function** through a Lambda event source mapping.
_Avoid_: SQS route, SQS worker, queue resource

**SQS Message Batch**:
The normalized input delivered to a **Function** by an **SQS Event Source**, where each message exposes a parsed body plus raw provider metadata.
_Avoid_: Raw SQS event as primary contract, queue payload

**SQS Batch Result**:
The handler result that tells an **SQS Event Source** which messages failed while allowing successful messages in the same batch to stay acknowledged.
_Avoid_: Raw Lambda batch response as primary contract

**Event Invocation**:
The local test/runtime path that delivers an event-shaped payload to an Event Source Function.
_Avoid_: Function invocation, route invocation

## Relationships

- A **Voke Project** has exactly one `voke.config.ts` as its project source of truth.
- A **Project Starter** creates one **Voke Project**.
- A **Voke Project** can define one or more **Functions**.
- A **Voke Project** can have exactly one **Function Registry**.
- A **Function Registry** contains zero or more **Functions**.
- A **Function** has a handler as its executable code.
- A **Function** has a **Function Contract**.
- A **Function** can have an explicit deployed name used for its AWS Lambda deployment.
- A **Function** can define one or more HTTP routes.
- A **Function** can define HTTP routes through a **Route Builder**.
- A **Function** can have HTTP route handlers, an invokable handler, or both.
- A **Function** can have one or more **Event Sources**.
- A Function with **Event Sources** does not mix HTTP routes or invokable handlers in v1.
- An **SQS Event Source** is attached to a **Function**.
- An **SQS Event Source** delivers an **SQS Message Batch** to its **Function**.
- An **SQS Event Source** uses partial batch failure reporting by default.
- An SQS Function can have one or more **SQS Event Sources**.
- Project code primarily invokes **Functions** through its imported **Function Registry**.
- A **Function Registry** is activated for local invocation by a **Gateway**.
- A **Gateway** accepts a **Function Registry** as top-level app composition.
- **Functions** are internal and invokable unless they define an HTTP route.
- A **Function Registry** can perform **Event Invocation** for Event Source Functions.

## Example dialogue

> **Dev:** "Is this helper just a TypeScript handler?"
> **Domain expert:** "No, a **Function** is the serverless compute unit; the handler is only the code that runs inside it."
>
> **Dev:** "Should route code invoke `prefix-get-user` directly?"
> **Domain expert:** "No, route code invokes the **Function Registry** key; Voke resolves that to the deployed name when using AWS."
>
> **Dev:** "Does route code use app context to call another **Function**?"
> **Domain expert:** "No, project code invokes **Functions** through direct **Function Registry** imports."
>
> **Dev:** "Can a **Function Registry** run local calls before the **Gateway** exists?"
> **Domain expert:** "No, the **Gateway** activates the **Function Registry** for local invocation."
>
> **Dev:** "What if local code invokes a **Function Registry** before activation?"
> **Domain expert:** "Voke should fail with a clear configuration error instead of silently falling back."
>
> **Dev:** "Does every **Function** become an HTTP endpoint?"
> **Domain expert:** "No, only **Functions** that define HTTP routes are exposed by the **Gateway**, and one **Function** can expose multiple routes."
>
> **Dev:** "Is an SQS consumer a separate worker concept?"
> **Domain expert:** "No, SQS is an **Event Source** that invokes a **Function**."
>
> **Dev:** "Is `sqsQueue()` how I attach a queue trigger?"
> **Domain expert:** "No, `sqsQueue()` defines a queue resource; `sqsEventSource()` attaches a queue as an **SQS Event Source**."
>
> **Dev:** "Does an SQS Event Source point at the queue object?"
> **Domain expert:** "No, it points at the queue resource key; Voke resolves that key during model and CloudFormation synthesis."
>
> **Dev:** "Does an SQS Function receive the raw AWS SQS event?"
> **Domain expert:** "No, the primary contract is an **SQS Message Batch** with parsed message bodies; raw provider records remain available inside each message."
>
> **Dev:** "If one SQS message fails, should Voke retry the whole batch?"
> **Domain expert:** "No, **SQS Event Sources** use partial batch failure reporting by default so successful messages are not retried."
>
> **Dev:** "Does an SQS Function manually declare its output?"
> **Domain expert:** "No, an SQS Function uses the **SQS Batch Result** output contract by default."
>
> **Dev:** "Can the same Function expose HTTP routes and consume SQS?"
> **Domain expert:** "No, Event Source Functions do not mix HTTP routes or invokable handlers in v1."
>
> **Dev:** "Does `events` mean only one queue?"
> **Domain expert:** "No, an SQS Function can list multiple **SQS Event Sources** as long as they are the same entrypoint kind."
>
> **Dev:** "Does an SQS Event Source configure queue redrive behavior?"
> **Domain expert:** "No, an SQS Event Source configures Lambda trigger behavior; queue redrive belongs to the queue resource."
>
> **Dev:** "Is DLQ/redrive part of SQS Event Source v1?"
> **Domain expert:** "No, DLQ/redrive is deferred from SQS Event Source v1 because it belongs to queue resource lifecycle design."
>
> **Dev:** "Does an invalid SQS message body fail the whole batch?"
> **Domain expert:** "No, invalid message bodies are automatic per-message failures by default, and only valid parsed messages reach the handler unless that behavior is disabled."
>
> **Dev:** "Where do I disable automatic invalid-message failure?"
> **Domain expert:** "On the **SQS Message Batch** contract with `invalidMessageBody: \"include\"`, because it changes input normalization rather than trigger infrastructure."
>
> **Dev:** "Does `sqsMessageBatch()` parse raw string messages?"
> **Domain expert:** "No, the v1 primary SQS contract treats message bodies as JSON application messages."
>
> **Dev:** "Should tests call an SQS Function handler directly?"
> **Domain expert:** "No, tests use **Event Invocation** through the **Function Registry** so SQS normalization and validation stay in the path."
>
> **Dev:** "Does `functions.sendEvent(...)` require a source for SQS?"
> **Domain expert:** "No, SQS is the default Event Invocation source in v1, though callers may state `source: \"sqs\"` explicitly."
>
> **Dev:** "Do local SQS tests have to build full AWS records?"
> **Domain expert:** "No, local **Event Invocation** accepts minimal messages with a body and lets Voke synthesize SQS metadata."
>
> **Dev:** "Do users write the deployed AWS SQS adapter?"
> **Domain expert:** "No, Voke owns SQS event normalization, handler execution, and Lambda batch response conversion."
>
> **Dev:** "Do I write Hono directly for the default HTTP path?"
> **Domain expert:** "No, the primary HTTP path uses a **Route Builder**; Hono is the implicit implementation detail."
>
> **Dev:** "Is a route handler the same entrypoint as a Function's invokable handler?"
> **Domain expert:** "No, they are separate entrypoints that can share the same deployed **Function**."
>
> **Dev:** "Does deployed code need to manually provide a Lambda invoke client for every **Function** call?"
> **Domain expert:** "No, Voke provides the default deployed invoke path; explicit transports are for tests and overrides."
>
> **Dev:** "Is a handler's TypeScript signature enough to describe a **Function**?"
> **Domain expert:** "No, a **Function Contract** defines the runtime-parsed input and output."
>
> **Dev:** "Is HTTP route invocation a **Gateway** concern?"
> **Domain expert:** "No, typed route invocation belongs to the **Function Registry**; the **Gateway** handles HTTP request execution and exposure."
>
> **Dev:** "Does HTTP return the same shape as internal invocation?"
> **Domain expert:** "No, internal invocation returns parsed values directly, while HTTP raw values are serialized with the API response envelope."

## Flagged ambiguities

- "Project creation" means creating a **Project Starter** through `voke create api`, not migrating an existing Serverless project.
- "function" can mean a generic TypeScript function or a Voke **Function**; use **Function** only for the named serverless compute unit.
- In `defineFunction`, "name" means an optional deployed AWS Lambda name, not the local registry key.
- A **Function Registry** key is the stable project identity used for type-safe invocation.
- A **Function Registry** belongs either to top-level API app composition or config input for a given app, not both.
- **Functions** use explicit input and output schemas as their primary contract.
- **Function Contracts** replace validation callbacks.
- HTTP route output schemas are optional, while invokable **Functions** require output schemas.
- Function invocation belongs to a **Function Registry**, not a global invoke helper.
- HTTP routes belong inside **Function** definitions in the primary authoring path; Hono is implicit by default.
- HTTP-backed **Functions** use a JavaScript-friendly **Route Builder** in the primary authoring path.
- Typed route invocation belongs to the **Function Registry**, not the **Gateway**.
- HTTP raw value serialization keeps the `{ data: ... }` success envelope.
- `sqsEventSource()` is the primary helper for attaching an **SQS Event Source** to a **Function**.
- An **SQS Event Source** references its queue by Voke resource key, not by passing the queue resource object.
- **SQS Message Batch** handlers validate message bodies as the primary contract instead of requiring users to validate the raw AWS SQS event.
- **SQS Batch Result** is the primary handler output for partial batch failure behavior.
- SQS Functions do not require users to manually provide an output schema.
- Event Source Functions do not mix with HTTP routes or invokable handlers in v1.
- SQS Functions use plural `events` and may attach multiple **SQS Event Sources**.
- SQS Event Source v1 options are limited to batch size, maximum batching window, and enabled state.
- DLQ/redrive configuration is deferred from SQS Event Source v1.
- Invalid SQS message bodies are automatic per-message failures by default, with an explicit opt-out for handlers that need to inspect invalid messages.
- `sqsMessageBatch()` uses `invalidMessageBody: "fail" | "include"` to control invalid body handling.
- `sqsMessageBatch()` treats SQS message bodies as JSON in v1.
- Event Source Functions are tested through `functions.sendEvent(...)`, not `functions.invoke(...)` or direct handler calls.
- `functions.sendEvent(...)` defaults to SQS in v1 and also accepts an explicit `source: "sqs"`.
- Local SQS **Event Invocation** accepts minimal message inputs and synthesizes provider metadata when omitted.
- Voke owns the deployed SQS Lambda adapter rather than requiring users to write AWS event glue.
