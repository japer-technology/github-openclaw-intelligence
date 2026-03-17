# OpenClaw Intelligence — Enabled

This file is a **sentinel**. Its presence means OpenClaw Intelligence is
**active** in this repository.

## How it works

Every workflow run begins by checking for this file.  If the file is absent
the run exits immediately with a non-zero status code, preventing the agent
from executing.  This is a **fail-closed** design — OpenClaw Intelligence
never runs unless a human has deliberately enabled it.

## Disable the agent

```bash
git rm .github-openclaw-intelligence/ENABLED.md
git commit -m "chore: disable OpenClaw Intelligence"
git push
```

## Re-enable the agent

Restore this file and push it to the repository.
