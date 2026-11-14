# Error conventions

Voke errors should help application developers understand what failed, where it failed, and what to try next.

## Framework errors

Public framework workflows should throw `VokeError` subclasses instead of plain `Error` when the failure is caused by user input, project configuration, model validation, or missing runtime bindings.

- `VokeConfigError`: invalid or missing `voke.config.ts` input, unsupported runtime settings, and dev/build config problems.
- `VokeModelError`: invalid internal model relationships or malformed model fields.
- `VokeResourceBindingError`: runtime resource binding environment variables are missing.
- `VokeRuntimeVariableError`: runtime variable resolution, provider loading, JSON parsing, schema validation, and unsupported value-shape failures.
- `CliUsageError`: invalid CLI commands, flags, or command shapes.
- `InvokeError`: function invocation validation, transport, timeout, and missing function failures.

## Message shape

Validation messages should include the public path and the specific expectation:

```txt
Invalid Voke config at runtime.timeout: expected a positive integer number of seconds; received 0
```

CLI usage errors should include the failed usage and the shortest useful correction:

```txt
Invalid CLI usage: Missing value for --entrypoint
Usage: voke build [entrypoint] [outdir]
```

Migration unsupported-feature messages should name the Serverless feature and the manual migration boundary:

```txt
Unsupported Serverless event kafka on function worker: kafka is not an automatic Voke migration target. Recreate the trigger, permissions, batching, and failure behavior manually before cutting over.
```

Runtime Variable errors should identify the Function key, Runtime Variable key, and redacted source label without including loaded values:

```txt
Runtime variable "stripeKey" for Function "checkout" could not be loaded from AWS Secrets Manager secret "/prod/stripe/key".
```

## HTTP error responses

The Gateway answers route errors with the public body `{ error: { code?, message, issues?, details? } }`:

- Invalid input (`InvokeError` with code `INVALID_PAYLOAD`): status 400 with `issues`.
- Invalid handler output (`InvokeError` with code `INVALID_RESULT`): status 500 with `issues`.
- Any other thrown error: status 500, code `INTERNAL_SERVER_ERROR`, message `Internal server error`. The original message never reaches the client. Voke logs the error once to `console.error` as one JSON line (`level`, `message`, `name`, `stack`, and `code` when present). Under `voke dev` only, the response also carries `details.message`, so you can see the cause locally. The stage does not enable this.

For a failure the client should see, handle it in the handler and return the response you want; do not rely on a thrown message.
