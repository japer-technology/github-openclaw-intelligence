/**
 * local-chat.ts — Local, GitHub-free runner for the OpenClaw Intelligence agent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Developer-facing alternative to `agent.ts` that runs the same `openclaw`
 * coding agent on the user's local machine.  Reuses the repository's
 * personality (`AGENTS.md`, bridged into `SOUL`), provider settings
 * (`.pi/settings.json`), memory (`MEMORY.md`), and skill packages verbatim so
 * that conversations driven from the terminal are indistinguishable in
 * behaviour from those driven by GitHub Issues — only the I/O surface changes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RELATIONSHIP TO agent.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * `agent.ts` is the production lifecycle entry point invoked by GitHub Actions.
 * It depends on `gh`, `GITHUB_EVENT_PATH`, `git push`, and Unix-only shell
 * tools (`tee`, `sh`).  This file is the *peer* entry point for local
 * development.  It removes every GitHub-specific dependency and replaces them
 * with cross-platform equivalents:
 *
 *   agent.ts (GitHub bot)            local-chat.ts (local runner)
 *   ─────────────────────────        ──────────────────────────────
 *   GitHub issue number              Monotonic integer thread ID
 *   `gh issue view` / `comment`      stdin/stdout REPL or one-shot prompt
 *   `tee` file capture               In-process capture of stdout+stderr
 *   `git add/commit/push` retry      No git mutation (workspace is yours)
 *   `state/issues/<n>.json`          `state/threads/<N>.json`
 *   session id `issue-<n>`           session id `local-<N>`
 *
 * The OpenClaw invocation (`openclaw agent --local --json --message …
 * --session-id …`), the runtime-config JSON written to OPENCLAW_CONFIG_PATH,
 * and the OPENCLAW_* environment variables mirror agent.ts exactly, so the
 * two entry points stay behaviourally aligned.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SESSION ATTRIBUTION
 * ─────────────────────────────────────────────────────────────────────────────
 * OpenClaw writes each conversation transcript to
 * `state/agents/main/sessions/<session-id>.jsonl` under OPENCLAW_STATE_DIR.
 * Because we pass a deterministic `--session-id local-<threadId>`, the
 * transcript path is known up front — no directory-diff attribution is needed
 * (unlike the pi-based implementation this file was ported from).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOCAL MODEL SERVERS
 * ─────────────────────────────────────────────────────────────────────────────
 * Local providers (LM Studio, Ollama, vLLM, or any OpenAI-compatible server
 * pointed at via LOCAL_LLM_BASE_URL) are wired through the runtime config's
 * `models.providers` section as custom providers speaking the
 * `openai-completions` API with a placeholder key, so no cloud credentials
 * are required.
 *
 * Precedence for provider/model: `LOCAL_*` env vars > `.pi/settings.json` >
 * built-in defaults.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXIT CODES
 * ─────────────────────────────────────────────────────────────────────────────
 *   0  success
 *   1  environment problem (missing API key, missing `openclaw` binary, ...)
 *   2  user error (unknown thread ref, invalid alias, ...)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPENDENCIES
 * ─────────────────────────────────────────────────────────────────────────────
 * - `bun`                         (local chat runtime and package runner)
 * - `node`                        (OpenClaw runtime; required for node:sqlite)
 * - `openclaw`                    (installed by `bun install`)
 * - `marked`, `marked-terminal`   (terminal Markdown rendering)
 * - `ansi-regex`                  (ANSI stripping before rendering)
 */

import {
  existsSync, readFileSync, writeFileSync, appendFileSync,
  mkdirSync, readdirSync, statSync, unlinkSync, renameSync,
  openSync, closeSync, symlinkSync,
} from "fs";
import { resolve, join, basename, sep } from "path";
import { networkInterfaces } from "os";
import { createInterface } from "readline";
import { execFileSync, execSync } from "child_process";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import ansiRegex from "ansi-regex";
import { buildOpenclawCommand, locateOpenclawEntry } from "./openclaw-launcher";

// marked-terminal's return type does not perfectly align with marked's
// MarkedExtension interface; the cast is the standard workaround.
marked.use(markedTerminal() as any);

// ─── Paths and constants ──────────────────────────────────────────────────────

const openclawDir = resolve(import.meta.dir, "..");
const stateDir = resolve(openclawDir, "state");
const threadsDir = resolve(stateDir, "threads");
// OpenClaw natively writes session transcripts here (under OPENCLAW_STATE_DIR),
// matching agent.ts.
const sessionsDir = resolve(stateDir, "agents", "main", "sessions");
const piSettingsPath = resolve(openclawDir, ".pi", "settings.json");
const memoryLogPath = resolve(openclawDir, "memory.log");
const lastRunRawPath = resolve(stateDir, "local-last-run.log");

// Runtime config consumed by the openclaw child via OPENCLAW_CONFIG_PATH.
// Kept inside state/ (gitignored) so local runs never touch committed files.
const runtimeConfigPath = resolve(stateDir, "local-runtime-config.json");

// Identity / memory bridging paths (mirrors agent.ts): AGENTS.md content is
// written to SOUL at runtime so the OpenClaw runtime reads it as the agent's
// identity; MEMORY.md is bridged into the workspace (repo root).
const agentsMdPath = resolve(openclawDir, "AGENTS.md");
const soulPath = resolve(openclawDir, "SOUL");
const canonicalMemoryPath = resolve(openclawDir, "MEMORY.md");

// Skills wiring (mirrors agent.ts): bundled skills allowed by config/skills.json
// are symlinked into skills/ and the directory is passed as an extra search dir.
const skillsDir = resolve(openclawDir, "skills");
const skillsConfigPath = resolve(openclawDir, "config", "skills.json");
const bundledSkillsDir = resolve(openclawDir, "node_modules", "openclaw", "skills");

// Alias grammar: starts with a letter; letters/digits/"_"/"-" only; max 64.
// Forbidding pure-digit names prevents ambiguity with integer IDs.
const ALIAS_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

// Cap for the atomic-allocation retry loop; defensive only.
const MAX_ALLOC_ATTEMPTS = 1000;

// Mapping of OpenClaw provider IDs to required environment variable names.
// `lmstudio` and any `openai` setup pointed at LOCAL_LLM_BASE_URL are exempt
// from this check (local servers do not need a real key).
const PROVIDER_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
};

// Providers we consider "local" for the purpose of skipping the cloud API-key
// check and enabling auto-retry by default.
const LOCAL_PROVIDERS = new Set(["lmstudio", "ollama", "vllm"]);

// Default OpenAI-compatible endpoints for well-known local servers.
const LOCAL_BRAND_DEFAULTS: Record<string, { label: string; baseUrl: string }> = {
  lmstudio: { label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
  ollama:   { label: "Ollama",    baseUrl: "http://localhost:11434/v1" },
  vllm:     { label: "vLLM",      baseUrl: "http://localhost:8000/v1"  },
};

// Local brands (lmstudio/ollama/vllm) are registered as first-class custom
// providers in the runtime config's `models.providers` section (see
// buildLocalProviderModels), so openclaw receives the brand name verbatim and
// reaches the local server over the OpenAI Chat Completions API.
function resolveOpenclawProvider(userProvider: string): string {
  return userProvider;
}

function localBrandLabel(userProvider: string): string | null {
  if (LOCAL_PROVIDERS.has(userProvider)) {
    return LOCAL_BRAND_DEFAULTS[userProvider]?.label ?? userProvider;
  }
  if (userProvider === "openai" && (process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_BASE_URL)) {
    return "openai-compatible";
  }
  return null;
}

// ─── Output styling ───────────────────────────────────────────────────────────
// All user-facing messages MUST go through `say.*` (stdout) instead of
// `console.error` (stderr).  PowerShell renders stderr as red-on-white which
// is unreadable; routing everything to stdout with ANSI lets us pick legible,
// purposeful colours.  Respects NO_COLOR, FORCE_COLOR, and !isTTY.

const useColor: boolean = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return !!(process.stdout && process.stdout.isTTY);
})();

function wrap(open: number, close: number, s: string): string {
  return useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;
}
const c = {
  reset:   (s: string) => wrap(0,  0, s),
  bold:    (s: string) => wrap(1, 22, s),
  dim:     (s: string) => wrap(2, 22, s),
  italic:  (s: string) => wrap(3, 23, s),
  under:   (s: string) => wrap(4, 24, s),
  red:     (s: string) => wrap(31, 39, s),
  green:   (s: string) => wrap(32, 39, s),
  yellow:  (s: string) => wrap(33, 39, s),
  blue:    (s: string) => wrap(34, 39, s),
  magenta: (s: string) => wrap(35, 39, s),
  cyan:    (s: string) => wrap(36, 39, s),
  gray:    (s: string) => wrap(90, 39, s),
};

/** Word-wrap a string to a max line width, preserving existing line breaks. */
function wordWrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (para.length <= width) { out.push(para); continue; }
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      if (line.length === 0) { line = w; continue; }
      if (line.length + 1 + w.length > width) { out.push(line); line = w; }
      else { line += " " + w; }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

const say = {
  /** Recoverable problem — yellow banner, stdout, never exits. */
  warn(title: string, body?: string): void {
    console.log("");
    console.log("  " + c.yellow(c.bold("! ")) + c.bold(title));
    if (body) for (const ln of wordWrap(body, 68)) console.log("    " + c.dim(ln));
    console.log("");
  },
  /** Hard failure — red label, stdout (not stderr), caller decides what to do next. */
  error(title: string, body?: string): void {
    console.log("");
    console.log("  " + c.red(c.bold("x ")) + c.bold(title));
    if (body) for (const ln of wordWrap(body, 68)) console.log("    " + c.dim(ln));
    console.log("");
  },
  /** Neutral informational note. */
  info(msg: string): void {
    console.log("  " + c.cyan("i ") + msg);
  },
  /** Success / confirmation. */
  ok(msg: string): void {
    console.log("  " + c.green("✓ ") + msg);
  },
  /** Subtle hint / next-step prompt. */
  hint(msg: string): void {
    console.log("  " + c.dim("· " + msg));
  },
};

// ─── Error taxonomy ───────────────────────────────────────────────────────────
// UserError marks problems caused by user input (unknown thread, taken alias,
// malformed args).  The top-level handler maps it to exit code 2, keeping the
// documented contract: 0 success, 1 environment problem, 2 user error.

class UserError extends Error {}

// ─── Thread record schema ─────────────────────────────────────────────────────

type Thread = {
  id: number;
  name: string | null;
  sessionPath: string | null;
  createdAt: string;
  updatedAt: string;
};

// ─── Thread helpers ───────────────────────────────────────────────────────────

function threadPath(id: number): string {
  return resolve(threadsDir, `${id}.json`);
}

