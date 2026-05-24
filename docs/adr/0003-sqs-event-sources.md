# Add SQS Event Sources as a Function entrypoint

Voke will support SQS by modelling it as an Event Source attached to a Function, not as a separate worker concept and not as an HTTP route. Users declare queues with `sqs({ queue: "queueResourceKey", message, handler })`, where the queue is referenced by Voke resource key so model and CloudFormation synthesis can resolve the queue resource consistently.

The SQS Event Source v1 option surface is intentionally narrow: batch size, maximum batching window, and enabled state. Queue redrive and DLQ configuration are deferred because they belong to queue resource lifecycle design rather than Lambda trigger wiring.

SQS Functions are a distinct v1 entrypoint shape: they use `queue` or `queues`, may attach multiple SQS Event Sources, and do not mix with HTTP routes or invokable handlers. This keeps Function Contracts unambiguous while leaving room for one deployed Lambda unit to consume more than one queue of the same entrypoint kind.

SQS handlers receive a normalized SQS Message Batch instead of the raw AWS SQS event. The `message` schema passed to `sqs(...)` parses each message body as JSON and validates it with a Standard Schema-compatible validator. Each valid message exposes a parsed body plus provider metadata and the raw record. Invalid JSON or schema failures are automatic per-message failures by default, and handlers receive only valid parsed messages. Projects that need to inspect invalid messages can opt out with `invalidMessageBody: "include"`.

Partial batch failure reporting is the default for every SQS Event Source. Voke will synthesize Lambda event source mappings with batch item failure reporting enabled and will provide an SQS Batch Result contract so handlers report failed message ids without handcrafting AWS response shapes. SQS Functions do not require users to manually provide an output schema because their output contract is the SQS Batch Result.

Local tests should use Event Invocation through the Function Registry, not direct handler calls or `functions.invoke(...)`. `functions.sendEvent(functionKey, payload)` defaults to SQS in v1 and accepts minimal body-first message inputs while Voke synthesizes SQS-like metadata. The same normalization and validation path should run locally and in deployed AWS runtime.

Voke will own the deployed SQS Lambda adapter. The adapter detects SQS events, normalizes records, parses and validates message bodies, executes the SQS Function handler, combines automatic invalid-message failures with handler-reported failures, and converts the result into Lambda's SQS batch response shape. This is intentionally batteries-included because the adapter and partial failure behavior are the most error-prone parts of SQS support.
