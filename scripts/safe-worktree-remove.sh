#!/usr/bin/env bash
# safe-worktree-remove.sh <worktree-path>
#
# Removes a git worktree WITHOUT the Windows junction-deletion hazard.
#
# Why this exists (2026-06-15 incident): worktrees here often have node_modules
# junctioned in from the main checkout so tests can run. A bare
# `git worktree remove --force <wt>` follows that junction during its recursive
# delete and wipes the TARGET (the main checkout's real node_modules), breaking
# tooling for every session. See feedback_never_remove_worktree_with_junction.md.
#
# This script strips any directory junctions (rmdir removes the LINK, never the
# target) before removing the worktree, then verifies the main checkout's
# node_modules is still intact (fail loud if not).
set -uo pipefail

WT="${1:-}"
if [ -z "$WT" ]; then
  echo "usage: safe-worktree-remove.sh <worktree-path>" >&2
  exit 2
fi

MAIN_ROOT="${SECONDBRAIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)}"
# Fallback derives the repo root from this script's own location (scripts/..),
# so no machine-specific home path is hardcoded (keeps the public-sync PII gate clean).
MAIN_ROOT="${MAIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Normalize to a Windows path for cmd rmdir.
to_win() { echo "$1" | sed -E 's#^/([a-zA-Z])/#\1:/#; s#/#\\#g'; }

# rmdir (NOT rm -rf) removes a junction's link without touching its target.
# Strip the common node_modules junction plus any other top-level junctions.
strip_junctions() {
  local dir="$1"
  # Known: node_modules junction.
  if [ -e "$dir/node_modules" ]; then
    cmd //c rmdir "$(to_win "$dir/node_modules")" 2>/dev/null || true
  fi
  # Generic: any reparse-point (junction) directly under the worktree root.
  # `dir /AL` lists reparse points; rmdir each by name.
  while IFS= read -r name; do
    [ -n "$name" ] && cmd //c rmdir "$(to_win "$dir/$name")" 2>/dev/null || true
  done < <(cmd //c "dir /AL /B \"$(to_win "$dir")\"" 2>/dev/null | tr -d '\r')
}

echo "[safe-worktree-remove] stripping junctions in $WT"
strip_junctions "$WT"

echo "[safe-worktree-remove] removing worktree $WT"
git worktree remove --force "$WT" 2>&1 | tail -3

# Fail loud if the main checkout's node_modules got damaged anyway.
if [ ! -d "$MAIN_ROOT/node_modules/vitest" ]; then
  echo "[safe-worktree-remove] FATAL: main node_modules looks damaged (vitest missing). Run: (cd \"$MAIN_ROOT\" && npm ci)" >&2
  exit 1
fi
echo "[safe-worktree-remove] done; main node_modules intact"
