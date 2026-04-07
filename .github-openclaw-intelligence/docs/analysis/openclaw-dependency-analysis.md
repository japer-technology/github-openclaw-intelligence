# OpenClaw Dependency Analysis: Upstream pi-mono Improvements

## 1. Overview

This document analyzes the impact of upstream `@mariozechner/pi-coding-agent` improvements (v0.57.1 → v0.65.2) on GitHub OpenClaw Intelligence. OCI depends on the `openclaw` package (`^2026.3.12`), which wraps pi-coding-agent as its core agent runtime. Improvements to the underlying runtime flow through to OCI automatically when OpenClaw updates its transitive dependency.

This analysis is derived from [github-minimum-intelligence's pi-mono upgrade analysis](https://github.com/japer-technology/github-minimum-intelligence/blob/main/.github-minimum-intelligence/docs/analysis/pi-mono-upgrade-57.1-to-65.1.md), which covers 17 releases (v0.58.0 through v0.65.1) including 5 releases with breaking changes, extended to include v0.65.2.

| Item | Detail |
|------|--------|
| **OCI dependency** | `openclaw` `^2026.3.12` (in `package.json`) |
| **Underlying runtime** | `@mariozechner/pi-coding-agent` (transitive via openclaw) |
| **Releases analyzed** | pi-mono v0.58.0 – v0.65.2 (18 releases) |
| **Breaking change releases** | v0.59.0, v0.62.0, v0.63.0, v0.64.0, v0.65.0 |
| **Source** | [github.com/badlogic/pi-mono/releases](https://github.com/badlogic/pi-mono/releases) |

---

## 2. How Upstream Changes Reach OCI

```
pi-mono (source)
  └─ @mariozechner/pi-coding-agent (npm)
       └─ openclaw (npm, wraps pi-coding-agent)
            └─ OCI (this repo, depends on openclaw ^2026.3.12)
```

When OpenClaw updates its transitive dependency on pi-coding-agent, OCI receives the improvements via `bun install`. The OpenClaw CLI (`openclaw agent --local`) delegates to the embedded pi-coding-agent runtime for:
- LLM provider interaction
- Tool execution (read, write, edit, bash, grep, find, ls)
- Session management
- Context compaction
- Extension and skill loading

---

## 3. Bug Fixes Most Relevant to OCI

These fixes from the pi-mono v0.57.1 → v0.65.2 range directly address issues that OCI is susceptible to in its `--json` / GitHub Actions usage:

| Fix | pi-mono Version | Impact on OCI |
|-----|----------------|---------------|
| **Bash output truncation** — full output preserved to temp file | v0.65.1 | Prevents silent data loss in commands with >2000 lines of output |
| **Concurrent edit/write serialization** — same-file mutations run serially | v0.61.0 | Prevents interleaved writes from overwriting each other |
| **File mutation queue ordering** — operations stay in request order | v0.63.0 | Ensures deterministic file modification behavior |
| **Repeated compaction fix** — messages no longer dropped | v0.63.1 | Critical for long multi-turn issue conversations |
| **JSON/print mode stdout isolation** — startup chatter removed from output | v0.62.0 | Cleaner JSON parsing in agent.ts |
| **Session shutdown in JSON/print mode** — `session_shutdown` emitted on exit | v0.63.0 | Non-interactive runs terminate cleanly |
| **Piped stdin JSON preservation** — `--json` output stays structured | v0.65.1 | Ensures `tac`/`jq` pipeline works correctly |
| **Provider retry improvements** — error messages treated as retryable | v0.59.0 | Reduces hard failures in CI environment |
| **Retry settlement** — waits for full retry cycle | v0.65.0 | Prevents stale state after transient errors |
| **Resource collision precedence** — project resources override packages | v0.65.1 | OCI's skills/ take priority over bundled |
| **Skill discovery recursion fix** — stops at `SKILL.md` | v0.63.1 | Correct discovery of custom skills |
| **Steering messages wait for tool completion** | v0.58.4 | Prevents premature tool-call termination |
| **Bedrock throttling → compaction misidentification** | v0.65.0 | Prevents unnecessary compaction on rate-limit errors |
| **Added missing `ajv` dependency** | v0.63.0 | Fixes standalone installs without transitive resolution |
| **Lazy provider loading** — faster startup | v0.59.0 | Reduces GitHub Actions wall time |
| **TUI render throttling** — throttle scheduling under streaming load | v0.65.2 | TUI-only fix; no impact on OCI's `--json` mode |

---

## 4. New Features Beneficial to OCI

### 4.1 Parallel Tool Execution (v0.58.0)

Extension tool calls now execute in parallel by default. When the agent calls multiple tools in a single turn (e.g., `read` + `bash` + `grep`), they run concurrently rather than sequentially. This directly reduces agent run time and GitHub Actions billing.

### 4.2 Lazy Provider Loading (v0.59.0)

Provider SDKs are loaded on first use, not at import time. Since OCI typically uses only one provider per run (e.g., `openai`), unused provider SDKs are never loaded. This reduces startup time.

### 4.3 `sessionDir` Setting (v0.63.0)

Session storage can now be configured in `settings.json` instead of via environment variables. OCI currently uses `OPENCLAW_STATE_DIR`; this could be simplified but requires evaluating path resolution semantics.

### 4.4 Multi-Edit Tool (v0.63.0)

The `edit` tool now supports updating multiple disjoint regions in a single call. This reduces tool-call count and improves agent efficiency for multi-point file edits.

### 4.5 `edits[]` as Sole Edit Schema (v0.63.2)

The edit tool now uses `edits[]` as the only replacement shape, eliminating the mixed single/multi-edit schema that caused repeated invalid tool calls and retries.

### 4.6 `defineTool()` Helper (v0.65.0)

A `defineTool()` helper creates standalone custom tool definitions with full TypeScript parameter type inference. If OCI adds custom extensions, this API provides better type safety than the older `registerTool()` pattern.

### 4.7 `ctx.signal` for Extension Cancellation (v0.63.2)

Extension handlers can use `ctx.signal` to forward cancellation into nested model calls, `fetch()`, and other abort-aware work.

### 4.8 Unified Diagnostics (v0.65.0)

Arg parsing, service creation, and resource loading now return structured diagnostics (`info`/`warning`/`error`) instead of logging or exiting. This improves error reporting in non-interactive mode.

### 4.9 1M Token Context Window (v0.58.0)

Claude Opus 4.6, Sonnet 4.6, and related Bedrock models now use a 1M token context window. If OCI users configure Claude as their provider, they benefit from 5× more context capacity.

---

## 5. Breaking Changes Impact Assessment for OCI

### 5.1 `promptSnippet` Required for Custom Tools (v0.59.0)

**What changed**: Extension tools without `promptSnippet` are no longer included in the `Available tools` system prompt section.

**Impact on OCI**: OCI currently has **no custom extensions** in `.pi/extensions/`. **No immediate code changes required**. However, if custom extensions are added in the future (recommended in the [feature utilization analysis](openclaw-feature-utilization.md)), they must include `promptSnippet`.

### 5.2 `sourceInfo` Replaces Legacy Fields (v0.62.0)

**What changed**: Skill, prompt template, command, and tool provenance fields replaced with unified `sourceInfo`.

**Impact on OCI**: OCI does not programmatically access skill/tool provenance fields. **No changes required**.

### 5.3 `getApiKey` → `getApiKeyAndHeaders` (v0.63.0)

**What changed**: SDK method replaced.

**Impact on OCI**: CLI-only usage via `openclaw agent --local`. **No changes required**.

### 5.4 `ModelRegistry` Constructor Removed (v0.64.0)

**What changed**: SDK-only change.

**Impact on OCI**: CLI-only usage. **No changes required**.

### 5.5 Session Events Removed (v0.65.0)

**What changed**: `session_switch`, `session_fork`, and `session_directory` events removed.

**Impact on OCI**: No custom extensions. **No changes required**.

### 5.6 Unknown Single-Dash Flags Error (v0.65.0)

**What changed**: Unknown single-dash CLI flags now produce errors instead of being silently ignored.

**Impact on OCI**: The agent invokes openclaw with these flags:

| Flag | Status |
|------|--------|
| `--local` | ✅ Valid |
| `--json` | ✅ Valid |
| `--message <prompt>` | ✅ Valid |
| `--thinking <level>` | ✅ Valid |
| `--session-id <id>` | ✅ Valid |

All flags use double-dash format. **No changes required**.

### 5.7 Package Auto-Update Removed (v0.60.0)

**What changed**: Startup no longer auto-updates unpinned packages.

**Impact on OCI**: OCI uses `bun install` in the workflow with a semver range (`^2026.3.12`). **No changes required**.

### 5.8 Keybinding Namespacing (v0.61.0)

**What changed**: Interactive keybinding IDs are now namespaced.

**Impact on OCI**: OCI runs in non-interactive `--json` mode. **No changes required**.

### 5.9 Deprecated MiniMax Model IDs Removed (v0.63.0)

**What changed**: Direct `minimax` and `minimax-cn` model IDs removed.

**Impact on OCI**: OCI defaults to `openai` / `gpt-5.4`. **No changes required**.

---

## 6. OCI-Specific Considerations

### 6.1 OpenClaw Wrapper Layer

Unlike GMI which depends directly on `@mariozechner/pi-coding-agent`, OCI depends on `openclaw` which wraps it. This introduces an additional consideration:

- **Version coupling**: OCI's effective pi-coding-agent version depends on what `openclaw ^2026.3.12` resolves to in its own dependency tree. OCI cannot independently pin the pi-coding-agent version.
- **Feature availability**: New pi-coding-agent features are available to OCI only after OpenClaw updates its dependency and passes them through.
- **CLI differences**: OCI uses `openclaw agent --local --json --message` rather than `pi --mode json -p`. The flag mapping is handled by the OpenClaw CLI layer.

### 6.2 Runtime Config vs CLI Flags

OCI sets model/provider via the runtime config file (`OPENCLAW_CONFIG_PATH`) using `agents.defaults.model` in `provider/model` format. This differs from GMI's approach of passing `--provider` and `--model` as CLI flags. Both approaches are valid; the runtime config approach avoids flag proliferation.

### 6.3 Extension Config Not Forwarded

OCI's `config/extensions.json` declares enabled extensions, but these are **not** forwarded to the OpenClaw runtime config. The OpenClaw Zod schema uses `.strict()` and rejects the `extensions` key. Extensions are logged for visibility only. This is a known architectural constraint documented in the codebase.

---

## 7. Verification Checklist

When updating the `openclaw` dependency version:

- [ ] Run `cd .github-openclaw-intelligence && bun install` to update dependencies
- [ ] Verify `openclaw agent --version` outputs the expected version
- [ ] Run a test prompt: `openclaw agent --local --json --message "What files are in the current directory?"` — confirm basic operation
- [ ] Test with `--session-id` flag — verify session continuity
- [ ] Trigger a real issue comment in a test repository — verify end-to-end workflow
- [ ] Test a multi-turn conversation to verify compaction behavior
- [ ] Test a long output command to verify bash output truncation fix
- [ ] Update version references in `PACKAGES.md`, `public-fabric/status.json`, and documentation
- [ ] If custom extensions are added, verify `promptSnippet` is included
- [ ] Verify all CLI flags remain valid (no unknown flag errors)

---

## 8. Recommended Follow-Up Work

1. ~~**Add compaction settings** — Configure `compaction.enabled`, `reserveTokens`, and `keepRecentTokens` in `.pi/settings.json` (P0)~~ ✅ Done — configured with `reserveTokens: 16384`, `keepRecentTokens: 32000`
2. ~~**Add retry settings** — Configure `retry.enabled`, `maxRetries`, and delay parameters (P0)~~ ✅ Done — configured with `maxRetries: 3`, `baseDelayMs: 2000`, `maxDelayMs: 60000`
3. **Add GitHub context extension** — Create `.pi/extensions/github-context.ts` with `promptSnippet` (P1)
4. **Add prompt templates** — Create `.pi/prompts/` with code-review and issue-triage templates (P1)
5. **Monitor OpenClaw releases** — Track when OpenClaw updates its pi-coding-agent dependency to ensure OCI receives upstream improvements
6. **Evaluate `defineTool()` migration** — When adding extensions, use the `defineTool()` API for type safety
7. **Re-audit feature utilization** — Update [openclaw-feature-utilization.md](openclaw-feature-utilization.md) after implementing P1 changes

---

## 9. Summary

The upstream pi-coding-agent improvements from v0.57.1 to v0.65.2 bring significant reliability and performance benefits to OCI through the OpenClaw transitive dependency chain. The most impactful improvements are:

- **Parallel tool execution** (v0.58.0) — faster agent runs
- **Concurrent file mutation serialization** (v0.61.0) — prevents data corruption
- **Compaction correctness fixes** (v0.63.1) — reliable long conversations
- **Bash output truncation fix** (v0.65.1) — no more silent data loss
- **JSON output stability** (v0.62.0, v0.65.1) — cleaner output parsing
- **Lazy provider loading** (v0.59.0) — faster startup
- **Multi-edit tool** (v0.63.0) — more efficient code modifications
- **TUI render throttling** (v0.65.2) — streaming performance (TUI-only, no OCI impact)

No **mandatory code changes** are required for OCI because:
1. OCI has no custom extensions (the `promptSnippet` breaking change doesn't apply)
2. OCI uses double-dash CLI flags exclusively (the single-dash flag rejection doesn't apply)
3. OCI uses CLI-only, not SDK (SDK-only breaking changes don't apply)

**P0 configuration improvements implemented**: Compaction settings (`reserveTokens: 16384`, `keepRecentTokens: 32000`) and retry settings (`maxRetries: 3`, `baseDelayMs: 2000`, `maxDelayMs: 60000`) are now configured in `.pi/settings.json`, with schema validation in `config/settings.schema.json` and preflight checks in `lifecycle/preflight.ts`.

The update is low-risk with high reward — it addresses several known reliability issues in the non-interactive JSON-mode pipeline that OCI depends on.