// Deterministic OpenClaw session id / transcript path for a thread.  The
// session id is passed to `openclaw agent --session-id` on every turn, so the
// runtime resumes the same conversation and writes to a known transcript path.
function threadSessionId(id: number): string {
  return `local-${id}`;
}

function threadSessionPath(id: number): string {
  return join(sessionsDir, `${threadSessionId(id)}.jsonl`);
}

function readThread(id: number): Thread | null {
  const p = threadPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Thread;
  } catch {
    return null;
  }
}

function writeThread(t: Thread): void {
  // Atomic write: write to a temp file then rename over the target so a crash
  // mid-write can never leave a truncated/corrupt thread record behind.
  const target = threadPath(t.id);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(t, null, 2) + "\n");
  renameSync(tmp, target);
}

function listThreads(): Thread[] {
  if (!existsSync(threadsDir)) return [];
  const ids = readdirSync(threadsDir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => parseInt(f, 10))
    .sort((a, b) => a - b);
  const out: Thread[] = [];
  for (const id of ids) {
    const t = readThread(id);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Atomically allocate the next free integer thread ID.
 * Thread identity is closed-world: IDs are allocated only by this tool and
 * unknown refs are rejected rather than auto-created (see the CLI help text).
 */
function allocateThread(name: string | null): Thread {
  if (name !== null) {
    if (!ALIAS_PATTERN.test(name)) {
      throw new UserError(
        `Invalid name "${name}". Must start with a letter and contain only ` +
        `letters, digits, "_" or "-" (max 64 chars). Pure-digit names are ` +
        `reserved for IDs.`
      );
    }
    for (const existing of listThreads()) {
      if (existing.name === name) {
        throw new UserError(
          `Thread name "${name}" already taken by thread #${existing.id}.`
        );
      }
    }
  }

  mkdirSync(threadsDir, { recursive: true });
  const existingIds = readdirSync(threadsDir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => parseInt(f, 10));
  let candidate = (existingIds.length === 0 ? 0 : Math.max(...existingIds)) + 1;

  for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt++) {
    const p = threadPath(candidate);
    try {
      const fd = openSync(p, "wx");
      closeSync(fd);
      const now = new Date().toISOString();
      const t: Thread = {
        id: candidate, name, sessionPath: null,
        createdAt: now, updatedAt: now,
      };
      writeThread(t);
      return t;
    } catch (err: any) {
      if (err.code === "EEXIST") { candidate++; continue; }
      throw err;
    }
  }
  throw new Error(
    `Could not allocate a thread ID after ${MAX_ALLOC_ATTEMPTS} attempts.`
  );
}

function resolveThreadRef(ref: string): Thread | null {
  if (/^\d+$/.test(ref)) return readThread(parseInt(ref, 10));
  for (const t of listThreads()) {
    if (t.name === ref) return t;
  }
  return null;
}

// ─── OpenClaw session JSONL parsing ───────────────────────────────────────────

type PiBlock = { type?: string; text?: string };
type PiEvent = { type?: string; message?: { role?: string; content?: PiBlock[] } };

// OpenClaw session transcripts (v3) record conversation turns as
// `{type:"message"}` events; older pi-style streams used `message_end`.
// Accept both so the parsers stay tolerant across runtime versions.
function isMessageEvent(evt: PiEvent): boolean {
  return evt.type === "message" || evt.type === "message_end";
}

/**
 * Extract the final assistant text reply from an OpenClaw session transcript
 * (JSONL of pi-style events — openclaw is a pi fork): walk events in reverse
 * and return the text of the most recent `message_end` assistant event with
 * at least one text block.  Used as a fallback when the `--json` result
 * envelope could not be parsed.
 */
function extractFinalAssistantText(jsonl: string): string {
  const lines = jsonl.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let evt: PiEvent;
    try { evt = JSON.parse(line) as PiEvent; } catch { continue; }
    if (!isMessageEvent(evt) || evt.message?.role !== "assistant") continue;
    const blocks = (evt.message.content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string");
    if (blocks.length === 0) continue;
    return blocks.map((b) => (b.text ?? "").trim()).filter((s) => s.length > 0).join("\n\n");
  }
  return "";
}

/** Count message events with role=user — i.e. user turns in a session. */
function countSessionTurns(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    const lines = readFileSync(filePath, "utf-8")
      .split(/\r?\n/).filter((l) => l.trim().length > 0);
    let turns = 0;
    for (const line of lines) {
      try {
        const evt = JSON.parse(line) as PiEvent;
        if (isMessageEvent(evt) && evt.message?.role === "user") turns++;
      } catch {}
    }
    return turns;
  } catch { return 0; }
}

/** Condensed per-turn preview list for /history and /export. */
function getSessionHistory(filePath: string): Array<{ role: string; preview: string }> {
  if (!existsSync(filePath)) return [];
  try {
    const lines = readFileSync(filePath, "utf-8")
      .split(/\r?\n/).filter((l) => l.trim().length > 0);
    const out: Array<{ role: string; preview: string }> = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line) as PiEvent;
        if (!isMessageEvent(evt)) continue;
        const role = evt.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = (evt.message?.content ?? [])
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => (b.text ?? "").trim())
          .filter((t) => t.length > 0)
          .join(" ").replace(/\s+/g, " ");
        if (!text) continue;
        out.push({ role, preview: text.length > 80 ? text.slice(0, 77) + "..." : text });
      } catch {}
    }
    return out;
  } catch { return []; }
}

// ─── Formatting / display helpers ─────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(ansiRegex(), "");
}

/**
 * Render markdown text for terminal display.  Strips stray ANSI from the
 * source first so `marked` does not mistakenly treat escape sequences as
 * literal characters and produce garbled output.
 */
function renderMarkdown(text: string): string {
  try {
    return (marked(stripAnsi(text)) as string).trimEnd();
  } catch {
    return text;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
// Braille frames driven by setInterval; cleared with a CR + blanking row.

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function createSpinner(message: string): { stop: (finalMessage?: string) => void } {
  let frameIndex = 0;
  let stopped = false;
  const interval = setInterval(() => {
    if (stopped) return;
    const frame = spinnerFrames[frameIndex % spinnerFrames.length];
    process.stdout.write(`\r  ${frame} ${message}`);
    frameIndex++;
  }, 80);
  return {
    stop(finalMessage?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      process.stdout.write(`\r${" ".repeat(80)}\r`);
      if (finalMessage) console.log(`  ${finalMessage}`);
    },
  };
}

// ─── Git / repo helpers (best-effort, never throw out) ────────────────────────

function getGitBranch(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim() || null;
  } catch { return null; }
}

function getRepoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return resolve(openclawDir, "..");
  }
}

function getRepoName(): string {
  try { return basename(getRepoRoot()); } catch { return "local-chat"; }
}

/** Resolve a user-supplied path, rejecting anything outside the repo root. */
function safePath(userPath: string): string | null {
  const root = getRepoRoot();
  const resolved = resolve(root, userPath);
  // Require the repo root itself or a path under `root + sep`; a bare
  // startsWith(root) check would wrongly accept sibling dirs like
  // "/repo-evil" when root is "/repo".
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

// ─── Memory log helpers ───────────────────────────────────────────────────────

function getMemoryCount(): number {
  if (!existsSync(memoryLogPath)) return 0;
  try {
    return readFileSync(memoryLogPath, "utf-8")
      .split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  } catch { return 0; }
}

// ─── CLI parsing ──────────────────────────────────────────────────────────────

type CliArgs = {
  threadRef: string | null;
  newThread: boolean;
  newName: string | null;
  list: boolean;
  rmRef: string | null;
  prompt: string;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    threadRef: null, newThread: false, newName: null,
    list: false, rmRef: null, prompt: "",
  };
  const promptParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--thread": case "-t": out.threadRef = argv[++i] ?? null; break;
      case "--new": out.newThread = true; break;
      case "--name": out.newName = argv[++i] ?? null; break;
      case "--list": case "-l": out.list = true; break;
      case "--rm": out.rmRef = argv[++i] ?? null; break;
      case "--help": case "-h": printCliHelp(); process.exit(0);
      default: promptParts.push(a);
    }
  }
  out.prompt = promptParts.join(" ").trim();
  return out;
}

function printCliHelp(): void {
  console.log(
`GitHub OpenClaw Intelligence — Local Chat

Usage:
  bun run chat                                   Interactive launcher (pick or create).
  bun run chat --new [--name <alias>]            Create a new thread; prints its ID.
  bun run chat --thread <id|alias> [prompt...]   Continue a thread; REPL if no prompt.
  bun run chat --list                            List all threads.
  bun run chat --rm <id|alias>                   Delete a thread mapping.
  bun run chat --help                            Show this message.

Environment overrides (highest precedence):
  LOCAL_PROVIDER      Override .pi/settings.json defaultProvider.
                      Local brands: lmstudio | ollama | vllm (no API key needed;
                      default endpoints auto-filled, auto-retry enabled).
  LOCAL_MODEL         Override defaultModel.
  LOCAL_THINKING      Override defaultThinkingLevel  (e.g. low, medium, high).
  LOCAL_LLM_BASE_URL  OpenAI-compatible base URL (LM Studio, Ollama, vLLM).
                      Forwarded to OPENAI_BASE_URL with a placeholder API key.
  OPENCLAW_NODE        Node.js executable for OpenClaw (default: node from PATH).
  NO_COLOR            Disable ANSI colour output.

Debugging:
  Raw stdout/stderr of the last agent run is saved to state/local-last-run.log.
  Exit codes: 0 success · 1 environment problem · 2 user error.

Closed-world identity: thread IDs are allocated by this tool; unknown refs are
rejected (no auto-create on typos). Aliases must start with a letter.`
  );
}

// ─── EOF-safe readline questions ──────────────────────────────────────────────

/**
 * Build an EOF-safe `ask` function for a readline interface.  Resolves with
 * the user's answer, or `null` when the input reaches EOF (Ctrl-D / closed
 * non-TTY stdin) — readline never invokes the question callback in that case,
 * which would otherwise leave the promise (and the process) hanging forever.
 * The `pending` hand-off guarantees each promise settles exactly once even if
 * the close event and the question callback race.  Questions must be asked
 * serially (await each answer before asking the next), which is how every
 * call site in this file uses it; concurrent questions would overwrite the
 * single pending resolver.
 */
function makeAsk(rl: ReturnType<typeof createInterface>): (q: string) => Promise<string | null> {
  let pending: ((v: string | null) => void) | null = null;
  rl.on("close", () => {
    const p = pending; pending = null;
    if (p) p(null);
  });
  return (q: string) => new Promise((res) => {
    pending = res;
    rl.question(q, (a: string) => {
      const p = pending; pending = null;
      if (p) p(a ?? "");
    });
  });
}

