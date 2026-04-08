# Suggestions v1 — Maximizing OpenClaw Inside GitHub-as-Infrastructure

> Goal: Keep GitHub (Issues, Actions, Git, Pages) as the infrastructure backbone, but leverage as much of OpenClaw's runtime, tooling, and capabilities as possible instead of reinventing them in `agent.ts`.

---

## Executive Summary

The current system is a solid proof-of-concept: a GitHub Actions workflow runs `openclaw agent --local` on issue events, manages session state via git, and posts replies as comments. But it only uses ~20% of what OpenClaw can do. The orchestrator (`agent.ts`) manually reimplements session management, git push conflict resolution, reaction handling, and error reporting — all things OpenClaw has built-in machinery for.

Below are concrete, prioritized improvements organized by impact.

---

## 🔴 High Impact — Architecture

### 1. Replace the Custom Session Layer with OpenClaw's Native Session Management

**Current:** `agent.ts` manually copies `.jsonl` session transcripts between `state/sessions/` and an ephemeral `agents/` runtime directory, manages issue→session mappings in `state/issues/*.json`, and handles all resume/restore logic (~100 lines of plumbing).

**Proposed:** Use OpenClaw's `--session-id` (already partially used) combined with `OPENCLAW_STATE_DIR` to let the runtime handle session persistence natively. The transcript files can still be committed to git for auditability, but the copy-back-and-forth choreography should be eliminated by pointing `OPENCLAW_STATE_DIR` directly at a git-tracked location and letting OpenClaw read/write in place.

**Why:** Less code to maintain, fewer edge cases around interrupted runs, and the system automatically benefits from any upstream session improvements (compression, pruning, etc.).

---

### 2. Use OpenClaw's Gateway Mode Instead of `--local` for Long-Running Workflows

**Current:** Each workflow run starts `openclaw agent --local`, processes one prompt, exits. No Gateway, no heartbeat, no cron, no webhook ingress.

**Proposed:** For issues that need multi-step work (code analysis → implementation → testing → PR), start the Gateway in the background within the Actions runner, then send the prompt via the webhook/agent API. This unlocks:

- **Heartbeat & cron** — the agent can schedule follow-up checks ("run tests again in 2 minutes after the build completes").
- **Sub-agent orchestration** — spawn parallel sub-agents for different files/tasks within a single workflow run.
- **Webhook ingress** — other Actions workflows (CI, deploy) could ping the running Gateway to notify the agent of build results.

The Gateway would run for the duration of the Actions job (max 6 hours on GitHub-hosted runners), then shut down. Session state still commits to git.

**Trade-off:** Slightly more complex workflow setup, but dramatically more capable agent runs.

---

### 3. Add PR Event Triggers and Code Review Capabilities

**Current:** The workflow only triggers on `issues.opened` and `issue_comment.created`. The agent can't respond to PRs, review requests, or CI status changes.

**Proposed:** Extend the workflow triggers to include:
```yaml
on:
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]
  pull_request:
    types: [opened, synchronize]
  check_run:
    types: [completed]
```

Combined with the `gh-issues` skill (already bundled), the agent could:
- Auto-review PRs when opened or updated
- Respond to review comments with code fixes
- React to CI failures by analyzing logs and suggesting fixes
- Auto-merge PRs that pass all checks (with appropriate safeguards)

**Why:** The `gh-issues` skill already has comprehensive PR review handling (Phase 6). Wiring it to PR events turns the agent from a "talk in issues" tool into a genuine CI/CD participant.

---

### 4. Leverage OpenClaw's Sub-Agent System for Parallel Work

**Current:** One prompt → one agent run → one reply. No parallelism.

