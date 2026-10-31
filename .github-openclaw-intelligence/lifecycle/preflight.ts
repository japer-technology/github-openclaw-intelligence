/**
 * preflight.ts — Pre-flight validation for OpenClaw Intelligence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * This script runs between the Guard and Install workflow steps.  It
 * validates the repository's OpenClaw Intelligence configuration and
 * structural integrity before any dependencies are installed or the agent is
 * invoked.
 *
 * Catching configuration errors here prevents silent failures from
 * compounding in downstream steps.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LIFECYCLE POSITION
 * ─────────────────────────────────────────────────────────────────────────────
 * Workflow step order:
 *   1. Guard       (enabled.ts)       — verify opt-in sentinel exists
 *   2. Preflight   (preflight.ts)     ← YOU ARE HERE
 *   3. Install     (bun install)      — install npm/bun dependencies
 *   4. Build       (bun run build)    — compile (no-op for Bun/TS)
 *   5. Run         (agent.ts)         — execute the AI agent
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CHECKS PERFORMED
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. All required files exist (sentinel, config, lifecycle scripts).
 *   2. .pi/settings.json conforms to config/settings.schema.json.
 *   3. trustPolicy and limits fields are structurally valid.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPENDENCIES
 * ─────────────────────────────────────────────────────────────────────────────
 * - Node.js built-in `fs` module  (existsSync, readFileSync)
 * - Node.js built-in `path` module (resolve)
 * - Bun runtime (for `import.meta.dir` support)
 *
 * No external packages are required; validation is performed with a
 * lightweight inline validator to keep this step dependency-free (it runs
 * before `bun install`).
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// ─── Paths ────────────────────────────────────────────────────────────────────
const openclawDir = resolve(import.meta.dir, "..");
const configDir = resolve(openclawDir, "config");
const piSettingsPath = resolve(openclawDir, ".pi", "settings.json");
const schemaPath = resolve(configDir, "settings.schema.json");
const packageJsonPath = resolve(openclawDir, "package.json");
const localChatLabel = "lifecycle/local-chat.ts";

// ─── Required files ───────────────────────────────────────────────────────────
const requiredFiles: { path: string; label: string }[] = [
  { path: resolve(openclawDir, "ENABLED.md"), label: "ENABLED.md" },
  { path: piSettingsPath, label: ".pi/settings.json" },
  { path: resolve(openclawDir, "lifecycle", "agent.ts"), label: "lifecycle/agent.ts" },
  { path: resolve(openclawDir, "lifecycle", "enabled.ts"), label: "lifecycle/enabled.ts" },
  { path: resolve(openclawDir, localChatLabel), label: localChatLabel },
  { path: resolve(openclawDir, "bun.lock"), label: "bun.lock" },
  { path: packageJsonPath, label: "package.json" },
];

// ─── Collect errors ───────────────────────────────────────────────────────────
const errors: string[] = [];

// ── 1. Check required files ─────────────────────────────────────────────────
for (const { path: filePath, label } of requiredFiles) {
  if (!existsSync(filePath)) {
    errors.push(`Missing required file: ${label}`);
  }
}

// ── 1b. Ensure local chat entry point is installed ───────────────────────────
if (existsSync(packageJsonPath)) {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    const chatScript = packageJson?.scripts?.chat;
    if (typeof chatScript !== "string" || !chatScript.includes(localChatLabel)) {
      errors.push(`package.json: "chat" script must reference ${localChatLabel} (e.g. "bun run ${localChatLabel}")`);
    }
  } catch (err) {
    errors.push(`package.json: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

// ── 2. Validate settings.json against the schema ────────────────────────────
interface SettingsSchema {
  type: string;
  required?: string[];
  properties?: Record<string, SettingsSchema>;
  additionalProperties?: boolean;
  items?: SettingsSchema;
  enum?: unknown[];
  minLength?: number;
  minimum?: number;
  maximum?: number;
}

// Supports the validation keywords used by config/settings.schema.json.
function validateSetting(value: unknown, schema: SettingsSchema, path: string): void {
  const isObject = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input);
  const matchesType = schema.type === "object" ? isObject(value)
    : schema.type === "array" ? Array.isArray(value)
    : schema.type === "integer" ? typeof value === "number" && Number.isInteger(value)
    : typeof value === schema.type;

  if (!matchesType) {
    errors.push(`${path}: must be ${schema.type}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of [${schema.enum.join(", ")}], got ${JSON.stringify(value)}`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && [...value].length < schema.minLength) {
    errors.push(`${path}: must be at least ${schema.minLength} character(s) long`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be at most ${schema.maximum}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    const itemSchema = schema.items;
    value.forEach((item, index) => validateSetting(item, itemSchema, `${path}[${index}]`));
  }
  if (isObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${path}: missing required field "${key}"`);
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateSetting(entry, properties[key], `${path}.${key}`);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unknown field "${key}"`);
      }
    }
  }
}

if (existsSync(piSettingsPath) && existsSync(schemaPath)) {
  try {
    const settings: unknown = JSON.parse(readFileSync(piSettingsPath, "utf-8"));
    const schema: SettingsSchema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    validateSetting(settings, schema, "settings.json");
  } catch (e) {
    errors.push(`settings.json: failed to parse — ${(e as Error).message}`);
  }
} else if (!existsSync(schemaPath)) {
  errors.push("Missing schema file: config/settings.schema.json");
}

// ── Report and exit ─────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error("Preflight failed with the following errors:\n");
  for (const err of errors) {
    console.error(`  ✗ ${err}`);
  }
  console.error(`\n${errors.length} error(s) found. Fix the above issues and try again.`);
  process.exit(1);
}

console.log("Preflight passed — all checks OK.");
