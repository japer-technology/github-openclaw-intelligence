import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { version } from "../node_modules/openclaw/package.json";
import { buildOpenclawCommand, locateOpenclawEntry } from "./openclaw-launcher";

describe("OpenClaw launcher", () => {
  test("runs the package entry point with Node instead of a Bun shim", () => {
    const entry = locateOpenclawEntry(resolve(import.meta.dir, ".."));

    expect(buildOpenclawCommand(entry, ["--version"])).toEqual([
      "node",
      entry,
      "--version",
    ]);
  });

  test("supports an explicit Node executable", () => {
    expect(buildOpenclawCommand("openclaw.mjs", ["--version"], "C:\\Node\\node.exe")).toEqual([
      "C:\\Node\\node.exe",
      "openclaw.mjs",
      "--version",
    ]);
  });

  test("starts the installed OpenClaw CLI under Node", () => {
    const entry = locateOpenclawEntry(resolve(import.meta.dir, ".."));
    const [executable, ...args] = buildOpenclawCommand(entry, ["--version"]);
    const output = execFileSync(executable, args, { encoding: "utf8", timeout: 30_000 });

    expect(output).toContain(version);
  }, 60_000);

  test("supports the agent flags used by both runners", () => {
    const entry = locateOpenclawEntry(resolve(import.meta.dir, ".."));
    const [executable, ...args] = buildOpenclawCommand(entry, ["agent", "--help"]);
    const output = execFileSync(executable, args, { encoding: "utf8", timeout: 30_000 });

    for (const flag of ["--local", "--json", "--message", "--session-id", "--thinking"]) {
      expect(output).toContain(flag);
    }
  }, 60_000);
});