**Proposed:** When the Gateway is running (see suggestion #2), use `sessions_spawn` to fan out work:
- **Issue triage:** A coordinator agent reads a batch of new issues, spawns sub-agents to analyze each one in parallel, collects results.
- **Multi-file changes:** For large refactors, spawn per-file or per-module sub-agents.
- **Research + implement:** One sub-agent researches the codebase and writes a plan; another implements it.

The `gh-issues` skill already does this pattern (Phase 5 spawns up to 8 parallel fix agents). Surface it as a first-class workflow capability.

---

## 🟡 Medium Impact — Capabilities

### 5. Enable the Bundled Skills Properly

**Current:** The `config/extensions.json` lists capabilities (sub-agents, semantic-memory, browser-cdp, multi-search), but these are just flags — the actual OpenClaw skills (`gh-issues`, `github`, `weather`, etc.) aren't wired into the agent runtime.

**Proposed:** 
- Add a `skills/` directory to `.github-openclaw-intelligence/` and symlink or install relevant skills there.
- Configure the agent's workspace so OpenClaw discovers them at runtime.
- Expose skill invocation to issue authors (e.g., `@ /gh-issues owner/repo --label bug` triggers the skill directly).

**Why:** The skills are already installed in `node_modules/openclaw/skills/` — they just need to be on the skill search path. This immediately gives the agent capabilities like automated issue fixing, GitHub operations, web search, and more.

---

### 6. Add Semantic Memory Search

**Current:** "Memory" is a raw `memory.log` append-only file and git-committed session transcripts. No search, no retrieval, no distillation.

**Proposed:** OpenClaw has built-in semantic memory (`memory_search`, `memory_get`) backed by BM25 + vector embeddings. Enable it:
- Create `MEMORY.md` in the agent workspace (or `.github-openclaw-intelligence/`).
- Let the agent write significant learnings, decisions, and codebase knowledge to memory files.
- On each run, the agent can search its memory for relevant context before responding.

**Why:** Over time, the agent builds a searchable knowledge base about the repo. "How did we handle error X last time?" → instant recall instead of searching through issue history.

---

### 7. Use OpenClaw's Browser Tool for Documentation and Web Research

**Current:** The agent can only interact via files and shell commands.

**Proposed:** The extensions config already enables `browser-cdp`. With a headless Chromium in the Actions runner:
- The agent can browse documentation, API references, and examples.
- It can visit linked URLs in issues (bug reports with screenshots, external API docs).
- Combined with web_search + web_fetch (also available), the agent becomes a genuine research assistant.

**Setup:** Add `npx playwright install chromium` to the workflow install step.

---

### 8. Add `AGENTS.md` Identity and Standing Orders

**Current:** The `.github-openclaw-intelligence/AGENTS.md` just says "No identity yet. Open an issue with the `hatch` label to bootstrap one."

**Proposed:** Replace with substantive standing orders:
```markdown
# Agent Instructions

You are a code maintenance agent for this repository.

## Standing Orders
- When reviewing code, check for: correctness, test coverage, error handling, and style consistency.
- Before making changes, always read existing tests and ensure your changes pass them.
- Prefer minimal, focused changes. One fix per commit.
- Always explain your reasoning in PR descriptions.

## Repository Context
- Language: [auto-detect from package.json/Cargo.toml/etc.]
- Test framework: [auto-detect]
- Style guide: [link or description]

## Constraints
- Never force-push to main.
- Never delete branches without asking.
- Never modify CI/CD configuration without explicit approval.
```

**Why:** Standing orders dramatically improve agent behavior consistency. Without them, the agent starts from zero context every time.

---

### 9. Multi-Model Failover and Cost Optimization

**Current:** Single model configured in `.pi/settings.json` (GPT-5.4). If the API is down or rate-limited, the workflow fails.

**Proposed:** OpenClaw has built-in multi-model failover (`extensions.json` already enables it). Configure a fallback chain:
```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.4",
  "fallback": [
    { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
    { "provider": "google", "model": "gemini-2.5-pro" }
  ]
}
```

Additionally, use cheaper models for sub-agents and triage, reserving the expensive model for the main response.

---

### 10. Webhook-Driven CI Feedback Loop

**Current:** The agent runs once per issue/comment and never learns about the outcome (did the PR pass CI? did the deploy succeed?).

**Proposed:** Using OpenClaw's webhook ingress (`/hooks/wake` and `/hooks/agent`):
1. Add a separate lightweight workflow triggered on `check_run.completed` and `deployment_status`.
2. That workflow sends a webhook to the agent Gateway (if running) or creates a system event for the next run.
3. The agent can then auto-respond: "CI passed on PR #42, merging" or "Tests failed, investigating."

This creates a closed feedback loop: issue → agent fix → PR → CI → agent reaction.

---

## 🟢 Lower Impact — Polish

### 11. Simplify the Push/Conflict Resolution

**Current:** 70+ lines of retry-with-backoff logic for `git push`.

**Proposed:** Move to a simple wrapper:
```bash
git pull --rebase origin main && git push origin main
```
With the existing concurrency group (`github-openclaw-intelligence-${{ github.repository }}-issue-${{ github.event.issue.number }}`), push conflicts between runs on the *same* issue are already prevented. Cross-issue conflicts are rare and a single rebase-retry is usually sufficient. The 10-retry loop with increasing backoff is over-engineered for the actual failure mode.

---

### 12. Add Issue Templates for Structured Agent Interaction

**Current:** Users must know to prefix with `@`.

**Proposed:** Ship GitHub issue templates that structure the interaction:
```yaml
# .github/ISSUE_TEMPLATE/agent-task.yml
name: "🤖 Agent Task"
description: "Ask the AI agent to do something"
title: "@ "
labels: ["agent"]
body:
  - type: textarea
    id: task
    attributes:
      label: "What do you need?"
      description: "Describe the task. Be specific about files, functions, or behaviors."
  - type: dropdown
    id: scope
    attributes:
      label: "Scope"
      options:
        - "Analysis only (no code changes)"
        - "Small fix (< 5 files)"
        - "Feature (new functionality)"
        - "Refactor (restructure existing code)"
```

**Why:** Structured input → better agent performance. Also discoverable for new repo contributors.

---

### 13. GitHub Pages Dashboard Enhancement

**Current:** `public-fabric/` serves a static `status.json`-driven page with project info.

**Proposed:** Make the dashboard dynamic by having the agent update `status.json` after each run:
```json
{
  "lastRun": "2026-07-15T10:30:00Z",
  "totalRuns": 42,
  "issuesProcessed": 38,
  "prsOpened": 12,
  "activeConversations": 3,
  "recentActivity": [
    { "issue": 15, "action": "replied", "timestamp": "..." },
    { "issue": 12, "action": "opened PR #18", "timestamp": "..." }
  ]
}
```

The Pages site becomes a live activity dashboard for the agent.

---

### 14. Comment Chunking for Long Responses

**Current:** Responses are truncated at 60,000 characters with no indication of what was lost.

**Proposed:** Split long responses into multiple comments with navigation:
```
**Part 1 of 3** — Analysis

[content]

---
*Continued in next comment...*
```

OpenClaw's agent output can be split at natural boundaries (sections, code blocks) rather than at an arbitrary character limit.

---

### 15. Scheduled Maintenance via GitHub Actions Cron

**Current:** The agent only runs reactively (on issues/comments).

**Proposed:** Add a `schedule` trigger to the workflow:
```yaml
on:
  schedule:
    - cron: '0 8 * * 1'  # Every Monday at 8 AM UTC
```

The scheduled run could:
- Clean up stale branches from old `fix/issue-*` PRs
- Update the memory/knowledge base
- Run a "health check" on open issues and PRs
- Prune old session transcripts to keep the repo lean
- Update the Pages dashboard

---

## 📋 Migration Path

For adopters who want to incrementally move toward "maximum OpenClaw":

1. **Week 1:** Fix `AGENTS.md` with real standing orders (#8). Enable skills discovery (#5). Add issue templates (#12).
2. **Week 2:** Add PR event triggers (#3). Enable semantic memory (#6).  
3. **Week 3:** Switch to Gateway mode (#2). Enable sub-agents (#4) and browser (#7).
4. **Week 4:** Wire up webhook feedback loop (#10). Add scheduled maintenance (#15). Configure multi-model failover (#9).

Each step is independently valuable and backward-compatible.

---

## What NOT to Change

These are the system's strengths — keep them:

- **GitHub Issues as the conversation surface** — universally accessible, no extra UI needed
- **Git as the state/memory layer** — auditable, versionable, forkable
- **GitHub Actions as compute** — zero-infra, pay-per-use, automatic scaling
- **The `@` prefix protocol** — simple, memorable, prevents accidental triggers
- **Authorization via collaborator permissions** — leverages GitHub's existing access model
- **Reaction-based status indicators** (🚀 working, 👍 success, 👎 failure) — non-intrusive UX
- **Session-per-issue model** — clean conversation boundaries
- **Auto-installer via `workflow_dispatch`** — frictionless onboarding

---

*Generated by analyzing the full system: workflow YAML, agent.ts orchestrator, OpenClaw docs, bundled skills, extensions config, and project structure.*
