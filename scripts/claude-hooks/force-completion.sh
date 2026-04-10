#!/bin/bash
# Stop hook: check if todo list has unfinished items before allowing Claude to stop
# Returns blocking decision if work is incomplete

# Read stdin for stop context
CONTEXT=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(JSON.stringify(j))}catch{console.log('{}')}})}" 2>/dev/null)

# Check if there's a stop_hook_active flag to prevent infinite loops
if echo "$CONTEXT" | grep -q '"stop_hook_active":true'; then
  exit 0
fi

cat <<'INSTRUCTIONS'
[COMPLETION CHECK — AUTO-TRIGGERED]

Before stopping, verify:
1. Are there any in_progress or pending items in your todo list?
2. Did you actually finish what Luke asked for, or did you just get partway?
3. Are there any failing tests from changes you made?

If work is incomplete, keep going. If everything is done, proceed to stop.
INSTRUCTIONS

exit 0
