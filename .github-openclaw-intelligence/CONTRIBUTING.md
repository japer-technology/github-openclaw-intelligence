# Contributing to OpenClaw Intelligence

Thank you for your interest in contributing. This project values transparency, auditability, and human judgment above all else. Every contribution — code, documentation, or discussion — becomes part of the repository's permanent history.

---

## How to Contribute

### Reporting Bugs

Open a [GitHub Issue](../../issues) with:

- A clear, descriptive title.
- Steps to reproduce the problem.
- What you expected to happen and what actually happened.
- Your environment (OS, Bun version, LLM provider).

### Suggesting Features

Open a [GitHub Issue](../../issues) describing:

- The problem or gap the feature addresses.
- How it fits within the existing architecture (issues as conversation, Git as memory, Actions as runtime).
- Any security implications.

### Submitting Changes

1. Fork the repository and create a branch from `main`.
2. Make your changes in small, reviewable increments.
3. Test locally with `cd .github-openclaw-intelligence && bun install` and verify dependencies install cleanly.
4. Open a pull request with a clear description of what changed and why.

---

## Project Structure

```
.github-openclaw-intelligence/       # Core agent framework
  .pi/                              # LLM provider configuration
  config/                           # Extension and skill activation
  install/                          # Default templates for agent identity and settings
  lifecycle/                        # Agent orchestrator and runtime hooks
  state/                            # Git-tracked session history and issue mappings

.github/                            # GitHub Actions workflows
```

See the [README](README.md#project-structure) for a detailed breakdown of every file.

---

## Development Setup

1. Install [Bun](https://bun.sh).
2. Clone the repository.
3. Install dependencies:
   ```bash
   cd .github-openclaw-intelligence && bun install
   ```
4. Add an LLM API key as a repository secret (see [Supported Providers](README.md#supported-providers)).

---

## Style and Conventions

- **Documentation** is Markdown. Use tables, clear headings, and concise language consistent with existing files.
- **Code** is TypeScript, executed with Bun.
- **Commit messages** should be short and descriptive. Every commit is permanent and auditable.

---

## Security

If you discover a security vulnerability, **do not open a public issue**. Contact the maintainers privately.

---

## Code of Conduct

All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE.md).
