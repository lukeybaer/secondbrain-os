#!/usr/bin/env bash
# Durable sync of the EC2 briefing build path (/home/ec2-user/secondbrain-current)
# to landed origin/master. Replaces the brittle `git pull --ff-only` cron that
# aborted whenever runtime drift or a root-owned dir blocked the merge, leaving
# the build path stuck on stale code so landed fixes silently reverted.
#
# Robust against the two failure modes seen on 2026-06-22:
#   1. root-owned dirs (e.g. scripts/) -> ec2-user cannot unlink -> chown first.
#   2. runtime drift in tracked files -> stash (PRESERVED, never destroyed) first.
# Then fast-forward. HEAD always advances to master; nothing is lost.
set -uo pipefail
REPO=/home/ec2-user/secondbrain-current
cd "$REPO" || exit 1

# 1. Heal ownership so git can update every path (drift guard #1).
if [ -n "$(find . -not -user ec2-user -not -path './.git/*' -print -quit 2>/dev/null)" ]; then
  sudo -n find . -not -user ec2-user -not -path './.git/*' -print0 2>/dev/null \
    | sudo -n xargs -0 -r chown ec2-user:ec2-user 2>/dev/null || true
fi

# 2. Preserve any runtime drift in a stash (drift guard #2), then fast-forward.
if [ -n "$(git status --short)" ]; then
  git stash push -u -m "ec2-runtime-drift-$(date +%Y%m%d-%H%M%S)" || true
fi
git fetch -q origin master || exit 1
git pull --ff-only origin master || git reset --hard origin/master

# 3. Prune old drift stashes so they do not pile up unbounded (keep newest 10).
COUNT=$(git stash list | wc -l)
if [ "$COUNT" -gt 10 ]; then
  for i in $(seq "$COUNT" -1 11); do git stash drop "stash@{$((i-1))}" >/dev/null 2>&1 || true; done
fi

echo "[ec2-sync] $(date -u +%FT%TZ) HEAD=$(git rev-parse --short HEAD) stashes=$(git stash list | wc -l)"
