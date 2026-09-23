import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import settings from "../.pi/settings.json";
import installSettings from "../install/settings.json";
import { buildCompactionConfig } from "./openclaw-config";
import { buildOpenclawCommand, locateOpenclawEntry } from "./openclaw-launcher";

describe("OpenClaw compaction configuration", () => {
  test("omits retired reserveTokens while preserving supported settings", () => {
    expect(buildCompactionConfig(settings.compaction)).toEqual({
      enabled: true,
      keepRecentTokens: 32000,
    });
  });

  test("preserves an explicit compaction opt-out", () => {
    expect(buildCompactionConfig({ enabled: false, reserveTokens: 16384 })).toEqual({
      enabled: false,
    });
  });

  test("leaves unspecified settings to OpenClaw defaults", () => {
    expect(buildCompactionConfig()).toEqual({});
  });

  for (const [name, compaction] of [
    ["repository settings", settings.compaction],
    ["installer settings", installSettings.compaction],
    ["disabled compaction", { enabled: false }],
    ["upstream defaults", undefined],
  ] as const) {
    test(`validates ${name} against the installed OpenClaw schema`, () => {
      const directory = mkdtempSync(join(tmpdir(), "openclaw-config-"));
      try {
        const configPath = join(directory, "config.json");
        writeFileSync(configPath, JSON.stringify({
          agents: {
            defaults: {
              workspace: directory,
              timeoutSeconds: 1800,
              model: `${settings.defaultProvider}/${settings.defaultModel}`,
              skipBootstrap: true,
              compaction: buildCompactionConfig(compaction),
            },
          },
          skills: { allowBundled: [], load: { extraDirs: [] } },
        }));
        const entry = locateOpenclawEntry(resolve(import.meta.dir, ".."));
        const [executable, ...args] = buildOpenclawCommand(entry, ["config", "validate", "--json"]);
        const output = execFileSync(executable, args, {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: directory,
            OPENCLAW_HOME: directory,
          },
        });
        expect(JSON.parse(output).valid).toBe(true);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
