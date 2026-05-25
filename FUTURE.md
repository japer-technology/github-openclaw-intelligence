# FUTURE.md

> A deep analysis of what **GitHub OpenClaw Intelligence (GMI)** can become,
> read against the architecture, guardrails, and ecosystem of
> **GitHub Agentic Workflows (`gh-aw`)** —
> <https://github.github.com/gh-aw>.

---

## 0. Why this document exists

GMI today is a *single, opinionated, tool-rich AI agent* that lives in a
repository, is activated by the `@` prefix on issues and comments, and runs
through a hand-rolled GitHub Actions workflow
([`.github/workflows/github-openclaw-intelligence-agent.yml`](.github/workflows/github-openclaw-intelligence-agent.yml))
backed by a TypeScript lifecycle pipeline
([`enabled.ts` → `preflight.ts` → `agent.ts`](.github-openclaw-intelligence/lifecycle/)).
It ships its own trust model, sentinel-based kill switch, settings schema,
skills allowlist, and self-installer.

`gh-aw` is GitHub Next's emerging *platform* for authoring **agentic
workflows in natural-language Markdown** that compile to standard GitHub
Actions. It is built around hard-won primitives — read-only-by-default
permissions, sanitized `safe-outputs`, SHA-pinned supply chains, tool
allow-listing, compile-time validation, network egress firewalling
(`gh-aw-firewall`), an MCP gateway (`gh-aw-mcpg`), shared action library
(`gh-aw-actions`), and machine-readable docs (`llms.txt` / `llms-full.txt`).

These two projects are converging on the same problem from opposite
directions:

- **GMI** is "one agent, deeply integrated, opinionated, multi-provider,
  stateful in Git."
- **gh-aw** is "many agents, declaratively authored, secured by
  construction, platform-grade."

Treating `gh-aw` as a *reference architecture* rather than a competitor is
the most productive framing for GMI's next 12–24 months.

---

## 1. Where GMI is today (honest snapshot)

What GMI already gets right:

- **Repository-native agent identity.** `AGENTS.md` → `SOUL` bridge, plus
  the *fail-closed* `ENABLED.md` sentinel, makes the agent's presence and
  authority *human-auditable in Git*. This is a quality `gh-aw` does not
  natively provide and that GMI should keep as a differentiator.
- **A real lifecycle pipeline.** `enabled → preflight → install → agent`
  with each stage independently testable is closer to a production runtime
  than most "AI bot" projects.
- **Trust policy with per-actor capability gating.** Trusted / semi-trusted
  / untrusted is the right shape, even if today it leans on
  `collaborators/.../permission`.
- **Schema-validated settings.** `config/settings.schema.json` validated at
  preflight catches drift before any LLM call.
- **Multi-provider failover.** OpenAI, Anthropic, Google, xAI, OpenRouter,
  Mistral, Groq behind a single `defaultProvider` switch is rare and
  valuable.
- **Skills as a first-class extension surface.** `config/skills.json` with
  bundled + extra-dir loading, plus `/skill-name` direct invocation, is
  conceptually close to MCP servers but lives in user space.
- **Self-installer / upgrader.** `workflow_dispatch` job that pulls
  `main.zip`, preserves `.pi/`, `config/`, `AGENTS.md`, and `state/`,
  is a clean update story.

What is currently fragile:

- **One handwritten workflow file** carries the entire trigger surface,
  auth, guard, install, build, and run logic. Every new trigger
  (`pull_request`, `schedule`, `discussion`, `workflow_run`, …) means
  hand-editing YAML.
- **Trigger surface is narrow.** Only `issues.opened` and
  `issue_comment.created` with an `@` prefix. No PRs, no scheduled
  agents, no event-driven sub-agents.
- **Permissions are coarse.** The job grants
  `contents: write`, `issues: write`, `actions: write` unconditionally
  for the entire run, regardless of what the user asked for.
- **No sandboxed network egress.** Anything the agent's tools fetch goes
  to the open internet.
