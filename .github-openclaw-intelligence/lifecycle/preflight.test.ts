import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import settings from "../.pi/settings.json";
import installSettings from "../install/settings.json";

describe("preflight", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "openclaw-preflight-"));
    for (const name of ["lifecycle", ".pi", "config"]) {
      mkdirSync(join(directory, name));
    }
    copyFileSync(import.meta.path.replace(".test.ts", ".ts"), join(directory, "lifecycle/preflight.ts"));
    copyFileSync(
      resolve(import.meta.dir, "../config/settings.schema.json"),
      join(directory, "config/settings.schema.json"),
    );
    for (const name of ["ENABLED.md", "bun.lock", "lifecycle/agent.ts", "lifecycle/enabled.ts", "lifecycle/local-chat.ts"]) {
      writeFileSync(join(directory, name), "");
    }
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      scripts: { chat: "bun run lifecycle/local-chat.ts" },
    }));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function runPreflight(value: unknown) {
    writeFileSync(join(directory, ".pi/settings.json"), JSON.stringify(value));
    return Bun.spawnSync([process.execPath, join(directory, "lifecycle/preflight.ts")]);
  }

  for (const [name, value] of [
    ["repository settings", settings],
    ["installer settings", installSettings],
    ["optional sections omitted", {
      defaultProvider: "openai", defaultModel: "test", defaultThinkingLevel: "none",
    }],
    ["empty optional sections", { ...settings, trustPolicy: {}, limits: {}, compaction: {} }],
    ["unknown top-level settings", { ...settings, customSetting: true }],
    ["minimum boundaries", {
      ...settings, limits: { workflowTimeoutMinutes: 1 },
      compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1024 },
    }],
    ["maximum timeout", { ...settings, limits: { workflowTimeoutMinutes: 360 } }],
  ] as const) {
    test(`accepts ${name}`, () => {
      const result = runPreflight(value);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Preflight passed");
    });
  }

  for (const [name, value, field] of [
    ["null root", null, "settings.json"],
    ["array root", [], "settings.json"],
    ["missing required field", {}, "defaultProvider"],
    ["invalid provider", { ...settings, defaultProvider: "invalid" }, "defaultProvider"],
    ["empty model", { ...settings, defaultModel: "" }, "defaultModel"],
    ["non-string model", { ...settings, defaultModel: 42 }, "defaultModel"],
    ["invalid thinking level", { ...settings, defaultThinkingLevel: "invalid" }, "defaultThinkingLevel"],
    ["null trust policy", { ...settings, trustPolicy: null }, "trustPolicy"],
    ["array trust policy", { ...settings, trustPolicy: [] }, "trustPolicy"],
    ["unknown trust field", { ...settings, trustPolicy: { trustedUser: ["octocat"] } }, "trustedUser"],
    ["null trusted users", { ...settings, trustPolicy: { trustedUsers: null } }, "trustedUsers"],
    ["non-string trusted user", { ...settings, trustPolicy: { trustedUsers: [1] } }, "trustedUsers"],
    ["invalid role", { ...settings, trustPolicy: { semiTrustedRoles: ["read"] } }, "semiTrustedRoles"],
    ["invalid behavior", { ...settings, trustPolicy: { untrustedBehavior: "allow" } }, "untrustedBehavior"],
    ["null limits", { ...settings, limits: null }, "limits"],
    ["unknown limit", { ...settings, limits: { timeoutMinutes: 30 } }, "timeoutMinutes"],
    ["null timeout", { ...settings, limits: { workflowTimeoutMinutes: null } }, "workflowTimeoutMinutes"],
    ["fractional timeout", { ...settings, limits: { workflowTimeoutMinutes: 1.5 } }, "workflowTimeoutMinutes"],
    ["timeout below minimum", { ...settings, limits: { workflowTimeoutMinutes: 0 } }, "workflowTimeoutMinutes"],
    ["timeout above maximum", { ...settings, limits: { workflowTimeoutMinutes: 361 } }, "workflowTimeoutMinutes"],
    ["null compaction", { ...settings, compaction: null }, "compaction"],
    ["unknown compaction field", { ...settings, compaction: { enable: true } }, "enable"],
    ["null enabled flag", { ...settings, compaction: { enabled: null } }, "enabled"],
    ["non-boolean enabled flag", { ...settings, compaction: { enabled: "false" } }, "enabled"],
    ["reserve below minimum", { ...settings, compaction: { reserveTokens: 1023 } }, "reserveTokens"],
    ["recent tokens below minimum", { ...settings, compaction: { keepRecentTokens: 1023 } }, "keepRecentTokens"],
  ] as const) {
    test(`rejects ${name}`, () => {
      const result = runPreflight(value);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(field);
      expect(result.stdout.toString()).not.toContain("Preflight passed");
    });
  }

  test("rejects a missing schema", () => {
    rmSync(join(directory, "config/settings.schema.json"));
    const result = runPreflight(settings);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Missing schema file");
  });

  test("rejects malformed settings JSON", () => {
    writeFileSync(join(directory, ".pi/settings.json"), "{");
    const result = Bun.spawnSync([process.execPath, join(directory, "lifecycle/preflight.ts")]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("failed to parse");
  });
});
