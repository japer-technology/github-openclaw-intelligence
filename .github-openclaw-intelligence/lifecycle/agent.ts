/**
 * agent.ts — Core agent orchestrator for OpenClaw Intelligence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the main entry point for the OpenClaw Intelligence AI agent.  It
 * receives a GitHub issue (or issue comment) event, runs the OpenClaw agent
 * against the user's prompt, and posts the result back as an issue comment.
 * It also manages all session state so that multi-turn conversations across
 * multiple workflow runs are seamlessly resumed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LIFECYCLE POSITION
 * ─────────────────────────────────────────────────────────────────────────────
 * Workflow step order:
 *   1. Authorize   (inline shell)            — auth check + add 🚀 reaction indicator
 *   2. Install     (bun install)            — install npm/bun dependencies
 *   3. Build       (bun run build)          — compile OpenClaw TypeScript
 *   4. Run         (agent.ts)               ← YOU ARE HERE
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AGENT EXECUTION PIPELINE
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Fetch issue title/body from GitHub via the `gh` CLI.
 *   2. Strip the `@` prefix from the prompt (routing signal, not user content).
 *   3. Resolve (or create) a conversation session for this issue number.
 *      - New issue  → create a fresh session; record the mapping in state/.
 *      - Follow-up  → load the existing session file for conversation context.
 *   4. Build a prompt string from the event payload.
 *   5. Run the `openclaw agent --local --json` command with the prompt.
 *      Agent output is streamed through `tee` to provide a live Actions log AND
 *      persist the raw output to `/tmp/agent-raw.json` for post-processing.
 *   6. Extract the assistant's final text reply from the JSON output.
 *   7. Persist the issue → session mapping so the next run can resume the conversation.
 *   8. Post the extracted reply as a new comment on the originating issue.
 *      This happens before the git push so the user sees the response quickly.
 *   9. Stage, commit, and push all changes (session log, mapping, repo edits)
 *      back to the default branch with an automatic retry-on-conflict loop.
 *  10. [finally] Add an outcome reaction: 👍 (thumbs up) on success or
 *      👎 (thumbs down) on error.  The 🚀 rocket from the Authorize step
 *      is left in place for both success and error cases.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SESSION CONTINUITY
 * ─────────────────────────────────────────────────────────────────────────────
 * OpenClaw Intelligence maintains per-issue session state in:
 *   .github-openclaw-intelligence/state/issues/<number>.json   — maps issue # → session ID
 *   .github-openclaw-intelligence/state/agents/main/sessions/<id>.jsonl — the session transcript
 *
 * OPENCLAW_STATE_DIR points at `.github-openclaw-intelligence/state/`, so the
 * OpenClaw runtime reads and writes session transcripts directly in the
 * git-tracked `agents/main/sessions/` directory.  No manual copying between
 * an ephemeral runtime dir and a persistent archive is needed — the runtime's
 * native storage location *is* the persistent location.  Session files are
 * committed alongside other state changes for auditability and cross-run
 * persistence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PUSH CONFLICT RESOLUTION
 * ─────────────────────────────────────────────────────────────────────────────
 * Multiple agents may race to push to the same branch.  To handle this gracefully
 * the script retries a failed `git push` up to 10 times with increasing backoff
 * delays, pulling with `--rebase -X theirs` between attempts.  If all attempts
 * fail, the run throws a clear error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GITHUB COMMENT SIZE LIMIT
 * ─────────────────────────────────────────────────────────────────────────────
 * GitHub enforces a ~65 535 character limit on issue comments.  The agent reply
 * is capped at 60 000 characters to leave a comfortable safety margin.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPENDENCIES
 * ─────────────────────────────────────────────────────────────────────────────
 * - Node.js built-in `fs` module  (existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync)
 * - Node.js built-in `path` module (resolve)
 * - GitHub CLI (`gh`)             — must be authenticated via GITHUB_TOKEN
 * - `openclaw` binary             — installed by `bun install` from package.json
 * - System tools: `tee`, `git`, `bash`
 * - Bun runtime                   — for Bun.spawn and top-level await
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync } from "fs";
import { resolve } from "path";

// ─── Paths and event context ───────────────────────────────────────────────────
// `import.meta.dir` resolves to `.github-openclaw-intelligence/lifecycle/`; stepping up one level
// gives us the `.github-openclaw-intelligence/` directory which contains `state/` and `node_modules/`.
const openclawDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(openclawDir, "..");
const stateDir = resolve(openclawDir, "state");
const issuesDir = resolve(stateDir, "issues");
const piSettingsPath = resolve(openclawDir, ".pi", "settings.json");

// OpenClaw natively writes session transcripts to this directory under
// OPENCLAW_STATE_DIR.  It is git-tracked for cross-run persistence and
// auditability — no manual copy choreography is needed.
const sessionsDir = resolve(stateDir, "agents", "main", "sessions");

// Legacy location where session transcripts were archived before native
// session management.  Used only for one-time migration of existing sessions.
const legacySessionsDir = resolve(stateDir, "sessions");

// The sessions directory as a relative path from repo root (for git commit messages).
const sessionsDirRelative = ".github-openclaw-intelligence/state/agents/main/sessions";

// ─── Skills paths ────────────────────────────────────────────────────────────
// User-customisable skills directory.  Skills placed here (as `<name>/SKILL.md`)
// are loaded as workspace-level overrides and take precedence over bundled ones.
const skillsDir = resolve(openclawDir, "skills");

// Skills configuration that controls which bundled skills are allowed and where
// additional skill directories are located.
const skillsConfigPath = resolve(openclawDir, "config", "skills.json");

// Extensions configuration that controls which OpenClaw capabilities are enabled
// (e.g. sub-agents, semantic-memory, browser-cdp, multi-search).
const extensionsConfigPath = resolve(openclawDir, "config", "extensions.json");

// AGENTS.md is the user-facing agent identity file (GitHub convention).  Its
// content is written to SOUL at runtime so the OpenClaw runtime reads it as the
// agent's identity — bridging the GitHub AGENTS.md convention with OpenClaw's
// native SOUL system.
const agentsMdPath = resolve(openclawDir, "AGENTS.md");
const soulPath = resolve(openclawDir, "SOUL");

// Bundled skills shipped inside the openclaw npm package.
const bundledSkillsDir = resolve(openclawDir, "node_modules", "openclaw", "skills");

// GitHub enforces a ~65 535 character limit on issue comments; cap at 60 000
// characters to leave a comfortable safety margin and avoid API rejections.
const MAX_COMMENT_LENGTH = 60000;

// Maximum time (in ms) to wait for the agent process to produce output.
// If the agent does not close stdout within this window, both the agent and
// the `tee` helper are forcefully killed.  5 minutes is generous enough to
// cover large prompts while still surfacing hangs quickly.
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

// After the agent's stdout closes (output fully captured), we give the
// process a short grace period to exit on its own before killing it.
// This prevents the script from hanging when the agent keeps running after
// writing its response.
const AGENT_EXIT_GRACE_MS = 10_000;

// Parse the full GitHub Actions event payload (contains issue/comment details).
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf-8"));

// "issues" for new issues, "issue_comment" for replies on existing issues.
const eventName = process.env.GITHUB_EVENT_NAME!;

// "owner/repo" format — used when calling the GitHub REST API via `gh api`.
const repo = process.env.GITHUB_REPOSITORY!;

// Fall back to "main" if the repository's default branch is not set in the event.
const defaultBranch = event.repository?.default_branch ?? "main";

// The issue number is present on both the `issues` and `issue_comment` payloads.
const issueNumber: number = event.issue.number;

// Read the committed `.pi` defaults and pass them explicitly to the runtime.
// This prevents provider/model drift from host-level config (for example a
// runner image with a global `~/.pi/settings.json` set to github-copilot).
const piSettings = JSON.parse(readFileSync(piSettingsPath, "utf-8"));
const configuredProvider: string = piSettings.defaultProvider;
const configuredModel: string = piSettings.defaultModel;
const configuredThinking: string | undefined = piSettings.defaultThinkingLevel;

if (!configuredProvider || !configuredModel) {
  throw new Error(
    `Invalid .pi settings at ${piSettingsPath}: expected defaultProvider and defaultModel`
  );
}

// Catch whitespace-only or obviously malformed model identifiers early so the
// openclaw agent doesn't start up only to fail with an opaque API error.
if (configuredModel.trim() !== configuredModel || /\s/.test(configuredModel)) {
  throw new Error(
    `Invalid model identifier "${configuredModel}" in ${piSettingsPath}: ` +
    `model IDs must not contain whitespace. ` +
    `Update the "defaultModel" field in .pi/settings.json to a valid model ID for the "${configuredProvider}" provider.`
  );
}

console.log(`Configured provider: ${configuredProvider}, model: ${configuredModel}${configuredThinking ? `, thinking: ${configuredThinking}` : ""}`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Spawn an arbitrary subprocess, capture its stdout, and return both the
 * trimmed output and the process exit code.
 *
 * @param cmd  - Command and arguments array (e.g. ["git", "push", "origin", "main"]).
 * @param opts - Optional options; `stdin` can be piped from another process.
 * @returns    - `{ exitCode, stdout }` after the process has exited.
 */