- **No compile-time validation of the agent's tool surface.** Whether a
  given skill is actually safe to expose for a given trust level is
  decided at runtime, in TypeScript, per session.
- **State lives only in Git.** That is great for auditability and terrible
  for concurrency, large transcripts, and cross-repo memory.
- **`/skill-name` is the only structured surface** for routing beyond
  free-form `@`.

This is the right base. It is not yet a platform.

---

## 2. What `gh-aw` actually contributes to the conversation

Stripped to its load-bearing ideas, `gh-aw` is teaching the ecosystem
five lessons GMI should absorb on its own terms:

1. **Workflows as natural-language Markdown that *compile* to Actions.**
   The author writes intent; a compiler emits the YAML, the permissions,
   the SHA-pinned `uses:`, the safe-output wrappers. The human-edited
   surface is small; the generated surface is large and
   security-reviewed.

2. **Read-only by default, write only through `safe-outputs`.**
   The agent cannot mutate the repository directly. It emits structured
   "outputs" (create issue, comment, open PR, add label, dispatch
   workflow) that a *separate, minimal* step validates and applies. This
   collapses the blast radius of any prompt injection or model mistake.

3. **Layered isolation: sandbox + network firewall + MCP gateway.**
   - Sandboxed execution per job.
   - `gh-aw-firewall` enforces domain-level egress allowlists.
   - `gh-aw-mcpg` routes all MCP traffic through one auditable HTTP gateway.
   - SHA-pinned dependencies for supply-chain integrity.
   - Tool allow-listing decided at compile time, not at runtime.

4. **Human approval gates as first-class workflow primitives**, gated by
   team membership rather than by ad-hoc per-actor permission checks.

5. **Documentation designed to be consumed by agents** — `llms.txt` /
   `llms-full.txt` — so other agents (including GMI) can reason about
   `gh-aw` itself without scraping HTML.

None of these require GMI to *become* `gh-aw`. They do define a moving
baseline for "what a serious agentic system on GitHub looks like." GMI
should adopt the *primitives* while keeping its own *posture*.

---

## 3. Strategic positioning: what GMI should be, in one sentence

> **GMI is the *resident, stateful, multi-skill agent* that lives in your
> repository, and `gh-aw` is the *compiler and guardrail layer* it should
> stand on.**

Concretely, that means GMI should stop being "an agent built on a hand-
rolled workflow" and become "an agent whose workflow surface is generated
and policed by `gh-aw` primitives, while keeping its own runtime,
identity, skills, memory, and trust model."

This re-positioning is non-destructive: every existing GMI capability
(SOUL bridge, sentinel, trust policy, skills, multi-provider failover,
slash commands, semantic memory, sub-agent orchestration) survives. What
changes is the *substrate* underneath.

---

## 4. Convergence map: what GMI already does vs. what `gh-aw` offers

| Concern                | GMI today                                       | `gh-aw` equivalent                          | Direction for GMI |
|------------------------|-------------------------------------------------|---------------------------------------------|-------------------|
| Workflow authoring     | Single hand-edited YAML                         | Markdown → compiled YAML                    | **Adopt** — emit GMI's workflow from a Markdown spec checked into `.github-openclaw-intelligence/workflows/` |
| Default permissions    | `contents/issues/actions: write` always         | Read-only default + `safe-outputs`          | **Adopt** — drop default-write; route mutations through a typed `safe-outputs` layer |
| Trigger surface        | `issues`, `issue_comment`, `workflow_dispatch`  | `pull_request`, `schedule`, `discussion`, `workflow_run`, …  | **Expand** — let GMI react to PRs, schedules, CI failures, label events |
| Trust gating           | Runtime check in TypeScript                     | Compile-time + team-membership gates        | **Layer** — keep runtime checks, *add* compile-time policy compilation |
| Tool allowlist         | Runtime via `config/skills.json`                | Compile-time tool allow-listing             | **Layer** — emit a compile-time manifest that `gh-aw` can verify |
| Network egress         | Open internet                                   | `gh-aw-firewall`                            | **Adopt** — opt-in domain allowlist per skill |
| MCP routing            | Direct from runtime                             | `gh-aw-mcpg` central gateway                | **Adopt** — route GMI's MCP calls through the gateway when present |
| Supply chain           | `actions/checkout@v4`, `oven-sh/setup-bun@v2` (tags) | SHA-pinned                            | **Adopt** — pin all `uses:` to commit SHAs in generated YAML |
| Docs for agents        | Human Markdown only                             | `llms.txt` / `llms-full.txt`                | **Adopt** — publish GMI's own `llms.txt` and `llms-full.txt` under `public-fabric/` |
| State                  | Git only (`state/`)                             | Job-scoped, ephemeral                       | **Differentiator** — keep Git-native state, add optional remote tier |
| Identity               | `AGENTS.md` + `SOUL` + `ENABLED.md` sentinel    | None                                        | **Differentiator** — double down |
| Multi-provider         | 7 providers + failover                          | Copilot / Claude / Codex / Gemini           | **Differentiator** — keep |
| Skills                 | First-class user-space skills                   | Tools / MCP servers                         | **Bridge** — expose every GMI skill as an MCP server through `gh-aw-mcpg` |

