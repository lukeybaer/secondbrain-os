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

if [[ ! -d .git ]]; then
  echo "ERROR: not inside a git repo root" >&2
  exit 1
fi

for src in scripts/git-hooks/*; do
  name=$(basename "$src")
  dest=".git/hooks/$name"
  cp "$src" "$dest"
  chmod +x "$dest"
  echo "installed $name -> $dest"
done

echo "done."
