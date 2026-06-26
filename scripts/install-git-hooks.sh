#!/bin/bash
# install-git-hooks.sh
#
# Installs repo-tracked git hooks from scripts/git-hooks/ into .git/hooks/.
# Run this after a fresh clone, or whenever scripts/git-hooks/ changes.
#
# The tracked hooks live in scripts/git-hooks/ so they travel with the code
# and show up in diffs. .git/hooks/ is not tracked so without this install
# step a fresh clone has no hooks.

set -e

cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: not inside a git repo" >&2
  exit 1
fi

COMMON_DIR=$(git rev-parse --git-common-dir)
if [[ "$COMMON_DIR" != /* && ! "$COMMON_DIR" =~ ^[A-Za-z]: ]]; then
  COMMON_DIR="$REPO_ROOT/$COMMON_DIR"
fi
HOOK_DIR="$COMMON_DIR/hooks"
mkdir -p "$HOOK_DIR"

for src in scripts/git-hooks/*; do
  [[ -f "$src" ]] || continue
  name=$(basename "$src")
  dest="$HOOK_DIR/$name"
  cp "$src" "$dest"
  chmod +x "$dest"
  echo "installed $name -> $dest"
done

echo "done."