async function run(cmd: string[], opts?: { stdin?: any }): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "inherit",   // surface errors directly in the Actions log
    stdin: opts?.stdin,
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim() };
}

/**
 * Convenience wrapper: run `gh <args>` and return trimmed stdout.
 * Uses the `run` helper above so that `gh` errors appear in the Actions log.
 * Throws on non-zero exit codes to fail fast on API errors.
 */
async function gh(...args: string[]): Promise<string> {
  const { exitCode, stdout } = await run(["gh", ...args]);
  if (exitCode !== 0) {
    throw new Error(`gh ${args[0]} failed with exit code ${exitCode}`);
  }
  return stdout;
}

/**
 * Load the skills configuration from `config/skills.json`.
 * Returns the parsed JSON object, or an empty default if the file is missing.
 */
function loadSkillsConfig(): { skills: { allowBundled?: string[]; load?: { extraDirs?: string[] } } } {
  if (existsSync(skillsConfigPath)) {
    return JSON.parse(readFileSync(skillsConfigPath, "utf-8"));
  }
  return { skills: {} };
}

/**
 * Load the extensions configuration from `config/extensions.json`.
 * Returns the extensions object (e.g. `{ "sub-agents": true, "browser-cdp": true }`)
 * or an empty object if the file is missing, unreadable, or has no extensions key.
 */
