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

**Function Contract Artifact**:
An implementation-free, JSON-schema-like metadata description of one or more **Function Contracts** that another **Voke Project** can consume even when the provider project's source code lives elsewhere.
_Avoid_: Function implementation import, remote source import, TypeScript-only contract module

**Remote Function Registry**:
A typed catalog of Functions provided by another **Voke Project** and invoked through that project's runtime endpoint instead of local handlers.
_Avoid_: Imported implementation registry, HTTP route client

**Dev Function Invoke Endpoint**:
A Voke-owned local development endpoint exposed by a provider **Voke Project** so another project can invoke its internal **Functions** without those Functions becoming public HTTP routes.
_Avoid_: Public function route, user-defined HTTP endpoint

**Remote Code Generation**:
The explicit workflow where a consuming **Voke Project** fetches a provider's **Function Contract Artifact** and generates local typed remote-function code before runtime.
_Avoid_: Runtime-only contract fetching, implicit boot-time type discovery

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

**Dev Function Summary**:
A human-readable startup log that lists the runtime **Gateway** assembly's **Functions** and **Event Sources** during `voke dev`.
_Avoid_: Inspect API, machine-readable manifest, config summary

## Relationships

- A **Voke Project** has exactly one `voke.config.ts` as its project source of truth.
- A **Project Starter** creates one **Voke Project**.
- A **Voke Project** can define one or more **Functions**.
- A **Voke Project** can have exactly one **Function Registry**.
- A **Function Registry** contains zero or more **Functions**.
- A **Function** has a handler as its executable code.
- A **Function** has a **Function Contract**.
- A **Function Contract Artifact** can describe **Functions** without exposing or importing their handlers.
- A **Voke Project** can consume a **Function Contract Artifact** from another **Voke Project** without sharing source repositories.
- A **Function Contract Artifact** may be generated, fetched from provider metadata, or written manually.
- Runtime-exposed provider metadata is the primary source for generating a **Function Contract Artifact**.
- A **Function Contract Artifact** is portable metadata for code generation and cross-language consumption.
- A **Function Contract Artifact** has a stable fingerprint that changes when its public Function contract surface changes.
- **Remote Code Generation** is the primary happy path for consuming provider metadata.
- `voke remote generate` runs **Remote Code Generation** for every configured remote by default.
- `voke remote generate <name>` runs **Remote Code Generation** for one configured remote.
- A consuming **Voke Project** should be able to typecheck and run tests from generated remote-function code without the provider dev server running.
- **Remote Code Generation** produces checked-in generated modules in the consuming **Voke Project**.
- A generated remote module exports a ready-to-import **Remote Function Registry** created with `defineRemoteFunctions`.
- The default generated remote module path is `src/voke/remotes/<remote>.ts`.
- A configured remote can override its generated module path with `out`.
- A generated remote module embeds the provider **Function Contract Artifact** fingerprint it was generated from.
- A **Remote Function Registry** is created from a **Function Contract Artifact** plus a runtime target for the provider project.
- A **Remote Function Registry** preserves Function-key invocation without requiring provider source imports.
- A **Remote Function Registry** sends its expected contract fingerprint during remote invocation when the provider can validate it.
- A consuming **Voke Project** defines runtime targets for its **Remote Function Registries** in `voke.config.ts`.
- Remote runtime targets are keyed by provider project name, not repeated at each invocation callsite.
- Remote runtime targets are selected by stage, with environment overrides available as escape hatches.
- A remote contract metadata URL can be omitted when it can be derived from the selected runtime target plus `/_voke/contract`.
- Cross-project invocation v1 focuses on local `voke dev` to local `voke dev` invocation.
- The remote target model stays stage-aware so deployed cross-project invocation can be added later without changing the core vocabulary.
- A provider **Voke Project** exposes a **Dev Function Invoke Endpoint** during `voke dev` for remote local Function invocation.
- A **Dev Function Invoke Endpoint** is reserved for Voke runtime traffic and is separate from user-defined HTTP routes.
- A **Dev Function Invoke Endpoint** can invoke internal **Functions** that do not define public HTTP routes.
- A **Dev Function Invoke Endpoint** does not require Voke-managed tokens in v1.
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
- A **Gateway** is the runtime source of truth for dev-visible **Function** and **Event Source** details.
- A **Dev Function Summary** is produced from the runtime **Gateway** assembly.
- A **Dev Function Summary** is emitted automatically under `voke dev` and remains silent outside `voke dev`.
- A **Dev Function Summary** lists every **Function** in the runtime **Gateway** assembly grouped by entrypoint kind.
- A **Dev Function Summary** shows HTTP route URLs for route-backed **Functions** so local routes can be opened in an external browser.
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
> **Dev:** "Does cross-project invocation require importing the provider project's Function implementation?"
> **Domain expert:** "No, cross-project invocation consumes a **Function Contract Artifact** so projects in separate repositories can still call each other through typed contracts."
>
> **Dev:** "Should the provider dev server be the only source of cross-project types?"
> **Domain expert:** "No, a portable **Function Contract Artifact** is the primary source; live discovery can be a convenience, but CI and editors should not require another dev server to be running."
>
> **Dev:** "Should generated contracts be TypeScript modules?"
> **Domain expert:** "No, the canonical **Function Contract Artifact** is JSON-schema-like metadata so services can expose it and other services can fetch it for code generation."
>
> **Dev:** "Does the provider need a contract emit command before another project can generate remotes?"
> **Domain expert:** "No, provider `voke dev` exposes contract metadata at runtime; `voke remote generate` fetches that metadata and writes checked-in generated modules in the consuming project."
>
> **Dev:** "Should wallet fetch users contracts every time it boots?"
> **Domain expert:** "No, **Remote Code Generation** fetches provider metadata explicitly before runtime so editor types, CI, and tests do not depend on another dev server being online."
>
> **Dev:** "Should wallet invoke users if its generated contract is stale?"
> **Domain expert:** "No, remote invocation should fail clearly on contract fingerprint drift and tell the caller project to regenerate its remote code."
>
> **Dev:** "Should app code hand-write Remote Function Registries after generation?"
> **Domain expert:** "No, **Remote Code Generation** produces a checked-in generated module that exports a ready-to-import `defineRemoteFunctions` registry."
>
> **Dev:** "Where should generated Remote Function Registries live?"
> **Domain expert:** "By default in `src/voke/remotes/<remote>.ts`, with a per-remote `out` override when a project needs a different generated-code layout."
>
> **Dev:** "Is a Remote Function Registry an HTTP route client?"
> **Domain expert:** "No, a **Remote Function Registry** invokes provider **Functions** by Function key and contract, even if the local transport happens to use HTTP."
>
> **Dev:** "Should every callsite pass the users project origin?"
> **Domain expert:** "No, the consuming **Voke Project** defines the users runtime target once in `voke.config.ts`; callsites invoke the **Remote Function Registry** by Function key."
>
> **Dev:** "Does every remote need an explicit contract URL?"
> **Domain expert:** "No, a remote can default contract metadata discovery from its selected runtime target plus `/_voke/contract`; explicit contract URLs are for different metadata locations."
>
> **Dev:** "Should a remote Function need a public HTTP route for local cross-project invocation?"
> **Domain expert:** "No, provider `voke dev` exposes a reserved **Dev Function Invoke Endpoint** so internal **Functions** remain invokable without becoming public routes."
>
> **Dev:** "Does v1 require a Voke-managed token for local remote invocation?"
> **Domain expert:** "No, v1 does not add token handling to the **Dev Function Invoke Endpoint**."
>
> **Dev:** "Does v1 solve deployed cross-project invocation too?"
> **Domain expert:** "No, v1 focuses on local `voke dev` to local `voke dev` invocation, while the stage-aware remote target model leaves room for deployed targets later."
>
> **Dev:** "Is HTTP route invocation a **Gateway** concern?"
> **Domain expert:** "No, typed route invocation belongs to the **Function Registry**; the **Gateway** handles HTTP request execution and exposure."
>
> **Dev:** "Does HTTP return the same shape as internal invocation?"
> **Domain expert:** "No, internal invocation returns parsed values directly, while HTTP raw values are serialized with the API response envelope."
>
> **Dev:** "Should `voke dev` list **Functions** from `voke.config.ts` before booting?"
> **Domain expert:** "No, dev-visible **Function** and **Event Source** details come from the runtime **Gateway** assembly after it activates the **Function Registry**."
>
> **Dev:** "Is the dev function listing a JSON manifest?"
> **Domain expert:** "No, the v1 **Dev Function Summary** is a compact human startup log, not a machine-readable API."
>
> **Dev:** "Should app code call a print helper to see dev details?"
> **Domain expert:** "No, the **Dev Function Summary** appears automatically under `voke dev` and stays silent in tests, production, and non-dev scripts."
>
> **Dev:** "Should the summary only show externally reachable **Functions**?"
> **Domain expert:** "No, the **Dev Function Summary** lists every **Function** in the runtime **Gateway** assembly and groups them by route, invokable, and event entrypoint kind."
>
> **Dev:** "Should HTTP routes only show method and path?"
> **Domain expert:** "No, route-backed entries in the **Dev Function Summary** also show the local URL for quick browser access."

