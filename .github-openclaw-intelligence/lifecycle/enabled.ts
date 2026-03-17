/**
 * enabled.ts — Fail-closed guard for the ENABLED.md sentinel file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * This script is the very first step executed in every OpenClaw Intelligence
 * workflow.  Its sole job is to verify that the operator has deliberately
 * opted-in to OpenClaw Intelligence by checking for the presence of the
 * sentinel file `.github-openclaw-intelligence/ENABLED.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY MODEL — "FAIL-CLOSED"
 * ─────────────────────────────────────────────────────────────────────────────
 * If the sentinel file is ABSENT the script:
 *   1. Prints a human-readable explanation to stderr.
 *   2. Exits with a non-zero status code (1).
 *   3. Causes GitHub Actions to mark the job as failed, which prevents every
 *      downstream step (dependency install, agent run, git push, etc.) from
 *      executing.
 *
 * This "fail-closed" design means OpenClaw Intelligence is ALWAYS disabled by
 * default on a freshly cloned repository until the operator explicitly creates
 * (or restores) the sentinel file, preventing accidental automation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 * The workflow invokes this file as the "Guard" step:
 *
 *   - name: Guard
 *     run: bun .github-openclaw-intelligence/lifecycle/enabled.ts
 *
 * To ENABLE:  ensure `.github-openclaw-intelligence/ENABLED.md` exists.
 * To DISABLE: delete `.github-openclaw-intelligence/ENABLED.md` and push.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPENDENCIES
 * ─────────────────────────────────────────────────────────────────────────────
 * - Node.js built-in `fs` module  (existsSync)
 * - Node.js built-in `path` module (resolve)
 * - Bun runtime (for `import.meta.dir` support)
 *
 * No external packages are required; this file intentionally has zero
 * third-party dependencies so it can run before `bun install`.
 */

import { existsSync } from "fs";
import { resolve } from "path";

// ─── Resolve the absolute path to the sentinel file ───────────────────────────
const enabledFile = resolve(import.meta.dir, "..", "ENABLED.md");

// ─── Guard: fail-closed if the sentinel is missing ────────────────────────────
if (!existsSync(enabledFile)) {
  console.error(
    "OpenClaw Intelligence disabled — sentinel file `.github-openclaw-intelligence/ENABLED.md` is missing.\n" +
    "To enable OpenClaw Intelligence, restore that file and push it to the repository."
  );
  process.exit(1);
}

// ─── Sentinel found: log confirmation and let the workflow continue ───────────
console.log("OpenClaw Intelligence enabled — ENABLED.md found.");
