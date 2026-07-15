import { existsSync } from "fs";
import { resolve } from "path";

export function locateOpenclawEntry(baseDir: string): string {
  const entry = resolve(baseDir, "node_modules", "openclaw", "openclaw.mjs");
  if (existsSync(entry)) return entry;
  throw new Error(`openclaw entry point not found: ${entry}`);
}

export function buildOpenclawCommand(entry: string, args: string[], nodeExecutable = "node"): string[] {
  return [nodeExecutable, entry, ...args];
}
