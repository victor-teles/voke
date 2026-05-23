# Use AWS SDK Lambda for default function invocation

Voke Functions need a batteries-included deployed invocation path, so the core package depends directly on `@aws-sdk/client-lambda` and uses it for the default AWS Lambda invoke transport. This is a deliberate exception to the Bun-first and minimal-dependency preference because requiring every project to install and wire its own Lambda client would weaken the framework's developer experience; tests and advanced use cases can still override invocation through Voke's transport abstraction.
