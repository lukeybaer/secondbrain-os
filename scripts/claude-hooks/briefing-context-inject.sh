#!/bin/bash
# UserPromptSubmit hook: whenever Luke mentions the daily briefing (or any
# synonym), inject the canonical spec path + first 40 lines into the session
# context so Claude reads the spec FIRST before editing anything related.
#
# Matches: "briefing", "daily briefing", "morning briefing", "exec briefing",
# "executive briefing", "change the briefing", "update the briefing",
# "refresh briefing", "regenerate briefing", "daily exec briefing"
#
# The canonical spec lives at:
#   C:\Users\luked\secondbrain\memory\project_briefing_spec.md
#
# This spec is authoritative — do NOT merge from project_ea_vision.md (stale).

PROMPT=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log((j.prompt||j.user_prompt||'').toLowerCase())}catch{console.log('')}})" 2>/dev/null)

if ! echo "$PROMPT" | grep -qiE "briefing|brief"; then
  exit 0
fi

SPEC="C:/Users/luked/secondbrain/memory/project_briefing_spec.md"
if [ ! -f "$SPEC" ]; then
  exit 0
fi

# Emit a systemMessage pointing Claude at the canonical spec
node -e "
const fs = require('fs');
const spec = fs.readFileSync('$SPEC', 'utf8');
const head = spec.split('\n').slice(0, 60).join('\n');
const msg = 'BRIEFING CONTEXT AUTO-INJECTED:\n\n' +
  'Luke mentioned the daily briefing. The CANONICAL spec is:\n' +
  '  $SPEC\n\n' +
  'Read this file in full BEFORE making ANY briefing change, edit, or regeneration.\n' +
  'Do NOT scope the briefing from conversation context.\n' +
  'Do NOT merge from project_ea_vision.md (that file is stale).\n' +
  'This spec is the ONLY source of truth.\n\n' +
  'First 60 lines of the spec:\n\n' + head;
console.log(JSON.stringify({ systemMessage: msg }));
" 2>/dev/null
exit 0
