import type * as voke from "../src/index";

// @ts-expect-error SQS batch schema types belong to @voke/aws, not root voke.
type RootSqsMessageBatchSchema = voke.SqsMessageBatchSchema;
// @ts-expect-error SQS event source model types are AWS-owned, not root voke.
type RootVokeModelSqsEventSource = voke.VokeModelSqsEventSource;
// @ts-expect-error resource provider kind names are not part of root voke.
type RootVokeResourceKind = voke.VokeResourceKind;

void (undefined as unknown as RootSqsMessageBatchSchema);
void (undefined as unknown as RootVokeModelSqsEventSource);
void (undefined as unknown as RootVokeResourceKind);
