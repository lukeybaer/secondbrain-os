#!/bin/bash
# archive-session-to-s3.sh
#
# Claude Code Stop hook. Fires when a session ends. Uploads the full
# transcript jsonl plus a metadata JSON to S3 so every prompt the owner has
# typed and every response Amy has generated is searchable forever.
#
# Bucket: s3://secondbrain-sessions-000000000000-us-east-1
# Layout: {repo}/{yyyy-mm-dd}/{session-id}.jsonl
#         {repo}/{yyyy-mm-dd}/{session-id}.meta.json
#
# Addresses the owner's 2026-04-11 ask: "I want every prompt I give you, and
# the final output from you, the response, saved on S3 somewhere and I
# want each session to have a searchable json against it - how do you
# propose to integrate that into our system? because you were so
# confused about our requirements before forgetting what I wanted."
#
# Commit 14 of 18 in plans/dazzling-rolling-moler.md.

set -e

REGION="${SECONDBRAIN_AWS_REGION:-us-east-1}"

# Account ID is intentionally not in source (PII strip 2f94cce, 2026-04-11).
# Resolve at runtime: env override -> aws sts. If neither works, the
# upload silently fails (|| true downstream) but we log a hard warning so
# the broken state is visible instead of pretending we uploaded.
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '')}"

if [[ -z "$ACCOUNT_ID" || "$ACCOUNT_ID" == "000000000000" ]]; then
  echo "[archive-session] could not resolve AWS account ID (set AWS_ACCOUNT_ID or configure aws cli); skipping" >&2
  exit 0
fi

BUCKET="${SECONDBRAIN_SESSIONS_BUCKET:-secondbrain-sessions-${ACCOUNT_ID}-${REGION}}"

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

# Project dir-slugified path Claude Code uses for session storage.
# Claude Code rule (Windows): replace colons and (back)slashes with single
# dashes. C:\Users\<user>\<repo> -> C--Users-<user>-<repo>
# The forward-slash form C:/Users/... slugifies the same because both /
# and \ map to -. The previous regex stripped the leading C: which is
# wrong on Windows; that has been fixed.
SLUG=$(echo "$PROJECT_DIR" | sed 's|:|-|g; s|\\|-|g; s|/|-|g')
CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
TRANSCRIPT_FILE="$CLAUDE_PROJECTS_DIR/$SLUG/$SESSION_ID.jsonl"

if [[ ! -f "$TRANSCRIPT_FILE" ]]; then
  # Try alternate slug formats
  for alt in "C--Users-USER-secondbrain" "$(echo $PROJECT_DIR | sed 's|/|_|g')"; do
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
# Separate prefixes so Athena can point at meta/ only without parsing
# transcript rows as malformed table entries. Transcripts live alongside
# under transcripts/ for full-fidelity archival.
S3_KEY_JSONL="transcripts/$REPO_NAME/$DATE/$SESSION_ID.jsonl"
S3_KEY_META="meta/$REPO_NAME/$DATE/$SESSION_ID.json"

# Tempfile written by Python directly. Avoids Windows cp1252 mangling
# when passing UTF-8 JSON via $(...) capture into bash.
TMP_META=$(mktemp -t sb-meta-XXXXXX.json)

# Build metadata using a small Python helper. Reads the jsonl and produces
# a payload covering: identity (session_id, repo, started_at, ended_at,
# message_count), display anchors (first_prompt, last_response, topic_guess,
# tool_calls), and a search corpus (corpus_user + corpus_assistant) used
# for FTS5 retrieval. Without the corpus fields, mid-session content is
# invisible to dispatch / email-draft path queries.
python - "$TRANSCRIPT_FILE" "$SESSION_ID" "$REPO_NAME" "$TMP_META" <<'PY'
import json, sys
path, session_id, repo, out_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

USER_CORPUS_LIMIT = 32 * 1024
ASSISTANT_CORPUS_LIMIT = 32 * 1024
MAX_USER_MESSAGES = 200
MAX_ASSISTANT_MESSAGES = 50

first_prompt = None
last_response = None
started_at = None
ended_at = None
message_count = 0
tool_calls = set()
topic_guess = ""
user_messages = []
assistant_messages = []
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
            if role == "user" and content:
                if not first_prompt:
                    first_prompt = content[:1000]
                    topic_guess = content[:200]
                user_messages.append(content)
            if role == "assistant" and content:
                last_response = content[-1000:]
                assistant_messages.append(content)
except Exception as e:
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"error": str(e), "session_id": session_id}, fh, ensure_ascii=False)
    sys.exit(0)


