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
│   └── settings.json              # LLM provider, model, thinking level
├── AGENTS.md                      # Agent identity and standing orders
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE.md
├── PACKAGES.md
├── README.md
├── SECURITY.md
├── VERSION
├── config/
│   ├── extensions.json            # Extension and skill activation
│   └── skills.json                # Bundled skill allowlist and extra dirs
├── docs/
├── install/
│   ├── OPENCLAW-AGENTS.md         # Default AGENTS.md for fresh installs
│   └── settings.json              # Default .pi/settings.json
├── lifecycle/
│   └── agent.ts                   # Core orchestrator
├── package.json
├── public-fabric/                 # GitHub Pages content
├── skills/                        # Runtime-linked skills (symlinks to bundled)
└── state/
    ├── issues/                    # Issue-to-session mappings
    ├── sessions/                  # Conversation transcripts (JSONL)
    └── memory.log                 # Append-only long-term memory
```

---

## Agent Identity

The `AGENTS.md` file defines the agent's personality and standing orders. At runtime, its content is automatically written to a `SOUL` file (gitignored) so that the OpenClaw runtime reads it as the agent's native identity — bridging the GitHub `AGENTS.md` convention with OpenClaw's `SOUL` system.

To customise the agent, edit `AGENTS.md` with your instructions. If `AGENTS.md` contains only the default placeholder text, no `SOUL` is generated and the agent runs with OpenClaw defaults.

---

## Configuration

Edit `.github-openclaw-intelligence/.pi/settings.json` to change the LLM provider and model:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.4",
  "defaultThinkingLevel": "high"
}
```

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

---

## Extensions

OpenClaw's capabilities are configured in `config/extensions.json` and actively forwarded to the runtime configuration at launch:

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

All enabled extensions are merged into the runtime config written to `OPENCLAW_CONFIG_PATH`, so the OpenClaw process receives the full set of capabilities.

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
