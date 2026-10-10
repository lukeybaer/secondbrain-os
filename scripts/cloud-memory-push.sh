#!/usr/bin/env bash
# Amy mobile cloud-session memory push (v1).
#
# Safe way to push memory commits to secondbrain master from a sandbox clone.
# Used by the #learn hook when triggered from a mobile / cloud session so a
# memory update made on a phone lands on origin/master without ever
# force-pushing or clobbering a concurrent scheduled job's commit.
#
# Usage:
#   cloud-memory-push.sh "commit message" [pathspec...]
#   (pathspec defaults to "memory/" when none is given)
#
# Behavior:
#   - cds to the repo root first, so it can be invoked from any subdirectory.
#   - Sets a local git identity (user.name / user.email) only if unset locally,
#     never touches global config.
#   - Stages only the given pathspec(s).
#   - If nothing ends up staged, prints a clear message and exits 0 (not an
#     error, there is just nothing to push).
#   - Commits, then retries push up to 3 times total: on rejection it runs
#     `git pull --rebase origin master` and retries. Never force-pushes.
#   - On a rebase conflict: aborts the rebase, prints a message prefixed
#     "[memory-push] CONFLICT" listing the conflicting files, exits 1, and
#     leaves the local commit intact (does not undo the commit).
#
# All log lines are prefixed "[memory-push]" so they are greppable in cloud
# session logs.
set -euo pipefail

log() { echo "[memory-push] $*"; }
err() { echo "[memory-push] $*" >&2; }

if [ "$#" -lt 1 ]; then
  err "usage: cloud-memory-push.sh \"commit message\" [pathspec...]"
  exit 1
fi

COMMIT_MSG="$1"
shift || true

if [ "$#" -gt 0 ]; then
  PATHSPECS=("$@")
else
  PATHSPECS=("memory/")
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# --- local git identity (never touch global config) ------------------------
if [ -z "$(git config --local user.name || true)" ]; then
  git config --local user.name "Amy (cloud)"
  log "set local user.name = Amy (cloud)"
fi
if [ -z "$(git config --local user.email || true)" ]; then
  git config --local user.email "amy-cloud@users.noreply.github.com"
  log "set local user.email = amy-cloud@users.noreply.github.com"
fi

# --- stage only the requested pathspec(s) -----------------------------------
git add -- "${PATHSPECS[@]}"

if git diff --cached --quiet; then
  log "nothing staged for ${PATHSPECS[*]}, nothing to push"
  exit 0
fi

# --- commit ------------------------------------------------------------------
git commit -m "$COMMIT_MSG"
log "committed: $COMMIT_MSG"

# --- retry-push loop, never force ------------------------------------------
ATTEMPT=1
MAX_ATTEMPTS=3
while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
  log "push attempt $ATTEMPT of $MAX_ATTEMPTS"
  if git push origin HEAD:master; then
    log "push succeeded on attempt $ATTEMPT"
    exit 0
  fi

  log "push rejected on attempt $ATTEMPT, rebasing onto origin/master"
  if git pull --rebase origin master; then
    log "rebase clean, retrying push"
    ATTEMPT=$((ATTEMPT + 1))
    continue
  fi

  # Rebase failed: conflict. Collect conflicting files, abort, leave commit intact.
  CONFLICT_FILES="$(git diff --name-only --diff-filter=U || true)"
  git rebase --abort || true
  err "CONFLICT: rebase hit conflicts, aborted rebase, local commit left intact"
  if [ -n "$CONFLICT_FILES" ]; then
    err "CONFLICT files:"
    while IFS= read -r f; do
      [ -n "$f" ] && err "  - $f"
    done <<EOF
$CONFLICT_FILES
EOF
  fi
  exit 1
done

err "push failed after $MAX_ATTEMPTS attempts, local commit left intact"
exit 1
