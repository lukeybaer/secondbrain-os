#!/bin/bash
# PreToolUse hook: block gh pr create / git push if tests fail

COMMAND=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.tool_input?.command||'')}catch{console.log('')}})" 2>/dev/null)

# Only gate on PR creation and pushes
if echo "$COMMAND" | grep -qE '(gh\s+pr\s+create|git\s+push)'; then
  echo "Running tests before PR/push..." >&2
  OUTPUT=$(cd "$(git rev-parse --show-toplevel)" && npx vitest run 2>&1)
  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "$OUTPUT" | tail -20 >&2
    echo "Tests failed. Fix failing tests before creating a PR or pushing." >&2
    exit 2
  fi

  echo "All tests passed." >&2
fi

exit 0
