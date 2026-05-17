---
date: 2026-05-16
topic: multi-repo-claude-orchestrator
---

# Multi-Repo Claude Code Orchestrator with Per-Repo proma PM

## What We're Building

A new top-level **Code** tab in the SecondBrain desktop app that lets the user dispatch Claude Code tasks against any registered repo. Each task runs in an isolated git worktree, Claude works autonomously, commits, and opens a PR via `gh`. Per-repo [proma](https://github.com/dpraj007/proma) (markdown-based Claude Code PM plugin) is initialized in each registered repo so PM state (epics, tasks, ADRs, inbox) persists across sessions and ships with the code in git.

Telegram dispatch is **explicitly deferred to phase 2** — the same IPC handlers we build for the UI will become the dispatch target for `command-queue.ts`'s existing EC2 polling rail, with no rewrite.

## Why This Approach

We considered four surface options (Telegram-only, Telegram+UI, web dashboard, all-phased) and four onboarding models (whitelist, clone-on-demand, both, worktrees). The chosen combo wins on:

- **Demo-ability.** A new Code tab in the running Electron app shows end-to-end value in ~60 seconds with no remote infra.
- **Isolation by construction.** One worktree per task means concurrent tasks don't collide; PR-per-task is the natural shape.
- **Faithful PM.** Per-repo proma matches the plugin's native model — PM state is committed markdown that travels with the repo.
- **Reversibility.** PR-gated means git is the audit log; no destructive autonomous merges.

## Key Decisions

- **Surface (v1):** Desktop UI only — new top-level "Code" tab next to existing tabs in `src/renderer/src/App.tsx`. **Why:** demo-able locally, no auth surface, no EC2 dependency.
- **Repo model:** Register a parent repo path; each task spawns a fresh worktree on branch `feat/task-<id>` off the repo's default branch. **Why:** zero-cost task isolation; PR-per-task; no clone-on-demand auth headaches.
- **proma scope:** Per-repo, native install. On registration, run `/proma:init` once in the repo, commit, push. **Why:** matches proma's design; PM state ships in git; no central DB to keep in sync.
- **Safety:** PR-gated only. Claude runs autonomously inside the worktree, commits, opens a PR via `gh pr create`. User reviews/merges on GitHub. **Why:** leverages git review as the audit log; one less custom approval UI.
- **Cleanup:** Auto-discard worktree when PR merges (polled via `gh pr view`), with manual "Discard" button as override.
- **Telegram bridge:** Phase 2. `command-queue.ts` adds a `code_task` routing type that invokes the same IPC-handler-backed functions. No rewrite, just a thin dispatcher.

## File Layout (per CONTRIBUTING.md conventions)

**Main process (`src/main/`)**
- `registered-repos.ts` — JSON store at `userData/data/registered-repos.json`, schema `{alias, path, defaultBranch, promaInitialized, createdAt}`. Mirrors the `projects.ts` pattern.
- `worktree-manager.ts` — `createWorktree(alias, taskId)`, `discardWorktree(taskId)`, `listActiveWorktrees()`, branch naming `feat/task-<id>`.
- `code-tasks.ts` — task lifecycle, status tracking (`queued | running | awaiting-pr | merged | discarded | error`), streaming output buffer.
- `claude-runner.ts` (extend) — add `runClaudeInWorktree(alias, prompt, taskId, onChunk)`. Existing `spawnClaude` already supports custom `cwd` and `extraEnv`; this is mostly a wrapper.
- `pr-watcher.ts` — periodic `gh pr view --json state,url` poll per open task; emit IPC event on state change.
- `ipc-handlers.ts` (extend) — namespaces: `repos:list | register | unregister`, `code:run | list-tasks | get-task | discard | stream`, `proma:read-dashboard`.

**Preload (`src/preload/index.ts`)**
- Expose `window.api.repos`, `window.api.code`, `window.api.proma`.

**Renderer (`src/renderer/src/`)**
- `pages/Code.tsx` — the tab. Layout: left repo list (+ register button), middle task composer + live streaming output, right active-worktrees panel with PR-link/discard buttons, bottom drawer with rendered `TODO.md` / `PROGRESS.md` preview (read via `proma:read-dashboard` IPC, never raw Node fs from renderer).
- `App.tsx` — register the new tab. Dark theme `#0f0f0f` bg / `#111` sidebar per code standards.

**Tests (`tests/`)**
- `registered-repos.spec.ts` — register/unregister/persistence
- `worktree-manager.spec.ts` — create/discard/concurrent-task isolation
- `code-tasks.spec.ts` — lifecycle transitions, streaming
- `code-tab.pw.spec.ts` — Playwright E2E: register repo → run task → PR link appears

## Demo Script (the 60-second story)

1. Open Code tab → click "Register repo" → file-pick a local repo → see proma init run in a progress toast → it appears in the left list.
2. Select the repo, type "add a /healthz endpoint", click Run.
3. Watch Claude's stdout stream into the middle pane in real time.
4. Worktree card appears on the right with status `running` → `awaiting-pr` → PR link button.
5. Click PR link → merge on GitHub → within ~30s the card flips to `merged` and the worktree auto-disappears.
6. Open the bottom drawer → `PROGRESS.md` shows the new task as done.

## Open Questions (must resolve before `/workflows:plan`)

1. **gh auth coverage.** Is `gh auth status` working across all repos you plan to register, including cross-org ones? PR-gated assumes `gh pr create` works.
2. **Push permissions.** Is Claude pushing branches directly to origin (needs push perms), or to a fork (safer for repos you don't fully own)? **Default proposal:** direct to origin, since v1 targets your own repos.
3. **proma plugin install location.** proma is a Claude Code plugin. Is it installed once globally at `~/.claude/plugins/` and inherited by `claude -p` spawned in any cwd? Or does each repo need a local `.claude/plugins/` entry? Verify by running `/proma:init` in a fresh repo before designing the registration flow.
4. **Concurrency cap.** How many concurrent worktrees per repo before queueing? **Default proposal:** 3 per repo, 6 global. Configurable in Settings later.
5. **PR-watch cadence.** Poll `gh pr view` every 30s? 60s? Trade-off: snappier merge detection vs. gh rate limits. **Default proposal:** 60s, escalate to 15s for the most-recently-active task only.
6. **SessionStart hook gating.** The existing Tier 1 SessionStart hook (~10K tokens) is wrong for external repos. Confirm we add a `SECONDBRAIN_SESSION_MODE=external` env (similar to existing `ingest` mode in `claude-runner.ts`) that routes to a no-op or repo-aware stub hook.
7. **Error surfacing.** Where do task failures (claude exits non-zero, gh fails, tests fail in CI) appear? **Default proposal:** worktree card flips to `error` with stderr preview; click → full log modal; "Retry" and "Discard" buttons.

## Out of Scope for v1

- Telegram dispatch (phase 2 — thin wrapper)
- Web dashboard (phase 3+ if ever)
- Cross-repo proma aggregation / global TODO across all repos
- Clone-on-demand from a GitHub URL
- Multi-author / team mode
- Cost / token tracking per task
- Plan-then-approve gate (skipped per PR-gated decision)

## Next Steps

→ Answer the seven open questions above (especially #3 — verify proma plugin install path with a quick experiment).
→ Run `/compound-engineering:workflows:plan` (or `/everything-claude-code:plan`) on this brainstorm to produce the phased implementation plan.
→ Suggested phase order: (1) registered-repos + worktree-manager + tests, (2) claude-runner extension + IPC handlers, (3) Code tab UI skeleton, (4) live streaming, (5) pr-watcher + auto-discard, (6) proma dashboard drawer.