/**
 * Interactive launcher shown when `bun run chat` is invoked with no args.
 * Lists existing threads and lets the user pick by row number, press Enter
 * to resume the most-recent thread, type `n` to create a new one, or `q` to
 * quit. Returns the chosen Thread or null if the user quit.
 */
async function interactiveStart(provider: string, model: string, thinking: string | undefined): Promise<Thread | null> {
  const all = listThreads();
  const branch = getGitBranch();
  const repo = getRepoName();

  console.log("");
  console.log("  " + c.cyan("┌─────────────────────────────────────────────────────────────────────┐"));
  console.log("  " + c.cyan("│  ") + c.bold("GitHub OpenClaw Intelligence") + c.dim(" — Local Chat") + "                           " + c.cyan("│"));
  console.log("  " + c.cyan("└─────────────────────────────────────────────────────────────────────┘"));
  console.log("");
  console.log(`    ${c.dim("Repo:")}     ${c.bold(repo)}${branch ? c.dim(`  (${branch})`) : ""}`);
  console.log(`    ${c.dim("Provider:")} ${c.bold(provider)}    ${c.dim("Model:")} ${c.bold(model)}${thinking ? `    ${c.dim("Thinking:")} ${thinking}` : ""}`);
  const memCount = getMemoryCount();
  if (memCount > 0) {
    console.log(`    ${c.dim("Memory:")}   ${memCount} entr${memCount === 1 ? "y" : "ies"} in memory.log`);
  }
  console.log("");

  if (all.length === 0) {
    console.log("    No threads yet. Creating your first thread…");
    console.log("");
    const t = allocateThread(null);
    console.log(`    Created thread #${t.id}.`);
    console.log("");
    console.log("    Quick start:");
    console.log("      • Just type a message to chat.");
    console.log("      • Type /help inside the chat for all commands.");
    console.log("      • Type /exit (or Ctrl-C) to end the session.");
    console.log("");
    return t;
  }

  // Sort by updatedAt descending so the most recent is first.
  const sorted = [...all].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  console.log(`    Existing threads (${sorted.length}):`);
  console.log("");
  console.log("      #   ID   ALIAS                       UPDATED               TURNS");
  console.log("      ─── ──── ─────────────────────────── ───────────────────── ─────");
  const max = Math.min(sorted.length, 20);
  for (let i = 0; i < max; i++) {
    const t = sorted[i];
    const turns = t.sessionPath && existsSync(t.sessionPath) ? countSessionTurns(t.sessionPath) : 0;
    console.log(
      `      ${String(i + 1).padStart(2, " ")}. ${String(t.id).padEnd(4)} ` +
      `${(t.name ?? "(unnamed)").padEnd(27)} ${t.updatedAt.padEnd(20)} ${String(turns).padStart(4)}`
    );
  }
  if (sorted.length > max) {
    console.log(`      … and ${sorted.length - max} more (use \`--list\` to see all).`);
  }
  console.log("");
  console.log("    Choose:");
  console.log("      • Enter a row number to resume that thread.");
  console.log("      • Press [Enter] to resume the most recent (#" + sorted[0].id + ").");
  console.log("      • Type  n  to create a new thread.");
  console.log("      • Type  q  (or Ctrl-C) to quit.");
  console.log("");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  const ask = makeAsk(rl);
  try {
    while (true) {
      const answer = await ask("    Select> ");
      if (answer === null) return null; // EOF — treat as quit.
      const raw = answer.trim();
      if (raw === "q" || raw === "Q" || raw === "/exit" || raw === "/quit") {
        return null;
      }
      if (raw === "n" || raw === "N" || raw === "/new") {
        const t = allocateThread(null);
        console.log(`    Created thread #${t.id}.\n`);
        return t;
      }
      if (raw === "") {
        const t = sorted[0];
        console.log(`    Resuming thread #${t.id}${t.name ? ` ("${t.name}")` : ""}.\n`);
        return t;
      }
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n >= 1 && n <= sorted.length) {
        const t = sorted[n - 1];
        console.log(`    Resuming thread #${t.id}${t.name ? ` ("${t.name}")` : ""}.\n`);
        return t;
      }
      // Also accept raw IDs or aliases.
      const direct = resolveThreadRef(raw);
      if (direct) {
        console.log(`    Resuming thread #${direct.id}${direct.name ? ` ("${direct.name}")` : ""}.\n`);
        return direct;
      }
      console.log(`    Not a valid choice: "${raw}". Try a row number, \`n\`, or \`q\`.`);
    }
  } finally {
    rl.close();
  }
}

// ─── Environment / settings resolution ────────────────────────────────────────

type PiSettings = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
};

function loadPiSettings(): PiSettings {
  if (!existsSync(piSettingsPath)) return {};
  try { return JSON.parse(readFileSync(piSettingsPath, "utf-8")) as PiSettings; }
  catch { return {}; }
}

/**
 * Resolve final provider/model/thinking by applying env overrides on top of
 * settings, validate the result, and (for OpenAI-compatible local servers)
 * forward `LOCAL_LLM_BASE_URL` into `OPENAI_BASE_URL` with a placeholder key.
 */
function resolveRuntimeConfig(): { provider: string; model: string; thinking: string | undefined } {
  const settings = loadPiSettings();
  const provider = process.env.LOCAL_PROVIDER ?? settings.defaultProvider ?? "";
  const model = process.env.LOCAL_MODEL ?? settings.defaultModel ?? "";
  const thinking = process.env.LOCAL_THINKING ?? settings.defaultThinkingLevel;

  if (!provider || !model) {
    throw new Error(
      `Invalid .pi settings at ${piSettingsPath}: ` +
      `expected defaultProvider and defaultModel (or LOCAL_PROVIDER / LOCAL_MODEL).`
    );
  }
  if (model.trim() !== model || /\s/.test(model)) {
    throw new Error(
      `Invalid model identifier "${model}": model IDs must not contain whitespace.`
    );
  }

  // OpenAI-compatible local server wiring.
  // For brand providers (lmstudio/ollama/vllm) auto-fill a default base URL
  // if the user did not set LOCAL_LLM_BASE_URL/OPENAI_BASE_URL explicitly.
  if (provider === "openai" || LOCAL_PROVIDERS.has(provider)) {
    const brandDefault = LOCAL_BRAND_DEFAULTS[provider]?.baseUrl;
    if (brandDefault && !process.env.LOCAL_LLM_BASE_URL && !process.env.OPENAI_BASE_URL) {
      process.env.LOCAL_LLM_BASE_URL = brandDefault;
    }
    if (process.env.LOCAL_LLM_BASE_URL && !process.env.OPENAI_BASE_URL) {
      process.env.OPENAI_BASE_URL = process.env.LOCAL_LLM_BASE_URL;
    }
    if ((process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_BASE_URL) && !process.env.OPENAI_API_KEY) {
      // OpenAI-compatible local servers often ignore the key, but the SDK
      // refuses to send a request without one.  A literal "local" satisfies it.
      process.env.OPENAI_API_KEY = "local";
    }
  }

  return { provider, model, thinking };
}

/** True when this provider+env combination targets a local model server. */
function isLocalProvider(provider: string): boolean {
  if (LOCAL_PROVIDERS.has(provider)) return true;
  if (provider === "openai" && (process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_BASE_URL)) return true;
  return false;
}

/**
 * Resolve the effective OpenAI-compatible base URL for a local provider,
 * honouring explicit env vars first, then well-known brand defaults.
 */
function resolveLocalBaseUrl(provider: string): string {
  return (
    process.env.LOCAL_LLM_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    LOCAL_BRAND_DEFAULTS[provider]?.baseUrl ||
    "http://localhost:1234/v1"
  );
}

/**
 * Build the `models` section of the OpenClaw runtime config so the agent talks
 * to a local OpenAI-compatible server (LM Studio, Ollama, vLLM, or an `openai`
 * provider pointed at LOCAL_LLM_BASE_URL).
 *
 * Why this exists: OpenClaw's built-in cloud providers would contact the real
 * provider endpoints and fail without valid credentials.  The supported
 * mechanism for a local server is a `models.providers` entry in the runtime
 * config describing a custom provider with an explicit `baseUrl` and the
 * `openai-completions` API.  The runtime config is written to a repo-local
 * path and passed via OPENCLAW_CONFIG_PATH, so the user's global OpenClaw
 * configuration is left untouched.
 */
function buildLocalProviderModels(provider: string, model: string): Record<string, unknown> {
  const baseUrl = resolveLocalBaseUrl(provider);
  process.env.OPENAI_BASE_URL = baseUrl;
  if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = "local";
  return {
    mode: "merge",
    providers: {
      [provider]: {
        baseUrl,
        api: "openai-completions",
        apiKey: process.env.OPENAI_API_KEY || "local",
        models: [{ id: model, name: model }],
      },
    },
  };
}

// ─── Subprocess lifecycle ─────────────────────────────────────────────────────
// Track the active `openclaw` child so we can terminate it on Ctrl+C / EPIPE /
// SIGTERM rather than leaving orphan processes streaming JSONL into a dead
// terminal — a real problem on Windows.

let activeOpenclawProcess: ReturnType<typeof Bun.spawn> | null = null;

