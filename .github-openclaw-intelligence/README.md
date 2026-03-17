# OpenClaw Intelligence

> A standalone tool-rich AI agent that lives inside your GitHub repository.

OpenClaw Intelligence is activated by the `@` prefix on issues and comments. It provides a rich tool surface — including sub-agent orchestration, semantic memory search, media understanding, and multi-model failover — while keeping all session state, file changes, and conversation history in Git.

---

## How It Works

1. **Open an issue** (or add a comment) starting with `@`.
2. **GitHub Actions** detects the prefix and runs the OpenClaw workflow.
3. **The agent** reads your prompt, uses its extended tool surface to process it, and posts the response as a comment.
4. **Everything is committed** — session state, file changes, and conversation history all live in Git.

---

## The Prefix Protocol

| Prefix | Intelligence | Description |
|--------|-------------|-------------|
| `@` | OpenClaw Intelligence | Tool-rich, complex multi-step tasks |
| _(other)_ | None | No agent responds |

---

## Project Structure

```
.github-openclaw-intelligence/
├── .pi/
│   └── settings.json              # LLM provider, model, thinking level, trust policy, limits
├── AGENTS.md                      # Agent identity and standing orders
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
├── install/
│   ├── OPENCLAW-AGENTS.md         # Default AGENTS.md for fresh installs
│   └── settings.json              # Default .pi/settings.json
├── lifecycle/
│   ├── agent.ts                   # Core orchestrator
│   ├── command-parser.ts          # Slash command parser (openclaw CLI registry)
│   ├── enabled.ts                 # Fail-closed sentinel guard
│   ├── preflight.ts               # Pre-run config and structural validation
│   └── trust-level.ts             # Trust-level resolution per actor
├── package.json
├── public-fabric/                 # GitHub Pages content
├── skills/                        # Runtime-linked skills (symlinks to bundled)
└── state/
    ├── agents/main/sessions/      # Conversation transcripts (JSONL)
    ├── issues/                    # Issue-to-session mappings
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

## Configuration

Edit `.github-openclaw-intelligence/.pi/settings.json` to change the LLM provider, model, trust policy, and resource limits:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.4",
  "defaultThinkingLevel": "high",
  "trustPolicy": {
    "trustedUsers": ["your-github-username"],
    "semiTrustedRoles": ["write"],
    "untrustedBehavior": "read-only-response"
  },
  "limits": {
    "maxTokensPerRun": 500000,
    "maxToolCallsPerRun": 200,
    "workflowTimeoutMinutes": 30
  }
}
```

Settings are validated against `config/settings.schema.json` during the preflight step.

The `--model`, `--provider`, and `--thinking` flags are passed explicitly to the OpenClaw CLI from this file, ensuring the committed settings are always respected regardless of host-level configuration on the runner image.

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

The `limits` section sets resource boundaries:

- **`maxTokensPerRun`** — Maximum total tokens per agent run.
- **`maxToolCallsPerRun`** — Maximum tool calls per agent run.
- **`workflowTimeoutMinutes`** — Hard time boundary for the workflow (max 360).

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