def cap_concat(messages, total_limit, max_n):
    if not messages:
        return ""
    if len(messages) > max_n:
        # Sample evenly across the run so middle content survives
        step = max(len(messages) // max_n, 1)
        sampled = [messages[i] for i in range(0, len(messages), step)][:max_n]
    else:
        sampled = messages
    per = max(total_limit // max(len(sampled), 1), 200)
    parts = [m[:per] for m in sampled]
    joined = "\n\n".join(parts)
    if len(joined) > total_limit:
        joined = joined[:total_limit]
    return joined


corpus_user = cap_concat(user_messages, USER_CORPUS_LIMIT, MAX_USER_MESSAGES)
corpus_assistant = cap_concat(assistant_messages, ASSISTANT_CORPUS_LIMIT, MAX_ASSISTANT_MESSAGES)

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
    "corpus_user": corpus_user,
    "corpus_assistant": corpus_assistant,
    "schema_version": 2,
}
# Write directly to the tempfile path passed in. Avoids Windows cp1252
# mangling on $(python ...) capture for transcripts containing arrows,
# em dashes, etc.
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False)
PY

# Upload both files. Use server-side encryption. Failures are logged
# under $HOME/.secondbrain/archive-session.log so silent breakage like
# the bucket-name placeholder bug (Apr 11 to Apr 30) cannot recur.
LOG_DIR="$HOME/.secondbrain"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/archive-session.log"

aws_upload() {
  local src="$1" dst="$2" content_type="${3:-}"
  local extra=()
  if [[ -n "$content_type" ]]; then extra+=(--content-type "$content_type"); fi
  if aws s3 cp "$src" "$dst" --region "$REGION" --only-show-errors --sse AES256 "${extra[@]}" 2>>"$LOG_FILE"; then
    return 0
  fi
  echo "[$(date -u +%FT%TZ)] upload failed: $src -> $dst" >>"$LOG_FILE"
  return 1
}

# Throttle policy. Today's 10k-turn session would otherwise PUT ~10k
# transcripts and fire ~10k Graphiti entity-extractor LLM calls. The
# meta upload stays per-turn because it is small (~50 KB) and the
# corpus inside it powers FTS5 + dispatch retrieval. The transcript
# upload happens on first turn, then every JSONL_THROTTLE_SEC seconds.
# Graphiti add fires on first turn, then every GRAPHITI_THROTTLE_TURNS
# turns. Either env var can be tuned without touching code.
#
# Final-stop guarantee: when SECONDBRAIN_FINAL_FLUSH=1 (set by a
# SessionEnd hook or the matching flush-session.sh wrapper) the
# throttles are bypassed so the last meta + transcript + Graphiti add
# always run on session close.
JSONL_THROTTLE_SEC="${SECONDBRAIN_JSONL_THROTTLE_SEC:-60}"
GRAPHITI_THROTTLE_TURNS="${SECONDBRAIN_GRAPHITI_THROTTLE_TURNS:-50}"
FORCE_FLUSH="${SECONDBRAIN_FINAL_FLUSH:-0}"

STATE_DIR="$LOG_DIR/upload-state"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/$SESSION_ID.json"
NOW_EPOCH=$(date -u +%s)

# Read the message_count out of the meta we just wrote so the throttle
# decisions key off the same number of turns the corpus reflects.
MESSAGE_COUNT=$(python -c '
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        d = json.load(fh)
    print(int(d.get("message_count", 0)))
except Exception:
    print(0)
' "$TMP_META" 2>/dev/null || echo 0)

# Read prior throttle state. Empty means first turn for this session.
read_state_int() {
  local key="$1"
  python -c '
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        d = json.load(fh)
    print(int(d.get(sys.argv[2], 0)))
except Exception:
    print(0)
' "$STATE_FILE" "$key" 2>/dev/null || echo 0
}
LAST_JSONL_TS=0
LAST_GRAPHITI_TURNS=0
FIRST_TURN_FLAG=1
if [[ -f "$STATE_FILE" ]]; then
  LAST_JSONL_TS=$(read_state_int last_jsonl_upload_ts)
  LAST_GRAPHITI_TURNS=$(read_state_int last_graphiti_message_count)
  FIRST_TURN_FLAG=0
fi

UPLOAD_JSONL=0
UPLOAD_GRAPHITI=0
if [[ "$FORCE_FLUSH" == "1" ]] || [[ "$FIRST_TURN_FLAG" == "1" ]]; then
  UPLOAD_JSONL=1
  UPLOAD_GRAPHITI=1
else
  if (( NOW_EPOCH - LAST_JSONL_TS >= JSONL_THROTTLE_SEC )); then
    UPLOAD_JSONL=1
  fi
  if (( MESSAGE_COUNT - LAST_GRAPHITI_TURNS >= GRAPHITI_THROTTLE_TURNS )); then
    UPLOAD_GRAPHITI=1
  fi
fi

JSONL_OK=0
META_OK=0
GRAPHITI_OK=0
JSONL_SKIPPED=0
GRAPHITI_SKIPPED=0

if [[ "$UPLOAD_JSONL" == "1" ]]; then
  if aws_upload "$TRANSCRIPT_FILE" "s3://$BUCKET/$S3_KEY_JSONL"; then JSONL_OK=1; fi
else
  JSONL_SKIPPED=1
fi
if aws_upload "$TMP_META" "s3://$BUCKET/$S3_KEY_META" "application/json"; then META_OK=1; fi

# Keep the local FTS5 index fresh in real time so #recall and dispatch can
# see the session right after it ends, instead of waiting for a periodic
# rebuild. Also save a copy of the meta to the local cache dir so a future
# full rebuild has the file available without re-pulling from S3.
CACHE_TARGET_DIR="$HOME/.secondbrain/meta-cache/$REPO_NAME/$DATE"
mkdir -p "$CACHE_TARGET_DIR"
CACHE_TARGET_FILE="$CACHE_TARGET_DIR/$SESSION_ID.json"
cp "$TMP_META" "$CACHE_TARGET_FILE" 2>/dev/null || true
HOOK_DIR="$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")"
BUILDER="$HOOK_DIR/../build-sessions-db-py.py"
if [[ -f "$BUILDER" ]]; then
  python "$BUILDER" --upsert "$CACHE_TARGET_FILE" "$DATE" >>"$LOG_FILE" 2>&1 || true
