import { describe, expect, test } from "bun:test";
import { resolve } from "path";
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
});
