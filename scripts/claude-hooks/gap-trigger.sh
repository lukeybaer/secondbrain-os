#!/bin/bash
# UserPromptSubmit hook: detect #gap keyword — regression prevention workflow

PROMPT=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.user_prompt||'')}catch{console.log('')}})" 2>/dev/null)

if echo "$PROMPT" | grep -qi '#gap'; then
  cat <<'INSTRUCTIONS'
[GAP WORKFLOW TRIGGERED — REGRESSION PREVENTION]

The user tagged this message with #gap. This means something that was ALREADY FIXED has broken again. A later session undid prior work. This is a regression — treat it seriously.

Follow this workflow EXACTLY:

1. IDENTIFY THE REGRESSION: What broke? What was the correct behavior before? When did it work?
2. FIX IT NOW: Restore the correct behavior immediately.
3. DIAGNOSE WHY IT REGRESSED: What caused a later session to undo the fix? Missing test? Vibes-based instruction that got forgotten? No mechanical enforcement?
4. CLOSE THE LOOP — pick the strongest prevention mechanism:
   a. WRITE A TEST that fails if this regresses again (preferred — tests run on every edit via PostToolUse hook)
   b. ADD A HOOK if it's a behavioral/workflow issue that tests can't catch (PreToolUse gate, PostToolUse enforcement)
   c. UPDATE CLAUDE.md if it's a code convention that needs to be in every session's context
   d. SAVE A MEMORY only as a last resort — memories are the weakest enforcement; prefer tests and hooks
5. CONFIRM to Luke: what regressed, what you fixed, and what mechanical guard now prevents it from happening again.

The goal: this specific thing can NEVER regress again. Whatever you do must be mechanically enforced, not dependent on Claude "remembering."

Settings file: C:\Users\luked\secondbrain\.claude\settings.json
Hooks directory: C:\Users\luked\secondbrain\.claude\hooks\
Test directory: C:\Users\luked\secondbrain\src\main\__tests__\
Memory directory: C:\Users\luked\.claude\projects\C--Users-luked-secondbrain\memory\
INSTRUCTIONS
fi

exit 0
