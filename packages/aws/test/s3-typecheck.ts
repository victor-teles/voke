// Compile-time checks for s3(); `bun run typecheck` runs them.
import { createFunctions } from "voke";

import { s3 } from "../src/index";
import type { S3EventKind, S3ObjectEvent } from "../src/index";

const ignoreEvent = (): void => {
  // These checks only need a handler of the right type.
};

const functions = createFunctions({
  onUpload: s3({
    bucket: "uploadsBucket",
    handler: (event) => {
      const _event: S3ObjectEvent = event;
      const _kind: S3EventKind = event.kind;
      const _key: string = event.key;
      const _bucket: string = event.bucket;
      const _size: number | undefined = event.size;
      // @ts-expect-error an S3 event carries object metadata, not an application payload.
      void event.detail;
    },
    on: ["created", "deleted"],
    prefix: "incoming/",
    suffix: ".jpg",
  }),
});

// sendEvent resolves to the handler's own result: nothing.
const _result: Promise<void> = functions.sendEvent("onUpload", {
  key: "incoming/a.jpg",
});
const _deleted: Promise<void> = functions.sendEvent("onUpload", {
  bucket: "my-bucket",
  key: "incoming/a.jpg",
  kind: "deleted",
  size: 5,
});

// @ts-expect-error key is required.
void functions.sendEvent("onUpload", {});
// @ts-expect-error kind is "created" or "deleted".
void functions.sendEvent("onUpload", { key: "a.jpg", kind: "restored" });

s3({
  bucket: "uploadsBucket",
  handler: ignoreEvent,
  // @ts-expect-error on lists only "created" and "deleted".
  on: ["restored"],
});
s3({
  bucket: "uploadsBucket",
  handler: ignoreEvent,
  // @ts-expect-error S3 Functions cannot serve HTTP routes.
  routes: [],
});
s3({
  bucket: "uploadsBucket",
  // @ts-expect-error handlers return nothing; EventBridge ignores the result.
  handler: () => ({ ok: true }),
});
// @ts-expect-error bucket is required.
s3({ handler: ignoreEvent });

// Resource Links: the handler reads only the resource keys the Function lists in `resources`.
createFunctions({
  linkedUpload: s3({
    bucket: "uploadsBucket",
    handler: (_event, context) => {
      const _bucket: string = context.resource("uploadsBucket");
      // @ts-expect-error the Function does not link ordersTable.
      void context.resource("ordersTable");
    },
    resources: ["uploadsBucket"],
  }),
  unlinkedUpload: s3({
    bucket: "uploadsBucket",
    handler: (_event, context) => {
      // @ts-expect-error a Function without resources links nothing.
      void context.resource("uploadsBucket");
    },
  }),
});
