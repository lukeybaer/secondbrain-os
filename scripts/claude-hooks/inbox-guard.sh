#!/bin/bash
# Guard: only fire #inbox/#mail workflow if prompt STARTS with #inbox or #mail
PROMPT=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).user_prompt||'')}catch{console.log('')}})" 2>/dev/null)

if echo "$PROMPT" | grep -qE '^\s*#(inbox|mail)\b'; then
  # Use runtime username so source stays clean of owner-specific paths
  _U="${USERNAME:-user}"
  cat <<'ENDJSON' | sed "s/OWNER_USERNAME/$_U/g"
{"systemMessage": "The user typed #inbox/#mail. Run an immediate Gmail scan + contact enrichment:\n\n1. Use gmail_search_messages to find recent emails (last 48h, exclude promotions/social)\n2. Read each significant thread with gmail_read_thread\n3. Match senders/recipients to contacts in C:\\Users\\OWNER_USERNAME\\.claude\\memory\\contacts\\INDEX.md\n4. For each matched contact: extract personal context using C:\\Users\\OWNER_USERNAME\\.claude\\memory\\reference_contact_extraction_prompt.md -- kids, birthdays, anniversaries, health, housing, hobbies, personality, opinions, needs, career updates\n5. Update contact files in C:\\Users\\OWNER_USERNAME\\.claude\\memory\\contacts\\ with new details + History entry with date and (Gmail) source tag\n6. For unknown important contacts: create new file in contacts dir + add to INDEX.md\n7. Report: threads scanned, contacts updated, new personal intel discovered\n\nDo NOT ask permission -- scan and report."}
ENDJSON
fi
exit 0
