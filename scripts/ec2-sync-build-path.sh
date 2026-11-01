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

# 4. Restore executable bits from git's own index (drift guard #3, 2026-08-17).
#
# On 2026-08-16 a release shipped the graphiti maintenance script WITHOUT its
# execute bit. The scheduler could not run it at all, memory-health proof went
# stale, and nothing could self-recover because the thing that writes the proof
# was the thing that could not start. A watcher had to chmod it by hand, and
# that hand fix lives inside a release directory, so the next deploy reverts it.
#
# git records the executable bit in its index, so the index is the authority.
# Re-applying it after every fast-forward makes the deploy path self-healing:
# whatever drops the bit (core.fileMode, a copy, an archive, a chown sweep) is
# corrected on the next sync instead of waiting for someone to notice a silent
# scheduler failure. Cheap, idempotent, and it cannot mark anything executable
# that git does not already say is executable.
RESTORED=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if [ ! -x "$f" ]; then
    chmod +x "$f" 2>/dev/null && RESTORED=$((RESTORED+1))
  fi
done < <(git ls-files --stage | awk '$1 == "100755" { $1=""; $2=""; $3=""; sub(/^[ \t]+/, ""); print }')

# 5. Fail loudly if a scheduler target is still not executable. A deploy that
# leaves a cron target unrunnable must not report success.
NOT_EXEC=0
for f in $(crontab -l 2>/dev/null | grep -oE '/[^ ]*secondbrain[^ ]*\.(sh|js)' | sort -u); do
  [ -f "$f" ] || continue
  case "$f" in *.sh) [ -x "$f" ] || { echo "[ec2-sync] NOT EXECUTABLE cron target: $f" >&2; NOT_EXEC=$((NOT_EXEC+1)); };; esac
done

echo "[ec2-sync] $(date -u +%FT%TZ) HEAD=$(git rev-parse --short HEAD) stashes=$(git stash list | wc -l) exec-bits-restored=$RESTORED non-exec-cron-targets=$NOT_EXEC"
[ "$NOT_EXEC" -eq 0 ] || exit 1
