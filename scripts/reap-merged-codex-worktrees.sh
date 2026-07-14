#!/usr/bin/env bash
#
# reap-merged-codex-worktrees.sh
#
# Maintained janitor for the disposable isolation worktrees that the scheduled
# fleet + scan-output lander create: branches `codex/scheduled-skill/*` and
# `codex/scan-outputs/*` under (usually) ~/sb-sessions/. Their outputs land
# through scripts/land.js, after which the worktree is pure bloat. Most get
# reaped inline, but a failed/killed run can leave a DIRTY worktree behind, and
# scripts/git-janitor.js deliberately SKIPS dirty worktrees (git-janitor.js:140)
# so those accumulate and re-bloat .git. This script fills exactly that gap: it
# force-reaps codex worktrees whose branch is already an ancestor of
# origin/master (nothing unmerged can be lost), even when dirty.
#
# Safety invariants (conservative by construction):
#   * Only ever touches branches matching codex/scheduled-skill/* or
#     codex/scan-outputs/*. Never main, dev, agent, or human branches.
#   * NEVER touches a LOCKED worktree (a lock means "in use").
#   * NEVER touches .claude/worktrees/agent-* (interactive agent worktrees).
#   * Only reaps when `git merge-base --is-ancestor <branch> origin/master`
#     proves the branch is fully merged -- unmerged work is left untouched.
#   * Strips top-level directory junctions (e.g. a node_modules junction into
#     the main checkout) BEFORE removal, so `git worktree remove` can never
#     follow a junction and delete the TARGET (2026-06-15 incident guard).
#   * `git branch -d` (safe delete, refuses unmerged) -- never -D.
#   * Idempotent + non-fatal per item: one failure never aborts the sweep.
#
# Usage:
#   scripts/reap-merged-codex-worktrees.sh            # reap
#   scripts/reap-merged-codex-worktrees.sh --dry-run  # report only, change nothing
#
set -u

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    *) echo "ExampleCo arg: $arg" >&2; exit 2 ;;
  esac
done

# Resolve the MAIN checkout root from the shared common git dir so this works no
# matter which worktree the script is invoked from.
COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -z "$COMMON_DIR" ]; then
  # Older git without --path-format: fall back and absolutize manually.
  COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  [ -n "$COMMON_DIR" ] && COMMON_DIR="$(cd "$COMMON_DIR" 2>/dev/null && pwd || echo "$COMMON_DIR")"
fi
if [ -z "$COMMON_DIR" ]; then
  echo "reap: not inside a git repository" >&2
  exit 1
fi
case "$COMMON_DIR" in
  */.git) MAIN_ROOT="$(dirname "$COMMON_DIR")" ;;
  *)      MAIN_ROOT="$(dirname "$COMMON_DIR")" ;;
esac

GIT() { git -C "$MAIN_ROOT" "$@"; }

# Best-effort refresh so the ancestor test reflects what actually landed.
GIT fetch origin master --quiet 2>/dev/null || true

# Pick the origin ref that exists (origin/master preferred, origin/main fallback).
BASE_REF=""
for cand in origin/master origin/main; do
  if GIT rev-parse --verify --quiet "$cand" >/dev/null 2>&1; then BASE_REF="$cand"; break; fi
done
if [ -z "$BASE_REF" ]; then
  echo "reap: no origin/master or origin/main to compare against" >&2
  exit 1
fi

# Strip top-level directory junctions/symlinks (link only, never the target)
# before removal. On Windows a node_modules junction is removed with `rmdir`
# via cmd; elsewhere a symlinked dir entry is unlinked with rm.
strip_junctions() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  local entry p
  for entry in node_modules; do
    p="$dir/$entry"
    if [ -L "$p" ]; then
      rm -f "$p" 2>/dev/null || true
    elif [ -e "$p" ]; then
      # Windows junction: not a POSIX symlink; remove the reparse point only.
      cmd //c "rmdir \"$(cygpath -w "$p" 2>/dev/null || echo "$p")\"" >/dev/null 2>&1 || true
    fi
  done
}

reaped=0
skipped_locked=0
skipped_agent=0
skipped_unmerged=0
failed=0

# Parse `git worktree list --porcelain` records (blank-line separated).
wt_path=""
wt_branch=""
wt_locked=0

process_record() {
  [ -n "$wt_path" ] || return 0
  case "$wt_branch" in
    refs/heads/codex/scheduled-skill/*|refs/heads/codex/scan-outputs/*) : ;;
    *) return 0 ;;  # not a disposable codex worktree
  esac
  case "$wt_path" in
    *.claude/worktrees/agent-*|*/.claude/worktrees/agent-*)
      skipped_agent=$((skipped_agent+1)); return 0 ;;
  esac
  if [ "$wt_locked" -eq 1 ]; then
    skipped_locked=$((skipped_locked+1)); return 0
  fi
  local branch="${wt_branch#refs/heads/}"
  if ! GIT merge-base --is-ancestor "$branch" "$BASE_REF" 2>/dev/null; then
    skipped_unmerged=$((skipped_unmerged+1)); return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would reap: $wt_path  ($branch, merged into $BASE_REF)"
    reaped=$((reaped+1)); return 0
  fi
  strip_junctions "$wt_path"
  if GIT worktree remove --force "$wt_path" 2>/dev/null; then
    GIT branch -d "$branch" 2>/dev/null || true
    echo "reaped: $wt_path  ($branch)"
    reaped=$((reaped+1))
  else
    echo "reap FAILED (left in place): $wt_path  ($branch)" >&2
    failed=$((failed+1))
  fi
}

while IFS= read -r line; do
  case "$line" in
    worktree\ *) wt_path="${line#worktree }" ;;
    branch\ *)   wt_branch="${line#branch }" ;;
    locked*)     wt_locked=1 ;;
    "")          process_record; wt_path=""; wt_branch=""; wt_locked=0 ;;
  esac
done < <(GIT worktree list --porcelain)
process_record  # flush the final record (no trailing blank line)

# Prune stale administrative entries for worktrees whose dir is already gone.
[ "$DRY_RUN" -eq 1 ] || GIT worktree prune 2>/dev/null || true

echo "reap summary: reaped=$reaped skipped(locked=$skipped_locked agent=$skipped_agent unmerged=$skipped_unmerged) failed=$failed dry_run=$DRY_RUN"
[ "$failed" -eq 0 ]
