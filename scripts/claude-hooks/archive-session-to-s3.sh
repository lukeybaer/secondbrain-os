#!/bin/bash
# archive-session-to-s3.sh
#
# Claude Code Stop hook. Fires when a session ends. Uploads the full
# transcript jsonl plus a metadata JSON to S3 so every prompt Luke has
# typed and every response Amy has generated is searchable forever.
#
# Bucket: s3://secondbrain-sessions-672613094048-us-east-1
# Layout: {repo}/{yyyy-mm-dd}/{session-id}.jsonl
#         {repo}/{yyyy-mm-dd}/{session-id}.meta.json
#
# Addresses Luke's 2026-04-11 ask: "I want every prompt I give you, and
# the final output from you, the response, saved on S3 somewhere and I
# want each session to have a searchable json against it - how do you
# propose to integrate that into our system? because you were so
# confused about our requirements before forgetting what I wanted."
#
# Commit 14 of 18 in plans/dazzling-rolling-moler.md.

set -e

BUCKET="secondbrain-sessions-672613094048-us-east-1"
REGION="us-east-1"

# Claude Code passes context via CLAUDE_* env vars; CLAUDE_SESSION_ID is
# the canonical one. CLAUDE_PROJECT_DIR gives the repo root. Fall back to
# parsing the transcript path if anything is missing.
SESSION_ID="${CLAUDE_SESSION_ID:-}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
REPO_NAME=$(basename "$PROJECT_DIR")

if [[ -z "$SESSION_ID" ]]; then
  # Try to read from stdin payload (Claude passes JSON to hooks)
  HOOK_JSON=$(cat 2>/dev/null || echo '{}')
  SESSION_ID=$(echo "$HOOK_JSON" | python -c 'import json,sys; d=json.load(sys.stdin); print(d.get("session_id",""))' 2>/dev/null || echo "")
fi

if [[ -z "$SESSION_ID" ]]; then
  echo "[archive-session] no CLAUDE_SESSION_ID, skipping" >&2
  exit 0
fi

# Project dir-slugified path Claude Code uses for session storage
SLUG=$(echo "$PROJECT_DIR" | sed 's|^C:||; s|:||g; s|\\|-|g; s|/|-|g')
CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
TRANSCRIPT_FILE="$CLAUDE_PROJECTS_DIR/$SLUG/$SESSION_ID.jsonl"

if [[ ! -f "$TRANSCRIPT_FILE" ]]; then
  # Try alternate slug formats
  for alt in "C--Users-luked-secondbrain" "$(echo $PROJECT_DIR | sed 's|/|_|g')"; do
    if [[ -f "$CLAUDE_PROJECTS_DIR/$alt/$SESSION_ID.jsonl" ]]; then
      TRANSCRIPT_FILE="$CLAUDE_PROJECTS_DIR/$alt/$SESSION_ID.jsonl"
      break
    fi
  done
fi

if [[ ! -f "$TRANSCRIPT_FILE" ]]; then
  echo "[archive-session] transcript not found for $SESSION_ID" >&2
  exit 0
fi

DATE=$(date -u +"%Y-%m-%d")
S3_KEY_JSONL="$REPO_NAME/$DATE/$SESSION_ID.jsonl"
S3_KEY_META="$REPO_NAME/$DATE/$SESSION_ID.meta.json"

# Build metadata using a small Python helper. Reads the jsonl, pulls
# first user prompt, last assistant response, counts, timestamps, and
# tool calls used.
META_JSON=$(python - "$TRANSCRIPT_FILE" "$SESSION_ID" "$REPO_NAME" <<'PY'
import json, sys, os
path, session_id, repo = sys.argv[1], sys.argv[2], sys.argv[3]
first_prompt = None
last_response = None
started_at = None
ended_at = None
message_count = 0
tool_calls = set()
topic_guess = ""
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
            ts = row.get("timestamp") or row.get("ts")
            if ts and not started_at:
                started_at = ts
            if ts:
                ended_at = ts
            message_count += 1
            role = None
            content = None
            msg = row.get("message") or row
            if isinstance(msg, dict):
                role = msg.get("role")
                c = msg.get("content")
                if isinstance(c, str):
                    content = c
                elif isinstance(c, list):
                    parts = []
                    for p in c:
                        if isinstance(p, dict):
                            if p.get("type") == "text":
                                parts.append(p.get("text", ""))
                            elif p.get("type") == "tool_use":
                                tool_calls.add(p.get("name", "unknown"))
                    content = "\n".join(parts).strip()
            if role == "user" and content and not first_prompt:
                first_prompt = content[:500]
                topic_guess = content[:200]
            if role == "assistant" and content:
                last_response = content[-500:]
except Exception as e:
    print(json.dumps({"error": str(e), "session_id": session_id}))
    sys.exit(0)

out = {
    "session_id": session_id,
    "repo": repo,
    "started_at": started_at,
    "ended_at": ended_at,
    "message_count": message_count,
    "tool_calls": sorted(tool_calls),
    "first_prompt": first_prompt or "",
    "last_response": last_response or "",
    "topic_guess": topic_guess or "",
}
print(json.dumps(out, ensure_ascii=False))
PY
)

# Upload both files. Use server-side encryption. Fail silently if AWS
# isn't reachable — do not block session exit.
TMP_META=$(mktemp -t sb-meta-XXXXXX.json)
echo "$META_JSON" > "$TMP_META"

aws s3 cp "$TRANSCRIPT_FILE" "s3://$BUCKET/$S3_KEY_JSONL" --region "$REGION" --only-show-errors --sse AES256 2>/dev/null || true
aws s3 cp "$TMP_META" "s3://$BUCKET/$S3_KEY_META" --region "$REGION" --only-show-errors --sse AES256 --content-type "application/json" 2>/dev/null || true

rm -f "$TMP_META"
echo "[archive-session] uploaded $SESSION_ID to s3://$BUCKET/$REPO_NAME/$DATE/" >&2
exit 0