function loadExtensionsConfig(): Record<string, boolean> {
  if (!existsSync(extensionsConfigPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(extensionsConfigPath, "utf-8"));
    return parsed.extensions ?? {};
  } catch (err) {
    console.log(`Could not load extensions config: ${err}`);
    return {};
  }
}

/**
 * Generate a SOUL identity file from AGENTS.md so that the OpenClaw runtime
 * reads it as the agent's personality and standing orders.
 *
 * This bridges the GitHub AGENTS.md convention with OpenClaw's native SOUL
 * system.  The SOUL file is written at runtime and gitignored — AGENTS.md
 * remains the single source of truth for the agent's identity.
 *
 * If AGENTS.md is absent, unreadable, or contains only the default install
 * template text, no SOUL file is generated and the agent runs with OpenClaw
 * defaults.
 */
const DEFAULT_AGENTS_MD = "# Agent Instructions\n\n_No identity yet. Open an issue with the `hatch` label to bootstrap one._";

function generateSoulFromAgentsMd(): void {
  if (!existsSync(agentsMdPath)) return;
  try {
    const content = readFileSync(agentsMdPath, "utf-8").trim();
    // Skip the default install template — it carries no meaningful instructions.
    if (!content || content === DEFAULT_AGENTS_MD) return;
    writeFileSync(soulPath, content);
    console.log("Generated SOUL from AGENTS.md");
  } catch (err) {
    console.log(`Could not generate SOUL from AGENTS.md: ${err}`);
  }
}

/**
 * Symlink allowed bundled skills into the local `skills/` directory so that
 * OpenClaw discovers them on the workspace skill search path.  Existing symlinks
 * are left in place; missing ones are created; stale ones are skipped.
 *
 * This runs once per agent invocation and is idempotent.
 */
