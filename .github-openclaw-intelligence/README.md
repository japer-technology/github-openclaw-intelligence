# OpenClaw Intelligence

> A standalone tool-rich AI agent that lives inside your GitHub repository.

OpenClaw Intelligence is activated by the `@` prefix on issues and comments. It provides a rich tool surface — including sub-agent orchestration, semantic memory search, media understanding, and multi-model failover — while keeping all session state, file changes, and conversation history in Git.

---

## How It Works

1. **Open an issue or pull request** (or add a comment / PR review) starting with `@`.
2. **GitHub Actions** detects the prefix and runs the OpenClaw workflow.
3. **The agent** reads your prompt, uses its extended tool surface to process it, and posts the response as a comment.
4. **Everything is committed** — session state, file changes, and conversation history all live in Git.

In addition, a **scheduled maintenance** run executes weekly (no `@` prefix and no
originating issue) to perform low-risk housekeeping such as pruning stale session
state. See [Triggers](#triggers) below.

Prefer the terminal? The same agent also runs entirely on your machine — see
[Local Chat (`bun run chat`)](#local-chat-bun-run-chat).

---

## Triggers

The agent responds to the following events when the title/body starts with `@`
(only collaborators with write access or higher can trigger it):

| Event | Activates on |
|-------|-------------|
| Issue opened | Title starts with `@` |
| Issue comment | Body starts with `@` (bots ignored) |
| Pull request opened | Title starts with `@` |
| PR review submitted | Review body starts with `@` (bots ignored) |
| PR review comment | Body starts with `@` (bots ignored) |
| Schedule (weekly cron) | Always — runs maintenance, no `@` needed |

Scheduled maintenance runs skip authorization (there is no triggering user) and
perform deterministic, low-risk housekeeping only. GitHub Actions cron timing is
approximate — runs may be delayed by 5–60 minutes under load.

---

## The Prefix Protocol

| Prefix | Intelligence | Description |
|--------|-------------|-------------|
| `@` | OpenClaw Intelligence | Tool-rich, complex multi-step tasks |
| _(other)_ | None | No agent responds |

---

## Local Chat (`bun run chat`)

Talk to the **same agent from your terminal** — no GitHub Issues, no Actions, no `gh` CLI. The local runner (`lifecycle/local-chat.ts`) reuses the repository's identity (`AGENTS.md`), long-term memory (`MEMORY.md`), provider settings (`.pi/settings.json`), and skill packages verbatim, so local conversations behave identically to issue-driven ones — only the I/O surface changes.

### Quick Start

```bash
# 1. Install Bun and Node.js (once)
#    OpenClaw requires Node.js >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0
#    Bun: https://bun.sh
#    Windows:  powershell -c "irm bun.sh/install.ps1 | iex"
#    macOS/Linux:  curl -fsSL https://bun.sh/install | bash

# 2. Install dependencies (once, from the repository root)
cd .github-openclaw-intelligence
bun install

# 3. Provide an API key for the provider configured in .pi/settings.json
#    (default provider: openai)
export OPENAI_API_KEY="sk-..."        # bash/zsh
#  or:  setx OPENAI_API_KEY "sk-..."  # PowerShell (new terminals)

# 4. Chat
bun run chat
```

PowerShell users should run each command separately. After `Set-Location .\.github-openclaw-intelligence`, run `bun install`, then run `bun run chat`; do not combine `cd` and `bun run chat` in one command.

`bun run chat` with no arguments opens an **interactive launcher**: it lists your existing threads and lets you resume one, create a new one, or quit. Inside the chat, type `/help` for the full in-chat command list and `/exit` (or Ctrl-C) to leave.

**No API key?** The runner never crashes on a missing key — it walks you through your options: paste a key for the current session only, auto-scan your LAN for a running LM Studio server, or print instructions for setting the environment variable permanently.

### CLI Reference

| Command | Purpose |
|---------|---------|
| `bun run chat` | Interactive launcher (pick or create a thread) |
| `bun run chat --new [--name <alias>]` | Create a new thread; prints its ID |
| `bun run chat --thread <id\|alias> [prompt...]` | Continue a thread; REPL if no prompt given |
| `bun run chat --list` | List all threads |
| `bun run chat --rm <id\|alias>` | Delete a thread mapping (transcript preserved) |
| `bun run chat --help` | Show usage help |

**Threads** are the local analogue of GitHub issues: numbered conversations with optional aliases, stored as gitignored JSON under `state/threads/`. Thread identity is *closed-world* — IDs are only created by this tool, and unknown references are rejected rather than silently auto-created, so a typo can never fork your conversation.

### In-Chat Commands

Type `/help` inside the chat for the complete list. Highlights:

| Command | Purpose |
|---------|---------|
| `/status` | Provider, model, thread, branch, memory, toggles |
| `/model <id>` / `/model <provider>:<id>` | Switch model (and provider) mid-session |
| `/provider <name>` | Switch provider (`lmstudio`, `ollama`, `vllm`, `openai`, …) |
| `/list`, `/new`, `/switch`, `/rename` | Manage and hop between threads |
| `/history`, `/export md` | Review or export the conversation |
| `/retry`, `/again`, `/best-of <n>` | Re-run the last prompt (same/new/multiple threads) |
| `/remember <text>`, `/memories [term]` | Append to / search the memory log |
| `/cat`, `/md`, `/git`, `/diff`, `/run` | Inspect files and repo state without leaving chat |
| `/multiline` | Paste multi-line input (blank line submits) |

### Local Model Servers (no cloud key required)

Point the chat at any OpenAI-compatible local server — LM Studio, Ollama, or vLLM — and no cloud credentials are needed:

```bash
# LM Studio (default endpoint http://localhost:1234/v1)
LOCAL_PROVIDER=lmstudio LOCAL_MODEL=google/gemma-3-27b bun run chat

# Ollama (default endpoint http://localhost:11434/v1)
LOCAL_PROVIDER=ollama LOCAL_MODEL=llama3.1 bun run chat

# Any other OpenAI-compatible server
LOCAL_PROVIDER=openai LOCAL_MODEL=my-model \
LOCAL_LLM_BASE_URL=http://192.168.1.50:8000/v1 bun run chat
```

Known local brands (`lmstudio`, `ollama`, `vllm`) get their default endpoint auto-filled and auto-retry enabled. A placeholder API key (`local`) is sent automatically, since OpenAI SDK clients require one even when the server ignores it.

### Environment Overrides

Highest precedence first: environment variables, then `.pi/settings.json`, then built-in defaults.

| Variable | Effect |
|----------|--------|
| `LOCAL_PROVIDER` | Override `defaultProvider` from `.pi/settings.json` |
| `LOCAL_MODEL` | Override `defaultModel` |
| `LOCAL_THINKING` | Override `defaultThinkingLevel` (`low`, `medium`, `high`) |
| `LOCAL_LLM_BASE_URL` | OpenAI-compatible base URL for a local/remote server |
| `OPENCLAW_NODE` | Node.js executable used to launch OpenClaw (defaults to `node` from `PATH`) |
| `NO_COLOR` / `FORCE_COLOR` | Disable / force ANSI colour output |

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `openclaw binary not found` | Run `bun install` inside `.github-openclaw-intelligence/` |
| `missing node:sqlite` | Install a supported Node.js version (Node 24.15+ recommended). OpenClaw cannot run under Bun. |
| `Set-Location : A positional parameter cannot be found that accepts argument 'run'` | You are passing `bun run chat` to PowerShell's `cd`. Run `Set-Location .\.github-openclaw-intelligence` first, then run `bun run chat` as a separate command. |
| `Integrity check failed for tarball` during install | `bun pm cache rm && bun install` |
| Missing API key prompt | Set the provider's env var (see [Supported Providers](#supported-providers)), or choose the LM Studio scan option |
| Empty / garbled reply | Inspect the raw streams saved at `state/local-last-run.log` |
| `Provider error: … context length …` (LM Studio) | The loaded model's context length is too small for the agent's system prompt. In LM Studio, reload the model with a larger context length (16k+ recommended). |
| `The assistant turn failed before producing content` | The provider rejected the request — the failure message includes the provider's original error and a hint; full logs are at `state/local-last-run.log` |
| Local server not responding | Verify the server is running and `LOCAL_LLM_BASE_URL` matches its endpoint |

Exit codes: `0` success · `1` environment problem (missing key/binary) · `2` user error (unknown thread, invalid alias).

All local-chat state (threads, transcripts, runtime config, logs) lives under the gitignored `state/` directory — local runs never touch committed files.

---

## Project Structure

```
.github-openclaw-intelligence/
├── .pi/
│   └── settings.json              # LLM provider, model, thinking level, trust policy, limits
├── AGENTS.md                      # Agent identity and standing orders
├── MEMORY.md                      # Committed long-term memory seed (bridged at runtime)
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── ENABLED.md                     # Sentinel — delete to disable the agent (fail-closed)
├── LICENSE.md
├── PACKAGES.md
├── README.md
├── SECURITY.md
├── VERSION
├── config/
│   ├── extensions.json            # Extension and skill activation
│   ├── settings.schema.json       # JSON Schema for .pi/settings.json validation
│   └── skills.json                # Bundled skill allowlist and extra dirs
├── docs/
│   └── analysis/                  # Dependency and feature analysis documents
├── install/
│   ├── OPENCLAW-AGENTS.md         # Default AGENTS.md for fresh installs
│   └── settings.json              # Default .pi/settings.json
├── lifecycle/
│   ├── agent.ts                   # Core orchestrator (GitHub Actions entry point)
│   ├── command-parser.ts          # Slash command parser (openclaw CLI registry)
│   ├── command-parser.test.ts     # Command parser tests
│   ├── enabled.ts                 # Fail-closed sentinel guard
│   ├── local-chat.ts              # Local terminal chat runner (`bun run chat`)
│   ├── preflight.ts               # Pre-run config and structural validation
│   ├── trust-level.ts             # Trust-level resolution per actor
│   └── trust-level.test.ts        # Trust-level tests
├── package.json
├── public-fabric/                 # GitHub Pages content
├── skills/                        # Runtime-linked skills (symlinks to bundled)
└── state/
    ├── agents/main/sessions/      # Conversation transcripts (JSONL)
    ├── issues/                    # Issue-to-session mappings
    ├── threads/                   # Local-chat thread records (gitignored)
    └── memory.log                 # Append-only long-term memory
```

---

## Fail-Closed Sentinel

The `ENABLED.md` file is a **sentinel**. Its presence means OpenClaw Intelligence is active in this repository. Every workflow run begins by checking for this file — if it is absent, the run exits immediately with a non-zero status, preventing the agent from executing.

- **To disable the agent**: `git rm .github-openclaw-intelligence/ENABLED.md && git commit -m "chore: disable" && git push`
- **To re-enable**: restore the file and push.

This is a fail-closed design — the agent never runs unless a human has deliberately enabled it.

---

## Lifecycle Pipeline

Every agent interaction follows an ordered pipeline of discrete, independently-testable scripts:

| Step | Script | Purpose |
|------|--------|---------|
| 1 | `enabled.ts` | **Guard** — is the agent allowed to run? |
| 2 | `preflight.ts` | **Validation** — is config present? Is the schema valid? |
| 3 | _(bun install)_ | **Install** — prepare the runtime |
| 4 | `agent.ts` | **Execute** — run the agent, post the reply, commit state |

Each step is a discrete TypeScript file that can fail independently.

---

## Agent Identity

The `AGENTS.md` file defines the agent's personality and standing orders. At runtime, its content is automatically written to a `SOUL` file (gitignored) so that the OpenClaw runtime reads it as the agent's native identity — bridging the GitHub `AGENTS.md` convention with OpenClaw's `SOUL` system.

To customise the agent, edit `AGENTS.md` with your instructions. If `AGENTS.md` contains only the default placeholder text, no `SOUL` is generated and the agent runs with OpenClaw defaults.

---

## Long-Term Memory

The `MEMORY.md` file is the agent's **committed long-term memory seed** — a curated, human-readable set of durable facts the agent should always keep in context. Because it is committed to Git, it persists across the ephemeral GitHub Actions runners that execute each run. At runtime, `agent.ts` bridges it into the agent workspace so the OpenClaw runtime loads it as durable context (the runtime copy is gitignored).

This is distinct from OpenClaw's *semantic* memory index (stored under `state/` via `OPENCLAW_STATE_DIR`), which the agent populates automatically as it works. Use `MEMORY.md` for facts you want guaranteed in context; let the semantic index handle everything else.

**Keep `MEMORY.md` small and high-signal.** Prefer one short, durable fact per line; remove obsolete entries (an incorrect memory is worse than a missing one); never store secrets, tokens, or personal data. The weekly scheduled maintenance run is a good time to review and trim it. The pruning strategy is documented in the comment at the top of the file.

---

## Configuration

Edit `.github-openclaw-intelligence/.pi/settings.json` to change the LLM provider, model, trust policy, and resource limits:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.4",
  "defaultThinkingLevel": "high",
  "trustPolicy": {
    "trustedUsers": ["your-github-username"],
    "semiTrustedRoles": ["admin", "maintain", "write"],
    "untrustedBehavior": "read-only-response"
  },
  "limits": {
    "workflowTimeoutMinutes": 30
  },
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 32000
  }
}
```

Settings are validated against `config/settings.schema.json` during the preflight step.

The provider, model, thinking level, timeout, and compaction values are passed explicitly to OpenClaw, ensuring the committed settings are respected regardless of host-level configuration on the runner image.

### Supported Providers

| Provider | Secret Name | Models |
|----------|------------|--------|
| OpenAI | `OPENAI_API_KEY` | GPT-5.4 (default), GPT-4o, GPT-4o-mini |
| Anthropic | `ANTHROPIC_API_KEY` | Claude Sonnet, Claude Haiku, Claude Opus |
| Google | `GEMINI_API_KEY` | Gemini 2.5 Pro, Gemini 2.0 Flash |
| xAI | `XAI_API_KEY` | Grok 3, Grok 3 Mini |
| OpenRouter | `OPENROUTER_API_KEY` | DeepSeek, and hundreds more |
| Mistral | `MISTRAL_API_KEY` | Mistral Large |
| Groq | `GROQ_API_KEY` | DeepSeek R1 distills |

### Trust Policy

The `trustPolicy` section controls per-actor capability gating:

| Level | Capabilities |
|-------|-------------|
| `trusted` | Full capabilities — all tools, mutation commands |
| `semi-trusted` | Read-only tools — informational commands only |
| `untrusted` | Blocked or read-only response (no agent invocation) |

- **`trustedUsers`** — GitHub usernames that receive full agent capabilities.
- **`semiTrustedRoles`** — Repository permission levels (`admin`, `maintain`, `write`) that receive semi-trusted access.
- **`untrustedBehavior`** — How to handle actors below semi-trusted: `read-only-response` or `block`.

When no `trustPolicy` is configured, all actors with write-level access are treated as trusted (backwards-compatible).

### Resource Limits

The `limits.workflowTimeoutMinutes` setting bounds the OpenClaw subprocess. The
workflow also has a 30-minute job-level timeout as a fail-safe.

---

## Slash Commands

Issue authors can use slash commands to invoke OpenClaw CLI operations directly:

```
@ /status
@ /help
@ /doctor
@ /sessions
@ /models
@ /skills
```

The command parser recognises all commands from the OpenClaw CLI registry. Mutation commands (e.g. `/config set`, `/reset`) are gated by trust level — only trusted actors can execute them.

Use `@ /help` to see all available commands.

---

## Extensions

OpenClaw's capabilities are configured in `config/extensions.json`. Enabled extensions are logged at launch for visibility, but are **not** forwarded to the runtime config — the OpenClaw schema does not accept an `extensions` top-level key. Extensions are informational metadata that documents which capabilities the agent environment supports:

```json
{
  "extensions": {
    "sub-agents": true,
    "semantic-memory": true,
    "media-understanding": true,
    "diff-analysis": true,
    "multi-model-failover": true,
    "browser-cdp": true,
    "multi-search": true
  },
  "skills": "config/skills.json"
}
```

All enabled extensions are logged by the agent at startup. The OpenClaw runtime receives its capabilities through its own configuration mechanisms rather than through the runtime config file.

---

## Skills

OpenClaw ships with bundled skills that provide domain-specific capabilities. Skills are configured in `config/skills.json`:

```json
{
  "skills": {
    "allowBundled": [
      "gh-issues",
      "github",
      "weather",
      "summarize",
      "coding-agent",
      "healthcheck",
      "oracle",
      "session-logs",
      "nano-pdf",
      "xurl"
    ],
    "load": {
      "extraDirs": []
    }
  }
}
```

### Available Skills

| Skill | Description |
|-------|-------------|
| `gh-issues` | Fetch GitHub issues, spawn sub-agents to implement fixes and open PRs |
| `github` | GitHub operations via `gh` CLI: issues, PRs, CI runs, code review |
| `weather` | Get current weather and forecasts via wttr.in |
| `summarize` | Summarize text, files, or URLs |
| `coding-agent` | Dedicated code review and editing agent |
| `healthcheck` | System health and diagnostics |
| `oracle` | Knowledge base queries |
| `session-logs` | View and manage session transcripts |
| `nano-pdf` | PDF extraction and analysis |
| `xurl` | URL fetching and web content extraction |

### Direct Skill Invocation

Issue authors can invoke a skill directly by prefixing the prompt with `/skill-name`:

```
@ /gh-issues owner/repo --label bug
@ /weather London
@ /github pr list --repo owner/repo
```

The `@` prefix routes to the agent, and the `/skill-name` tells it which skill to use. The remainder of the message is passed as the skill's input.

### Adding Custom Skills

Place a `SKILL.md` file in a subdirectory of `skills/`:

```
.github-openclaw-intelligence/skills/my-skill/SKILL.md
```

Custom skills in this directory take precedence over bundled ones with the same name. See the [OpenClaw skills documentation](https://docs.openclaw.ai/tools/skills) for the SKILL.md format.

### Adding Extra Skill Directories

To load skills from additional directories, add paths to the `load.extraDirs` array in `config/skills.json`:

```json
{
  "skills": {
    "load": {
      "extraDirs": ["/path/to/my-skills"]
    }
  }
}
```

---

## Tool Surface

| Capability | Available |
|-----------|-----------|
| File read/write/edit | ✅ |
| Code search (grep, glob) | ✅ |
| Bash execution | ✅ |
| Browser automation (headless Chromium with CDP) | ✅ |
| Web search / fetch (multiple backends) | ✅ |
| Sub-agent orchestration | ✅ |
| Semantic memory search (BM25 + vector embeddings) | ✅ |
| Media understanding (image analysis, OCR, PDF extraction) | ✅ |
| Diff analysis (dedicated extension) | ✅ |
| Multi-model failover (automatic provider fallback) | ✅ |

---

## License

[MIT](LICENSE.md) — © 2026 Eric Mourant