## Flagged ambiguities

- "Project creation" means creating a **Project Starter** through `voke create api`, not migrating an existing Serverless project.
- "function" can mean a generic TypeScript function or a Voke **Function**; use **Function** only for the named serverless compute unit.
- In `defineFunction`, "name" means an optional deployed AWS Lambda name, not the local registry key.
- A **Function Registry** key is the stable project identity used for type-safe invocation.
- A **Function Registry** belongs either to top-level API app composition or config input for a given app, not both.
- **Functions** use explicit input and output schemas as their primary contract.
- **Function Contracts** replace validation callbacks.
- Cross-project invocation must not require importing a provider project's Function implementation source.
- A **Function Contract Artifact** uses JSON-schema-like portable metadata so it can be exposed by services and fetched by other services for code generation.
- A **Function Contract Artifact** may be handwritten or fetched from provider runtime metadata for code generation.
- Remote invocation should fail loudly on contract fingerprint drift instead of silently invoking with stale generated code.
- **Remote Code Generation** is explicit and happens before runtime; provider contract metadata is exposed at runtime for generation, not fetched implicitly on every consumer boot.
- `voke remote generate` defaults to every configured remote; passing a remote name narrows generation to that remote.
- Generated remote modules are checked into the consuming project and export ready-to-import **Remote Function Registries** using `defineRemoteFunctions`.
- Generated remote modules default to `src/voke/remotes/<remote>.ts`, with `out` available for per-remote path overrides.
- A **Remote Function Registry** must not be reduced to an HTTP route client; it preserves Function invocation semantics across project boundaries.
- Remote runtime targets belong in the consuming project's `voke.config.ts`, keyed by provider project name, rather than inline in invocation callsites.
- Remote runtime targets are stage-aware; contract metadata defaults to the selected target's `/_voke/contract` endpoint unless explicitly configured.
- Cross-project invocation v1 is local-dev focused; deployed cross-project invocation is deferred while preserving a compatible config shape.
- Local cross-project invocation uses a reserved **Dev Function Invoke Endpoint**, not user-defined HTTP routes.
- The first **Dev Function Invoke Endpoint** design does not include Voke-managed tokens.
- HTTP route output schemas are optional, while invokable **Functions** require output schemas.
- Function invocation belongs to a **Function Registry**, not a global invoke helper.
- HTTP routes belong inside **Function** definitions in the primary authoring path; Hono is implicit by default.
- HTTP-backed **Functions** use a JavaScript-friendly **Route Builder** in the primary authoring path.
- Typed route invocation belongs to the **Function Registry**, not the **Gateway**.
- Dev-visible Function and Event Source details come from the runtime **Gateway** assembly, not from pre-boot config inspection.
- The v1 **Dev Function Summary** is human-readable output only; JSON output is not part of the v1 contract.
- The **Dev Function Summary** is automatic under `voke dev`, not an explicit user-code call.
- The **Dev Function Summary** includes internal invokable **Functions** as well as route-backed and Event Source **Functions**.
- Route-backed entries in the **Dev Function Summary** include local URLs in addition to method and path.
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
