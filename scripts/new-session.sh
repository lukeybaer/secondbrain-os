#!/bin/bash
# new-session.sh
#
# Phase 1 of the session-isolation plan: launcher wrapper that creates a fresh,
# ISOLATED per-session git worktree so a session never works in the shared main
# checkout (where peers can clobber uncommitted work).
#
# What it does:
#   1. Creates a worktree at  C:/Users/USER/sb-sessions/<id>
#      on a new branch     session/<id>  off  origin/master
#   2. Junctions node_modules from the main checkout into the worktree so the
#      session has deps without a multi-GB copy or a fresh npm install.
#   3. Prints the worktree path and tells the caller to cd there and launch
#      claude / codex.
#
# Usage:
#   bash scripts/new-session.sh <id>
#   bash scripts/new-session.sh                 # auto id from UTC timestamp
#
# <id> comes from arg1. We do NOT compute Date.now() in JS; if no arg is given
# we derive a simple, sortable, filesystem-safe slug from the shell `date`.
# Pass your own <id> when you want a memorable name.
#
# Idempotent-ish: if the worktree dir already exists, it is reused (no error),
# and the node_modules junction is only created if missing.
#
# Exit codes: 0 on success, non-zero only if the worktree could not be created.

set -euo pipefail

MAIN="${SECONDBRAIN_ROOT:-$HOME/secondbrain}"
MAIN="${MAIN//\\//}"
# Derive the worktree parent from the main checkout's parent so this resolves on
# any machine/home dir. A hardcoded "C:/Users/USER/sb-sessions" silently broke
# isolation here (the literal "USER" placeholder never resolved), which pushed
# sessions back into the shared checkout. Env override wins for non-default layouts.
SESSIONS_ROOT="${SB_SESSIONS_ROOT:-$(dirname "$MAIN")/sb-sessions}"

# 1. Resolve the session id. arg1 wins; otherwise a UTC timestamp slug.
ID="${1:-}"
if [ -z "$ID" ]; then
  ID="sess-$(date -u +%Y%m%d%H%M%S)"
fi
# Sanitize: keep it filesystem- and branch-name-safe (alnum, dash, underscore).
ID="$(printf '%s' "$ID" | tr -c 'A-Za-z0-9_-' '-')"

BRANCH="session/$ID"
WORKTREE="$SESSIONS_ROOT/$ID"

echo "[new-session] main checkout : $MAIN"
echo "[new-session] worktree      : $WORKTREE"
echo "[new-session] branch        : $BRANCH"

# Make sure the parent dir for worktrees exists.
mkdir -p "$SESSIONS_ROOT"

# 2. Create the worktree off origin/master (fetch first so origin/master is fresh).
if [ -d "$WORKTREE/.git" ] || [ -f "$WORKTREE/.git" ]; then
  echo "[new-session] worktree already exists, reusing it."
else
  git -C "$MAIN" fetch origin master --quiet || {
    echo "[new-session] WARNING: git fetch origin master failed; using local origin/master ref." >&2
  }
  # If the branch already exists, attach to it; otherwise create it off origin/master.
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$MAIN" worktree add "$WORKTREE" "$BRANCH"
  else
    git -C "$MAIN" worktree add -b "$BRANCH" "$WORKTREE" origin/master
  fi
fi

# 3. Junction node_modules from the main checkout (Windows directory junction).
# A junction avoids copying the (large) dependency tree and keeps the worktree
# in sync with the main checkout's installed deps. Only create it if absent.
if [ -e "$WORKTREE/node_modules" ]; then
  echo "[new-session] node_modules already present in worktree, leaving it."
elif [ -d "$MAIN/node_modules" ]; then
  # mklink needs backslash paths and runs via cmd. /J = directory junction.
  WIN_LINK="$(printf '%s' "$WORKTREE/node_modules" | sed 's#/#\\#g')"
  WIN_TARGET="$(printf '%s' "$MAIN/node_modules" | sed 's#/#\\#g')"
  cmd //c "mklink /J \"$WIN_LINK\" \"$WIN_TARGET\"" >/dev/null \
    && echo "[new-session] junctioned node_modules -> $MAIN/node_modules" \
    || echo "[new-session] WARNING: could not junction node_modules; run 'npm install' in the worktree if needed." >&2
else
  echo "[new-session] WARNING: $MAIN/node_modules not found; run 'npm install' in the worktree before working." >&2
fi

echo ""
echo "[new-session] DONE. Your isolated worktree is ready."
echo ""
echo "  Next, do all work in the worktree (NOT the main checkout):"
echo ""
echo "    cd \"$WORKTREE\""
echo "    # then launch claude / codex from there"
echo ""
echo "  When finished, push your branch and remove the worktree:"
echo ""
echo "    git -C \"$WORKTREE\" push -u origin \"$BRANCH\""
echo "    git -C \"$MAIN\" worktree remove \"$WORKTREE\""
echo ""

# Emit the bare path on the last line so a caller can capture it:
#   WT=$(bash scripts/new-session.sh myid | tail -1)
printf '%s\n' "$WORKTREE"
