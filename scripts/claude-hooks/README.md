# Claude Hooks (tracked)

This directory holds all Claude Code hook scripts. They used to live only at `~/.claude/hooks/` with no git tracking, meaning every hook I wrote was local-only and vanished on reclone. Now they are tracked here and will be junctioned from `~/.claude/hooks/` via a one-time Luke setup.

## Why this exists

Per `memory/AMY_REQUIREMENTS.md` principle 2 ("All memory is git-tracked, raw material always saved"), nothing important to Amy's operation should live only on one disk. Hooks are behavioral code that shapes every session — they qualify.

## Files

### Existing hooks (copied from `~/.claude/hooks/` in Phase 3)

- `briefing-context-inject.sh` — UserPromptSubmit hook, fires on "briefing" prompts, injects canonical briefing spec
- `contact-enrichment.sh` — contact memory enrichment workflow
- `content-qc-gate.sh` — video content QC gate
- `force-completion.sh` — forces task completion on stop
- `gap-trigger.sh` — #gap workflow injection
- `git-context-inject.sh` — auto-injects git status + recent commits on every prompt
- `learn-trigger.sh` — #learn workflow injection
- `memory-validation.sh` — PostToolUse memory file validation
- `notify-on-stop.sh` — stop notification
- `run-tests-before-pr.sh` — PreToolUse test runner on git push
- `vapi-validation.sh` — Vapi call validation

### New hooks added in Phase 3

- **`session-start-inject.sh`** — SessionStart hook, runs once at every new Claude Code session, reads MEMORY.md + reference_amy_state_locations.md + AMY_REQUIREMENTS.md first 80 lines, emits them as a systemMessage so the session starts with full architectural map loaded. Fix for the 2026-04-10 "every session rediscovers from scratch" regression.
- **`memory-path-enforce.sh`** — PreToolUse hook on Write/Edit/NotebookEdit, blocks any target path matching `~/.claude/memory/`, `~/.claude/hooks/`, `~/.claude/CLAUDE.md`, or `~/.claude/settings.json`, rewrites to the project-relative tracked equivalent, exits 2 (blocking error) with a message telling Claude Code to use the `secondbrain/...` path instead. Mechanically enforces the "never trigger permission prompts" rule.

## Junction setup (one-time Luke action)

After cloning or pulling, run these commands once to link `~/.claude/hooks/` to this tracked directory:

```cmd
REM Back up whatever is there
if exist C:\Users\luked\.claude\hooks (
  ren C:\Users\luked\.claude\hooks hooks.backup-2026-04-10
)

REM Create directory junction
mklink /J C:\Users\luked\.claude\hooks C:\Users\luked\secondbrain\scripts\claude-hooks
```

After this, any edit to a script in `secondbrain/scripts/claude-hooks/` (via the project-relative path, no permission prompt) propagates to `~/.claude/hooks/` automatically because the junction points at the same physical directory.

The `.claude/settings.json` registration for each hook references `~/.claude/hooks/script.sh` (the junction path), which resolves to this tracked location.

## Maintenance

Edit scripts via `C:\Users\luked\secondbrain\scripts\claude-hooks\...` path. Git tracks. Claude Code sees the update on next session start.
