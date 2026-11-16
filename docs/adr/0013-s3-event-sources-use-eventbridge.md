# S3 Event Sources use EventBridge instead of bucket notifications

`@vokejs/aws` adds `s3({ bucket, on?, prefix?, suffix?, handler })`: a Function runs for each object created in or deleted from a bucket declared with `s3Bucket()`. It follows the push Event Source model (ADR "Push Event Sources fail the invocation on an invalid payload"): one event per invocation, a normalized handler input that keeps the provider event as `raw`, local Event Invocation through `functions.sendEvent`, and one Event Source per Function. There is no schema: an S3 event carries object metadata, not an application payload.

The trigger is an EventBridge rule, not a bucket notification to Lambda. A classic notification puts the Function's ARN in the bucket's `NotificationConfiguration.LambdaConfigurations`, so the bucket depends on the Function. Every Function's role holds the policy statements for every declared resource, and a bucket's statements reference it with `Fn::GetAtt`, so each role depends on the bucket, and each Function depends on its role. The result, Bucket → Function → Role → Bucket, is a circular dependency that CloudFormation rejects. The usual workaround is a fixed bucket name written into the ARN as a string, and Voke does not set physical names (ADR "AWS Emulator local provider": bindings come from stack outputs). With EventBridge the bucket only gets `NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled: true` and references nothing. The rule references the bucket (by `Ref`, in its pattern) and the Function, and the permission references the Function and the rule. Nothing points back to the rule, so there is no cycle; a test walks the synthesized template's references to prove it. ADR "Voke is an opinionated framework" allows one way, so bucket notifications are not offered as an alternative, even once per-Function resource linking removes the cycle.

The bucket flag is derived, not declared: a bucket gets it when at least one Function has an `s3` Event Source for it, and `s3Bucket()` gains no option. The internal adapter interface gains an optional `resourceProperties` member that returns the properties of the resource an Event Source references, merged with what is there. Synthesis calls it after `synthesize`; it does not run for the resources-only template, which is correct because nothing delivers S3 events locally. Enabling EventBridge sends all of the bucket's events to the account's default bus.

Key filters map to EventBridge operators on `detail.object.key`: `prefix` alone is `{ prefix }`, `suffix` alone is `{ suffix }`, both are one `{ wildcard: "<prefix>*<suffix>" }` with `*` and `\` escaped. EventBridge does not accept consecutive wildcards, so with both filters `prefix` cannot end with `*` and `suffix` cannot start with `*`; `s3()` throws a `VokeConfigError` instead of emitting `\**` or `*\*`.

## Object keys are passed through, not decoded

`event.key` is `detail.object.key` exactly as delivered, and `sendEvent` takes the key verbatim; Voke never URL-decodes it, and filters match the delivered key. The evidence on whether S3 encodes the key in EventBridge events conflicts:

- The classic notification format is documented as URL-encoded (`red flower.jpg` arrives as `red+flower.jpg`; Amazon S3 User Guide, "Event message structure").
- The EventBridge format page (Amazon S3 User Guide, "EventBridge event message structure") is silent, and its examples use `example-key`.
- AWS Powertools for Python decodes the EventBridge key with `unquote_plus` (`S3EventBridgeNotificationObject.key`).
- Two third-party projects (ExaForce/vector #52, chrisjenkinson/dmarc-tally #9) say EventBridge sends the key unencoded, without a captured event.

The owner decided (2026-11-15) to pass the key through: it cannot corrupt a key whichever way AWS sends it, while decoding would silently turn keys containing `+` or `%` into different keys if EventBridge sends them unencoded.

Open item: confirm with a captured S3 → EventBridge event before the first release; if AWS encodes keys, switch to decoding then.

Deferred: other S3 event types (restore, tagging, ACL, storage class, replication), filters on `reason`, size or metadata, buckets that are not Voke resources, migrator code generation, and delivery of emulator events to `voke dev`.