function linkBundledSkills(allowBundled: string[]): void {
  if (!existsSync(bundledSkillsDir)) {
    console.log("Bundled skills directory not found — skipping skill linking");
    return;
  }
  mkdirSync(skillsDir, { recursive: true });

  for (const name of allowBundled) {
    const source = resolve(bundledSkillsDir, name);
    const target = resolve(skillsDir, name);
    if (!existsSync(source)) {
      console.log(`Bundled skill "${name}" not found in openclaw package — skipping`);
      continue;
    }
    // Skip if the target already exists (symlink or real directory).
    if (existsSync(target)) continue;
    try {
      symlinkSync(source, target, "dir");
    } catch (err) {
      console.log(`Could not symlink skill "${name}": ${err}`);
    }
  }
}

/**
 * Parse a `/skill-name` invocation prefix from the user's prompt.
 * Returns `{ skillName, remainder }` if a skill invocation was detected,
 * or `null` if the prompt does not start with a `/skill-name` pattern.
 *
 * Examples:
 *   "@ /gh-issues owner/repo --label bug"  → { skillName: "gh-issues", remainder: "owner/repo --label bug" }
 *   "@ /weather London"                    → { skillName: "weather", remainder: "London" }
 *   "@ Tell me about X"                    → null
 */
function parseSkillInvocation(prompt: string): { skillName: string; remainder: string } | null {
  const match = prompt.match(/^\s*\/([a-zA-Z0-9_-]+)\s*(.*)/s);
  if (!match) return null;
  return { skillName: match[1], remainder: match[2].trim() };
}

// ─── Restore reaction state from Authorize step ─────────────────────
// The Authorize step writes the 🚀 reaction metadata to
// `/tmp/reaction-state.json`.  We read it here so the `finally` block can
// add the outcome reaction (👍 or 👎) when the agent finishes.
// If the file is absent (e.g., authorization was skipped), we default to null.
const reactionState = existsSync("/tmp/reaction-state.json")
  ? JSON.parse(readFileSync("/tmp/reaction-state.json", "utf-8"))
  : null;

// Track whether the agent completed successfully so the `finally` block can
// add the correct outcome reaction (👍 on success, 👎 on error).
let succeeded = false;

