#!/usr/bin/env python
"""sb-session-search.py

Cross-session search CLI. Any Claude Code session in any repo can call
this to find prior sessions that touched a topic. Replaces the
`session-search.ts` runtime path on this host where better-sqlite3
fails to load under ts-node (Electron-targeted native module).

Usage:
    python sb-session-search.py search "<query>" [--limit N] [--json]
    python sb-session-search.py recent [--limit N] [--json]
    python sb-session-search.py show <session_id_prefix>     # full meta
    python sb-session-search.py transcript <session_id_prefix>  # raw jsonl

The DB lives at ~/.secondbrain/sessions.db. If it does not exist, run
build-sessions-db-py.py first (and aws s3 sync s3://<bucket>/meta/
~/.secondbrain/meta-cache/ before that).
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

# Windows console is cp1252 by default; transcripts contain arrows, em
# dashes, and other non-cp1252 chars. Force UTF-8 on stdout/stderr so
# print() never crashes on a session full of them.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DB_PATH = Path(os.environ.get("USERPROFILE") or os.environ.get("HOME") or "") / ".secondbrain" / "sessions.db"


def _sanitize(query: str) -> str:
    """Turn free text into an FTS5 query: drop non-word chars, OR-join tokens."""
    tokens = [t for t in re.split(r"\s+", query) if t]
    cleaned = []
    for t in tokens:
        c = re.sub(r"[^a-zA-Z0-9._-]", "", t)
        if len(c) >= 2:
            cleaned.append(c)
    if not cleaned:
        return ""
    return " OR ".join(f'"{t}"' for t in cleaned)


def _open_ro() -> sqlite3.Connection:
    if not DB_PATH.exists():
        print(f"sessions.db not found at {DB_PATH}", file=sys.stderr)
        print("run scripts/build-sessions-db-py.py to build it from S3 metas", file=sys.stderr)
        sys.exit(2)
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)


def cmd_search(args):
    q = _sanitize(args.query)
    if not q:
        print("query has no usable terms", file=sys.stderr)
        return 1
    con = _open_ro()
    rows = con.execute(
        """
        SELECT s.session_id, s.repo, s.started_at, s.topic_guess,
               substr(s.first_prompt, 1, 240) AS first_prompt_short,
               substr(s.last_response, 1, 240) AS last_response_short,
               s.message_count
        FROM sessions_fts
        JOIN sessions s ON s.rowid = sessions_fts.rowid
        WHERE sessions_fts MATCH ?
        ORDER BY s.started_at DESC
        LIMIT ?
        """,
        (q, args.limit),
    ).fetchall()
    if args.json:
        out = [
            {
                "session_id": r[0],
                "repo": r[1],
                "started_at": r[2],
                "topic_guess": r[3],
                "first_prompt": r[4],
                "last_response": r[5],
                "message_count": r[6],
            }
            for r in rows
        ]
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    if not rows:
        print(f"no matches for: {args.query}")
        return 0
    for r in rows:
        sid_short = (r[0] or "")[:8]
        date = (r[2] or "")[:10]
        print(f"\n[{date}] {r[1]} {sid_short} (msgs={r[6]})")
        print(f"  topic: {(r[3] or '').strip()[:140]}")
        if r[4]:
            print(f"  user : {r[4].strip()[:200]}")
        if r[5]:
            print(f"  amy  : {r[5].strip()[:200]}")
    return 0


def cmd_recent(args):
    con = _open_ro()
    rows = con.execute(
        "SELECT session_id, repo, started_at, topic_guess, message_count FROM sessions ORDER BY started_at DESC LIMIT ?",
        (args.limit,),
    ).fetchall()
    if args.json:
        print(json.dumps([
            {"session_id": r[0], "repo": r[1], "started_at": r[2], "topic_guess": r[3], "message_count": r[4]}
            for r in rows
        ], ensure_ascii=False, indent=2))
        return 0
    for r in rows:
        sid_short = (r[0] or "")[:8]
        date = (r[2] or "")[:10]
        print(f"[{date}] {r[1]} {sid_short} (msgs={r[4]}) {(r[3] or '').strip()[:120]}")
    return 0


def cmd_show(args):
    con = _open_ro()
    row = con.execute(
        "SELECT session_id, repo, started_at, ended_at, message_count, tool_calls, first_prompt, last_response, topic_guess, corpus_user, corpus_assistant FROM sessions WHERE session_id LIKE ? || '%' LIMIT 1",
        (args.session_id_prefix,),
    ).fetchone()
    if not row:
        print(f"no session matches prefix {args.session_id_prefix}", file=sys.stderr)
        return 1
    out = {
        "session_id": row[0],
        "repo": row[1],
        "started_at": row[2],
        "ended_at": row[3],
        "message_count": row[4],
        "tool_calls": row[5],
        "first_prompt": row[6],
        "last_response": row[7],
        "topic_guess": row[8],
        "corpus_user_len": len(row[9] or ""),
        "corpus_assistant_len": len(row[10] or ""),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_transcript(args):
    """Print path to local transcript jsonl. Falls back to S3 download."""
    con = _open_ro()
    row = con.execute(
        "SELECT session_id, repo, s3_date FROM sessions WHERE session_id LIKE ? || '%' LIMIT 1",
        (args.session_id_prefix,),
    ).fetchone()
    if not row:
        print(f"no session matches {args.session_id_prefix}", file=sys.stderr)
        return 1
    session_id, repo, s3_date = row
    # Local: ~/.claude/projects/<slug>/<session>.jsonl. Slug guessing is
    # tricky cross-repo so we just instruct the caller. S3 path always works.
    bucket_env = os.environ.get("SECONDBRAIN_SESSIONS_BUCKET")
    if not bucket_env:
        acct = os.environ.get("AWS_ACCOUNT_ID")
        if not acct:
            try:
                import subprocess
                acct = subprocess.check_output(
                    ["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"],
                    text=True, stderr=subprocess.DEVNULL,
                ).strip()
            except Exception:
                acct = ""
        region = os.environ.get("SECONDBRAIN_AWS_REGION", "us-east-1")
        bucket_env = f"secondbrain-sessions-{acct}-{region}" if acct else ""
    s3_url = f"s3://{bucket_env}/transcripts/{repo}/{s3_date}/{session_id}.jsonl" if bucket_env else "(set SECONDBRAIN_SESSIONS_BUCKET)"
    print(f"session : {session_id}")
    print(f"repo    : {repo}")
    print(f"s3_url  : {s3_url}")
    print(f"download: aws s3 cp {s3_url} ./{session_id}.jsonl --region {os.environ.get('SECONDBRAIN_AWS_REGION', 'us-east-1')}")
    return 0


def main():
    ap = argparse.ArgumentParser(prog="sb-session-search")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="FTS5 keyword search")
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_search)

    r = sub.add_parser("recent", help="N most recent sessions")
    r.add_argument("--limit", type=int, default=20)
    r.add_argument("--json", action="store_true")
    r.set_defaults(func=cmd_recent)

    sh = sub.add_parser("show", help="show full meta for a session id (prefix ok)")
    sh.add_argument("session_id_prefix")
    sh.set_defaults(func=cmd_show)

    tr = sub.add_parser("transcript", help="print s3 path / download cmd for a session")
    tr.add_argument("session_id_prefix")
    tr.set_defaults(func=cmd_transcript)

    args = ap.parse_args()
    sys.exit(args.func(args) or 0)


if __name__ == "__main__":
    main()
