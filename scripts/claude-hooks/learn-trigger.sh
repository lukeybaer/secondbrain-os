#!/bin/bash
# UserPromptSubmit hook: detect #learn keyword and inject memory-save workflow

PROMPT=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.user_prompt||'')}catch{console.log('')}})" 2>/dev/null)

if echo "$PROMPT" | grep -qi '#learn'; then
  cat <<'INSTRUCTIONS'
[LEARN WORKFLOW TRIGGERED]

The user tagged this message with #learn. Follow this workflow EXACTLY:

1. Extract the learning from the user's message (everything after #learn is the content)
2. Determine the memory type (user, feedback, project, reference) based on content
3. Check MEMORY.md to see if an existing memory file covers this topic — update it if so, create new if not
4. Write/update the memory file with proper frontmatter (name, description, type) and structured content
5. Update MEMORY.md index with a one-line entry
6. Confirm to Luke: what was saved, where, and how future sessions will pick it up (2-3 sentences max)

Memory directory: C:\Users\luked\.claude\projects\C--Users-luked-secondbrain\memory\
Index file: C:\Users\luked\.claude\projects\C--Users-luked-secondbrain\memory\MEMORY.md
INSTRUCTIONS
fi

exit 0
