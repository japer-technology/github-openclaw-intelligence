# Dependencies

> No repo is an island.
> Every codebase depends on memory, intent, and shared understanding

## Direct Dependencies

### Runtime (npm)

| Package | Version | Description |
|---------|---------|-------------|
| [@buape/carbon](https://github.com/buape/carbon) | ^0.14.0 | Discord UI component library required by OpenClaw's bundled Discord channel plugin. The plugin is eagerly loaded during CLI bootstrap even when using `--local` mode. |
| [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk) | ^1.60.0 | Lark/Feishu API SDK required by OpenClaw's bundled Feishu channel plugin. The plugin is eagerly loaded during CLI bootstrap via `jiti`, which resolves modules from the project root — so this must be a direct dependency to ensure top-level hoisting. |
| [openclaw](https://github.com/openclaw/openclaw) | ^2026.3.12 | Multi-channel AI gateway with extensible messaging integrations. Provides the `openclaw agent --local` CLI command that powers the OpenClaw Intelligence system — it processes prompts, interacts with LLM providers, and manages conversation sessions. |

### OpenClaw Feature Surface

Beyond the CLI binary, OCI uses the following OpenClaw feature categories:

| Feature | Location | Description |
|---------|----------|-------------|
| Session management | `OPENCLAW_STATE_DIR`, `--session-id` | Multi-turn conversation continuity across workflow runs |
| Project settings | `.pi/settings.json` | Provider, model, thinking level, compaction, and retry configuration |
| Context files | `AGENTS.md` → `SOUL` | Agent identity and standing orders (bridged at runtime) |
| Skills | `config/skills.json`, `skills/` | Bundled skill allowlist and runtime-linked skill directories |
| Runtime config | `OPENCLAW_CONFIG_PATH` | Model, workspace, timeout, and skill configuration |
| Environment isolation | `OPENCLAW_HOME`, `OPENCLAW_OAUTH_DIR` | Agent home and credential separation |
| Compaction | `.pi/settings.json` `compaction` | Automatic context compaction for long conversations (`keepRecentTokens: 32000`) |
| Retry | `.pi/settings.json` `retry` | Automatic retry with exponential backoff for transient LLM errors (`maxRetries: 3`) |

See [docs/analysis/openclaw-feature-utilization.md](docs/analysis/openclaw-feature-utilization.md) for a full audit of used vs. available features.

## Infrastructure Dependencies

These are not package dependencies but are required for the system to function:

| Dependency | Description |
|------------|-------------|
| [GitHub Actions](https://github.com/features/actions) | The sole compute runtime. Every issue event triggers a workflow that runs the AI agent. No external servers or containers are needed. |
| [GitHub Issues](https://docs.github.com/en/issues) | Used as the conversation interface. Each issue maps to a persistent AI conversation thread. |
| [Git](https://git-scm.com/) | All session state, conversation history, and agent edits are committed to the repository. Git serves as the memory and storage layer. |
| [Bun](https://bun.sh) | JavaScript/TypeScript runtime used to execute the agent orchestrator and install dependencies. |
| [Node.js](https://nodejs.org/) | Required by the OpenClaw CLI binary (>= 22). Installed alongside Bun in the workflow. |
| [gh CLI](https://cli.github.com/) | GitHub's official CLI tool, used by the agent lifecycle scripts to interact with the GitHub API (fetching issues, posting comments, managing reactions). |

## GitHub Actions Workflow Dependencies

These are referenced in `.github/workflows/`:

| Action | Workflow | Description |
|--------|----------|-------------|
| [actions/checkout@v4](https://github.com/actions/checkout) | agent | Checks out the repository so the agent can read and write files. |
| [oven-sh/setup-bun@v2](https://github.com/oven-sh/setup-bun) | agent | Installs the Bun runtime in the GitHub Actions environment. |
| [actions/setup-node@v4](https://github.com/actions/setup-node) | agent | Installs Node.js 22 required by the OpenClaw CLI binary. |
| [actions/cache@v5](https://github.com/actions/cache) | agent | Caches `node_modules` keyed on the `bun.lock` hash to speed up dependency installation. |
| [actions/configure-pages@v5](https://github.com/actions/configure-pages) | agent | Configures GitHub Pages deployment. |
| [actions/upload-pages-artifact@v4](https://github.com/actions/upload-pages-artifact) | agent | Uploads the static site artifact from `.github-openclaw-intelligence/public-fabric/`. |
| [actions/deploy-pages@v4](https://github.com/actions/deploy-pages) | agent | Deploys the uploaded artifact to GitHub Pages. |

## LLM Provider Dependencies (one required)

An API key from at least one supported LLM provider is needed:

| Provider | API Key Secret | Description |
|----------|---------------|-------------|
| [OpenAI](https://platform.openai.com/) | `OPENAI_API_KEY` | GPT models including GPT-5.4 (default provider). |
| [Anthropic](https://console.anthropic.com/) | `ANTHROPIC_API_KEY` | Claude models. |
| [Google Gemini](https://aistudio.google.com/) | `GEMINI_API_KEY` | Gemini 2.5 Pro and Flash models. |
| [xAI](https://console.x.ai/) | `XAI_API_KEY` | Grok 3 and Grok 3 Mini models. |
| [OpenRouter](https://openrouter.ai/) | `OPENROUTER_API_KEY` | Access to DeepSeek, and hundreds of other models via a unified API. |
| [Mistral](https://console.mistral.ai/) | `MISTRAL_API_KEY` | Mistral Large and other Mistral models. |
| [Groq](https://console.groq.com/) | `GROQ_API_KEY` | Fast inference for open-source models like DeepSeek R1 distills. |

## Transitive Dependencies (notable)

These are pulled in transitively by `openclaw`:

| Package | Description |
|---------|-------------|
| `@mariozechner/pi-coding-agent` | Coding agent CLI used internally by OpenClaw for AI agent capabilities. |
| `@mariozechner/pi-ai` | AI provider abstraction layer used by OpenClaw. |
| `@anthropic-ai/sdk` | Official Anthropic API client for Claude models. |
| `@aws-sdk/client-bedrock` | AWS Bedrock client for accessing models via AWS infrastructure. |
| `openai` | Official OpenAI API client. |
| `@google/genai` | Google's Generative AI SDK for Gemini models. |
| `express` | Web framework used by OpenClaw's gateway server. |
| `playwright-core` | Browser automation used by OpenClaw's browser capabilities. |
