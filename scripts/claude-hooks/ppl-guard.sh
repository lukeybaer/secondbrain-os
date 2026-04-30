#!/bin/bash
# Guard: only fire #ppl workflow if prompt STARTS with #ppl
PROMPT=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).user_prompt||'')}catch{console.log('')}})" 2>/dev/null)

if echo "$PROMPT" | grep -qE '^\s*#ppl\b'; then
  # Use runtime username so source stays clean of owner-specific paths
  _U="${USERNAME:-user}"
  cat <<'ENDJSON' | sed "s/OWNER_USERNAME/$_U/g"
{"systemMessage": "The user typed #ppl. Run a full people/contacts memory cleanup:\n\n1. READ every file in C:\\Users\\OWNER_USERNAME\\.claude\\memory\\contacts\\ and the family file (C:\\Users\\OWNER_USERNAME\\.claude\\memory\\user_wife_family.md)\n2. CROSS-REFERENCE: For each contact, check if they appear in multiple files (contacts/, family, companies, profile). Flag duplicates and contradictions.\n3. CATEGORIZE: Ensure every contact file has the correct category (family, inner-circle, active-network, amazon, job-search, etc.) and that INDEX.md matches.\n4. DEDUP: If the same person appears in multiple contact files, merge into one canonical file and update all references.\n5. CASCADE: When you learn new info about a person (like a relationship change), update ALL files that mention them -- their contact file, INDEX.md, family file, companies file, etc.\n6. CLEAN: Remove stale or wrong info. Fix broken cross-references.\n7. REPORT: Summarize what you found and fixed.\n\nDo NOT ask permission -- just do the cleanup and report results."}
ENDJSON
fi
exit 0
