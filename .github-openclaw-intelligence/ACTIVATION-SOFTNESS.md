# Activation Softness

This document describes the "soft activation" behaviour introduced to OpenClaw
Intelligence so that the agent no longer unconditionally requires an activation
prefix (e.g. `@`) at the start of every issue title or comment body.

---

## Background

Previously, the agent **only** activated when:

- A new issue was opened with a title starting with `@`.
- An issue comment was created with a body starting with `@`.

This was hard-coded in two places:

1. **Workflow YAML** (`github-openclaw-intelligence-agent.yml`) — the job-level
   `if` expression used `startsWith(github.event.issue.title, '@')` and
   `startsWith(github.event.comment.body, '@')` to skip events that lacked the
   prefix.
2. **Agent TypeScript** (`lifecycle/agent.ts`) — the prompt-building logic
   stripped the `@` prefix using the hard-coded regex `/^@\s*/`.

This meant the `@` symbol was both:
- A **routing signal** that told the workflow "this event is for the agent".
- A **magic constant** embedded in two different files with no single point of
  control.

---

## What Changed

### 1. Configurable activation prefix (`ACTIVATION_PREFIX`)

A single environment variable — `ACTIVATION_PREFIX` — is now defined once at the
job level in the workflow YAML:

```yaml
env:
  ACTIVATION_PREFIX: "@"
```

To change the routing symbol (for example to `$`, `!`, or `#`), a human only
needs to edit this one line.  Every downstream consumer reads from this same
source:

| Consumer | How it reads the prefix |
|---|---|
| **Activation gate** (shell step in the YAML) | `"${ACTIVATION_PREFIX}"` — inherited from the job `env`. |
| **agent.ts** (TypeScript) | `process.env.ACTIVATION_PREFIX ?? "@"` — reads the env var at runtime with a safe fallback. |

The TypeScript code constructs a `RegExp` dynamically from the prefix (with
proper escaping of special regex characters) so that any single-character or
multi-character prefix works correctly.

### 2. Sole-intelligence detection ("soft activation")

The job-level `if` expression no longer checks `startsWith(…, '@')`.  Instead,
a new **Activation gate** step runs immediately after checkout and inspects the
repository's root directory:

```
find . -maxdepth 1 -type d -name '.github-*-intelligence' \
  ! -name '.github-openclaw-intelligence'
```

- **If no other `.github-*-intelligence` directories are found**, the agent is
  the *sole intelligence* installed.  It activates unconditionally — no prefix
  is required.  Every new issue and every non-bot comment triggers the agent.

- **If one or more other intelligence directories exist** (e.g.
  `.github-minimum-intelligence`, `.github-custom-intelligence`), the prefix
  requirement is enforced.  The step reads the issue title (for `issues` events)
  or the comment body (for `issue_comment` events) from `$GITHUB_EVENT_PATH` via
  `jq` and checks whether the text starts with `ACTIVATION_PREFIX`.  If it does
  not, the step sets `activated=false` and all subsequent steps are skipped.

### 3. Step reordering

Because the activation gate needs the repository's file tree, **Checkout** was
moved to be the very first step (before Authorize).  The full step order is now:

| # | Step | Condition |
|---|---|---|
| 1 | Checkout | always |
| 2 | Activation gate | always |
| 3 | Authorize | `activated == 'true'` |
| 4 | Reject | auth failure |
| 5 | Check for folder | `activated == 'true'` |
| 6 | Guard | folder exists |
| 7–12 | Setup / Install / Build / Run | folder exists |

Steps gated on `steps.check-folder.outputs.exists == 'true'` are transitively
skipped when the activation gate sets `activated=false`, because the
`check-folder` step itself is skipped and therefore never outputs `exists=true`.

### 4. Prefix stripping in agent.ts

The hard-coded regex `/^@\s*/` was replaced with a dynamically constructed
`RegExp` built from `ACTIVATION_PREFIX`:

```typescript
const ACTIVATION_PREFIX = process.env.ACTIVATION_PREFIX ?? "@";
const activationPrefixRegex = new RegExp(`^${escapeRegExp(ACTIVATION_PREFIX)}\\s*`);
```

This regex is used in exactly two places to strip the prefix from the prompt:

- `event.comment.body.replace(activationPrefixRegex, "")` — for comment events.
- `title.replace(activationPrefixRegex, "")` — for new-issue events.

When the agent activates without a prefix (sole-intelligence mode), the replace
is a no-op because the text does not start with the prefix — so the full text is
preserved as the prompt.

---

## Summary of Files Changed

| File | Change |
|---|---|
| `.github/workflows/github-openclaw-intelligence-agent.yml` | Removed hard-coded `startsWith('@')` from job `if`; added `ACTIVATION_PREFIX` env var; added Activation gate step; reordered Checkout before Authorize; updated step numbering and comments. |
| `.github-openclaw-intelligence/lifecycle/agent.ts` | Added `ACTIVATION_PREFIX` const (from env); added `escapeRegExp` helper; replaced hard-coded `/^@\s*/` with dynamic `activationPrefixRegex`; updated comments. |
| `.github-openclaw-intelligence/ACTIVATION-SOFTNESS.md` | This file — documents the change. |

---

## How to Customize

### Change the activation prefix

Edit the workflow YAML and set `ACTIVATION_PREFIX` to any string:

```yaml
env:
  ACTIVATION_PREFIX: "$"
```

Then every issue title or comment body must start with `$` (instead of `@`) to
trigger the agent — but only when other intelligences are co-installed.

### Force prefix-always mode

If you always want the prefix required (even as the sole intelligence), remove
the sole-intelligence bypass from the Activation gate step by deleting or
commenting out the `OTHER_COUNT` / early-exit block.

### Force prefix-never mode

If you never want the prefix required, remove the Activation gate step entirely
and restore the `if` conditions on subsequent steps to their pre-change state.
