import { describe, expect, test } from "bun:test";
import { isMutationInvocation, parseCommand } from "./command-parser";

describe("parseCommand", () => {
  test("parses a supported slash command and its arguments", () => {
    expect(parseCommand("/config set provider openai")).toEqual({
      command: "config",
      args: ["set", "provider", "openai"],
      rawText: "/config set provider openai",
    });
  });

  test("uses agent mode for natural language", () => {
    expect(parseCommand("Review this change").command).toBe("agent");
  });

  test("preserves unknown commands for skill dispatch", () => {
    expect(parseCommand("/weather London").command).toBe("weather");
  });
});

describe("isMutationInvocation", () => {
  test("distinguishes config reads from writes", () => {
    expect(isMutationInvocation("config", ["get", "provider"])).toBe(false);
    expect(isMutationInvocation("config", ["set", "provider", "openai"])).toBe(true);
  });

  test("treats an unspecified mutation command as mutating", () => {
    expect(isMutationInvocation("reset", [])).toBe(true);
  });
});
