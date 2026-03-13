# OpenClaw Intelligence

> A tool-rich AI agent that lives inside your GitHub repository alongside GitHub Minimum Intelligence.

OpenClaw Intelligence is activated by the `@` prefix on issues and comments. It provides a richer tool surface than GMI — including sub-agent orchestration, semantic memory search, media understanding, and multi-model failover — while sharing the same repository, authorization model, and audit trail.

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
| `!` | Minimum Intelligence (GMI) | Fast, lightweight, focused on repository tasks |
| `@` | OpenClaw Intelligence | Tool-rich, complex multi-step tasks |
| _(other)_ | Neither | No agent responds |

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
│   └── extensions.json            # Extension and skill activation
├── docs/
├── install/
│   ├── OPENCLAW-AGENTS.md         # Default AGENTS.md for fresh installs
│   └── settings.json              # Default .pi/settings.json
├── lifecycle/
│   └── agent.ts                   # Core orchestrator
├── package.json
├── public-fabric/                 # GitHub Pages content
└── state/
    ├── issues/                    # Issue-to-session mappings
    ├── sessions/                  # Conversation transcripts (JSONL)
    └── memory.log                 # Append-only long-term memory
```

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

OpenClaw's capabilities are configured in `config/extensions.json`:

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

## Coexistence with GMI

OpenClaw and GMI operate on the same repository with full isolation:

- **Separate folders** — `.github-openclaw-intelligence/` and `.github-minimum-intelligence/`
- **Separate workflows** — each with its own prefix guard
- **Separate state** — independent session directories, no shared sessions
- **Shared authorization** — GitHub collaborator permissions apply to both
- **Shared audit trail** — all commits in one git log
- **Cross-intelligence awareness** — via the shared issue thread, not shared state

---

## License

[MIT](LICENSE.md) — © 2026 Eric Mourant
