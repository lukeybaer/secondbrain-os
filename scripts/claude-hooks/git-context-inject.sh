#!/bin/bash
# UserPromptSubmit hook: inject git context so Claude always knows repo state
# Only fires once per session (creates a flag file to avoid repeat injection)

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || exit 0)
FLAG="$ROOT/.claude/.git-context-injected"

# Only inject once per session — check flag file age (< 30 min = skip)
if [ -f "$FLAG" ]; then
  AGE=$(( $(date +%s) - $(date -r "$FLAG" +%s 2>/dev/null || echo 0) ))
  if [ "$AGE" -lt 1800 ]; then
    exit 0
  fi
fi

touch "$FLAG" 2>/dev/null

echo "[GIT CONTEXT — auto-injected]"
echo ""
echo "Branch: $(git branch --show-current 2>/dev/null)"
echo ""
echo "Status:"
git -C "$ROOT" status --short 2>/dev/null | head -20
echo ""
echo "Recent commits:"
git -C "$ROOT" log --oneline -10 2>/dev/null

exit 0