try {
  // ── Read issue title and body from the event payload ──────────────────────────
  // Use the webhook payload directly to avoid two `gh` API round-trips (~2–4 s).
  // GitHub truncates string fields at 65 536 characters in webhook payloads, so
  // we fall back to the API only when the body hits that limit.
  const title = event.issue.title;
  let body: string = event.issue.body ?? "";
  if (body.length >= 65536) {
    body = await gh("issue", "view", String(issueNumber), "--json", "body", "--jq", ".body");
  }

  // ── Strip the @ prefix (routing signal, not part of the user's question) ────
  let prompt: string;
  if (eventName === "issue_comment") {
    prompt = event.comment.body.replace(/^@\s*/, "");
  } else {
    prompt = `${title.replace(/^@\s*/, "")}\n\n${body}`;
  }

  // ── Parse skill invocation from prompt ──────────────────────────────────────
  // If the prompt starts with `/skill-name`, extract the skill name and rewrite
  // the prompt so OpenClaw invokes the named skill.  For example:
  //   "@ /gh-issues owner/repo --label bug"  → skill "gh-issues", prompt "owner/repo --label bug"
  //   "@ /weather London"                    → skill "weather", prompt "London"
  const skillInvocation = parseSkillInvocation(prompt);
  if (skillInvocation) {
    console.log(`Skill invocation detected: /${skillInvocation.skillName}`);
    prompt = `Use the "${skillInvocation.skillName}" skill to: ${skillInvocation.remainder}`;
  }

  // ── Load skills configuration and link bundled skills ──────────────────────
  const skillsConfig = loadSkillsConfig();
  const allowBundled = skillsConfig.skills?.allowBundled ?? [];
  if (allowBundled.length > 0) {
    linkBundledSkills(allowBundled);
    console.log(`Skills enabled: ${allowBundled.join(", ")}`);
  }

  // ── Load extensions configuration ─────────────────────────────────────────
  // Extensions control which OpenClaw capabilities are active (sub-agents,
  // semantic-memory, browser-cdp, multi-search, etc.).  The config is merged
  // into the runtime JSON so the OpenClaw process receives them.
  const extensions = loadExtensionsConfig();
  const enabledExtensions = Object.entries(extensions).filter(([, v]) => v).map(([k]) => k);
  if (enabledExtensions.length > 0) {
    console.log(`Extensions enabled: ${enabledExtensions.join(", ")}`);
  }

  // ── Generate SOUL from AGENTS.md ──────────────────────────────────────────
  // Bridge the GitHub AGENTS.md convention with OpenClaw's native identity
  // system so that user-defined standing orders are respected by the runtime.
  generateSoulFromAgentsMd();

  // ── Resolve or create session mapping ───────────────────────────────────────
  // Each issue maps to exactly one session via `state/issues/<n>.json`.
  // If a mapping exists AND the referenced session ID is present, we resume
  // the conversation by passing `--session-id <id>` to OpenClaw.  Otherwise we start fresh.
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  let mode = "new";
  let sessionId = "";
  const mappingFile = resolve(issuesDir, `${issueNumber}.json`);

  if (existsSync(mappingFile)) {
    const mapping = JSON.parse(readFileSync(mappingFile, "utf-8"));
    if (mapping.sessionId) {
      // A prior session exists — resume it to preserve conversation context.
      mode = "resume";
      sessionId = mapping.sessionId;
      console.log(`Found existing session: ${sessionId}`);
    } else if (mapping.sessionPath && existsSync(mapping.sessionPath)) {
      // Backward compatibility: extract a session ID from the pi-era file path.
      // e.g. ".github-openclaw-intelligence/state/sessions/1234567890.jsonl" → "1234567890"
      mode = "resume";
      const basename = mapping.sessionPath.split("/").pop() ?? "";
      sessionId = basename.replace(/\.jsonl$/, "") || `issue-${issueNumber}`;
      console.log(`Found existing session (path): ${sessionId}`);
    } else {
      // The mapping points to a session that no longer exists (e.g., cleaned up).
      console.log("Mapped session missing, starting fresh");
    }
  } else {
    console.log("No session mapping found, starting fresh");
  }

  const resolvedSessionId = sessionId || `issue-${issueNumber}`;

  // Backward compatibility: if a session transcript exists at the legacy
  // archive location (state/sessions/) but not in OpenClaw's native
  // directory, migrate it so the runtime can find it by session-id.
  if (mode === "resume" && sessionId) {
    const legacyTranscript = resolve(legacySessionsDir, `${sessionId}.jsonl`);
    const nativeTranscript = resolve(sessionsDir, `${sessionId}.jsonl`);
    if (existsSync(legacyTranscript) && !existsSync(nativeTranscript)) {
      copyFileSync(legacyTranscript, nativeTranscript);
      console.log(`Migrated session transcript from legacy location: ${legacyTranscript}`);
    }
  }

  // ── Configure git identity ───────────────────────────────────────────────────
  // Set the bot identity for all git commits made during this run.
  await run(["git", "config", "user.name", "github-openclaw-intelligence[bot]"]);
  await run(["git", "config", "user.email", "github-openclaw-intelligence[bot]@users.noreply.github.com"]);

  // ── Validate provider API key ────────────────────────────────────────────────
  // This check is inside the try block so that the finally clause always runs
  // (adding the outcome reaction) and a helpful comment can be posted to the issue.
  const providerKeyMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    xai: "XAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    mistral: "MISTRAL_API_KEY",
    groq: "GROQ_API_KEY",
  };
  const requiredKeyName = providerKeyMap[configuredProvider];
  if (requiredKeyName && !process.env[requiredKeyName]) {
    await gh(
      "issue", "comment", String(issueNumber),
      "--body",
      `## ⚠️ Missing API Key: \`${requiredKeyName}\`\n\n` +
      `The configured provider is \`${configuredProvider}\`, but the \`${requiredKeyName}\` secret is not available to this workflow run.\n\n` +
      `### How to fix\n\n` +
      `**Option A — Repository secret** _(simplest)_\n` +
      `1. Go to **Settings → Secrets and variables → Actions → New repository secret**\n` +
      `2. Name: \`${requiredKeyName}\`, Value: your API key\n\n` +
      `**Option B — Organization secret** _(already have one?)_\n` +
      `Organization secrets are only available to workflows if the secret has been explicitly granted to this repository:\n` +
      `1. Go to your **Organization Settings → Secrets and variables → Actions**\n` +
      `2. Click the \`${requiredKeyName}\` secret → **Repository access**\n` +
      `3. Add **this repository** to the selected repositories list\n\n` +
      `Once the secret is accessible, re-trigger this workflow by posting a new comment on this issue.`
    );
    throw new Error(
      `${requiredKeyName} is not available to this workflow run. ` +
      `If you have set it as a repository secret, verify the secret name matches exactly. ` +
      `If you have set it as an organization secret, ensure this repository has been granted access ` +
      `(Organization Settings → Secrets and variables → Actions → ${requiredKeyName} → Repository access).`
    );
  }

  // ── Run the OpenClaw agent ───────────────────────────────────────────────────
  // Use `openclaw agent --local` for embedded execution without a Gateway.
  // The --json flag provides structured output for response extraction.
  // The --model and --provider flags are passed explicitly from the committed
  // `.pi/settings.json` to prevent provider/model drift from any host-level
  // OpenClaw configuration that may be present on the runner image.
  // Pipe agent output through `tee` so we get:
  //   • a live stream to stdout (visible in the Actions log in real time), and
  //   • a persisted copy at `/tmp/agent-raw.json` for post-processing below.
  const openclawBin = resolve(openclawDir, "node_modules", ".bin", "openclaw");
  const openclawArgs = [
    openclawBin,
    "agent",
    "--local",
    "--json",
    "--model",
    configuredModel,
    "--provider",
    configuredProvider,
    "--message",
    prompt,
    "--thinking",
    configuredThinking ?? "high",
    "--session-id",
    resolvedSessionId,
  ];

  // ── Runtime isolation: source stays raw, runtime goes in .github-openclaw-intelligence ──
  // Write a temporary config that points the agent's workspace at the repo root
  // so it can read the raw source code.  All mutable state (sessions, memory,
  // sqlite, caches) is kept inside .github-openclaw-intelligence/state/ via OPENCLAW_STATE_DIR.
  // The skills section enables bundled skills listed in config/skills.json and
  // adds the local skills/ directory as an extra search path.
  // The extensions section forwards config/extensions.json so the OpenClaw runtime
  // activates the full set of capabilities (sub-agents, semantic-memory, browser-cdp, etc.).
  const extraDirs = [
    skillsDir,
    ...(skillsConfig.skills?.load?.extraDirs ?? []),
  ].filter(Boolean);

  const runtimeConfig: Record<string, unknown> = {
    agents: {
      defaults: {
        workspace: repoRoot,
        timeoutSeconds: 600,
      },
    },
    skills: {
      allowBundled: allowBundled,
      load: {
        extraDirs,
      },
    },
    extensions,
  };
  const runtimeConfigPath = "/tmp/openclaw-runtime.json";
  writeFileSync(runtimeConfigPath, JSON.stringify(runtimeConfig, null, 2));

  const agentEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: runtimeConfigPath,
    // OPENCLAW_OAUTH_DIR is the env var name that the OpenClaw runtime reads
    // for its credential storage path (despite the "oauth" naming, it covers
    // all credential types).  The directory is named "credentials" for clarity.
    OPENCLAW_OAUTH_DIR: resolve(stateDir, "credentials"),
    OPENCLAW_HOME: openclawDir,
    // Point OpenClaw at the bundled skills directory shipped in the npm package
    // so the runtime can discover them without relying on path-walking heuristics.
    OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir,
  };

  const agent = Bun.spawn(openclawArgs, {
    stdout: "pipe",
    stderr: "inherit",
    env: agentEnv,
    cwd: repoRoot,
  });
  const tee = Bun.spawn(["tee", "/tmp/agent-raw.json"], { stdin: agent.stdout, stdout: "inherit" });

  // ── Timeout-aware wait for output capture ──────────────────────────────────
  // `tee` exits when the agent's stdout closes (EOF).  If the agent never
  // closes stdout the race timeout fires, and we kill both processes.
  let agentTimedOut = false;
  let agentTimerId: ReturnType<typeof setTimeout> | undefined;

  const teeResult = await Promise.race([
    tee.exited.then(() => "done" as const),
    new Promise<"timeout">((resolve) => {
      agentTimerId = setTimeout(() => resolve("timeout"), AGENT_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(agentTimerId);

  if (teeResult === "timeout") {
    agentTimedOut = true;
    console.error(`Agent timed out after ${AGENT_TIMEOUT_MS / 1000}s — killing processes`);
    agent.kill();
    tee.kill();
    await Promise.allSettled([agent.exited, tee.exited]);
  }

  // ── Grace period: wait for the agent process to exit ───────────────────────
  // After `tee` exits the output has been fully captured to disk.  Give the
  // agent a short window to exit on its own; if it doesn't, kill it so the
  // script can continue with posting the reply and pushing state.
  if (!agentTimedOut) {
    let graceTimerId: ReturnType<typeof setTimeout> | undefined;
    const graceResult = await Promise.race([
      agent.exited.then(() => "exited" as const),
      new Promise<"timeout">((resolve) => {
        graceTimerId = setTimeout(() => resolve("timeout"), AGENT_EXIT_GRACE_MS);
      }),
    ]);
    clearTimeout(graceTimerId);

    if (graceResult === "timeout") {
      console.log("Agent process did not exit after output was captured — killing it");
      agent.kill();
      await agent.exited;
    }
  }

  // Check the exit code.  SIGTERM (143 = 128 + 15) is expected when we
  // killed the process ourselves after the grace period — treat it as success.
  const agentExitCode = await agent.exited;
  if (agentExitCode !== 0 && agentExitCode !== 143) {
    // Surface the provider/model in the error so that an invalid or
    // misspelled model ID doesn't fail silently — the most common cause of
    // unexpected non-zero exits from the openclaw agent is an unrecognised model.
    throw new Error(
      `openclaw agent exited with code ${agentExitCode} (provider: ${configuredProvider}, model: ${configuredModel}). ` +
      `This may indicate an invalid or misspelled model ID in .pi/settings.json. ` +
      `Check the workflow logs above for details.`
    );
  }

  // ── Extract final assistant text ─────────────────────────────────────────────
  // The `openclaw agent --json` command outputs a JSON envelope with a `payloads`
  // array containing the response text.  Extract the text from the payloads.
  // Falls back to reading the raw output as plain text if JSON parsing fails.
  let agentText = "";
  try {
    const rawOutput = readFileSync("/tmp/agent-raw.json", "utf-8").trim();
    if (rawOutput) {
      const output = JSON.parse(rawOutput);
      if (output.payloads && Array.isArray(output.payloads)) {
        agentText = output.payloads
          .map((p: { text?: string }) => p.text || "")
          .filter((t: string) => t.length > 0)
          .join("\n\n");
      } else if (typeof output.text === "string") {
        agentText = output.text;
      } else if (typeof output === "string") {
        agentText = output;
      }
    }
  } catch {
    // If JSON parsing fails, try reading the raw output as plain text.
    const rawOutput = readFileSync("/tmp/agent-raw.json", "utf-8").trim();
    agentText = rawOutput;
  }

  // ── Resolve session path for the issue mapping ──────────────────────────────
  // OpenClaw writes session transcripts directly to the git-tracked sessions
  // directory (state/agents/main/sessions/).  Just check if a transcript exists.
  const transcript = resolve(sessionsDir, `${resolvedSessionId}.jsonl`);
  const sessionPath = existsSync(transcript)
    ? `${sessionsDirRelative}/${resolvedSessionId}.jsonl`
    : "";

  // ── Persist issue → session mapping ─────────────────────────────────────────
  // Write (or overwrite) the mapping file so that the next run for this issue
  // can locate the correct session and resume the conversation.
  writeFileSync(
    mappingFile,
    JSON.stringify({
      issueNumber,
      sessionId: resolvedSessionId,
      sessionPath,
      updatedAt: new Date().toISOString(),
    }, null, 2) + "\n"
  );
  console.log(`Saved mapping: issue #${issueNumber} -> ${resolvedSessionId}`);

  // ── Post reply as issue comment ──────────────────────────────────────────────
  // Post the comment immediately so the user sees the response as soon as
  // possible, before the potentially slow git push operation.
  // Guard against empty/null responses — post an error message instead of silence.
  const trimmedText = agentText.trim();
  const commentBody = trimmedText.length > 0
    ? trimmedText.slice(0, MAX_COMMENT_LENGTH)
    : `✅ The agent ran successfully but did not produce a text response. Check the repository for any file changes that were made.\n\nFor full details, see the [workflow run logs](https://github.com/${repo}/actions).`;
  await gh("issue", "comment", String(issueNumber), "--body", commentBody);

  // ── Commit and push state changes ───────────────────────────────────────────
  // Stage all changes (session log, mapping JSON, any files the agent edited),
  // commit only if the index is dirty, then push with a retry-on-conflict loop.
  const addResult = await run(["git", "add", "-A"]);
  if (addResult.exitCode !== 0) {
    console.error("git add failed with exit code", addResult.exitCode);
  }
  const { exitCode } = await run(["git", "diff", "--cached", "--quiet"]);
  if (exitCode !== 0) {
    // exitCode !== 0 means there are staged changes to commit.
    const commitResult = await run(["git", "commit", "-m", `openclaw-intelligence: work on issue #${issueNumber}`]);
    if (commitResult.exitCode !== 0) {
      console.error("git commit failed with exit code", commitResult.exitCode);
    }
  }

  // Retry push up to 10 times with increasing backoff delays, rebasing on
  // each conflict with `-X theirs` to auto-resolve in favour of the remote.
  const pushBackoffs = [1000, 2000, 3000, 5000, 7000, 8000, 10000, 12000, 12000, 15000];
  let pushSucceeded = false;
  for (let i = 1; i <= 10; i++) {
    const push = await run(["git", "push", "origin", `HEAD:${defaultBranch}`]);
    if (push.exitCode === 0) { pushSucceeded = true; break; }
    if (i < 10) {
      console.log(`Push failed, rebasing and retrying (${i}/10)...`);
      await run(["git", "pull", "--rebase", "-X", "theirs", "origin", defaultBranch]);
      await new Promise(r => setTimeout(r, pushBackoffs[i - 1]));
    }
  }
  if (!pushSucceeded) {
    // Post a warning comment so the user knows state was not persisted, then throw.
    try {
      await gh("issue", "comment", String(issueNumber), "--body",
        `⚠️ **Warning:** The agent's session state could not be pushed to the repository. Conversation context may not be preserved for follow-up comments. See the [workflow run logs](https://github.com/${repo}/actions) for details.`);
    } catch (e) {
      console.error(`Failed to post push-failure warning comment on issue #${issueNumber}:`, e);
    }
    throw new Error(
      "All 10 push attempts failed. Auto-reconciliation could not be completed. " +
      "Session state was not persisted to remote. Check the workflow logs for details."
    );
  }

  // Mark the run as successful so the `finally` block adds 👍 instead of 👎.
  succeeded = true;

} finally {
  // ── Guaranteed outcome reaction: 👍 on success, 👎 on error ─────────────────
  // This block always executes — even when the try block throws.  The 🚀 rocket
  // from the Authorize step is intentionally left in place; we only
  // ADD the outcome reaction here.
  if (reactionState) {
    try {
      const { reactionTarget, commentId: stateCommentId } = reactionState;
      const outcomeContent = succeeded ? "+1" : "-1";
      if (reactionTarget === "comment" && stateCommentId) {
        // Add outcome reaction to the triggering comment.
        await gh("api", `repos/${repo}/issues/comments/${stateCommentId}/reactions`, "-f", `content=${outcomeContent}`);
      } else {
        // Add outcome reaction to the issue itself.
        await gh("api", `repos/${repo}/issues/${issueNumber}/reactions`, "-f", `content=${outcomeContent}`);
      }
    } catch (e) {
      // Log but do not re-throw — a failed reaction should not mask the original error.
      console.error("Failed to add outcome reaction:", e);
    }
  }
}