The pattern is clear: **adopt the substrate, keep the soul.**

---

## 5. Concrete adoption opportunities (ranked by leverage)

### 5.1 Replace the handwritten workflow with a compiled one

- Author the GMI workflow as a `gh-aw`-style Markdown spec in
  `.github-openclaw-intelligence/workflows/agent.md` describing triggers,
  permissions, safe-outputs, secrets, and the `agent.ts` invocation.
- Generate `.github/workflows/github-openclaw-intelligence-agent.yml`
  from it at install/upgrade time (the existing `run-install` job is the
  natural home for the compiler).
- Outcome: the human-edited YAML disappears; the security review surface
  collapses to the spec + the compiler.

### 5.2 Adopt `safe-outputs` for every repository mutation

Today the agent commits files, opens comments, and reacts directly using
the workflow's broad write permissions. Replace this with a typed
`safe-outputs` layer:

- `agent.ts` writes structured JSON outputs (`comment`, `react`,
  `commit`, `open-pr`, `add-label`, `close-issue`, `dispatch-workflow`).
- A minimal follow-up step — *the only step with write tokens* — validates
  the schema and applies the action.
- Effect: a successful prompt-injection cannot exfiltrate or rewrite the
  repo; the worst it can do is request an action the safe-output layer
  refuses.

### 5.3 Compile-time skill/tool manifest per trust level

- For each skill in `config/skills.json`, declare:
  - which trust levels may invoke it,
  - which network domains it needs,
  - which MCP servers it depends on,
  - which `safe-outputs` it is allowed to emit.
- The compiler refuses to emit a workflow that lets an `untrusted` actor
  reach a write-capable skill.
- This turns `trust-level.ts` from a runtime gate into a *defense in
  depth* layer behind a compile-time gate.

### 5.4 Plug into the `gh-aw` companion services

- **`gh-aw-firewall`** — opt in per-repo via
  `.pi/settings.json.network.allowDomains`. The compiler injects the
  firewall side-car and a default deny.
- **`gh-aw-mcpg`** — when present, GMI's skills register as MCP servers
  behind the gateway, so all tool calls flow through one auditable
  endpoint and benefit from gateway-side rate-limiting, logging, and
  auth.
- **`gh-aw-actions`** — replace the inline bash in
  `github-openclaw-intelligence-agent.yml`
  (authorize, react, checkout, guard) with vetted, SHA-pinned shared
  actions where they exist.

### 5.5 Expand the trigger surface

Once `safe-outputs` is in place, lighting up new triggers becomes a spec
edit rather than a YAML rewrite:

- `pull_request[.opened|.synchronize]` → automated review with the
  `coding-agent` skill, gated to `safe-outputs: comment, review`.
- `schedule` → nightly housekeeping: stale-issue triage, dependency
  scans, `memory.log` compaction, `state/agents/main/sessions/` rotation.
