# Use Standard Schema for function contracts

Voke Functions use explicit input and output schemas as their primary runtime contract, and those schemas should accept Standard Schema-compatible validators rather than a Voke-only validation DSL. This keeps Function invocation type-safe and parsed across local and AWS runtimes while letting projects use their existing schema library; Voke can still add a small preferred schema helper later if the common authoring path needs one.