fi

# Graphiti is the unified semantic brain. Every Claude Code session
# becomes an episode there too, so #recall, dispatch, and any other
# surface that consults Graphiti can see this session by meaning, not
# just by keyword. Falls through silently if the SSH tunnel to EC2 is
# down (graphiti-cli.mjs returns exit 2 with stderr to the log).
GRAPHITI_CLI="$HOOK_DIR/../graphiti-cli.mjs"
if [[ "$UPLOAD_GRAPHITI" == "1" ]] && [[ -f "$GRAPHITI_CLI" ]]; then
  if node "$GRAPHITI_CLI" add-from-meta "$CACHE_TARGET_FILE" >>"$LOG_FILE" 2>&1; then
    GRAPHITI_OK=1
  fi
else
  GRAPHITI_SKIPPED=1
fi

# Persist throttle state. Update the JSONL timestamp only when an
# upload actually fired, the Graphiti turn-count only when an add
# fired, so a transient failure does not push the next attempt out
# by another full window.
NEW_LAST_JSONL_TS=$LAST_JSONL_TS
NEW_LAST_GRAPHITI_TURNS=$LAST_GRAPHITI_TURNS
if [[ "$UPLOAD_JSONL" == "1" ]] && [[ "$JSONL_OK" == "1" ]]; then
  NEW_LAST_JSONL_TS=$NOW_EPOCH
fi
if [[ "$UPLOAD_GRAPHITI" == "1" ]] && [[ "$GRAPHITI_OK" == "1" ]]; then
  NEW_LAST_GRAPHITI_TURNS=$MESSAGE_COUNT
fi
python - "$STATE_FILE" "$SESSION_ID" "$NEW_LAST_JSONL_TS" "$NEW_LAST_GRAPHITI_TURNS" "$MESSAGE_COUNT" "$NOW_EPOCH" <<'PY' 2>>"$LOG_FILE" || true
import json, sys
state_path, sid, jsonl_ts, graphiti_turns, msg_count, now_ts = sys.argv[1:7]
out = {
    "session_id": sid,
    "last_jsonl_upload_ts": int(jsonl_ts),
    "last_graphiti_message_count": int(graphiti_turns),
    "last_message_count": int(msg_count),
    "last_seen_ts": int(now_ts),
    "schema_version": 1,
}
with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False)
PY

rm -f "$TMP_META"

# Single status line so the log shows what fired vs throttled per turn.
JSONL_STATUS=$([[ "$JSONL_SKIPPED" == "1" ]] && echo "skip" || ([[ "$JSONL_OK" == "1" ]] && echo "ok" || echo "FAIL"))
META_STATUS=$([[ "$META_OK" == "1" ]] && echo "ok" || echo "FAIL")
GRAPHITI_STATUS=$([[ "$GRAPHITI_SKIPPED" == "1" ]] && echo "skip" || ([[ "$GRAPHITI_OK" == "1" ]] && echo "ok" || echo "FAIL"))
echo "[archive-session] $SESSION_ID turns=$MESSAGE_COUNT jsonl=$JSONL_STATUS meta=$META_STATUS graphiti=$GRAPHITI_STATUS final=$FORCE_FLUSH" >&2
exit 0