function cleanup(): void {
  if (activeOpenclawProcess) {
    try { activeOpenclawProcess.kill(); } catch {}
    activeOpenclawProcess = null;
  }
}

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") { cleanup(); process.exit(0); }
  throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") { cleanup(); process.exit(0); }
  throw err;
});
process.on("SIGINT",  () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

// ─── Runtime toggles (REPL only) ──────────────────────────────────────────────

type RuntimeState = {
  provider: string;
  model: string;
  thinking: string | undefined;
  showTiming: boolean;
  verbose: boolean;
  autoRetry: boolean;
  autoRetryMax: number;
  openclawEntry: string;
};

// ─── One agent turn ───────────────────────────────────────────────────────────

/**
 * Load the skills configuration from `config/skills.json` (mirrors agent.ts).
 */
function loadSkillsConfig(): { skills: { allowBundled?: string[]; load?: { extraDirs?: string[] } } } {
  if (!existsSync(skillsConfigPath)) return { skills: {} };
  try {
    return JSON.parse(readFileSync(skillsConfigPath, "utf-8"));
  } catch {
    return { skills: {} };
  }
}

/**
 * Symlink allowed bundled skills from the openclaw package into the local
 * skills/ directory (mirrors agent.ts).  Existing entries are left in place.
 */
function linkBundledSkills(allowBundled: string[]): void {
  if (!existsSync(bundledSkillsDir)) return;
  mkdirSync(skillsDir, { recursive: true });
  for (const name of allowBundled) {
    const source = resolve(bundledSkillsDir, name);
    const target = resolve(skillsDir, name);
    if (!existsSync(source) || existsSync(target)) continue;
    try { symlinkSync(source, target, "dir"); } catch {}
  }
}

/**
 * Generate a SOUL identity file from AGENTS.md so the OpenClaw runtime reads
 * it as the agent's personality (mirrors agent.ts).  Skipped when AGENTS.md
 * is absent or still contains the default install template.
 */
const DEFAULT_AGENTS_MD = "# Agent Instructions\n\n_No identity yet. Open an issue with the `hatch` label to bootstrap one._";

function generateSoulFromAgentsMd(): void {
  if (!existsSync(agentsMdPath)) return;
  try {
    const content = readFileSync(agentsMdPath, "utf-8").trim();
    if (!content || content === DEFAULT_AGENTS_MD) return;
    writeFileSync(soulPath, content);
  } catch {}
}

/**
 * Bridge the committed canonical MEMORY.md into the agent workspace (repo
 * root) so the OpenClaw runtime loads it as durable context (mirrors
 * agent.ts).  Skipped when the workspace already has a MEMORY.md.
 */
function bridgeMemory(): void {
  try {
    const workspaceMemoryPath = resolve(getRepoRoot(), "MEMORY.md");
    if (existsSync(canonicalMemoryPath) && !existsSync(workspaceMemoryPath)) {
      writeFileSync(workspaceMemoryPath, readFileSync(canonicalMemoryPath, "utf-8"));
    }
  } catch {}
}

/** One-time per-process runtime preparation: SOUL, MEMORY, and skills wiring. */
let runtimePrepared = false;
function prepareOpenclawRuntime(): void {
  if (runtimePrepared) return;
  runtimePrepared = true;
  generateSoulFromAgentsMd();
  bridgeMemory();
  const skillsConfig = loadSkillsConfig();
  linkBundledSkills(skillsConfig.skills?.allowBundled ?? []);
}

/**
 * Write the OpenClaw runtime config for the current provider/model and return
 * its path.  Mirrors the runtime config agent.ts writes: workspace at the repo
 * root, all mutable state under state/ via OPENCLAW_STATE_DIR, skills from
 * config/skills.json, and compaction settings from .pi/settings.json.  For
 * local providers a custom `models.providers` entry wires the local
 * OpenAI-compatible server.
 */
function writeRuntimeConfig(rt: RuntimeState): string {
  const repoRoot = getRepoRoot();
  const settings = loadPiSettings();
  const skillsConfig = loadSkillsConfig();
  const extraDirs = [
    skillsDir,
    ...(skillsConfig.skills?.load?.extraDirs ?? []),
  ].filter(Boolean);
  const compaction = (settings as { compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number } }).compaction;
  const timeoutMinutes = (settings as { limits?: { workflowTimeoutMinutes?: number } }).limits?.workflowTimeoutMinutes ?? 30;
  const localMode = isLocalProvider(rt.provider);

  const runtimeConfig: Record<string, unknown> = {
    agents: {
      defaults: {
        workspace: repoRoot,
        timeoutSeconds: timeoutMinutes * 60,
        model: `${resolveOpenclawProvider(rt.provider)}/${rt.model}`,
        // Prevent OpenClaw from creating bootstrap/identity template files in
        // the workspace; identity is bridged via generateSoulFromAgentsMd().
        skipBootstrap: true,
        ...(compaction?.enabled === false
          ? {}
          : {
              compaction: {
                reserveTokens: compaction?.reserveTokens,
                keepRecentTokens: compaction?.keepRecentTokens,
              },
            }),
      },
    },
    skills: {
      allowBundled: skillsConfig.skills?.allowBundled ?? [],
      load: { extraDirs },
    },
    ...(localMode ? { models: buildLocalProviderModels(rt.provider, rt.model) } : {}),
  };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(runtimeConfigPath, JSON.stringify(runtimeConfig, null, 2) + "\n");
  return runtimeConfigPath;
}

/**
 * Extract the agent reply text from the `--json` result envelope (mirrors
 * agent.ts).  OpenClaw's --json flag routes ALL console output — including
 * the JSON result — to stderr via routeLogsToStderr(), so callers should try
 * stdout first and then stderr.  Returns null when no envelope was found.
 */
function extractAgentTextFromRaw(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try parsing the entire content as JSON first (clean output case).
  try {
    const output = JSON.parse(trimmed);
    if (output.payloads && Array.isArray(output.payloads)) {
      return output.payloads
        .map((pl: { text?: string }) => pl.text || "")
        .filter((t: string) => t.length > 0)
        .join("\n\n");
    }
    if (typeof output.text === "string") return output.text;
    if (typeof output === "string") return output;
  } catch { /* not pure JSON — fall through to bracket-search */ }

  // When the JSON is embedded in mixed output (log lines + JSON), find the
  // last top-level `{` that starts a line — the envelope is always the last
  // block of pretty-printed output from the agent CLI.
  const lastBrace = trimmed.lastIndexOf("\n{");
  if (lastBrace !== -1) {
    const candidate = trimmed.slice(lastBrace + 1);
    try {
      const output = JSON.parse(candidate);
      if (output.payloads && Array.isArray(output.payloads)) {
        return output.payloads
          .map((pl: { text?: string }) => pl.text || "")
          .filter((t: string) => t.length > 0)
          .join("\n\n");
      }
    } catch { /* not valid JSON from this position */ }
  }

  return null;
}

// ─── Provider error extraction ───────────────────────────────────────────────
// When openclaw exits non-zero, the provider's original error message (e.g.
// LM Studio rejecting a request because the model's context length is too
// small) is buried in the embedded-agent logs on stderr.  Surface it so the
// user sees the actual reason instead of only a generic exit-code message.

type ProviderErrorInfo = { detail: string | null; status: number | null };

/**
 * Pull the most specific provider error out of openclaw's raw output.
 * openclaw's embedded-agent logs carry the provider's original message as
 * `rawError=<status> <message>`; fall back to the `FailoverError:` summary.
 */
function extractProviderError(raw: string): ProviderErrorInfo {
  let detail: string | null = null;
  let status: number | null = null;

  const rawErrMatches = raw.match(/rawError=([^\n]+)/g);
  if (rawErrMatches && rawErrMatches.length > 0) {
    detail = rawErrMatches[rawErrMatches.length - 1].slice("rawError=".length).trim();
  }
  if (!detail) {
    const failover = raw.match(/FailoverError: ([^\n]+)/);
    if (failover) detail = failover[1].trim();
  }

  const statusFromDetail = detail?.match(/^(\d{3})\b/);
  if (statusFromDetail) {
    status = parseInt(statusFromDetail[1], 10);
  } else {
    const st = raw.match(/\bstatus=(\d{3})\b/);
    if (st) status = parseInt(st[1], 10);
  }
  return { detail, status };
}

/** Map a known provider error message to an actionable next step. */
function providerErrorHint(detail: string | null): string | null {
  if (!detail) return null;
  if (/context length|tokens to keep|context window|maximum context/i.test(detail)) {
    return (
      "The loaded model's context length is too small for the agent's system prompt. " +
      "In LM Studio, reload the model with a larger context length (16k+ recommended), " +
      "then try again."
    );
  }
  if (/tool/i.test(detail) && /support|unsupported|reject|does not|cannot/i.test(detail)) {
    return (
      "The loaded model (or its chat template) may not support tool calls, which the " +
      "agent requires. Load a tools-capable model in LM Studio and try again."
    );
  }
  if (/\b401\b|unauthorized|api key|authentication/i.test(detail)) {
    return (
      "The local server rejected the placeholder API key. If authentication is enabled " +
      "on the server, set its API token in your environment before starting the chat."
    );
  }
  return null;
}

/**
 * True when the provider rejected the request deterministically (HTTP 4xx,
 * excluding transient 408/429) — retrying the identical request cannot succeed.
 */
function isDeterministicProviderError(info: ProviderErrorInfo): boolean {
  return (
    info.status !== null &&
    info.status >= 400 && info.status < 500 &&
    info.status !== 408 && info.status !== 429
  );
}

// Marker openclaw embeds in the reply payload when the assistant turn failed
// before producing content (e.g. the provider rejected the request) but the
// process still exited 0 on a resumed session.
const TURN_FAILURE_MARKER = "[assistant turn failed before producing content]";

/**
 * Build a turn-failure Error carrying the provider's original message, an
 * actionable hint when the failure is recognised, and a pointer to the raw
 * log.  Also reports whether the failure is deterministic (retry-proof).
 */
function buildTurnFailureError(
  headline: string,
  rawOutput: string,
  fallbackDetail?: string,
): { err: Error; deterministic: boolean } {
  const provErr = extractProviderError(rawOutput);
  const hint = providerErrorHint(provErr.detail);
  const err = new Error(
    headline +
    (provErr.detail
      ? `\nProvider error: ${provErr.detail}`
      : (fallbackDetail ? `\n${fallbackDetail}` : "")) +
    (hint ? `\nHint: ${hint}` : "") +
    `\nRaw output saved to: ${lastRunRawPath}`
  );
  return { err, deterministic: isDeterministicProviderError(provErr) };
}

/**
 * Execute one turn of conversation against openclaw for the given thread.
 *
 * Pipeline:
 *   1. Bridge SOUL/MEMORY/skills and write the runtime config.
 *   2. Spawn `openclaw agent --local --json --message <prompt> --session-id
 *      local-<threadId>` from the repo root with the OPENCLAW_* env vars,
 *      mirroring agent.ts.
 *   3. Buffer stdout AND stderr (the --json envelope lands on stderr).
 *   4. Extract the reply from the JSON envelope; fall back to the session
 *      transcript's final assistant message, then raw stdout.
 *
 * Auto-retries (when enabled) on non-zero exit codes and on turns that
 * produced no assistant text.  The deterministic --session-id means every
 * attempt resumes the same conversation — no attribution diff is needed.
 */
