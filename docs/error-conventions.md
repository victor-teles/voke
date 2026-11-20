# Error conventions

Rules for contributors writing Voke errors. Voke errors should help application developers understand what failed, where it failed, and what to try next. For the errors users see, their codes and the HTTP error body, see the Errors reference (`apps/docs/content/docs/reference/errors.mdx`).

## Framework errors

Public framework workflows should throw `VokeError` subclasses instead of plain `Error` when the failure is caused by user input, project configuration, model validation, or missing runtime bindings.

- `VokeConfigError`: invalid or missing `voke.config.ts` input, unsupported runtime settings, and dev/build config problems.
- `VokeModelError`: invalid internal model relationships or malformed model fields.
- `VokeResourceBindingError`: `context.resource(key)` reads a resource the Function (or the entry Function of an in-process invocation) does not link, the registry has no config, or the binding environment variable is missing.
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

Runtime Variable errors should identify the Function key, the Runtime Variable key, and a redacted source label, never the loaded value.
