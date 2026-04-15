#!/bin/bash
# Guard: only fire #gap workflow if prompt STARTS with #gap
PROMPT=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).user_prompt||'')}catch{console.log('')}})" 2>/dev/null)

if echo "$PROMPT" | grep -qE '^\s*#gap\b'; then
  # Use runtime username so source stays clean of owner-specific paths
  _U="${USERNAME:-user}"
  cat <<'ENDJSON' | sed "s/OWNER_USERNAME/$_U/g"
{"systemMessage": "The user typed #gap. A regression or process failure occurred. Follow this workflow EXACTLY:\n\n1. ACKNOWLEDGE the prior ask -- name the specific feedback or rule that should have prevented this. Quote it. Show you know this was already addressed.\n2. CONFIRM it was supposed to be fixed -- reference the memory file, hook, or rule that exists to prevent this.\n3. EXPLAIN architecturally what went wrong -- not surface-level. What was the reasoning flaw or process gap?\n4. WHY it happened again -- root cause, including why existing safeguards did not catch it.\n5. SELF-REFLECTION (if behavioral) -- what memory exists, why it was violated, how to sharpen it.\n6. THE FIX -- architecture summary: specific files changed, what each does mechanically. Add prevention using this hierarchy (strongest to weakest): test > hook > npm script > CLAUDE.md > memory file.\n7. CONFIRM it cannot recur -- name the guard and explain how it fires.\n8. EXEC SUMMARY: Bullet list of every file created/updated/deleted, one-line each. Explain what was changed, where, and why.\n\nGlobal memory: C:\\Users\\OWNER_USERNAME\\.claude\\memory\\\nGap workflow reference: C:\\Users\\OWNER_USERNAME\\.claude\\memory\\feedback_suggest_hooks.md\n\n#gap is NOT satisfied by just fixing the problem. The whole point is the prevention mechanism."}
ENDJSON
fi
exit 0
