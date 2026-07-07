#!/usr/bin/env python
"""
backfill-sessions-to-s3.py

One-shot backfill of every existing Claude Code session transcript into
s3://secondbrain-sessions-000000000000-us-east-1. Walks
~/.claude/projects/C--Users-USER-secondbrain/*.jsonl, generates a
metadata JSON for each, and uploads both. Safe to re-run: uses
`aws s3 cp` which is idempotent on content (re-uploads will overwrite
but versioning is on so history is preserved).

Addresses the owner's 2026-04-11 ask for searchable session history. This
script seeds the archive so the searchable JSON layer has content to
index before new sessions arrive via the Stop hook.

Commit 15 of 18 in plans/dazzling-rolling-moler.md.

Usage:
    python scripts/backfill-sessions-to-s3.py
"""

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HOME = Path(os.environ.get("USERPROFILE") or os.environ.get("HOME") or "")
PROJECTS_DIR = HOME / ".claude" / "projects" / "C--Users-USER-secondbrain"
REGION = os.environ.get("SECONDBRAIN_AWS_REGION", "us-east-1")
REPO = "secondbrain"


def _resolve_bucket() -> str:
    """Resolve bucket at runtime. Account ID is intentionally not in source
    (PII strip 2f94cce, 2026-04-11). Override via env or read via aws sts."""
    override = os.environ.get("SECONDBRAIN_SESSIONS_BUCKET")
    if override:
        return override
    account_id = os.environ.get("AWS_ACCOUNT_ID")
    if not account_id:
        try:
            account_id = subprocess.check_output(
                ["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"],
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()
        except Exception as exc:
            raise RuntimeError(
                "Cannot resolve AWS account: set SECONDBRAIN_SESSIONS_BUCKET, AWS_ACCOUNT_ID, or configure aws cli"
            ) from exc
    if not account_id or account_id == "000000000000":
        raise RuntimeError("Resolved account id is empty or placeholder")
    return f"secondbrain-sessions-{account_id}-{REGION}"


BUCKET = _resolve_bucket()


USER_CORPUS_LIMIT = 32 * 1024
ASSISTANT_CORPUS_LIMIT = 32 * 1024
MAX_USER_MESSAGES = 200
MAX_ASSISTANT_MESSAGES = 50


def _cap_concat(messages, total_limit, max_n):
    if not messages:
        return ""
    if len(messages) > max_n:
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


def build_meta(transcript_path: Path, session_id: str, repo: str = None) -> dict:
    """Parse a jsonl transcript and extract the metadata payload."""
    repo = repo or REPO
    first_prompt = None
    last_response = None
    started_at = None
    ended_at = None
    message_count = 0
    tool_calls: set[str] = set()
    topic_guess = ""
    user_messages: list[str] = []
    assistant_messages: list[str] = []

    try:
        with transcript_path.open("r", encoding="utf-8", errors="replace") as f:
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

                msg = row.get("message") or row
                if not isinstance(msg, dict):
                    continue
                role = msg.get("role")
                c = msg.get("content")
                content = None
                if isinstance(c, str):
                    content = c
                elif isinstance(c, list):
                    parts = []
                    for p in c:
                        if isinstance(p, dict):
                            if p.get("type") == "text":
                                parts.append(p.get("text", ""))
                            elif p.get("type") == "tool_use":
                                tool_calls.add(p.get("name", "ExampleCo"))
                    content = "\n".join(parts).strip() if parts else None

                if role == "user" and content:
                    if not first_prompt:
                        first_prompt = content[:1000]
                        topic_guess = content[:200]
                    user_messages.append(content)
                if role == "assistant" and content:
                    last_response = content[-1000:]
                    assistant_messages.append(content)
    except Exception as e:
        return {"error": str(e), "session_id": session_id, "repo": repo}

    return {
        "session_id": session_id,
        "repo": repo,
        "started_at": started_at,
        "ended_at": ended_at,
        "message_count": message_count,
        "tool_calls": sorted(tool_calls),
        "first_prompt": first_prompt or "",
        "last_response": last_response or "",
        "topic_guess": topic_guess or "",
        "corpus_user": _cap_concat(user_messages, USER_CORPUS_LIMIT, MAX_USER_MESSAGES),
        "corpus_assistant": _cap_concat(
            assistant_messages, ASSISTANT_CORPUS_LIMIT, MAX_ASSISTANT_MESSAGES
        ),
        "schema_version": 2,
    }


def upload(local_path: str, s3_key: str, content_type: str = "application/jsonl") -> bool:
    cmd = [
        "aws",
        "s3",
        "cp",
        local_path,
        f"s3://{BUCKET}/{s3_key}",
        "--region",
        REGION,
        "--only-show-errors",
        "--sse",
        "AES256",
        "--content-type",
        content_type,
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        return res.returncode == 0
    except Exception as e:
        print(f"  upload failed: {e}", file=sys.stderr)
        return False


def main() -> int:
    if not PROJECTS_DIR.exists():
        print(f"ERROR: {PROJECTS_DIR} does not exist", file=sys.stderr)
        return 1

    jsonls = sorted(PROJECTS_DIR.glob("*.jsonl"))
    total = len(jsonls)
    if total == 0:
        print("No session files to backfill")
        return 0

    print(f"Backfilling {total} session transcripts to s3://{BUCKET}/")
    ok = 0
    fail = 0
    skip = 0

    for i, jsonl_path in enumerate(jsonls, start=1):
        session_id = jsonl_path.stem

        # Date prefix: use file mtime so the S3 layout stays chronological
        mtime = datetime.fromtimestamp(jsonl_path.stat().st_mtime, tz=timezone.utc)
        date_prefix = mtime.strftime("%Y-%m-%d")

        # Separate prefixes so PRIVATE_NAME can point at meta/ cleanly without
        # the transcript lines parsing as malformed JsonSerDe rows.
        s3_key_jsonl = f"transcripts/{REPO}/{date_prefix}/{session_id}.jsonl"
        s3_key_meta = f"meta/{REPO}/{date_prefix}/{session_id}.json"

        # Small files can be sub-1KB transcripts with no real content. Skip empties.
        if jsonl_path.stat().st_size < 200:
            skip += 1
            continue

        meta = build_meta(jsonl_path, session_id)

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tmp:
            json.dump(meta, tmp, ensure_ascii=False)
            tmp_path = tmp.name

        try:
            up_jsonl = upload(str(jsonl_path), s3_key_jsonl, "application/jsonl")
            up_meta = upload(tmp_path, s3_key_meta, "application/json")
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

        if up_jsonl and up_meta:
            ok += 1
        else:
            fail += 1

        if i % 20 == 0 or i == total:
            print(
                f"  [{i}/{total}] ok={ok} fail={fail} skip={skip} "
                f"latest={session_id[:8]}... size={jsonl_path.stat().st_size}"
            )

    print(f"\nBackfill complete: {ok} ok, {fail} failed, {skip} skipped")
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
