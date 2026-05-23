# Error conventions

Voke errors should help application developers understand what failed, where it failed, and what to try next.

## Framework errors

Public framework workflows should throw `VokeError` subclasses instead of plain `Error` when the failure is caused by user input, project configuration, model validation, or missing runtime bindings.

- `VokeConfigError`: invalid or missing `voke.config.ts` input, unsupported runtime settings, and dev/build config problems.
- `VokeModelError`: invalid internal model relationships or malformed model fields.
- `VokeResourceBindingError`: runtime resource binding environment variables are missing.
- `CliUsageError`: invalid CLI commands, flags, or command shapes.
- `InvokeError`: function invocation validation, transport, timeout, and missing function failures.

## Message shape

Validation messages should include the public path and the specific expectation:

```txt
Invalid Voke config at runtime.lambda: expected one of "nodejs22.x", "nodejs24.x"; received "python3.12"
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
