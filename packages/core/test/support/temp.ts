import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests run on macOS and Linux CI, so scratch paths come from the OS temp
// directory instead of a hardcoded platform path like /private/tmp.
export const tempPath = (name: string): string => join(tmpdir(), name);
