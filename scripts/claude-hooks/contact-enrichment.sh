#!/bin/bash
# PostToolUse hook: after reading transcripts, conversations, or emails — inject contact enrichment reminder
# Fires on Read tool when the file looks like a transcript, conversation, or Otter output

FILE=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.tool_input?.file_path||'')}catch{console.log('')}})" 2>/dev/null)

# Match transcript/conversation/otter/email files
if echo "$FILE" | grep -qiE '(transcript|conversation|otter|speech|ingest|call.*log|email|inbox|whatsapp|sms|vapi|call|data.*message|archive)'; then
  cat <<'INSTRUCTIONS'
[CONTACT ENRICHMENT — AUTO-TRIGGERED]

You just read a transcript, conversation, or communication file. SCAN IT NOW for:

1. PEOPLE: Names, roles, companies, phone numbers, emails mentioned
2. RELATIONSHIPS: How they relate to Luke (colleague, vendor, prospect, etc.)
3. FACTS: Anything new about existing contacts (job change, new project, preference)
4. COMMITMENTS: Follow-ups promised, deadlines mentioned, action items
5. PERSONAL CONTEXT (CRITICAL): Kids names/ages/birthdays, spouse/partner details, birthdays, anniversaries, health conditions, housing/moves, personality traits, hobbies, opinions, secrets [CONFIDENTIAL], needs, pets, career updates
6. Use reference_contact_extraction_prompt.md as your extraction template

For each person found:
- Check if they exist in contacts/INDEX.md
- If YES: update their contact file with new info
- If NO: create a new contact file and add to INDEX.md
- Update any relevant memory files if significant context was discussed

Contact directory: C:\Users\luked\.claude\projects\C--Users-luked-secondbrain\memory\contacts\
Contact index: C:\Users\luked\.claude\projects\C--Users-luked-secondbrain\memory\contacts\INDEX.md

Do this AUTOMATICALLY. Do not ask Luke whether to do it.
INSTRUCTIONS
fi

exit 0