- `workflow_run` → react to CI failures with the `gh-issues` skill.
- `discussion` / `discussion_comment` → extend `@` activation beyond
  issues.
- `label` → `@triage`-style labels could trigger specific skills with
  pre-scoped permissions.

### 5.6 Publish `llms.txt` and `llms-full.txt`

GMI already has rich human Markdown in `.github-openclaw-intelligence/`
and a GitHub Pages site under `public-fabric/`. Generating:

- `public-fabric/llms.txt` — short, structured, link-rich index,
- `public-fabric/llms-full.txt` — full corpus,

makes GMI legible to other agents (including `gh-aw` workflows and other
GMI instances) without scraping. This is cheap and high-leverage for an
ecosystem that increasingly assumes its presence.

### 5.7 SHA-pin everything the compiler emits

The current workflow uses `actions/checkout@v4`, `oven-sh/setup-bun@v2`,
`actions/cache@v5`, `actions/setup-node@v4`. The compiler should resolve
these to commit SHAs at install time, write the SHA + a comment with the
human tag, and re-resolve on `run-install` upgrade.

---

## 6. Capabilities GMI can build that `gh-aw` does not aim to provide

These are the differentiators worth investing in *because* `gh-aw` is
deliberately staying minimal:

### 6.1 Persistent, queryable agent memory

`state/memory.log` is already append-only with `merge=union` in
`.gitattributes`. The next step:

- A **semantic index** (BM25 + embeddings is already listed as a tool)
  built incrementally on each run and committed under
  `state/agents/main/index/`.
- A `/memory` slash command surface: `search`, `forget`, `pin`, `export`.
- Cross-session continuity that doesn't depend on the LLM's context
  window.

### 6.2 Stateful, resumable sessions

`state/agents/main/sessions/` already stores JSONL transcripts and
`state/issues/` maps issues to sessions. Make this a first-class
contract:

- Idempotent resume: a re-triggered workflow continues the same session
  rather than starting over.
- A `/sessions resume <id>` command.
- Session checkpoints committed as their own commits with a fixed
  prefix, so they can be filtered out of `git log` views.

### 6.3 Sub-agent orchestration as a workflow primitive

`extensions.json` advertises `sub-agents: true`, and the `task` tool
exists. Promote this to:

- A declared "team" of sub-agents in
  `.github-openclaw-intelligence/agents/` (e.g. `reviewer.md`,
  `triager.md`, `release-notes.md`), each with its own `SOUL`, trust
  policy, skill allowlist, and budget.
- A scheduler in `agent.ts` that fans work out to sub-agents and joins
  results, with each sub-agent's transcript checkpointed under
  `state/agents/<name>/`.

### 6.4 Cross-repo federation

Because every GMI instance has the same shape, two GMIs can talk:

- A skill that calls another repo's GMI via `repository_dispatch` or via
  the MCP gateway.
- A shared "fleet config" repo whose `.github-openclaw-intelligence/`
  is the canonical version, with per-repo overlays.

### 6.5 Cost and budget enforcement as a first-class contract

`limits.maxTokensPerRun`, `maxToolCallsPerRun`,
`workflowTimeoutMinutes` already exist. Extend to:

- Per-skill budgets.
- Per-actor monthly budgets surfaced via `/status`.
- Provider-aware cost estimates pre-flighted before each run,
  with a typed `safe-outputs` action for "ask the user before exceeding."

### 6.6 An evaluation harness that runs in CI

A `gmi-eval.yml` workflow that, on each release of the
`.github-openclaw-intelligence/` template:

- Replays a fixture set of issues against the new template,
- Diffs outputs against a baseline,
- Gates the release on regression thresholds.

This is what turns GMI from a clever bot into a product.

---

## 7. The biggest risks if GMI does *not* adapt

1. **Security delta.** `gh-aw`-authored agents will, by construction, run
   with narrower permissions and isolated networks. A GMI that stays on
   broad-write workflows will look careless by comparison, even if its
   runtime gates are good.
