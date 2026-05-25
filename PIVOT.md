# PIVOT.md

> A deep analysis of what it would take for **GitHub OpenClaw Intelligence (GMI)**
> — the GitHub Action-based AI agent in this repository — to **fully utilise**
> [GitHub Agentic Workflows (`gh-aw`)](https://github.github.com/gh-aw).
>
> This document is the more aggressive sibling of
> [`FUTURE.md`](FUTURE.md). Where `FUTURE.md` argues for *gradual adoption of
> `gh-aw` primitives while keeping GMI's soul*, this one asks the harder
> question: **what would change, end to end, if we treated `gh-aw` as the
> substrate and committed to its model without reservation?**

---

## 0. Framing: pivot vs. adopt

`FUTURE.md` is explicit: *"adopt the substrate, keep the soul."* It treats
`gh-aw` as a vetted floor that GMI should stand on, with the existing
lifecycle pipeline (`enabled.ts → preflight.ts → agent.ts`), trust model,
sentinel, skills allowlist, and multi-provider failover all surviving
intact. That is the safe path.

This document explores the **other** path: what does GMI look like if
`gh-aw` is not just the substrate but the *primary authoring surface*?
If the answer is "GMI becomes a `gh-aw` workflow with a thicker runtime
attached," that is a pivot, not an adoption. The aim here is to be honest
about what would have to die, what would have to be rebuilt, and what
genuinely survives.

A real pivot has three tests:

1. **Authoring test.** Does the canonical, human-edited surface of GMI
   become a `gh-aw`-style Markdown workflow spec, with the YAML in
   `.github/workflows/` reduced to *compiled output*?
2. **Permissions test.** Does the workflow drop to read-only by default,
   with every mutation flowing through `safe-outputs`?
3. **Tooling test.** Are GMI's skills addressable as MCP servers behind
   `gh-aw-mcpg`, with their network egress confined by
   `gh-aw-firewall`?

A change that doesn't satisfy all three is adoption, not a pivot.

---

## 1. What GMI is today (the thing being pivoted)

Concrete shape, as it sits in this repository:

- **One handwritten workflow file:**
  [`.github/workflows/github-openclaw-intelligence-agent.yml`](.github/workflows/github-openclaw-intelligence-agent.yml)
  carries two jobs (`run-install`, `run-agent`), declares
  `permissions: contents: write, issues: write, actions: write`
  unconditionally, and triggers on `issues.opened`,
  `issue_comment.created`, and `workflow_dispatch`.
- **A TypeScript lifecycle pipeline** under
  [`.github-openclaw-intelligence/lifecycle/`](.github-openclaw-intelligence/lifecycle/):
  `enabled.ts` (fail-closed sentinel), `preflight.ts` (schema validation),
  `agent.ts` (orchestrator), `command-parser.ts`, `trust-level.ts`.
- **Configuration in Git:** `.pi/settings.json` (provider, model, trust
  policy, limits), `config/settings.schema.json`, `config/skills.json`,
  `config/extensions.json`.
- **Agent identity in Git:** `AGENTS.md` is bridged to OpenClaw's `SOUL`
  file at runtime, and the `ENABLED.md` sentinel acts as a fail-closed
  kill switch.
- **State in Git:** `state/agents/main/sessions/` (JSONL transcripts),
  `state/issues/` (issue↔session map), `state/memory.log` (append-only
  with `merge=union` in `.gitattributes`).
- **A self-installer / upgrader:** the `run-install` job that fetches
  `main.zip` from this repo, preserves user data
  (`AGENTS.md`, `.pi/`, `config/`, `state/`), and commits the result.
- **A second workflow,** `gmi-public-fabric.yml`, that publishes the
  `public-fabric/` directory to GitHub Pages.
- **A rich runtime tool surface:** sub-agents, semantic memory, media
  understanding, browser CDP, multi-search, multi-model failover across
  seven providers (OpenAI, Anthropic, Google, xAI, OpenRouter, Mistral,
  Groq).
- **Skills as first-class units:** ten bundled skills (`gh-issues`,
  `github`, `weather`, `summarize`, `coding-agent`, `healthcheck`,
  `oracle`, `session-logs`, `nano-pdf`, `xurl`), each loadable via
  `/skill-name` direct invocation, plus an extra-dirs mechanism for
  user-supplied skills.
- **A trust policy** with trusted / semi-trusted / untrusted tiers,
  evaluated at runtime in `trust-level.ts` against repository
  collaborator permissions.

This is a substantial, opinionated agent. Pivoting it onto a different
substrate is not a refactor.

---

## 2. What `gh-aw` actually is (the substrate being pivoted onto)

Stripped to its load-bearing primitives — and where they differ from
`FUTURE.md`'s summary, this section is the operative one for a *full*
pivot:

1. **Markdown-as-workflow.** The authored artefact is a Markdown file
   with frontmatter declaring `on:`, `permissions:`, `tools:`,
   `safe-outputs:`, `network:`, `mcp-servers:`, etc. A compiler emits
   a hardened GitHub Actions YAML from it. The YAML is generated
   output, not source.
2. **Read-only by default.** The emitted workflow runs with the
   minimum `permissions:` it can. Anything that mutates the repo —
   comments, labels, branches, PRs, dispatches — is declared as a
   `safe-outputs:` capability, serialised by the agent as structured
   JSON, and applied by a *separate, minimal post-step* whose only job
   is schema validation + the GitHub API call.
3. **Sandbox + firewall + gateway.**
   - **Sandboxed execution** per job (the runner is treated as
     untrusted-by-default).
   - **`gh-aw-firewall`** wraps the job with a transparent egress
     proxy that enforces an explicit domain allowlist; everything
     else fails closed.
   - **`gh-aw-mcpg`** is a single auditable HTTP gateway through
     which all MCP tool calls flow, with logging, auth, and
     rate-limiting at the gateway layer.
   - **`gh-aw-actions`** provides vetted, SHA-pinned reusable
     actions for the common scaffolding (checkout, authorize,
     react, etc.).
4. **Compile-time tool allow-listing.** Whether a tool/skill is even
   reachable in a given run is decided at compile time, against the
   declared trust gate, not at runtime inside the agent process.
5. **Team-membership approval gates** as first-class workflow
   primitives, distinct from per-actor permission checks.
6. **`llms.txt` / `llms-full.txt`** as the canonical agent-facing
   documentation format.

The crucial property: in `gh-aw`, **the human-edited surface is small
and intent-shaped; the security-sensitive surface is generated and
auditable.** GMI today has it the other way around — the human-edited
surface is a 357-line YAML file that *is* the security surface.

---

## 3. The pivot, in one paragraph

> Replace
> [`.github/workflows/github-openclaw-intelligence-agent.yml`](.github/workflows/github-openclaw-intelligence-agent.yml)
> as the source of truth with a `gh-aw` Markdown workflow under
> `.github-openclaw-intelligence/workflows/`. Compile it to YAML during
> `run-install`. Drop default-write permissions and route every
> mutation through `safe-outputs`. Re-express every skill in
> `config/skills.json` as an MCP server registered with `gh-aw-mcpg`,
> with declared egress domains enforced by `gh-aw-firewall`. Move
> `trust-level.ts` from a runtime gate to a compile-time policy that
> the `gh-aw` compiler refuses to violate. Keep `AGENTS.md`/`SOUL`,
> `ENABLED.md`, multi-provider failover, Git-native state, and the
> semantic memory tier as differentiators that ride *on top of* the
> `gh-aw` substrate, not under it.

The rest of this document is what that paragraph actually entails.

---

## 4. Component-by-component pivot

### 4.1 The workflow file

**Today.** `github-openclaw-intelligence-agent.yml` is hand-edited,
357 lines, two jobs, declares `contents/issues/actions: write`, and
encodes the entire trigger surface, authorize step, sentinel guard,
checkout, Bun/Node setup, cache, install, build, and run.

**After pivot.** The authored artefact is, conceptually:

```
.github-openclaw-intelligence/workflows/agent.md
.github-openclaw-intelligence/workflows/install.md
```

each a `gh-aw` Markdown spec with frontmatter declaring its `on:`,
`permissions:` (read-only minimum), `tools:` (allow-listed),
`safe-outputs:` (e.g. `comment`, `react`, `add-label`, `commit`,
`open-pr`), `network:` (domain allowlist), and `mcp-servers:`
(skills exposed as MCP). The agent prose itself — system prompt,
standing orders, slash-command catalogue — lives in the Markdown
body, where `AGENTS.md`'s content can be transcluded.

`.github/workflows/github-openclaw-intelligence-agent.yml` becomes
**generated output**, regenerated by the `run-install` job (now a
compiler driver) and committed with a header banner forbidding manual
edits.

**What dies:** every `if:` block in the current YAML that the compiler
can derive from the spec; the inline bash for authorize/react/guard;
the manual `permissions:` declaration.

**What survives:** the spec is still in Git, still PR-reviewable,
still diff-able. The audit trail does not degrade — it improves,
because the spec is shorter and the generated YAML is regenerable
from it.

### 4.2 Permissions and `safe-outputs`

**Today.** The job has `contents: write, issues: write, actions: write`
for its entire duration. `agent.ts` writes files, commits, pushes,
and calls `gh api` directly via the broad `GITHUB_TOKEN`.

**After pivot.** The job declares `contents: read, issues: read` by
default. `agent.ts` no longer mutates anything directly. Instead it
emits a typed stream of `safe-outputs` JSON objects:

- `{"type": "comment", "issue": N, "body": "…"}`
- `{"type": "react", "target": "comment|issue", "id": N, "content": "rocket"}`
- `{"type": "commit", "paths": ["state/agents/main/sessions/…"], "message": "…"}`
- `{"type": "open-pr", "branch": "…", "title": "…", "body": "…"}`
- `{"type": "add-label", "issue": N, "labels": ["triage"]}`
- `{"type": "dispatch-workflow", "ref": "…", "inputs": {…}}`

A separate, minimal post-step — *the only step that holds write
tokens* — validates each object against a schema and applies it via
the GitHub API. If the agent emits an output that wasn't declared in
the spec's `safe-outputs:` list, the post-step refuses it.

**Consequence for prompt-injection blast radius.** Today, a successful
injection in an issue body can in principle make the agent write
arbitrary files, push to the default branch, label/close any issue,
and dispatch other workflows. After pivot, the worst injection can do
is *request* one of the pre-declared safe-outputs. It cannot exfiltrate
secrets, cannot reach a domain that isn't in the firewall allowlist,
cannot invoke a skill that wasn't compiled into the manifest for the
current trust level, and cannot escalate beyond the structured-output
schema.

This is the single largest security delta in the pivot.

### 4.3 Triggers

**Today.** `issues.opened`, `issue_comment.created`,
`workflow_dispatch`. The `@`-prefix protocol is enforced in the
job's `if:` expression. Nothing reacts to PRs, schedules, CI
failures, discussions, or labels.

**After pivot.** Each trigger surface becomes its own Markdown spec,
each compiled to its own job with its own `permissions:`, `tools:`,
and `safe-outputs:`:

- `agent-issues.md` — current `@` behaviour on issues / issue
  comments.
- `agent-pr.md` — PR-open / PR-sync triggers, restricted to the
  `coding-agent` skill, `safe-outputs: [comment, review]`.
- `agent-schedule.md` — nightly housekeeping: stale-issue triage,
  `memory.log` compaction, session-log rotation, dependency
  scanning.
- `agent-workflow-run.md` — react to CI failures with `gh-issues`.
- `agent-discussion.md` — extend `@` to discussions / discussion
  comments.
- `agent-label.md` — `@triage`-style labels trigger specific
  skills with pre-scoped permissions.

Each is small because the compiler handles the scaffolding. Adding a
new trigger is a spec edit, not a YAML rewrite.

### 4.4 Trust policy

**Today.** `trust-level.ts` runs inside the agent process, computes
the actor's tier from `trustPolicy` in `.pi/settings.json` + the
collaborator-permission API call from the workflow's `Authorize`
step, and decides at *runtime* which commands and skills the actor
may invoke.

**After pivot.** Trust gating becomes a **two-layer defence**:

1. **Compile time.** The `gh-aw` compiler reads `trustPolicy`
   alongside the per-skill manifest (see §4.5) and refuses to emit
   a workflow that lets an `untrusted` actor reach a write-capable
   skill or a write-capable `safe-output`. The team-membership
   gate primitive replaces the ad-hoc collaborator-permission
   check for the highest tier.
2. **Runtime.** `trust-level.ts` survives as defence-in-depth — it
   re-checks the actor at the start of each run, with `block` /
   `read-only-response` behaviours preserved.

The runtime check is no longer load-bearing for security; it is a
seatbelt behind the airbag of compile-time refusal.

### 4.5 Skills

**Today.** Ten skills under `skills/`, loaded via `config/skills.json`,
plus user-supplied skills in `load.extraDirs`. The agent invokes them
in-process. Every skill has implicit access to the open internet, the
filesystem, and any tool the agent runtime exposes. Direct invocation
via `/skill-name`.

**After pivot.** Each skill is re-expressed as an **MCP server**,
registered with `gh-aw-mcpg`. The compile-time manifest declares,
per skill:

- which trust tiers may invoke it,
- which `safe-outputs` it may emit,
- which network domains it needs (fed to `gh-aw-firewall`),
- which secrets it may read,
- which other MCP servers / GitHub APIs it may call.

The runtime no longer loads skills directly — it issues MCP calls
through the gateway. The gateway logs, rate-limits, and authenticates
every call. The firewall denies any egress not in the skill's declared
allowlist.

**What this buys.** Discoverability (every GMI skill becomes an MCP
server other agents can use), enforceable least-privilege per skill,
single auditable choke point for tool traffic, and the ability for
GMI's own skills to be consumed by `gh-aw`-authored workflows
elsewhere — the federation property in §6.

**What it costs.** Every skill has to grow an MCP manifest. The
in-process invocation path becomes an out-of-process RPC. Latency
and complexity rise. `/skill-name` direct invocation has to be
re-implemented as a thin router over MCP. Skills that rely on
implicit shared state with the agent process (if any) need explicit
contracts.

### 4.6 The agent runtime (`agent.ts`)

**Today.** `agent.ts` is the orchestrator: it reads context, calls
the LLM provider, loops over tool calls, manages session state,
mutates the repo, and posts the reply.

**After pivot.** `agent.ts` becomes a **stateless reasoner**:

- Reads inputs from the workflow context (issue/comment, session
  resume hints, trust tier).
- Calls the LLM provider with the prompt and the MCP tool surface
  provided by `gh-aw-mcpg`.
- Emits `safe-outputs` JSON to stdout / a file the post-step reads.
- Returns. Does **not** mutate the repository, does **not** call
  `gh api` directly, does **not** push commits.

This is a much smaller, much more testable program. Session-state
writes become `safe-outputs: commit` operations that the post-step
applies, preserving the Git-native state property without giving the
agent itself the right to push.

### 4.7 Self-installer / upgrader

**Today.** The `run-install` job downloads `main.zip`, preserves
`AGENTS.md`, `.pi/`, `config/`, `state/`, and commits the result.

**After pivot.** `run-install` keeps the data-preservation logic
but gains a **compiler driver**:

1. Read `.github-openclaw-intelligence/workflows/*.md` (the specs).
2. Invoke the `gh-aw` compiler to emit
   `.github/workflows/github-openclaw-intelligence-*.yml`.
3. Resolve every `uses:` to a commit SHA (no floating tags).
4. Commit the regenerated YAML alongside any template changes,
   with a message that names both the template version and the
   compiler version.

The install/upgrade story for the template stays the same from the
user's perspective. The hardened-workflow guarantee comes for free.

### 4.8 Identity and the sentinel

**Today.** `AGENTS.md` → `SOUL` bridge at runtime; `ENABLED.md`
sentinel checked by both `enabled.ts` and a `Guard` step in the
workflow.

**After pivot.** Both survive *unchanged in spirit*:

- `ENABLED.md` becomes a compile-time guard *and* a runtime guard.
  The compiler can refuse to emit any job that runs while the
  sentinel is absent (belt), and `enabled.ts` continues to assert
  it at run start (braces).
- `AGENTS.md` → `SOUL` bridge stays. The Markdown workflow specs
  transclude `AGENTS.md` into the system prompt so the same file
  remains the single source of agent identity.

These are GMI's signature; the pivot must leave them more visible,
not less.

### 4.9 State and memory

**Today.** Everything lives in Git: `state/agents/main/sessions/`,
`state/issues/`, `state/memory.log`. Concurrency is single-issue
via the workflow's `concurrency:` group.

**After pivot.** Git remains the **source of truth**, applied via
`safe-outputs: commit`. Two additions become natural:

- **Semantic index sidecars** under `state/agents/main/index/`,
  rebuilt incrementally on each run and committed alongside
  transcripts. A `/memory` slash command surface (`search`, `pin`,
  `forget`, `export`) becomes the user-facing API.
- **An optional remote cache tier** (e.g. issue-keyed object
  storage) for large media artefacts and embeddings, treated
  strictly as a *cache*. Losing the cache must never change the
  agent's behaviour, only its latency.

This preserves the "everything is committed" property — Git remains
authoritative — while letting the agent grow beyond what's
ergonomic to keep in commit objects.

### 4.10 Multi-provider failover

**Today.** Seven providers behind a single `defaultProvider` switch,
selected via `.pi/settings.json` and passed explicitly via
`--provider`, `--model`, `--thinking` to the OpenClaw CLI.

**After pivot.** Unchanged. `gh-aw` favours fewer model families;
GMI keeps all seven. The provider abstraction sits *inside* the
agent runtime and is invisible to the `gh-aw` substrate, which only
sees "an MCP-speaking process emitting safe-outputs." This is one
of GMI's clearest differentiators and the pivot must not
compromise it.

---

## 5. What `FUTURE.md` understates that a real pivot has to confront

`FUTURE.md` is a careful document. Three things it deliberately
softens that a full pivot cannot:

### 5.1 Mutation latency

In-process file writes inside `agent.ts` are microseconds. A
`safe-outputs: commit` round-trip — agent emits JSON, post-step
parses, post-step pushes — is seconds. For interactive `@`
responses this is invisible, but for long sessions that checkpoint
frequently it adds up. The pivot has to either (a) batch
safe-outputs aggressively, (b) accept the latency as the cost of
the security model, or (c) keep an in-process scratch area and
only "publish" via safe-outputs at session boundaries. (c) is the
right answer, and `FUTURE.md` does not say so explicitly.

### 5.2 Skill ergonomics regression

Re-expressing every skill as an MCP server is a real cost.
Today's skills can lean on shared in-process state with the agent
runtime (file system, environment, the OpenClaw CLI's own tools).
After pivot, every skill needs an explicit MCP contract, its own
manifest of domains and secrets, and a deployment story (process
lifecycle, health checks, restart on crash). For ten skills this
is tractable. For the `load.extraDirs` user-supplied skill story
it is a meaningful UX regression: writing a skill is no longer
"drop a `SKILL.md` in a directory," it is "implement an MCP
server."

A pivot that does not invest in **skill scaffolding tooling**
(`gmi new skill` → generates an MCP server skeleton with manifest)
will degrade the skills experience that `FUTURE.md` correctly
identifies as a GMI strength.

### 5.3 Compiler ownership

`FUTURE.md` says "emit GMI's workflow from a Markdown spec." It
does not say *who maintains the compiler*. There are three options:

1. **Depend on the upstream `gh-aw` compiler** as a versioned tool
   pulled at install time. Minimum maintenance burden; maximum
   coupling to upstream's release cadence and breaking changes.
2. **Vendor `gh-aw`'s compiler** into the GMI template. Insulates
   from upstream churn; takes on the cost of tracking upstream
   security fixes.
3. **Write a GMI-specific subset compiler** that understands only
   the spec dialect GMI needs. Smallest surface; highest
   independence; duplicates work.

A full pivot should pick (1) initially and have a documented
fall-back to (2) once `gh-aw` either stabilises or proves to churn
faster than GMI can absorb. (3) is a trap.

### 5.4 The two-template problem

Once the workflow is compiled from a spec, the GMI template
contains **two layers**:

- The agent template (skills, lifecycle, configs, `AGENTS.md`).
- The workflow spec set (Markdown that compiles to YAML).

`run-install`'s upgrade logic today preserves
`AGENTS.md`, `.pi/`, `config/`, `state/` across a template refresh.
After pivot it must also reason about **spec drift** — what
happens when a user has customised a workflow spec and the
template ships a new version of the same file. This is a
non-trivial merge problem and `FUTURE.md` skips it. The honest
answer is probably: workflow specs are template-owned and
*overwritten* on upgrade; user customisation happens through
declared extension points (additional skills, additional
triggers in user-owned spec files), not by editing template
specs.

---

## 6. What survives the pivot intact (the non-negotiables)

These are the properties that distinguish GMI from "a `gh-aw`
workflow with extra steps." A pivot that loses any of them has
failed:

1. **`AGENTS.md` → `SOUL` bridge.** The agent's identity is
   human-auditable in Git.
2. **`ENABLED.md` sentinel.** Fail-closed kill switch. One file,
   one commit to disable.
3. **Git-native state.** Sessions, memory, issue maps all live in
   commits, replicated wherever the repo is cloned. Remote stores
   are caches, not authorities.
4. **Multi-provider failover.** Seven providers, settings-driven,
   no `gh-aw` provider lock-in.
5. **Slash-command surface.** `@ /status`, `@ /help`, `@ /skill`,
   etc., remain user-facing.
6. **Schema-validated settings.** Drift caught at preflight.
7. **Self-installer / upgrader** with user-data preservation.

Everything else in this document is either substitution
(YAML ← Markdown spec, in-process tools ← MCP), addition
(firewall, gateway, safe-outputs, compile-time policy), or
contraction (broad write perms → least-privilege defaults).

---

## 7. What dies in a full pivot (the honest list)

A document called PIVOT that doesn't enumerate losses is not honest.
The full pivot retires:

- **The hand-edited workflow YAML as a source of truth.** It still
  exists, but only as compiler output. PRs that edit it directly
  must be rejected.
- **Direct repo mutation from `agent.ts`.** Replaced by
  `safe-outputs`.
- **Open-internet egress for skills.** Replaced by per-skill
  allowlists.
- **In-process skill invocation.** Replaced by MCP calls.
- **The "drop a `SKILL.md` in a directory" skill UX** (in its
  current form). Replaced by MCP-server skill skeletons.
- **Single coarse `permissions:` block.** Replaced by per-job,
  per-trigger least-privilege scoping.
- **Runtime-only trust gating.** Demoted to defence-in-depth
  behind compile-time policy.
- **Direct `gh api` calls from inline workflow bash** for
  authorize/react/reject. Replaced by `gh-aw-actions` reusables
  and `safe-outputs`.

None of these are losses of *capability*. They are losses of
*shape*. The agent still reacts to `@`, still posts, still labels,
still commits — but the path from "agent decided to do X" to "X
happened to the repo" gets longer, narrower, and auditable.

---

## 8. Where this analysis diverges from `FUTURE.md`

Both documents see the same primitives and agree on the long-term
direction. They differ in **commitment level**:

| Question | `FUTURE.md` answer | `PIVOT.md` answer |
|---|---|---|
| Is the YAML the source of truth? | Eventually replaced by a spec | **Replaced immediately**; YAML is compiled output |
| Default permissions? | Reduce to read-only over Phase 1–2 | **Read-only from day one of the pivot** |
| Skills as MCP servers? | "Bridge" — expose them when the gateway is present | **All skills are MCP servers**; in-process loading is removed |
| Runtime trust gating? | Keep, layer compile-time on top | **Demote** to defence-in-depth; compile-time is load-bearing |
| Network egress? | Opt-in per skill | **Default deny**; every domain declared in the manifest |
| Sub-agents? | Future phase | Compose naturally once skills are MCP servers; no special case |
| The 5-phase roadmap | Hardening → Substrate → Surface → Differentiation → Productisation | **Two phases**: pivot the substrate, then invest the freed budget in the differentiators |

`FUTURE.md` is the right document if the constraint is "ship
nothing that breaks current users." `PIVOT.md` is the right
document if the constraint is "what would we build if we were
starting today against the `gh-aw` ecosystem as it now exists."

The honest recommendation is: **`FUTURE.md`'s phasing is correct;
`PIVOT.md`'s end state is correct.** Phase 1 of `FUTURE.md`
(hardening) should be done immediately. Phase 2 (substrate) should
be done with the *PIVOT end state in mind* — i.e., do not treat
the safe-outputs layer, the MCP gateway integration, or the
compile-time policy as optional, because every "optional" gate
becomes a permanent crutch.

---

## 9. The smallest credible first step

If only one thing changes this month, it should be this:

> Introduce a `safe-outputs` layer in `lifecycle/` such that **every
> repository mutation `agent.ts` performs is expressed as structured
> JSON consumed by a new post-step**. Drop the workflow's default
> `permissions:` to `contents: read, issues: read` and elevate only
> inside that post-step.

This single change:

- Cuts the prompt-injection blast radius by an order of magnitude.
- Costs no MCP, no compiler, no firewall, no Markdown spec.
- Is reversible if it breaks anything.
- Makes every subsequent pivot step (per-skill manifests,
  domain allowlists, compile-time policy, MCP migration) **mean
  something concrete** — they all become "narrow the surface of
  the safe-outputs layer further" rather than "build a new
  security model from scratch."

Every other change in this document depends on this one. None of
them are worth doing if `agent.ts` retains broad write tokens.

---

## 10. Closing

`gh-aw` is the clearest signal GitHub has yet sent about how it
believes agentic systems should be built on its platform: declared,
compiled, sandboxed, allow-listed, sanitised, SHA-pinned, machine-
legible. GMI can stay on its hand-rolled substrate and remain a
clever bot, or it can adopt `gh-aw` as substrate and become a
serious agent.

`FUTURE.md` argues — correctly — that this adoption is the work of
the next 12–24 months and need not look like a rewrite. This
document argues — also correctly — that the *end state* is a full
pivot, and that pretending otherwise will leave half the security
benefits unrealised because the optional gate is never closed.

The two documents are not in conflict. `FUTURE.md` is the **plan**.
`PIVOT.md` is the **destination**. Read together, they say:

> Take `FUTURE.md`'s phased path. At every junction where a phase
> says "optional," consult `PIVOT.md` and choose the option that
> moves the load-bearing edge from runtime to compile time, from
> the agent to the post-step, from open egress to declared
> egress. The phases are a kindness to existing users; the
> destination is not negotiable.

— Drafted against the repository at this commit and against
[`FUTURE.md`](FUTURE.md), with reference to the public `gh-aw`
documentation at <https://github.github.com/gh-aw>.
