# Report: Suggestions v2 — Feasibility, Current State & Implementation Roadmap

> An up-to-date revision of [suggestions-1-report.md](suggestions-1-report.md). It re-evaluates the 15 improvements in [suggestions-1.md](suggestions-1.md) against the **live OCI codebase** and the **current state of the upstream [openclaw/openclaw](https://github.com/openclaw/openclaw) project** (release `2026.6.9`, package version `2026.6.8`) as of 2026-06-19.

---

## 1. Executive Assessment

Suggestions v1 identifies 15 improvements organized by impact tier. The original report ([suggestions-1-report.md](suggestions-1-report.md)) assessed them against the codebase as of 2026-04-08, when OCI depended on `openclaw ^2026.3.12`. Since then two things have moved:

1. **OCI advanced.** OCI now pins `openclaw ^2026.5.22` (`package.json`, template `VERSION` `1.0.10`), with compaction and retry settings configured in `.pi/settings.json`. The long-response handler now appends an explicit truncation notice instead of silently dropping content.
2. **Upstream advanced further.** The current published `openclaw` release is `2026.6.9` — newer than OCI's pinned floor. The window `2026.5.22 → 2026.6.9` brought agent-recovery hardening, a governed plugin/skill install policy, a bundled parallel web-search provider, expanded provider/model coverage (GLM-5.2, Claude Haiku 4.5, Claude Opus 4.8, Kimi K2.7 Code, Claude Fable 5), tighter security boundaries (fail-closed exec/MCP/browser paths, SSRF policy on browser snapshot reads, prompt-marker spoofing protection), and sub-agent/Workboard coordination fixes.

**Bottom line:** The v1 verdicts still hold in shape, but several have shifted. Of the 15 suggestions, **3 remain done**, **5 are immediately actionable** (one — comment chunking — has been partially superseded by the new truncation notice), **4 require significant architectural work** (the upstream changes lower the risk for two of them), and **3 remain blocked or inadvisable** (the case for skipping the browser tool is now even stronger). The single highest-leverage new action is **bumping the `openclaw` dependency** to pick up the recovery and security fixes — none of which require OCI code changes.

---

## 2. Suggestions Already Addressed (Fully or Partially)

### Suggestion #1 — Native Session Management ✅ Done (unchanged)

The session-mapping logic in `agent.ts` uses `OPENCLAW_STATE_DIR` pointed directly at `.github-openclaw-intelligence/state/`, with `--session-id` for native session continuity. The legacy `state/sessions/` path is referenced only for backward-compatible migration of old transcripts. The manual copy-back-and-forth choreography described in the suggestion has been eliminated.

**What changed upstream:** Session robustness improved underneath OCI without any code change. The `2026.5.22 → 2026.6.9` window added warm transcript-read caching, session-history repair, partial JSON/history artifact recovery, and session-lock release on timeout abort. These flow into OCI transitively once the dependency is bumped, making interrupted issue conversations more resilient.

**Remaining gap:** The backward-compatibility migration code is still harmless and costs zero runtime overhead when no legacy sessions exist. It could be removed after a deprecation period.

### Suggestion #5 — Enable Bundled Skills ✅ Done (now with more upstream skills available)

`linkBundledSkills()` in `agent.ts` symlinks the allowed bundled skills from the installed `openclaw` package into the local `skills/` directory; `config/skills.json` lists 10 allowed skills (`gh-issues`, `github`, `weather`, `summarize`, `coding-agent`, `healthcheck`, `oracle`, `session-logs`, `nano-pdf`, `xurl`), and the runtime config passes `allowBundled` and `extraDirs` to OpenClaw. The claim in the original suggestion that skills "aren't wired" remains incorrect.

**What changed upstream:** The upstream `skills/` catalog has grown to **58 skills** (from the smaller set available at the time of v1). All 10 skills OCI enables still exist. Newly available and directly relevant to OCI are:
- **`skill-creator`** — scaffolds new custom skills (supports suggestion #5's "expose custom skills" goal).
- **`clawhub`** — installs skills from ClawHub; installs now retain verified source provenance (`2026.6.9`).
- **`model-usage`** — surfaces token/cost usage, complementing the new `/usage` footer renderer.
- **`taskflow` / `taskflow-inbox-triage`** — structured task/triage flows relevant to issue triage.

Skill installation is now governed by an **operator install policy** (`2026.6.2`) that replaced the older dangerous-code scanner, and skill support-file writes go through trusted lifecycle writes (`2026.6.7`). This makes adding custom skills safer in CI.

**Remaining gap:** OCI still ships **no custom skills** (`skills/` contains only `.gitkeep`), and there is still no user-facing documentation on invoking skills via `/skill-name`. `parseSkillInvocation()` continues to support `/skill-name` from issue comments.

### Suggestion #8 — AGENTS.md Identity ✅ Architecturally Ready (content still default)

The `AGENTS.md` → `SOUL` bridge is fully implemented via `generateSoulFromAgentsMd()` in `agent.ts`. The default install template is detected by exact string match (`DEFAULT_AGENTS_MD`) and skipped. `AGENTS.md` still contains only the default `_No identity yet…_` placeholder, so no `SOUL` is written.

**What changed upstream:** Sub-agent bootstrap now defaults to `AGENTS.md` + `TOOLS.md` only, so substantive `AGENTS.md` content propagates to delegated workers more cleanly. Writing real standing orders is therefore even higher value than at v1 time.

**Action required (still P0):** Write real standing orders in `AGENTS.md`. Zero-code change, high impact.

---

## 3. Immediately Actionable Suggestions

### Suggestion #3 — PR Event Triggers 🟢 Low–Medium Effort, High Impact (unchanged)

**Feasibility: High.** The workflow still triggers only on `issues.opened`, `issue_comment.created`, and `workflow_dispatch`. Adding PR-related triggers remains straightforward, and the `gh-issues` skill (already linked) provides PR review capabilities.

**Implementation considerations:**
- `agent.ts` reads `event.issue.title` / `event.issue.body`. PR events populate `event.pull_request` / `event.review` instead, so event-type branching is required.
- The concurrency group key `…-issue-${{ github.event.issue.number }}` must handle PR numbers (PR review comment events do not carry `event.issue.number`).
- The `@` prefix protocol fits issue comments; PR review comments have a different UX expectation.

**Estimated scope:** ~50 lines of event-dispatching logic in `agent.ts`, plus workflow YAML trigger additions.

### Suggestion #6 — Semantic Memory 🟢 Low Effort, Medium Impact (clearer upstream picture)

**Feasibility: High.** `semantic-memory` is declared in `config/extensions.json`. Upstream now exposes a richer memory stack — the `memory-core`, `memory-lancedb`, `memory-wiki`, and `active-memory` extensions back the native `memory_search` / `memory_get` tools.

**Implementation considerations (refined):**
- Extension declarations in `config/extensions.json` remain **informational only** — the OpenClaw runtime config schema is `.strict()` and rejects the `extensions` key. Activation depends on OpenClaw's own internal discovery, not on OCI's declaration.
- Upstream hardened the memory index: stale reindex temp files are cleaned (`2026.6.9`), rollback-journal reindex sidecars are cleaned on network stores, and SQLite WAL is avoided on network filesystems (`2026.6.9`). This makes a git-committed memory index under `OPENCLAW_STATE_DIR` more robust across runs, but persistence across ephemeral runners still needs end-to-end verification.
- A `MEMORY.md` (or equivalent) still needs to be created and committed, and a pruning strategy should be defined upfront to bound repo growth.

### Suggestion #12 — Issue Templates 🟢 Low Effort, Medium Impact (unchanged)

**Feasibility: High.** Pure configuration — create `.github/ISSUE_TEMPLATE/agent-task.yml`. No code changes needed.

**Implementation considerations:**
- The `@` prefix must be preserved in the issue title for the trigger filter; the template should prepend `@ ` automatically.
- A "scope" dropdown gives the agent useful context without natural-language description.
- Multiple templates could route to different skill invocations via `/skill-name`.

### Suggestion #14 — Comment Chunking 🟡 Partially Superseded, Low–Medium Impact

**Status change.** The most acute problem the suggestion targeted — silent data loss at the 60,000-character limit — has been **mitigated**. `agent.ts` (`MAX_COMMENT_LENGTH = 60000`) now appends an explicit truncation notice linking to the workflow run logs, so nothing is dropped silently. Additionally, upstream `2026.6.9` preserves full bash output to a temp file, reducing the chance that a single huge tool output dominates a response.

**Remaining opportunity:** Replacing hard truncation with a collapsible `<details>` overflow block (or multi-comment splitting at Markdown boundaries) is still a nice-to-have for very long analyses, but it is now **lower priority** because the failure mode is no longer silent. The `<details>` approach remains preferable to multi-comment splitting, which creates notification noise.

### Suggestion #15 — Scheduled Maintenance 🟢 Low Effort, Medium Impact (unchanged)

**Feasibility: High.** Adding a `schedule` trigger to the workflow is trivial.

**Implementation considerations:**
- Scheduled runs have no `event.issue`; `agent.ts` assumes `issueNumber` is present and must handle the no-issue case.
- The scheduled run needs a defined task list (stale branch cleanup, session pruning, dashboard update), each a separate function or skill.
- GitHub Actions cron timing is approximate (5–60 min delays under load) — fine for maintenance, but worth documenting.
- Upstream `2026.5.22 → 2026.6.9` hardened cron significantly (SQLite-backed cron status, `cron edit --clear-model`, scheduled-turn tool-policy preservation), but these apply to OpenClaw's **own** Gateway cron, not GitHub Actions cron — OCI's scheduled trigger remains a workflow-level concern.

---

## 4. Suggestions Requiring Significant Architectural Work

### Suggestion #2 — Gateway Mode 🟠 High Effort, High Impact (Conditional) — still defer

**Feasibility: Medium-Low.** Unchanged in fundamentals; the upstream investment in the Gateway has been heavy in the recent window (session workspace rail, plugin health, externally installed channel plugins at startup, Workboard goals), but **all of it targets always-on, multi-channel server deployments** — not ephemeral GitHub Actions runners.

**Trade-offs (unchanged):** Runner billing (a 6-hour Gateway run costs ~6× a single-prompt run), an HTTP server attack surface inside the runner, lifecycle-management complexity in `agent.ts`, and higher interruption risk for long jobs.

**Recommendation:** Defer unless a specific multi-step workflow is identified that the current single-prompt model cannot serve. Sub-agent parallelism (suggestion #4) is available without the Gateway.

### Suggestion #4 — Sub-Agent Orchestration 🟠 Medium Effort, High Impact (lower risk now)

**Feasibility: Medium, improving.** True orchestrator-level spawning (`sessions_spawn`) still requires the Gateway API and is unavailable in `--local` mode. However, the upstream window materially **hardened sub-agents**: subagent runs that previously reported success but failed to write their output file are fixed (`#92642`), subagents keep cwd/workspace separation (`2026.5.28`), yielded subagent pauses recover, and spawned task runs are correctly attributed to the child agent (`2026.6.9`). The `workboard` extension adds task-backed multi-agent coordination that survives reloads.

**Practical path (unchanged):** The `gh-issues` skill already spawns parallel fix agents (its multi-agent phase), available today via `/gh-issues` invocation. For in-run parallelism, the runtime already parallelizes tool calls. These reliability fixes reduce the risk of adopting the skill-driven approach now.

### Suggestion #9 — Multi-Model Failover 🟠 Medium Effort, Medium Impact (more options, native failover maturing)

**Feasibility: Medium.** `multi-model-failover` is declared in `config/extensions.json` but, like all extension declarations, is informational only. The `.pi/settings.json` schema (validated by `config/settings.schema.json` and `lifecycle/preflight.ts`) still supports only `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` — **no `fallback` array**.

**What changed upstream:**
- Native **auth-profile failover** and **static model fallback** recover cleanly across turns (`2026.6.1`, `2026.6.7`), so some failover now happens inside the runtime regardless of OCI config.
- The provider/model catalog expanded substantially — GLM-5.2, Claude Haiku 4.5, Claude Opus 4.8, Kimi K2.7 Code, Claude Fable 5, plus OpenRouter OAuth/Fusion. This widens the set of viable fallback targets and cheap triage models.

**Implementation considerations (unchanged):** Adding a `fallback` chain requires schema + preflight validator changes; each fallback provider needs its own API-key secret. The existing `retry` settings (`maxRetries: 3`) handle transient single-provider errors; true failover addresses a different failure mode (provider outage).

### Suggestion #10 — Webhook-Driven CI Feedback Loop 🟠 High Effort, High Impact (native webhooks exist, still Gateway-bound)

**Feasibility: Low-Medium.** The full webhook-ingress design still depends on the Gateway (suggestion #2). Upstream does ship a dedicated `webhooks` extension, but it is a Gateway server capability, not something OCI's `--local` runs can host inside an Actions job.

**Alternative without Gateway (unchanged and recommended):** Add a lightweight workflow triggered on `check_run.completed` that posts CI results as a comment on the originating issue; the agent reacts in a subsequent run. Mapping `check_run → commit → PR → issue` remains fragile and convention-dependent, but the comment-based loop works with the existing architecture.

---

## 5. Suggestions That Are Blocked or Inadvisable

### Suggestion #7 — Browser Tool 🔴 Still Skip (case strengthened)

**Feasibility: Low.** The practical objections from v1 stand — ~30–60 s Chromium install per run, ~400 MB disk, and a headless-browser attack surface in CI. Two upstream developments make skipping **more** attractive:

1. **Bundled parallel web search** (`2026.6.5`) plus first-class search providers (Brave, Exa, Tavily, Perplexity, SearXNG, DuckDuckGo, Parallel) and Codex Hosted Search cover the "research assistant" use case without a browser. Key-free providers remain explicit opt-ins (`2026.6.8`), avoiding surprise fallbacks.
2. The `xurl` skill and `web-readability` extension still provide URL fetching and content extraction.

Where the browser *is* used upstream, it now runs behind tighter boundaries (SSRF policy on snapshot reads, fail-closed browser paths in `2026.6.6`) — which underscores that the browser is a security-sensitive surface best left off for a fast, lean CI agent.

**Recommendation:** Skip. Enable only for a specific JS-rendering need that `xurl` + search cannot satisfy, and then install Chromium conditionally.

### Suggestion #11 — Simplify Push/Conflict Resolution 🔴 Still Inadvisable

The 10-attempt retry-with-backoff loop in `agent.ts` (pulling with `git pull --rebase -X theirs` between attempts) addresses real failure modes a single `git pull --rebase && git push` cannot: cross-issue races (the per-issue concurrency group does not serialize different issues), `state/` metadata conflicts, network transience, and rebase conflicts that resolve on retry. Reducing the count from 10 to ~5 is defensible; eliminating the loop would increase hard failures. This is a robustness measure appropriate for unattended CI, not over-engineering.

### Suggestion #13 — Dynamic Pages Dashboard 🟡 Still Low Priority

`public-fabric/` remains a static `status.json`-driven page. Making it dynamic adds I/O to every run, the data is stale between runs, and GitHub's own issue/PR activity feed already provides a richer view. Defer indefinitely unless a specific stakeholder need emerges.

---

## 6. Priority Matrix — Revised

| Priority | Suggestion | Effort | Impact | Depends On | Status |
|----------|-----------|--------|--------|------------|--------|
| **Done** | #1 Native Session Management | — | — | — | ✅ Implemented (more upstream resilience available) |
| **Done** | #5 Enable Bundled Skills | — | — | — | ✅ Implemented (58 upstream skills now available) |
| **Done** | #8 AGENTS.md Infrastructure | — | — | — | ✅ Ready |
| **P0** | Bump `openclaw` dependency | Low | High | — | `^2026.5.22` → `2026.6.x`; recovery + security fixes, no code change |
| **P0** | #8 AGENTS.md Content | Zero-code | High | — | Write standing orders |
| **P1** | #12 Issue Templates | Low | Medium | — | Pure configuration |
| **P1** | #3 PR Event Triggers | Medium | High | — | ~50 lines + YAML |
| **P2** | #6 Semantic Memory | Low | Medium | — | Needs run-to-run persistence verification |
| **P2** | #15 Scheduled Maintenance | Low–Medium | Medium | — | YAML + no-issue handling |
| **P3** | #9 Multi-Model Failover | Medium | Medium | — | Schema + preflight changes; native failover maturing |
| **P3** | #4 Sub-Agents (partial) | Medium | Medium | #2 (full) | Available via skills today; upstream hardened |
| **P3** | #14 Comment Chunking | Low–Medium | Low | — | Demoted — truncation no longer silent |
| **P4** | #10 CI Feedback Loop | Medium | Medium | #2 (full) or #3 (partial) | Comment-based alternative |
| **P4** | #2 Gateway Mode | High | Conditional | — | Defer — cost/complexity |
| **Skip** | #7 Browser Tool | Medium | Low | — | Skip case strengthened by bundled search |
| **Skip** | #11 Simplify Push Logic | Low | Negative | — | Would reduce reliability |
| **Skip** | #13 Dynamic Dashboard | Low | Low | #15 (optional) | Insufficient value |

---

## 7. Recommended Implementation Order

### Phase 0: Dependency Refresh (Week 0 — new)

0. **Bump `openclaw`** from `^2026.5.22` toward `2026.6.x`. This is the single highest-leverage, lowest-risk action: it pulls in agent-recovery hardening (retry thinking-only/empty post-tool turns, preserve fresh usage after compaction, session-history repair), governed skill installs, and security fixes — none requiring OCI code changes. Follow the verification checklist in [openclaw-dependency-analysis.md](openclaw-dependency-analysis.md) §7 and bump `VERSION`, `PACKAGES.md`, and `public-fabric/status.json` so the self-installer propagates downstream.

### Phase 1: Zero-Code Configuration (Week 1)

1. **Write `AGENTS.md` standing orders** — define identity, constraints, and behavioral guidelines. Highest impact on response quality.
2. **Add issue templates** — `.github/ISSUE_TEMPLATE/agent-task.yml` with the `@` prefix and a scope dropdown.

### Phase 2: Event Expansion (Week 2)

3. **Add PR event triggers** — extend the workflow with `pull_request`, `pull_request_review_comment`, and `pull_request_review`; add event-type dispatching to `agent.ts`.
4. **Document skill invocation** — user-facing docs on invoking skills via `/skill-name`; the infrastructure exists but is undiscoverable.

### Phase 3: Memory & Maintenance (Week 3)

5. **Enable semantic memory** — verify index persistence across runs via `OPENCLAW_STATE_DIR`; create `MEMORY.md`; test a multi-session conversation.
6. **Add scheduled maintenance** — a `schedule` trigger with a weekly cron and a no-issue code path in `agent.ts`.
7. **(Optional) Comment overflow polish** — replace hard truncation with a `<details>` block. Lower priority now that truncation is signposted.

### Phase 4: Resilience (Week 4)

8. **Multi-model failover** — extend the settings schema and preflight validator with a `fallback` chain; add fallback API-key secrets.
9. **Comment-based CI feedback** — a lightweight `check_run.completed` workflow that posts CI results as issue comments.

---

## 8. What the Suggestions Got Right

The v1 suggestions correctly identify the system's strengths (the "What NOT to Change" list) and the "leverage OpenClaw's built-in capabilities instead of reimplementing them" direction. The recent upstream window validates that philosophy: OCI receives session-recovery, compaction-correctness, security, and provider-coverage improvements **for free** through the transitive `openclaw` dependency, with no orchestrator changes. The phased, independently valuable migration path remains realistic.

## 9. What the Suggestions Missed or Got Wrong (revised)

1. **Session management was already fixed.** Still true — the described manual choreography no longer exists.
2. **Skills are already wired.** Still true; the upstream catalog has since grown to 58 skills, several directly useful (`skill-creator`, `clawhub`, `model-usage`, `taskflow`).
3. **Extensions config is informational only.** Still true — the strict runtime schema rejects the `extensions` key. Some capabilities the declarations imply (auth-profile failover, memory hardening) now activate natively upstream regardless.
4. **Gateway mode costs were understated.** Still true; the heavy upstream Gateway investment targets always-on server deployments, not ephemeral runners.
5. **Push simplification is harmful.** Still true; the retry loop addresses concurrent multi-issue failure modes.
6. **Browser tool overhead was not assessed.** Still true, and the case to skip is now stronger because parallel web search is bundled upstream.
7. **Comment chunking framed truncation as silent data loss.** No longer accurate — `agent.ts` now appends a truncation notice, so this suggestion is demoted.

---

## 10. Cross-Reference with Existing Analysis Documents

### Feature Utilization Analysis

[openclaw-feature-utilization.md](openclaw-feature-utilization.md) remains the more granular audit. Its P0 items (compaction, retry) are implemented. Its P1 items — a GitHub-context custom extension (`.pi/extensions/github-context.ts` with `promptSnippet`) and prompt templates (`.pi/prompts/`) — remain the highest-value next steps and are complementary to suggestion #5's intent. The upstream `defineTool()` helper and `ctx.signal` cancellation make a future custom extension cleaner and safer.

### Dependency Analysis

[openclaw-dependency-analysis.md](openclaw-dependency-analysis.md) documents the `openclaw ^2026.5.22` upgrade and the narrow CLI/env surface OCI uses. This report extends that: the current upstream release is `2026.6.9`, so a follow-up dependency bump (Phase 0 above) is now the recommended next dependency action. The verified non-impact areas (five double-dash CLI flags, the env vars, the `--json` envelope shape, the strict runtime schema, `engines.node >= 22.19.0`) remain unchanged in the `2026.6.x` line.

### Gaps Between Documents

The feature-utilization recommendations not covered by suggestions-1.md still stand: prompt templates (`.pi/prompts/`), system-prompt extension (`APPEND_SYSTEM.md`), and a GitHub-aware custom extension. These should be planned alongside the suggestions-1.md items.

---

## 11. Verification Attestation

All factual claims were verified against the live OCI codebase and the upstream [openclaw/openclaw](https://github.com/openclaw/openclaw) repository as of 2026-06-19.

| Claim Category | Verification Method | Result |
|---|---|---|
| Session management implementation | Inspected `agent.ts` session-mapping logic and `OPENCLAW_STATE_DIR` usage | ✅ Confirmed |
| `linkBundledSkills()` implementation | Inspected function and symlink logic in `agent.ts` | ✅ Confirmed |
| `generateSoulFromAgentsMd()` bridge + default detection | Inspected `DEFAULT_AGENTS_MD` exact-match skip | ✅ Confirmed |
| `parseSkillInvocation()` parser | Inspected `/skill-name` regex and handler | ✅ Confirmed |
| 10 bundled skills in `config/skills.json` | Read file contents | ✅ All 10 present |
| 7 extensions in `config/extensions.json` | Read file contents | ✅ All 7 declared (informational only) |
| Compaction & retry in `.pi/settings.json` | Read file contents | ✅ Confirmed |
| `AGENTS.md` still default template | Read file; content is the `_No identity yet…_` placeholder | ✅ Confirmed |
| Workflow event triggers | Read `.github/workflows/github-openclaw-intelligence-agent.yml` | ✅ `issues`, `issue_comment`, `workflow_dispatch` only |
| Truncation no longer silent | Inspected `MAX_COMMENT_LENGTH` handling in `agent.ts` | ✅ Appends a truncation notice |
| Push retry loop | Inspected 10-attempt `git pull --rebase -X theirs` loop in `agent.ts` | ✅ Confirmed |
| OCI pinned dependency | Read `package.json` | ✅ `openclaw ^2026.5.22`, template `VERSION` `1.0.10` |
| Current upstream release | Read upstream `package.json` / `CHANGELOG.md` | ✅ `2026.6.8` package / `2026.6.9` changelog |
| Upstream skill catalog size | Listed upstream `skills/` directory | ✅ 58 skills; OCI's 10 all present |
| Upstream feature/security changes | Read upstream `CHANGELOG.md` (`2026.5.22 → 2026.6.9`) | ✅ Recovery, install policy, bundled search, new models, security boundaries |

All OpenClaw-related operational files reside within the `.github-openclaw-intelligence/` directory. The root `README.md` is the standard repository landing page, not an OpenClaw operational file.

---

*Generated by cross-referencing [suggestions-1.md](suggestions-1.md) and [suggestions-1-report.md](suggestions-1-report.md) against the live OCI codebase (`agent.ts`, workflow YAML, config files, settings, skills) and the current state of the upstream openclaw/openclaw project (release `2026.6.9`, package `2026.6.8`), plus the existing analysis documents ([openclaw-feature-utilization.md](openclaw-feature-utilization.md), [openclaw-dependency-analysis.md](openclaw-dependency-analysis.md)). All claims verified as of 2026-06-19.*
