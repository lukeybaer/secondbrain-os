#!/bin/bash
# stall-detector.sh
#
# Claude Code Stop hook. Fires when Claude is about to end its turn.
# Reads the last assistant message from the session transcript and
# scans it for permission-stall phrases like "Want me to ..?",
# "Should I ..?", or "fix it now, or ...?". If any are found, emits
# {"decision": "block", "reason": "..."} which forces Claude to
# continue the turn and execute instead of ending on a question.
#
# Why this exists:
#   memory/feedback_no_permission_stalling.md and
#   memory/feedback_no_stopping_to_ask.md document a CHRONIC regression
#   where Claude pauses mid-task to ask permission instead of just
#   executing. Multiple incidents prior to 2026-04-15. The memory rule
#   alone has not fixed it -- so per the prevention hierarchy
#   (test > hook > npm script > CLAUDE.md > memory file), this hook
#   moves the guard up to the mechanical tier.
#
#   2026-04-15 incident: the owner asked to send an email to Dena. The
#   send pipeline was broken from a PII scrub. Instead of fixing the
#   pipeline inline, the response said "Want me to fix it now, or
#   spawn it as a separate task?" the owner flagged it as #gap.
#
# How it works:
#   1. Find the session transcript JSONL via CLAUDE_SESSION_ID
#   2. Read the LAST assistant text message
#   3. Strip code blocks (false positives from quoted user requests)
#   4. Match against stall phrases
#   5. If matched: print decision-block JSON to stdout, exit 0
#      (Claude Code reads stdout for hook decisions)
#   6. If clean: exit 0 with no output
#
# False-positive control:
#   - Only the LAST assistant message is scanned (not history)
#   - Code blocks are stripped before matching
#   - Quoted email/draft content is stripped (lines starting with > )
#   - The phrases are anchored to clear permission patterns

set -e

SESSION_ID="${CLAUDE_SESSION_ID:-}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

if [[ -z "$SESSION_ID" ]]; then
  HOOK_JSON=$(cat 2>/dev/null || echo '{}')
  SESSION_ID=$(echo "$HOOK_JSON" | python -c 'import json,sys; d=json.load(sys.stdin); print(d.get("session_id",""))' 2>/dev/null || echo "")
fi

if [[ -z "$SESSION_ID" ]]; then
  exit 0
fi

SLUG=$(echo "$PROJECT_DIR" | sed 's|^C:||; s|:||g; s|\\|-|g; s|/|-|g')
TRANSCRIPT_FILE="$HOME/.claude/projects/$SLUG/$SESSION_ID.jsonl"

if [[ ! -f "$TRANSCRIPT_FILE" ]]; then
  for alt in "C--Users-USER-secondbrain" "$(echo $PROJECT_DIR | sed 's|/|_|g')"; do
    if [[ -f "$HOME/.claude/projects/$alt/$SESSION_ID.jsonl" ]]; then
      TRANSCRIPT_FILE="$HOME/.claude/projects/$alt/$SESSION_ID.jsonl"
      break
    fi
  done
fi

if [[ ! -f "$TRANSCRIPT_FILE" ]]; then
  exit 0
fi

# Honor a stop_hook_active guard so we never re-block the same turn
# in a loop. Claude Code passes stop_hook_active=true on a re-entry.
HOOK_PAYLOAD=$(cat 2>/dev/null || echo '{}')
ALREADY_BLOCKED=$(echo "$HOOK_PAYLOAD" | python -c 'import json,sys
try: d=json.load(sys.stdin); print("yes" if d.get("stop_hook_active") else "no")
except: print("no")
' 2>/dev/null || echo "no")

if [[ "$ALREADY_BLOCKED" == "yes" ]]; then
  exit 0
fi

# Extract last assistant text and scan for stall phrases.
RESULT=$(python - "$TRANSCRIPT_FILE" <<'PY'
import json, re, sys

path = sys.argv[1]
last_assistant_text = ""
try:
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            msg = row.get("message") or row
            if not isinstance(msg, dict):
                continue
            if msg.get("role") != "assistant":
                continue
            c = msg.get("content")
            if isinstance(c, str):
                last_assistant_text = c
            elif isinstance(c, list):
                parts = []
                for p in c:
                    if isinstance(p, dict) and p.get("type") == "text":
                        parts.append(p.get("text", ""))
                if parts:
                    last_assistant_text = "\n".join(parts)
except Exception:
    print("CLEAN")
    sys.exit(0)

text = last_assistant_text

# Strip fenced code blocks
text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
# Strip inline code spans
text = re.sub(r"`[^`]*`", "", text)
# Strip blockquoted lines (often contain user-quoted content or draft email bodies)
text = "\n".join(ln for ln in text.split("\n") if not ln.lstrip().startswith(">"))

# Permission-stall phrases. Each is anchored to a clear permission pattern.
# Phrases are case-insensitive. Word boundaries used where helpful.
STALL_PATTERNS = [
    r"\bwant me to\b[^.?!]*\?",
    r"\bshould i\b[^.?!]*\?",
    r"\bdo you want me to\b[^.?!]*\?",
    r"\bwould you like me to\b[^.?!]*\?",
    r"\bready (?:for|to)\b[^.?!]*\?",
    r"\blet me know (?:if|when|whether)\b",
    r"\bshall i\b[^.?!]*\?",
    r"\bproceed\?",
    r"\bok to\b[^.?!]*\?",
    r"\bnow,? or\b[^.?!]*\?",
    r"\bfix it now\b[^.?!]*\?",
]

matches = []
for pat in STALL_PATTERNS:
    for m in re.finditer(pat, text, flags=re.IGNORECASE):
        snippet = m.group(0).strip()
        if len(snippet) > 200:
            snippet = snippet[:200] + "..."
        matches.append(snippet)

if not matches:
    print("CLEAN")
else:
    # Limit to first 3 to keep the reason concise
    print("STALL")
    for s in matches[:3]:
        print(s)
PY
)

if [[ -z "$RESULT" ]] || [[ "$RESULT" == "CLEAN" ]]; then
  exit 0
fi

if [[ "$(echo "$RESULT" | head -1)" != "STALL" ]]; then
  exit 0
fi

QUOTES=$(echo "$RESULT" | tail -n +2 | sed 's/"/\\"/g' | awk '{printf "  - %s\\n", $0}')

cat <<JSON
{
  "decision": "block",
  "reason": "STALL DETECTED: your last message asked permission instead of executing. memory/feedback_no_permission_stalling.md and memory/feedback_no_stopping_to_ask.md document this as a chronic regression. JUST DO THE THING. Phrases caught:\n${QUOTES}\nExecute the proposed action now without asking. Pick the obvious next step (the one the owner would say yes to) and run it. Only stop if the action is genuinely destructive or ambiguous, not because you want confirmation."
}
JSON

exit 0