async function runTurn(
  t: Thread,
  prompt: string,
  rt: RuntimeState,
  spinnerLabel?: string,
): Promise<{ thread: Thread; reply: string; rawJsonl: string }> {
  const maxAttempts = rt.autoRetry ? rt.autoRetryMax : 1;
  const repoRoot = getRepoRoot();
  const sessionId = threadSessionId(t.id);
  let lastErr: Error | null = null;
  let rawJsonl = "";

  prepareOpenclawRuntime();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const spinner = spinnerLabel
      ? createSpinner(maxAttempts > 1 && attempt > 1
          ? `${spinnerLabel} (retry ${attempt}/${maxAttempts})…`
          : `${spinnerLabel}…`)
      : null;

    // (Re)write the runtime config each attempt so runtime /model and
    // /provider switches are picked up.
    const configPath = writeRuntimeConfig(rt);
    // Custom local providers register non-reasoning models, and openclaw
    // rejects thinking levels other than "off" for them — omit the flag.
    const localMode = isLocalProvider(rt.provider);
    const args: string[] = [
      "agent",
      "--local",
      "--json",
      "--message", prompt,
      ...(rt.thinking && !localMode ? ["--thinking", rt.thinking] : []),
      "--session-id", sessionId,
    ];

    try {
      // Invoke the package entry point with Node explicitly. Bun-generated
      // Windows .exe shims run under Bun, which does not provide node:sqlite.
      const proc = Bun.spawn(buildOpenclawCommand(
        rt.openclawEntry,
        args,
        process.env.OPENCLAW_NODE || "node",
      ), {
        cwd: repoRoot,
        // Pass env explicitly so runtime mutations (e.g. OPENAI_BASE_URL set
        // by buildLocalProviderModels) reliably reach the child on every
        // platform, plus the OPENCLAW_* wiring that mirrors agent.ts.
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_OAUTH_DIR: resolve(stateDir, "credentials"),
          OPENCLAW_HOME: openclawDir,
          OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      activeOpenclawProcess = proc;
      const [stdoutRaw, stderrRaw] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      activeOpenclawProcess = null;
      spinner?.stop();
      rawJsonl = stdoutRaw;

      // Always save the raw streams for post-mortem debugging.
      try {
        writeFileSync(lastRunRawPath,
          `--- stdout ---\n${stdoutRaw}\n--- stderr ---\n${stderrRaw}\n`);
      } catch {}

      if (rt.verbose) {
        console.log(
          `  [verbose] attempt ${attempt}: ${formatBytes(stdoutRaw.length)} stdout, ` +
          `${formatBytes(stderrRaw.length)} stderr, exit ${exitCode}`
        );
      }

      // SIGTERM (143 = 128 + 15) can occur when the runtime is torn down
      // after output was produced — treat it like agent.ts does (success).
      if (exitCode !== 0 && exitCode !== 143) {
        const { err, deterministic } = buildTurnFailureError(
          `openclaw exited with code ${exitCode} (provider: ${rt.provider}, model: ${rt.model}).`,
          stderrRaw + "\n" + stdoutRaw,
          "This may indicate an invalid model ID, an unreachable local server, or a provider error.",
        );
        lastErr = err;
        // A deterministic 4xx rejection (bad request / context overflow /
        // unsupported payload) will fail identically on every attempt —
        // surface the error immediately instead of burning retries.
        if (attempt < maxAttempts && !deterministic) {
          console.log("  " + c.yellow(`⟳ Retry ${attempt + 1}/${maxAttempts} after exit code ${exitCode}…`));
          continue;
        }
        throw lastErr;
      }

      // The --json envelope normally lands on stderr (routeLogsToStderr), but
      // try stdout first in case a future openclaw version fixes this.
      let reply = extractAgentTextFromRaw(stdoutRaw) ?? extractAgentTextFromRaw(stderrRaw) ?? "";

      // On resumed sessions openclaw can exit 0 while the assistant turn
      // actually failed (the payload carries a failure marker and may echo
      // stale text from the previous turn) — treat it as a failed turn.
      if (reply.includes(TURN_FAILURE_MARKER)) {
        const { err, deterministic } = buildTurnFailureError(
          `The assistant turn failed before producing content (provider: ${rt.provider}, model: ${rt.model}).`,
          stderrRaw + "\n" + stdoutRaw,
        );
        lastErr = err;
        if (attempt < maxAttempts && !deterministic) {
          console.log("  " + c.yellow(`⟳ Retry ${attempt + 1}/${maxAttempts} after failed turn…`));
          continue;
        }
        throw lastErr;
      }

      if (!reply) {
        // Fall back to the session transcript's final assistant message.
        const transcript = threadSessionPath(t.id);
        if (existsSync(transcript)) {
          try { reply = extractFinalAssistantText(readFileSync(transcript, "utf-8")); } catch {}
        }
      }
      if (!reply) {
        lastErr = new Error("openclaw produced no assistant text for this turn.");
        if (attempt < maxAttempts) {
          console.log("  " + c.yellow(`⟳ Retry ${attempt + 1}/${maxAttempts} after empty reply…`));
          continue;
        }
        // Fall through with empty reply rather than throwing: the agent may
        // have legitimately performed file edits without a text reply.
      }

      if (attempt > 1 && reply) {
        console.log("  " + c.green(`✓ Got response on attempt ${attempt}/${maxAttempts}`));
      }

      // Deterministic session attribution: the transcript path follows from
      // the session id we passed.
      const transcriptPath = threadSessionPath(t.id);
      const sessionPath = existsSync(transcriptPath) ? transcriptPath : t.sessionPath;

      const updated: Thread = { ...t, sessionPath, updatedAt: new Date().toISOString() };
      writeThread(updated);
      return { thread: updated, reply, rawJsonl };
    } catch (err) {
      spinner?.stop();
      cleanup();
      lastErr = err as Error;
      if (attempt < maxAttempts) {
        console.log("  " + c.yellow(`⟳ Retry ${attempt + 1}/${maxAttempts} after error: ${(err as Error).message}`));
        continue;
      }
      throw lastErr;
    }
  }

  throw lastErr ?? new Error("runTurn: exhausted retries with no recorded error.");
}

// ─── Read-only subcommands ────────────────────────────────────────────────────

function cmdList(): void {
  const all = listThreads();
  if (all.length === 0) {
    console.log("(no threads — create one with `bun run chat --new`)");
    return;
  }
  console.log("ID    NAME                       UPDATED                   STATUS");
  for (const t of all) {
    const alive = t.sessionPath && existsSync(t.sessionPath) ? "ok" : "—";
    console.log(
      `${String(t.id).padEnd(5)} ${(t.name ?? "(unnamed)").padEnd(26)} ${t.updatedAt}  [${alive}]`
    );
  }
}

function cmdRemove(ref: string): void {
  const t = resolveThreadRef(ref);
  if (!t) {
    say.warn(`No thread matching "${ref}".`, "Use `--list` to see existing threads.");
    process.exitCode = 2; // user error per the documented exit-code contract
    return;
  }
  unlinkSync(threadPath(t.id));
  say.ok(`Removed thread mapping #${t.id}${t.name ? ` ("${t.name}")` : ""}.`);
  console.log("    " + c.dim(`Session transcript preserved: ${t.sessionPath ?? "n/a"}`));
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

function printReplHelp(): void {
  console.log(`
  Thread (closed-world identity, IDs allocated by the tool):
    /list                 — List all threads.
    /new [name]           — Create a new thread; switch to it.
    /switch <id|alias>    — Switch to an existing thread. (Unknown ref = error.)
    /history              — Condensed view of this thread's conversation.
    /export md            — Export this thread as a Markdown file.
    /rename <name>        — Attach/replace this thread's alias.

  Model & config:
    /status               — Provider, model, thread, branch, memory, toggles.
    /model <name>         — Switch model for subsequent turns.
    /model <prov>:<name>  — Switch provider+model (e.g. lmstudio:google/gemma-4-31b).
    /provider <name>      — Switch provider (lmstudio | ollama | vllm | openai | …).
    /time                 — Toggle elapsed-time display.
    /verbose              — Toggle verbose mode (JSONL event counts).
    /auto-retry [on|off|N]— Toggle / set auto-retry attempts.

  Memory log:
    /remember <text>      — Append a timestamped entry to memory.log.
    /memories [term]      — Search or show recent entries.

  Files & repo:
    /cat <path>           — Display a file with line numbers.
    /md <path>            — Render a Markdown file.
    /git                  — git status + diff stat.
    /diff [path]          — git diff (optionally scoped).
    /run <command>        — Shell command (30s timeout).

  Prompt:
    /retry                — Re-send the last prompt in this thread.
    /again                — New thread + re-send the last prompt.
    /best-of <n>          — Send last prompt n times (fresh threads), compare.
    /multiline            — Multiline input mode (blank line submits).

  General:
    /clear                — Clear the screen.
    /help                 — This message.
    /exit, /quit          — End the chat session.
`);
}

/**
 * Interactive REPL bound to a thread.  Reassigns `current` after every turn
 * because runTurn returns a *new* Thread object (timestamps / session path
 * may change), and subsequent turns must resume from the latest state.
 */
async function repl(initial: Thread, rt: RuntimeState): Promise<void> {
  const startTime = Date.now();
  const repoName = getRepoName();
  let current = initial;
  let lastPrompt: string | null = null;

  // ── Banner ────────────────────────────────────────────────────────────────
  const turns = current.sessionPath ? countSessionTurns(current.sessionPath) : 0;
  const sessionStatus = current.sessionPath
    ? `resuming session (${turns} turn${turns === 1 ? "" : "s"})`
    : "new session";
  console.log("");
  console.log("  " + c.bold("GitHub OpenClaw Intelligence") + c.dim(" — Local Chat"));
  const brand = localBrandLabel(rt.provider);
  console.log(
    `  ${c.dim("Provider:")} ${c.bold(rt.provider)}${brand ? c.dim(` (${brand})`) : ""} ${c.dim("|")} ${c.dim("Model:")} ${c.bold(rt.model)}` +
    `${rt.thinking ? ` ${c.dim("|")} ${c.dim("Thinking:")} ${rt.thinking}` : ""}`
  );
  if (brand && process.env.OPENAI_BASE_URL) {
    console.log(`  ${c.dim("Endpoint:")} ${c.bold(process.env.OPENAI_BASE_URL)}`);
  }
  console.log(`  ${c.dim("Thread:")}   ${c.bold("#" + current.id)}${current.name ? c.dim(` ("${current.name}")`) : ""} ${c.dim("— " + sessionStatus)}`);
  const memCount = getMemoryCount();
  if (memCount > 0) {
    console.log(`  ${c.dim("Memory:")}   ${memCount} entr${memCount === 1 ? "y" : "ies"} in memory.log`);
  }
  if (rt.autoRetry) {
    console.log(`  ${c.dim("Retry:")}    auto (max ${rt.autoRetryMax})`);
  }
  console.log("");
  console.log("  " + c.bold("Common commands:"));
  console.log("    " + c.cyan("/help") + "          all commands         " + c.cyan("/status") + "      runtime info");
  console.log("    " + c.cyan("/list /new") + "     manage threads       " + c.cyan("/switch <n>") + "  resume thread");
  console.log("    " + c.cyan("/history") + "       view this thread     " + c.cyan("/export md") + "   save as Markdown");
  console.log("    " + c.cyan("/retry /again") + "  redo last prompt     " + c.cyan("/multiline") + "   paste long input");
  console.log("    " + c.cyan("/exit") + "          end session          " + c.dim("Ctrl-C") + "       quit anytime");
  console.log("  " + c.dim("─────────────────────────────────────────────────────────────────────"));
  console.log("");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  // EOF-safe question wrapper: resolves null on Ctrl-D / closed stdin so the
  // REPL exits cleanly instead of hanging on an unanswerable question.
  const ask = makeAsk(rl);

  function prompt(): string {
    const branch = getGitBranch();
    const branchPart = branch ? ` (${branch})` : "";
    const aliasPart = current.name ? ` [${current.name}]` : "";
    return `${repoName}${branchPart} #${current.id}${aliasPart} > `;
  }

  /** Run one user prompt with timing display when enabled. */
  async function turn(text: string, spinnerLabel = "Thinking"): Promise<void> {
    lastPrompt = text;
    const t0 = Date.now();
    try {
      const { thread, reply } = await runTurn(current, text, rt, spinnerLabel);
      current = thread;
      console.log("");
      console.log(renderMarkdown(reply || "(no text reply produced)"));
      if (rt.showTiming) {
        const words = stripAnsi(reply).split(/\s+/).filter((w) => w.length > 0).length;
        console.log(`\n  ─ ${formatDuration(Date.now() - t0)} · ${words} words`);
      }
      console.log("");
    } catch (err) {
      console.log("\n  " + c.red("× ") + (err as Error).message + "\n");
    }
  }

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await ask(prompt());
      if (answer === null) break; // EOF — end the session cleanly.
      const line = answer.trim();
      if (!line) continue;

      // ─── Exit ─────────────────────────────────────────────────────────────
      if (line === "/exit" || line === "/quit") break;

      // ─── /help, /clear ────────────────────────────────────────────────────
      if (line === "/help") { printReplHelp(); continue; }
      if (line === "/clear") { process.stdout.write("\x1B[2J\x1B[H"); continue; }

      // ─── Thread commands ──────────────────────────────────────────────────
      if (line === "/list") { console.log(""); cmdList(); console.log(""); continue; }

      if (line === "/new" || line.startsWith("/new ")) {
        const arg = line.slice("/new".length).trim() || null;
        try {
          const t = allocateThread(arg);
          current = t;
          console.log(`\n  Created thread #${t.id}${t.name ? ` ("${t.name}")` : ""}; switched.\n`);
        } catch (err) {
          console.log("\n  " + c.red("× ") + (err as Error).message + "\n");
        }
        continue;
      }

      if (line.startsWith("/switch ")) {
        const ref = line.slice("/switch ".length).trim();
        const t = resolveThreadRef(ref);
        if (!t) {
          console.log("\n  " + c.yellow("! ") + `Unknown thread "${ref}". Use /list to see existing threads.\n`);
        } else {
          current = t;
          const n = current.sessionPath ? countSessionTurns(current.sessionPath) : 0;
          console.log(`\n  Switched to thread #${t.id}${t.name ? ` ("${t.name}")` : ""} (${n} turn${n === 1 ? "" : "s"}).\n`);
        }
        continue;
      }

      if (line.startsWith("/rename ")) {
        const newName = line.slice("/rename ".length).trim();
        if (!ALIAS_PATTERN.test(newName)) {
          console.log("\n  " + c.yellow("! ") + `Invalid name "${newName}". Use letters/digits/_/- (starts with a letter).\n`);
          continue;
        }
        const clash = listThreads().find((x) => x.name === newName && x.id !== current.id);
        if (clash) {
          console.log("\n  " + c.yellow("! ") + `Name "${newName}" already taken by thread #${clash.id}.\n`);
          continue;
        }
        current = { ...current, name: newName, updatedAt: new Date().toISOString() };
        writeThread(current);
        console.log(`\n  Thread #${current.id} renamed to "${newName}".\n`);
        continue;
      }

      // ─── /history ─────────────────────────────────────────────────────────
      if (line === "/history") {
        const h = current.sessionPath ? getSessionHistory(current.sessionPath) : [];
        if (h.length === 0) { console.log("\n  No history in this thread.\n"); continue; }
        console.log(`\n  Conversation history (${h.length} messages):\n`);
        let n = 0;
        for (const e of h) {
          if (e.role === "user") n++;
          const label = e.role === "user" ? `  [${n}] You:` : "       AI:";
          console.log(`${label} ${e.preview}`);
        }
        console.log("");
        continue;
      }

      // ─── /export md ───────────────────────────────────────────────────────
      if (line === "/export md" || line === "/export") {
        const h = current.sessionPath ? getSessionHistory(current.sessionPath) : [];
        if (h.length === 0) { console.log("\n  Nothing to export.\n"); continue; }
        const outPath = resolve(sessionsDir,
          `thread-${current.id}${current.name ? `-${current.name}` : ""}-export.md`);
        const md: string[] = [
          `# Thread #${current.id}${current.name ? ` — ${current.name}` : ""}`,
          ``,
          `Exported: ${new Date().toISOString()}`,
          `Provider: ${rt.provider} | Model: ${rt.model}`,
          ``,
        ];
        let n = 0;
        for (const e of h) {
          if (e.role === "user") { n++; md.push(`## Turn ${n}`, ``, `**You:** ${e.preview}`, ``); }
          else { md.push(`**AI:** ${e.preview}`, ``); }
        }
        try { writeFileSync(outPath, md.join("\n")); console.log(`\n  Exported to: ${outPath}\n`); }
        catch (err) { console.log("\n  " + c.red("× ") + (err as Error).message + "\n"); }
        continue;
      }

      // ─── /status ──────────────────────────────────────────────────────────
      if (line === "/status") {
        const branch = getGitBranch();
        const mc = getMemoryCount();
        const sExists = current.sessionPath ? existsSync(current.sessionPath) : false;
        const sTurns = sExists ? countSessionTurns(current.sessionPath!) : 0;
        const sSize = sExists ? formatBytes(statSync(current.sessionPath!).size) : "—";
        console.log("");
        const brandLabel = localBrandLabel(rt.provider);
        console.log("  Status:");
        console.log(`    Provider:    ${rt.provider}${brandLabel ? ` (${brandLabel}, local server)` : ""}`);
        console.log(`    OpenClaw --provider: ${resolveOpenclawProvider(rt.provider)}`);
        console.log(`    Model:       ${rt.model}`);
        if (rt.thinking) console.log(`    Thinking:    ${rt.thinking}`);
        console.log(`    Thread:      #${current.id}${current.name ? ` ("${current.name}")` : ""}`);
        console.log(`    Session:     ${sTurns} turn${sTurns === 1 ? "" : "s"}, ${sSize}`);
        if (branch) console.log(`    Git branch:  ${branch}`);
        console.log(`    Memory:      ${mc} entr${mc === 1 ? "y" : "ies"}`);
        console.log(`    Timing:      ${rt.showTiming ? "on" : "off"}`);
        console.log(`    Verbose:     ${rt.verbose ? "on" : "off"}`);
        console.log(`    Auto-retry:  ${rt.autoRetry ? `on (max ${rt.autoRetryMax})` : "off"}`);
        console.log(`    Uptime:      ${formatDuration(Date.now() - startTime)}`);
        if (process.env.OPENAI_BASE_URL) {
          console.log(`    OPENAI_BASE_URL: ${process.env.OPENAI_BASE_URL}`);
        }
        console.log("");
        continue;
      }

      // ─── /model <name> ────────────────────────────────────────────────────
      // Also accepts `provider:model` (e.g. `/model lmstudio:google/gemma-4-31b`)
      // to switch both at once. Known local brands: lmstudio, ollama, vllm.
      if (line === "/model" || line.startsWith("/model ")) {
        const newModel = line.slice("/model".length).trim();
        if (!newModel) {
          console.log(`\n  Current provider:model = ${rt.provider}:${rt.model}\n  Usage: /model <id>  or  /model <provider>:<id>\n`);
        } else if (/\s/.test(newModel)) {
          console.log("\n  " + c.yellow("! ") + "Model IDs must not contain whitespace.\n");
        } else if (newModel.includes(":") && /^[a-z][a-z0-9-]*:/.test(newModel)) {
          const idx = newModel.indexOf(":");
          const newProv = newModel.slice(0, idx);
          const newId   = newModel.slice(idx + 1);
          const oldProv = rt.provider, oldModel = rt.model;
          rt.provider = newProv;
          rt.model = newId;
          // Re-wire env for newly-selected local brand if needed.
          if (LOCAL_PROVIDERS.has(newProv)) {
            const def = LOCAL_BRAND_DEFAULTS[newProv];
            if (def && !process.env.OPENAI_BASE_URL) {
              process.env.OPENAI_BASE_URL = def.baseUrl;
              process.env.LOCAL_LLM_BASE_URL = def.baseUrl;
            }
            if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = "local";
            rt.autoRetry = true;
          }
          console.log(`\n  Switched: ${oldProv}:${oldModel} → ${rt.provider}:${rt.model}\n`);
        } else {
          const old = rt.model;
          rt.model = newModel;
          console.log(`\n  Model changed: ${old} → ${rt.model}\n`);
        }
        continue;
      }

      // ─── /provider <name> ─────────────────────────────────────────────────
      // Switch provider (and optionally re-wire local-server env vars).
      if (line === "/provider" || line.startsWith("/provider ")) {
        const arg = line.slice("/provider".length).trim();
        if (!arg) {
          console.log(`\n  Current provider: ${rt.provider}` +
            (localBrandLabel(rt.provider) ? c.dim(` (${localBrandLabel(rt.provider)})`) : "") +
            `\n  Usage: /provider <name>` +
            `\n  Known local brands: lmstudio, ollama, vllm` +
            `\n  Cloud examples:    openai, anthropic, google, xai, openrouter\n`);
        } else {
          const oldProv = rt.provider;
          rt.provider = arg;
          if (LOCAL_PROVIDERS.has(arg)) {
            const def = LOCAL_BRAND_DEFAULTS[arg];
            if (def && !process.env.OPENAI_BASE_URL) {
              process.env.OPENAI_BASE_URL = def.baseUrl;
              process.env.LOCAL_LLM_BASE_URL = def.baseUrl;
            }
            if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = "local";
            rt.autoRetry = true;
          }
          console.log(`\n  Provider: ${oldProv} → ${rt.provider}` +
            (localBrandLabel(rt.provider) ? c.dim(` (${localBrandLabel(rt.provider)} via openai-compatible client)`) : "") + "\n");
        }
        continue;
      }

      // ─── /time, /verbose ──────────────────────────────────────────────────
      if (line === "/time") {
        rt.showTiming = !rt.showTiming;
        console.log(`\n  Timing display: ${rt.showTiming ? "on" : "off"}\n`);
        continue;
      }
      if (line === "/verbose") {
        rt.verbose = !rt.verbose;
        console.log(`\n  Verbose mode: ${rt.verbose ? "on" : "off"}\n`);
        continue;
      }

      // ─── /auto-retry [on|off|N] ───────────────────────────────────────────
      if (line === "/auto-retry" || line.startsWith("/auto-retry ")) {
        const arg = line.slice("/auto-retry".length).trim();
        if (arg === "off" || arg === "0") {
          rt.autoRetry = false;
          console.log(`\n  Auto-retry: off\n`);
        } else if (arg === "on") {
          rt.autoRetry = true;
          console.log(`\n  Auto-retry: on (max ${rt.autoRetryMax})\n`);
        } else if (arg) {
          const n = parseInt(arg, 10);
          if (n >= 1 && n <= 10) {
            rt.autoRetry = true; rt.autoRetryMax = n;
            console.log(`\n  Auto-retry: on (max ${n})\n`);
          } else {
            console.log(`\n  Usage: /auto-retry [on|off|1-10]\n`);
          }
        } else {
          rt.autoRetry = !rt.autoRetry;
          console.log(`\n  Auto-retry: ${rt.autoRetry ? `on (max ${rt.autoRetryMax})` : "off"}\n`);
        }
        continue;
      }

      // ─── Memory commands ──────────────────────────────────────────────────
      if (line.startsWith("/remember ")) {
        const text = line.slice("/remember ".length).trim();
        if (!text) { console.log("\n  Usage: /remember <text>\n"); continue; }
        try {
          const ts = new Date().toISOString().replace("T", " ").slice(0, 16);
          appendFileSync(memoryLogPath, `[${ts}] ${text}\n`);
          console.log(`\n  Remembered: ${text}\n`);
        } catch (err) {
          console.log("\n  " + c.red("× ") + `could not write memory.log: ${(err as Error).message}\n`);
        }
        continue;
      }
      if (line === "/memories" || line.startsWith("/memories ")) {
        const term = line.slice("/memories".length).trim();
        if (!existsSync(memoryLogPath)) { console.log("\n  No memory.log yet.\n"); continue; }
        try {
          const all = readFileSync(memoryLogPath, "utf-8")
            .split(/\r?\n/).filter((l) => l.trim().length > 0);
          if (all.length === 0) { console.log("\n  memory.log is empty.\n"); continue; }
          if (term) {
            const lower = term.toLowerCase();
            const matches = all.filter((l) => l.toLowerCase().includes(lower));
            if (matches.length === 0) console.log(`\n  No memories matching "${term}".\n`);
            else {
              console.log(`\n  Memories matching "${term}" (${matches.length}):\n`);
              for (const m of matches) console.log(`    ${m}`);
              console.log("");
            }
          } else {
            const recent = all.slice(-10);
            console.log(`\n  Recent memories (${recent.length} of ${all.length}):\n`);
            for (const m of recent) console.log(`    ${m}`);
            console.log("");
          }
        } catch { console.log("\n  Could not read memory.log.\n"); }
        continue;
      }

      // ─── File / repo commands ─────────────────────────────────────────────
      if (line.startsWith("/cat ")) {
        const p = line.slice("/cat ".length).trim();
        const safe = p ? safePath(p) : null;
        if (!safe) { console.log("\n  Bad or out-of-repo path.\n"); continue; }
        if (!existsSync(safe)) { console.log(`\n  File not found: ${p}\n`); continue; }
        try {
          const lines = readFileSync(safe, "utf-8").split(/\r?\n/);
          const pad = String(lines.length).length;
          console.log("");
          for (let i = 0; i < lines.length; i++) {
            console.log(`  ${String(i + 1).padStart(pad)}. ${lines[i]}`);
          }
          console.log("");
        } catch (err) { console.log("\n  " + c.red("× ") + (err as Error).message + "\n"); }
        continue;
      }
      if (line.startsWith("/md ")) {
        const p = line.slice("/md ".length).trim();
        const safe = p ? safePath(p) : null;
        if (!safe) { console.log("\n  Bad or out-of-repo path.\n"); continue; }
        if (!existsSync(safe)) { console.log(`\n  File not found: ${p}\n`); continue; }
        try {
          console.log("");
          console.log(renderMarkdown(readFileSync(safe, "utf-8")));
          console.log("");
        } catch (err) { console.log("\n  " + c.red("× ") + (err as Error).message + "\n"); }
        continue;
      }
      if (line === "/git") {
        console.log("");
        try {
          const status = execFileSync("git", ["status", "--short"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
          if (status.trim()) {
            console.log("  Changes:");
            for (const s of status.trimEnd().split("\n")) console.log(`    ${s}`);
          } else {
            console.log("  Working tree clean.");
          }
          const diffStat = execFileSync("git", ["diff", "--stat"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
          if (diffStat.trim()) {
            console.log("");
            for (const s of diffStat.trimEnd().split("\n")) console.log(`    ${s}`);
          }
        } catch (err) { console.log("  " + c.red("× ") + (err as Error).message); }
        console.log("");
        continue;
      }
      if (line === "/diff" || line.startsWith("/diff ")) {
        const target = line.slice("/diff".length).trim();
        const args = target ? ["diff", "--", target] : ["diff"];
        console.log("");
        try {
          const out = execFileSync("git", args,
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
          if (out.trim()) process.stdout.write(out);
          else console.log("  No differences.");
        } catch (err) { console.log("  " + c.red("× ") + (err as Error).message); }
        console.log("");
        continue;
      }
      if (line.startsWith("/run ")) {
        const cmd = line.slice("/run ".length).trim();
        if (!cmd) { console.log("\n  Usage: /run <command>\n"); continue; }
        // /run is deliberately a free-form shell escape (the user is the
        // attacker as well as the victim here), but we still cap timeout.
        console.log("");
        try {
          const out = execSync(cmd, {
            encoding: "utf-8", timeout: 30_000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          process.stdout.write(out);
          if (!out.endsWith("\n")) console.log("");
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; status?: number };
          if (e.stdout) process.stdout.write(e.stdout);
          if (e.stderr) process.stderr.write(e.stderr);
          console.log(`  [exit ${e.status ?? "?"}]`);
        }
        console.log("");
        continue;
      }

      // ─── Prompt-management commands ───────────────────────────────────────
      if (line === "/retry") {
        if (!lastPrompt) { console.log("\n  No previous prompt to retry.\n"); continue; }
        console.log(`\n  Retrying: ${lastPrompt.length > 60 ? lastPrompt.slice(0, 57) + "..." : lastPrompt}`);
        await turn(lastPrompt, "Retrying");
        continue;
      }
      if (line === "/again") {
        if (!lastPrompt) { console.log("\n  No previous prompt to retry.\n"); continue; }
        try {
          const t = allocateThread(null);
          const oldId = current.id;
          current = t;
          console.log(`\n  New thread #${t.id} (was #${oldId}); re-sending last prompt.`);
          await turn(lastPrompt, "Thinking");
        } catch (err) { console.log("\n  " + c.red("× ") + (err as Error).message + "\n"); }
        continue;
      }
      if (line === "/best-of" || line.startsWith("/best-of ")) {
        const n = parseInt(line.slice("/best-of".length).trim(), 10);
        if (!n || n < 2 || n > 10) {
          console.log("\n  Usage: /best-of <n>  (n = 2–10)\n"); continue;
        }
        if (!lastPrompt) { console.log("\n  No previous prompt to retry.\n"); continue; }
        console.log(`\n  Sending the last prompt ${n} times in fresh throwaway threads…\n`);
        const saved = current;
        const savedAutoRetry = rt.autoRetry;
        rt.autoRetry = false;
        const results: Array<{ id: number; reply: string; ms: number }> = [];
        for (let i = 1; i <= n; i++) {
          try {
            const t = allocateThread(null);
            const t0 = Date.now();
            const { reply } = await runTurn(t, lastPrompt, rt, `best-of ${i}/${n}`);
            results.push({ id: t.id, reply, ms: Date.now() - t0 });
          } catch (err) {
            results.push({ id: -1, reply: `[error] ${(err as Error).message}`, ms: 0 });
          }
        }
        rt.autoRetry = savedAutoRetry;
        current = saved;
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          console.log(`  ── Response ${i + 1}/${n}` +
            `${r.id > 0 ? ` (thread #${r.id})` : ""} (${formatDuration(r.ms)}) ──`);
          console.log(renderMarkdown(r.reply));
          console.log("");
        }
        continue;
      }
      if (line === "/multiline") {
        console.log("\n  Multiline mode: type freely; enter a blank line to send.\n");
        const lines: string[] = [];
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const more = await ask("  ... ");
          if (more === null || more.trim() === "") break;
          lines.push(more);
        }
        const full = lines.join("\n").trim();
        if (!full) { console.log("  (empty, cancelled)\n"); continue; }
        await turn(full, "Thinking");
        continue;
      }

      // ─── Unknown command ──────────────────────────────────────────────────
      if (line.startsWith("/")) {
        const cmd = line.split(/\s/)[0];
        console.log(`\n  Unknown command: ${cmd}  (type /help)\n`);
        continue;
      }

      // ─── Regular prompt ───────────────────────────────────────────────────
      await turn(line, "Thinking");
    }
  } finally {
    rl.close();
    cleanup();
  }
}

// ─── Guided recovery flows ────────────────────────────────────────────────────
// These NEVER call process.exit().  They return a possibly-updated runtime
// shape so main() can decide whether to proceed.  All output goes through
// `say.*` (stdout) — no red-on-white stderr.

type RuntimeCfg = { provider: string; model: string; thinking: string | undefined };

/**
 * Friendly prompt for a single line; returns "" on Ctrl-C/EOF rather than
 * throwing, so callers can treat it as "user backed out".
 */
async function promptLine(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  try {
    // makeAsk resolves null on EOF (Ctrl-D / closed stdin); map that to ""
    // so callers can treat it as "user backed out".
    return (await makeAsk(rl)(question)) ?? "";
  } catch {
    return "";
  } finally {
    rl.close();
  }
}

/** Show the "how to persist this env var" instructions, no prompts. */
function printPersistHints(keyName: string, valueHint = "your-key-here"): void {
  console.log("    " + c.dim("To persist for future sessions:"));
  console.log("      " + c.cyan(`PowerShell  `) + c.gray(`setx ${keyName} "${valueHint}"`));
  console.log("      " + c.cyan(`bash/zsh    `) + c.gray(`export ${keyName}="${valueHint}"   # add to ~/.bashrc`));
  console.log("    " + c.dim("(setx values apply to NEW terminal windows.)"));
  console.log("");
}

// ─── Local LLM network discovery ──────────────────────────────────────────────

// Default port LM Studio exposes its OpenAI-compatible server on.
const LMSTUDIO_SCAN_PORT = 1234;

// A discovered OpenAI-compatible local LLM server.
type LocalLLMHit = { baseUrl: string; host: string; models: string[] };

/**
 * Collect the distinct IPv4 /24 prefixes (e.g. "192.168.1.") for every
 * non-internal IPv4 address bound to this host. Used to enumerate the LAN.
 */
function hostIPv4Prefixes(): string[] {
  const prefixes: string[] = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] ?? []) {
      // Node typings declare `family` as a string ("IPv4"); some runtimes
      // report the number 4. Accept both, and skip loopback/internal NICs.
      const fam = ni.family as unknown;
      const isV4 = fam === "IPv4" || fam === 4;
      if (!isV4 || ni.internal) continue;
      const parts = ni.address.split(".");
      if (parts.length !== 4) continue;
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`;
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
  }
  return prefixes;
}

/**
 * Probe a single host:port for an OpenAI-compatible server by requesting
 * `/v1/models`. Returns a hit (with any advertised model ids) or null on
 * timeout / connection-refused / non-OK response.
 */
async function probeOpenAIServer(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<LocalLLMHit | null> {
  const baseUrl = `http://${host}:${port}/v1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: ctrl.signal,
      // Some servers reject unauthenticated /models; send a benign dummy key.
      headers: { authorization: "Bearer local" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as any;
    const models = Array.isArray(body?.data)
      ? body.data.map((m: any) => String(m?.id ?? "")).filter(Boolean)
      : [];
    return { baseUrl, host, models };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scan the host's IPv4 /24 networks — all 256 addresses each, plus localhost —
 * for an OpenAI-compatible LLM server answering over http:// on `port`.
 * Probes are issued concurrently; returns every server that responded.
 */
async function scanForLocalLLM(
  port = LMSTUDIO_SCAN_PORT,
  timeoutMs = 600,
): Promise<LocalLLMHit[]> {
  const targets: string[] = ["127.0.0.1"];
  for (const prefix of hostIPv4Prefixes()) {
    for (let host = 0; host < 256; host++) {
      const addr = `${prefix}${host}`;
      if (!targets.includes(addr)) targets.push(addr);
    }
  }
  const results = await Promise.all(
    targets.map((host) => probeOpenAIServer(host, port, timeoutMs)),
  );
  return results.filter((r): r is LocalLLMHit => r !== null);
}

/**
 * Recover from a missing cloud API key without crashing.  Offers four paths:
 *   1. Paste the key now (session-scoped).
 *   2. Scan the LAN for a local LM Studio server (OpenAI-compatible endpoint).
 *   3. Show persistence instructions and quit.
 *   4. Quit.
 * Returns the (possibly updated) runtime config to use, or null to quit.
 */
async function guideMissingApiKey(cfg: RuntimeCfg): Promise<RuntimeCfg | null> {
  const keyName = PROVIDER_KEY_MAP[cfg.provider] ?? `${cfg.provider.toUpperCase()}_API_KEY`;

  console.log("");
  console.log("  " + c.yellow(c.bold("─ Setup needed ──────────────────────────────────────────────────────")));
  console.log("");
  console.log("    " + c.bold(`Provider "${cfg.provider}" needs an API key`));
  console.log("    " + c.dim(`The environment variable ${c.bold(keyName)}${c.dim(" is not set.")}`));
  console.log("");
  console.log("    " + c.bold("How would you like to continue?"));
  console.log("      " + c.cyan("[1]") + "  Paste your API key now " + c.dim("(used for this session only)"));
  console.log("      " + c.cyan("[2]") + "  Scan for local LM Studio " + c.dim("(auto-detected on your LAN)"));
  console.log("      " + c.cyan("[3]") + "  Show how to set the env var permanently, then quit");
  console.log("      " + c.cyan("[q]") + "  Quit");
  console.log("");

  while (true) {
    const choice = (await promptLine("    Choice [1/2/3/q]: ")).trim().toLowerCase();

    if (choice === "" || choice === "q" || choice === "quit" || choice === "exit") {
      return null;
    }

    if (choice === "1") {
      console.log("");
      say.hint("Paste your key and press Enter. It is not saved to disk.");
      const key = (await promptLine("    " + c.cyan(`${keyName} = `))).trim();
      if (!key) { say.warn("No key entered.", "Try again or pick another option."); continue; }
      process.env[keyName] = key;
      say.ok(`Key set for this session (${key.length} chars).`);
      printPersistHints(keyName, key.slice(0, 4) + "…" + key.slice(-4));
      return cfg;
    }

    if (choice === "2") {
      console.log("");
      console.log("    " + c.bold("Scanning your LAN for a local LM Studio server…"));
      console.log("    " + c.dim("Probing this host's IPv4 /24 (all 256 addresses) plus"));
      console.log("    " + c.dim(`localhost for an OpenAI-compatible server on port ${LMSTUDIO_SCAN_PORT}.`));
      console.log("    " + c.dim("LM Studio speaks the OpenAI-compatible Chat Completions API,"));
      console.log("    " + c.dim("so openclaw talks to it through a custom 'lmstudio' provider"));
      console.log("    " + c.dim("entry in the runtime config (openai-completions API)."));
      console.log("");

      const hits = await scanForLocalLLM(LMSTUDIO_SCAN_PORT);
      if (hits.length === 0) {
        say.warn(
          "No local LM Studio server found on your network.",
          `Make sure LM Studio is running with its local server enabled on ` +
          `port ${LMSTUDIO_SCAN_PORT}, then pick this option again or choose another.`,
        );
        continue;
      }

      const hit = hits[0];
      const url = hit.baseUrl;
      const modelDefault = hit.models[0] || cfg.model || "local-model";
      process.env.LOCAL_LLM_BASE_URL = url;
      process.env.OPENAI_BASE_URL = url;
      process.env.OPENAI_API_KEY = "local";
      say.ok(
        `Found LM Studio at ${url}` +
        (hits.length > 1 ? ` ${c.dim(`(+${hits.length - 1} more on the LAN)`)}` : ""),
      );
      say.hint(
        `Provider label: lmstudio  (openclaw reaches it via a custom provider entry ` +
        `in the runtime config; a placeholder "local" API key is sent on every turn).`,
      );
      console.log("");
      return { provider: "lmstudio", model: modelDefault, thinking: cfg.thinking };
    }

    if (choice === "3") {
      console.log("");
      printPersistHints(keyName);
      say.info("Once set, run `bun run chat` again. Goodbye.");
      return null;
    }

    say.warn(`Unrecognised choice: "${choice}"`, "Pick 1, 2, 3, or q.");
  }
}

/** Friendly handler for a missing OpenClaw package entry point. */
function guideOpenclawNotInstalled(entryPath: string): void {
  say.error(
    "The `openclaw` package isn't installed yet.",
    "This project uses the `openclaw` package under the hood, " +
    "which is added when you run `bun install` in the .github-openclaw-intelligence/ folder."
  );
  console.log("    " + c.bold("To fix:"));
  console.log("      " + c.gray("cd .github-openclaw-intelligence"));
  console.log("      " + c.gray("bun install"));
  console.log("");
  console.log("    " + c.dim("Checked this location:"));
  console.log("      " + c.dim(entryPath));
  console.log("");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  mkdirSync(threadsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  // Read-only subcommands don't need provider settings or an API key.
  if (args.list) { cmdList(); return; }
  if (args.rmRef !== null) { cmdRemove(args.rmRef); return; }

  let cfg: RuntimeCfg = resolveRuntimeConfig();

  // Pure allocation (`--new` without a prompt or thread ref) never contacts a
  // model, so it must work without an API key.
  const allocationOnly = args.newThread && !args.prompt && !args.threadRef;

  // ── Validate config BEFORE creating threads ─────────────────────────────
  // (so quitting from the guide doesn't leave orphan thread #1 behind.)
  if (!allocationOnly && !isLocalProvider(cfg.provider)) {
    const keyName = PROVIDER_KEY_MAP[cfg.provider];
    if (keyName && !process.env[keyName]) {
      const updated = await guideMissingApiKey(cfg);
      if (!updated) { console.log("  " + c.dim("Goodbye.")); return; }
      cfg = updated;
    }
  }

  // ── Resolve / create the active thread ──────────────────────────────────
  let activeThread: Thread | null = null;
  if (args.newThread) {
    activeThread = allocateThread(args.newName);
    say.ok(
      `Created thread #${activeThread.id}` +
      `${activeThread.name ? ` ("${activeThread.name}")` : ""}.`
    );
    if (!args.prompt && !args.threadRef) return;
  }
  if (!activeThread) {
    if (!args.threadRef) {
      activeThread = await interactiveStart(cfg.provider, cfg.model, cfg.thinking);
      if (!activeThread) { console.log("  " + c.dim("Goodbye.")); return; }
    } else {
      activeThread = resolveThreadRef(args.threadRef);
      if (!activeThread) {
        say.warn(
          `Unknown thread "${args.threadRef}".`,
          "Use `--list` to see existing threads, or `--new` to create one. " +
          "Closed-world: unknown refs are never auto-created."
        );
        process.exitCode = 2; // user error per the documented exit-code contract
        return;
      }
    }
  }

  // ── Locate OpenClaw's Node entry point; guide the user if it's missing ──
  // Allocation-only --new returns above and does not need runtime dependencies.
  let openclawEntry: string;
  try {
    openclawEntry = locateOpenclawEntry(openclawDir);
  } catch (err) {
    const msg = (err as Error).message;
    const entryPath = msg.slice(msg.indexOf(":") + 1).trim();
    guideOpenclawNotInstalled(entryPath);
    process.exitCode = 1;
    return;
  }

  // Auto-retry default: on for local providers (flaky/slow), off for cloud
  // (failures are usually configuration errors, not transient).
  const rt: RuntimeState = {
    provider: cfg.provider, model: cfg.model, thinking: cfg.thinking,
    showTiming: false, verbose: false,
    autoRetry: isLocalProvider(cfg.provider),
    autoRetryMax: 3,
    openclawEntry,
  };

  // For local providers, resolve the endpoint env vars up front so the REPL
  // banner shows the right endpoint and the first turn is correctly wired.
  if (isLocalProvider(rt.provider)) buildLocalProviderModels(rt.provider, rt.model);

  // One-shot mode.
  if (args.prompt) {
    try {
      const { reply } = await runTurn(activeThread, args.prompt, rt, "Thinking");
      console.log("");
      console.log(renderMarkdown(reply || "(no text reply produced)"));
    } catch (err) {
      say.error("Turn failed", (err as Error).message);
      process.exitCode = 1;
    }
    return;
  }

  await repl(activeThread, rt);
}

main().catch((err: unknown) => {
  // Top-level error handler: honour the documented exit-code contract
  // (1 = environment problem, 2 = user error) and print a readable message
  // instead of an unhandled-rejection stack trace.
  say.error(
    err instanceof UserError ? "Invalid request" : "Startup failed",
    err instanceof Error ? err.message : String(err),
  );
  cleanup();
  process.exit(err instanceof UserError ? 2 : 1);
});
