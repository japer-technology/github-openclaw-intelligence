# Analysis: OpenClaw Feature Utilization

GitHub OpenClaw Intelligence depends on a single package — [`openclaw`](https://github.com/openclaw/openclaw). This document audits which OpenClaw features the system currently uses, which remain untapped, and which additions deliver the highest value for a "GitHub as Infrastructure" deployment where the agent runs non-interactively in `--json` mode inside GitHub Actions.

---

## 1. OpenClaw Package Landscape

OpenClaw is a multi-channel AI gateway with extensible messaging integrations. It wraps `@mariozechner/pi-coding-agent` as its core agent runtime and adds:

| Layer | Description | Used by OCI |
|---|---|---|
| `openclaw agent --local` | Embedded agent execution (no gateway server) | **Yes** |
| `@mariozechner/pi-coding-agent` | Coding agent CLI with tool calling and session management | Yes (transitive) |
| `@mariozechner/pi-ai` | Unified multi-provider LLM API | No (transitive only) |
| `@mariozechner/pi-agent-core` | Agent runtime with tool calling and state management | No (transitive only) |
| `@mariozechner/pi-tui` | Terminal UI library with differential rendering | No (transitive only) |
| Gateway server (express) | HTTP API for multi-channel integrations | No |
| Browser automation (playwright-core) | Headless browser for CDP-based interaction | Configured (via extensions) |

OCI installs `openclaw` and uses it exclusively via the `openclaw agent --local --json` CLI command. The gateway server and direct SDK access are not used.

---

## 2. Features Currently Used

### 2.1 CLI Invocation (`--json` mode)

The agent spawns the `openclaw` binary as a subprocess:

```
openclaw agent --local --json --message <prompt> --thinking <T> --session-id <S>
```

JSON mode emits structured output on stdout. The agent pipes output through `tee` for live logging and post-processes with `tac` + `jq` to extract the final assistant reply.

**Key flags:**

| Flag | Purpose |
|------|---------|
| `--local` | Embedded execution without a Gateway server |
| `--json` | Structured JSON output for response extraction |
| `--message <prompt>` | User's prompt text |
| `--thinking <level>` | Thinking level (none, low, medium, high) |
| `--session-id <id>` | Session continuation for multi-turn conversations |

### 2.2 Runtime Configuration (`OPENCLAW_CONFIG_PATH`)

Model and provider are set via the runtime config file rather than CLI flags:

```json
{
  "agents": {
    "defaults": {
      "workspace": "/path/to/repo",
      "timeoutSeconds": 600,
      "model": "openai/gpt-5.4"
    }
  },
  "skills": {
    "allowBundled": ["gh-issues", "github", ...],
    "load": { "extraDirs": ["/path/to/skills"] }
  }
}
```

The runtime config uses Zod validation with `.strict()`, rejecting unknown top-level keys.

### 2.3 Session Management

OpenClaw's native session system (`OPENCLAW_STATE_DIR`, `--session-id`) provides multi-turn conversation continuity across workflow runs. Session transcripts are stored as `.jsonl` files under `state/agents/main/sessions/` and mapped per-issue via `state/issues/<N>.json`.

### 2.4 Settings (`.pi/settings.json`)

Six setting groups are configured:

| Setting | Value |
|---|---|
| `defaultProvider` | `openai` |
| `defaultModel` | `gpt-5.4` |
| `defaultThinkingLevel` | `high` |
| `compaction.enabled` | `true` (with `reserveTokens: 16384`, `keepRecentTokens: 32000`) |
| `retry.enabled` | `true` (with `maxRetries: 3`, `baseDelayMs: 2000`, `maxDelayMs: 60000`) |

Additional settings for trust policy and resource limits are also configured but are consumed by the orchestrator (`agent.ts`), not by the OpenClaw runtime directly.

The `compaction` settings prevent context window exhaustion during long multi-turn conversations. `keepRecentTokens` is set to `32000` (higher than the pi-coding-agent default of `20000`) because GitHub Actions tool outputs — file diffs, build logs, `gh` CLI results — are typically larger than interactive coding session outputs.

The `retry` settings enable automatic retry with exponential backoff for transient LLM API errors. This is particularly important in CI environments where concurrent workflow runs can cause rate-limit spikes.

### 2.5 Context Files (`AGENTS.md` → `SOUL`)

The `AGENTS.md` file defines the agent's personality and standing orders. At runtime, its content is written to a gitignored `SOUL` file via `generateSoulFromAgentsMd()`, bridging the GitHub `AGENTS.md` convention with OpenClaw's native `SOUL` identity system.

### 2.6 Skills (10 bundled, 0 custom)

Ten bundled skills are enabled via `config/skills.json`:

| Skill | Purpose |
|---|---|
| `gh-issues` | Fetch GitHub issues, spawn sub-agents for fixes |
| `github` | GitHub operations via `gh` CLI |
| `weather` | Current weather and forecasts |
| `summarize` | Text, file, and URL summarization |
| `coding-agent` | Dedicated code review and editing |
| `healthcheck` | System health and diagnostics |
| `oracle` | Knowledge base queries |
| `session-logs` | View and manage session transcripts |
| `nano-pdf` | PDF extraction and analysis |
| `xurl` | URL fetching and web content extraction |

### 2.7 Extensions (informational, not runtime)

Seven extensions are declared in `config/extensions.json`:

| Extension | Status |
|---|---|
| `sub-agents` | ✅ Enabled |
| `semantic-memory` | ✅ Enabled |
| `media-understanding` | ✅ Enabled |
| `diff-analysis` | ✅ Enabled |
| `multi-model-failover` | ✅ Enabled |
| `browser-cdp` | ✅ Enabled |
| `multi-search` | ✅ Enabled |

**Important**: These are logged for visibility at startup but are **not** forwarded to the OpenClaw runtime config. The OpenClaw Zod schema uses `.strict()` and rejects the `extensions` key. Extensions activate through OpenClaw's own internal configuration mechanisms.

### 2.8 Environment Isolation

The agent uses four environment variables for runtime isolation:

| Variable | Points To | Purpose |
|---|---|---|
| `OPENCLAW_STATE_DIR` | `.github-openclaw-intelligence/state/` | Persistent session storage |
| `OPENCLAW_CONFIG_PATH` | `/tmp/openclaw-runtime.json` | Runtime config (skills, model) |
| `OPENCLAW_OAUTH_DIR` | `.github-openclaw-intelligence/state/credentials/` | Credential storage |
| `OPENCLAW_HOME` | `.github-openclaw-intelligence/` | Agent home directory |

---

## 3. Features Not Used

### 3.1 ~~Compaction Settings~~ ✅ Now Configured

Compaction settings are now configured in `.pi/settings.json` with `compaction.enabled: true`, `reserveTokens: 16384`, and `keepRecentTokens: 32000`. The `keepRecentTokens` value is higher than the pi-coding-agent default (`20000`) to accommodate the larger tool outputs typical in GitHub Actions workflows (file diffs, build logs, `gh` CLI results).

### 3.2 ~~Retry Settings~~ ✅ Now Configured

Retry settings are now configured in `.pi/settings.json` with `retry.enabled: true`, `maxRetries: 3`, `baseDelayMs: 2000`, and `maxDelayMs: 60000`. This provides automatic retry with exponential backoff for transient LLM API errors, reducing hard failures from rate-limit spikes in CI environments.

### 3.3 Custom Extensions (`.pi/extensions/`)

The pi-coding-agent supports TypeScript extensions that register custom tools callable by the LLM. Extensions work in all modes including JSON mode.

**Impact of omission:** The agent relies solely on built-in tools and bundled skills. GitHub-specific context operations (fetching repository metadata, querying Actions status) require the agent to construct `gh` CLI invocations from scratch each time.

**Comparison with GMI:** GitHub Minimum Intelligence has a `github-context.ts` extension at `.pi/extensions/` that registers a `github_repo_context` tool, reducing prompt complexity and improving response reliability. OCI currently has no custom extensions.

**Recommendation:** Add a project-local extension providing GitHub-aware tools. Note: as of pi-coding-agent v0.59.0, custom tools require a `promptSnippet` field to appear in the system prompt.

### 3.4 System Prompt Extension (`APPEND_SYSTEM.md`)

The underlying runtime supports a project-level `APPEND_SYSTEM.md` that appends behavioral guidelines to the default system prompt.

**Impact of omission:** The agent relies solely on `AGENTS.md` (bridged to `SOUL`) for identity. Additional behavioral guidelines must be included in the `AGENTS.md` itself rather than layered via the separate append mechanism.

**Recommendation:** Evaluate whether separating core identity (`AGENTS.md`) from behavioral guidelines (`APPEND_SYSTEM.md`) improves maintainability.

### 3.5 Bootstrap Protocol (`BOOTSTRAP.md`)

The pi-coding-agent supports a first-run identity setup via `BOOTSTRAP.md`, which guides the agent through self-discovery when triggered by a specific label.

**Impact of omission:** First-run identity is established solely through `AGENTS.md`. There is no guided self-discovery process.

**Recommendation:** Low priority. The `AGENTS.md` approach is simpler and sufficient for most use cases.

### 3.6 Prompt Templates (`.pi/prompts/`)

The runtime loads reusable prompt templates from `.pi/prompts/`. In non-interactive mode, these can be referenced by skills or included in the system context.

**Impact of omission:** Common patterns (code review, issue triage, release notes) are re-described in each user prompt rather than standardised.

**Recommendation:** Add prompt templates for recurring GitHub workflows (code review, issue triage). Skills and the system prompt can reference these for consistency.

### 3.7 `sessionDir` Setting

As of pi-coding-agent v0.63.0, session storage can be configured in `settings.json` instead of via CLI flags or environment variables.

**Impact of omission:** OCI currently uses `OPENCLAW_STATE_DIR` for session storage configuration.

**Recommendation:** Evaluate whether migrating to the `sessionDir` setting simplifies the configuration. The environment variable approach works and is well-tested; migration should be deferred until path resolution semantics are verified.

### 3.8 Gateway Server

OpenClaw includes an Express-based gateway server for multi-channel integrations (Slack, Discord, webhooks).

**Impact of omission:** None for the GitHub Actions use case. OCI uses `--local` for embedded execution.

**Recommendation:** Not applicable. The gateway is designed for always-on server deployments, not ephemeral CI runs.

### 3.9 SDK / Programmatic API

OpenClaw and the underlying pi-coding-agent export TypeScript SDKs for programmatic usage.

**Impact of omission:** The agent spawns `openclaw` as a subprocess and parses JSON output with shell tools. This works but adds process overhead.

**Recommendation:** The SDK would eliminate the subprocess boundary and simplify output extraction. However, it requires restructuring `agent.ts` from shell-pipe orchestration to async/await TypeScript. Defer until the subprocess approach shows limitations.

### 3.10 `defineTool()` Helper (pi-coding-agent v0.65.0+)

A `defineTool()` helper creates standalone custom tool definitions with full TypeScript parameter type inference.

**Impact of omission:** If custom extensions are added in the future, they would use the older `registerTool()` API pattern.

**Recommendation:** Use `defineTool()` when implementing custom extensions for better type safety.

### 3.11 `ctx.signal` for Cancellation (pi-coding-agent v0.63.2+)

Extension handlers can use `ctx.signal` to forward cancellation into nested model calls, `fetch()`, and other abort-aware work.

**Impact of omission:** No custom extensions currently exist, so this is not applicable.

**Recommendation:** Adopt when implementing custom extensions.

---

## 4. Priority Matrix

| Feature | Effort | Impact | Priority |
|---|---|---|---|
| ~~Compaction settings~~ | ~~Low~~ | ~~High~~ | ~~**P0**~~ ✅ Done |
| ~~Retry settings~~ | ~~Low~~ | ~~High~~ | ~~**P0**~~ ✅ Done |
| Custom extensions (GitHub tools) | Medium | High | **P1** — reduces prompt complexity |
| Prompt templates | Low | Medium | **P1** — standardises common workflows |
| System prompt extension | Low | Medium | **P2** — separates identity from behavior |
| `sessionDir` migration | Low | Low | **P3** — configuration simplification |
| SDK migration | High | Medium | **P3** — simplifies architecture |
| Bootstrap protocol | Low | Low | **P4** — guided first-run setup |
| Gateway server | N/A | None | **Skip** — not applicable |

---

## 5. Comparison with GitHub Minimum Intelligence

GMI (the sibling project) uses the same underlying pi-coding-agent runtime but accesses it directly rather than through the OpenClaw wrapper. Key differences in feature utilization:

| Feature | GMI | OCI | Gap |
|---|---|---|---|
| CLI invocation | `pi --mode json -p <prompt>` | `openclaw agent --local --json --message <prompt>` | Different CLI, same underlying runtime |
| Model/provider config | CLI flags (`--provider`, `--model`) | Runtime config (`agents.defaults.model`) | OCI uses config file; GMI uses flags |
| Custom extensions | ✅ `github-context.ts` with `promptSnippet` | ❌ None | OCI should add equivalent |
| System prompt extension | ✅ `APPEND_SYSTEM.md` | ❌ Not used | OCI should evaluate |
| Bootstrap protocol | ✅ `BOOTSTRAP.md` | ❌ Not used | Low priority |
| Custom skills | ✅ `memory`, `skill-creator` | ❌ None (10 bundled only) | OCI should evaluate custom skills |
| Prompt templates | ✅ `code-review`, `issue-triage` | ❌ None | OCI should add |
| Compaction settings | Configured | ✅ Configured | Gap closed |
| Retry settings | Configured | ✅ Configured | Gap closed |
| Documentation analysis | Rich `docs/analysis/` | ✅ Comprehensive | Aligned with GMI |

---

## 6. Recommended Implementation Order

### Phase 1: Configuration (zero-code changes) ✅ Complete

1. ~~Add compaction settings to `.pi/settings.json`~~ ✅
2. ~~Add retry settings to `.pi/settings.json`~~ ✅

### Phase 2: Content (low-effort, high-value)

3. Add prompt templates to `.pi/prompts/` (code-review, issue-triage)
4. Add `APPEND_SYSTEM.md` for behavioral guidelines

### Phase 3: Extensions (medium-effort, high-value)

5. Create `.pi/extensions/github-context.ts` with `promptSnippet`
6. Evaluate custom skills (memory, skill-creator)

### Phase 4: Architecture (high-effort, deferred)

7. Evaluate SDK migration
8. Evaluate `sessionDir` migration

---

## 7. Summary

OCI currently uses 10 of OpenClaw's feature categories (CLI invocation, runtime configuration, session management, settings including compaction and retry, context files/SOUL bridge, bundled skills, extension declarations, and environment isolation). The highest-impact remaining additions are prompt templates and a GitHub context extension.

The P0 configuration gaps (compaction and retry settings) have been closed. Compaction is configured with `keepRecentTokens: 32000` (higher than the default `20000`) to accommodate the larger tool outputs typical in GitHub Actions workflows. Retry is configured with `maxRetries: 3` and exponential backoff to handle transient LLM API errors in CI environments.

The "GitHub as Infrastructure" principle is well served by OpenClaw's project-local configuration model: all settings, skills, and context files live inside the committed repository. The OpenClaw wrapper adds the gateway and multi-channel capabilities on top of pi-coding-agent, but OCI correctly uses only the embedded `--local` mode, keeping the deployment simple and consistent with the zero-infrastructure philosophy.
