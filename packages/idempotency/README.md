# @vokejs/idempotency

A Voke Plugin that makes a retried handler run once. It provisions a DynamoDB table, and `idempotent(...)` and `idempotentBatch(...)` record each operation by a key you choose.

Part of [Voke](https://github.com/victor-teles/voke). Every Voke package is released at the same version as `voke`.

```bash
bun add voke @vokejs/aws @vokejs/idempotency
```

Documentation:

- [Idempotency](https://github.com/victor-teles/voke/blob/main/apps/docs/content/docs/guides/idempotency.mdx)
- [Packages reference](https://github.com/victor-teles/voke/blob/main/apps/docs/content/docs/reference/packages.mdx)

Licensed under MIT.