2. **Authoring delta.** Once teams get used to writing agents in
   Markdown, hand-edited YAML feels archaic. New skills will land in
   `gh-aw` first.
3. **Tooling delta.** MCP is becoming the lingua franca. Skills that are
   not addressable as MCP servers will be invisible to other agents.
4. **Discoverability delta.** Agents without `llms.txt` will be opaque to
   the very systems most likely to integrate with them.
5. **Audit delta.** Compile-time policy is easier to review and certify
   than runtime policy. Enterprises will prefer the former.

None of these are existential individually. Together, they would push
GMI into a niche.

---

## 8. The biggest risks if GMI *over*-adapts

1. **Loss of identity.** The `AGENTS.md` → `SOUL` bridge and the
   sentinel are GMI's signature. They must survive any refactor.
2. **Loss of multi-provider neutrality.** `gh-aw` is friendly to four
   model families; GMI supports seven. The provider abstraction in
   `.pi/settings.json` must not be compromised by adopting any
   gh-aw-specific provider plumbing.
3. **Loss of Git-native auditability.** If state migrates wholesale to
   an external store, the "everything is committed" property dies.
   Treat any external store as a *cache*, not as a source of truth.
4. **Premature platformification.** Building a compiler, a federation
   layer, and an eval harness all at once will collapse under its own
   weight. The roadmap below is deliberately staged.

---

## 9. A phased roadmap

### Phase 1 — Hardening (smallest changes, biggest security wins)

- SHA-pin every `uses:` in the generated workflow.
- Introduce a typed `safe-outputs` layer in `lifecycle/` and route every
  repository mutation through it.
- Reduce default `permissions:` in the workflow to `contents: read,
  issues: read`; elevate only inside the safe-outputs step.
- Publish `public-fabric/llms.txt` and `llms-full.txt`.

### Phase 2 — Substrate (adopt `gh-aw` primitives)

- Author the workflow as a Markdown spec under
  `.github-openclaw-intelligence/workflows/` and emit YAML from
  `run-install`.
- Compile-time skill manifest: `(skill, trust, domains, safe-outputs)`.
- Optional `gh-aw-firewall` and `gh-aw-mcpg` integration when present.
- Expose each skill as an MCP server.

### Phase 3 — Surface expansion

- `pull_request`, `schedule`, `workflow_run`, `discussion`, `label`
  triggers, each with their own scoped safe-outputs and skill
  allowlist.
- A `/team` surface for declaring sub-agents in
  `.github-openclaw-intelligence/agents/`.

### Phase 4 — Differentiation

- Semantic memory index with `/memory` commands.
- Resumable sessions with checkpoint commits.
- Per-skill / per-actor budgets and pre-flight cost estimation.
- Cross-repo federation through MCP.
- CI eval harness gating template releases.

### Phase 5 — Productisation

- A signed, versioned release channel for the template (today's `VERSION`
  + `run-install` is the seed).
- A reference catalogue of vetted skills and sub-agent personas.
- Enterprise posture: SBOM for `.github-openclaw-intelligence/`,
  reproducible installs, attestation that the running workflow was
  emitted from the committed spec.

---

## 10. Closing read

`gh-aw` is GitHub telling the ecosystem how it thinks agentic systems
should be built on its platform: declared, compiled, sandboxed,
allow-listed, sanitized, SHA-pinned, and machine-legible. That is the
*floor*.

GMI's opportunity is to stand on that floor while keeping what `gh-aw`
deliberately does not provide: a **named, persistent, stateful, multi-
skill, multi-provider agent with a soul, a memory, and a kill switch,
all checked into Git**.

The work over the next year is therefore not a pivot. It is the careful
substitution of GMI's hand-rolled substrate for `gh-aw`'s vetted one,
preserving every existing capability while inheriting a security and
authoring posture GMI cannot reasonably build alone — and then spending
the freed engineering budget on the parts of the agent that only GMI is
positioned to build.

— Drafted against the repository at this commit, and against the public
`gh-aw` documentation at <https://github.github.com/gh-aw>.
