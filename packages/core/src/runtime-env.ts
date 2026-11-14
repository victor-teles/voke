import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Runtime code ships inside Lambda bundles that run on the Node.js runtime, where the
// `Bun` global does not exist. Runtime modules use these helpers instead of Bun globals.

export const readEnv = (name: string): string | undefined => process.env[name];

export const sleep = async (milliseconds: number): Promise<void> => {
  await delay(milliseconds);
};

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
