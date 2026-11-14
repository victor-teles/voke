// Assigning `undefined` to an environment variable stores the string "undefined" in Bun,
// so restoring an unset variable must delete it instead.
export const setEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }

  process.env[name] = value;
};

export const withEnv = async <TResult>(
  values: Record<string, string | undefined>,
  run: () => TResult | Promise<TResult>
): Promise<TResult> => {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]])
  );

  for (const [name, value] of Object.entries(values)) {
    setEnv(name, value);
  }

  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      setEnv(name, value);
    }
  }
};
