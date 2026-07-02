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
import math
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
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


# Common English function words that carry no retrieval signal. #recall queries
# are natural language ("what did we decide about the AWS quota"), and OR-joining
# these into the FTS query pulls in sessions that merely contain "the"/"about",
# diluting the bm25-ranked candidate pool. Dropping them sharpens the match.
_STOPWORDS = frozenset(
    {
        "the", "a", "an", "and", "or", "but", "if", "then", "of", "to", "in", "on",
        "for", "with", "is", "are", "was", "were", "be", "been", "being", "do",
        "did", "does", "done", "we", "you", "it", "that", "this", "what", "which",
        "who", "how", "when", "where", "why", "about", "as", "at", "by", "from",
        "into", "out", "up", "so", "no", "not", "yes", "my", "our", "me", "us",
        "he", "she", "they", "them", "his", "her", "their", "its", "have", "has",
        "had", "can", "could", "would", "should", "will", "get", "got", "any",
        "some", "all", "there", "here", "just", "did", "was",
    }
)


def _sanitize(query: str) -> str:
    """Turn free text into an FTS5 query: drop non-word chars and stopwords,
    OR-join the remaining content tokens. If every token is a stopword, fall
    back to the cleaned tokens so an all-common-word query still searches."""
    tokens = [t for t in re.split(r"\s+", query) if t]
    cleaned = []
    for t in tokens:
        c = re.sub(r"[^a-zA-Z0-9._-]", "", t)
        if len(c) >= 2:
            cleaned.append(c)
    if not cleaned:
        return ""
    content = [c for c in cleaned if c.lower() not in _STOPWORDS]
    terms = content or cleaned
    return " OR ".join(f'"{t}"' for t in terms)


# --- Composite recall ranking ---------------------------------------------
# Before: search returned the most *recent* FTS matches (ORDER BY started_at
# DESC), so #recall surfaced whatever session most recently mentioned a word,
# not the session that actually discussed the topic. This mirrors the app's
# src/main/memory-multi-signal-fuse.ts composite fusion (relevance + recency +
# engagement) so the standalone #recall path ranks the same way. Weights and
# half-life are the CrewAI-style defaults, adapted to the signals we actually
# store (bm25, started_at, message_count).
RECALL_HALF_LIFE_DAYS = 30.0
W_RELEVANCE = 0.5
W_RECENCY = 0.3
W_ENGAGEMENT = 0.2
# Fetch a wider bm25-ordered pool than the caller asked for, then re-rank the
# pool by the composite score and return the top N.
CANDIDATE_POOL_MULT = 5
CANDIDATE_POOL_MIN = 50


def _parse_ts(ts: str):
    """Parse an ISO8601 timestamp to an aware UTC datetime, or None."""
    if not ts:
        return None
    s = ts.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        # Fall back to the date prefix (YYYY-MM-DD) if the full stamp is odd.
        try:
            dt = datetime.fromisoformat(s[:10])
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _minmax(values):
    """Return a normalizer mapping each value into [0,1]; neutral 0.5 when the
    pool is degenerate (all equal), so a single signal never dominates."""
    lo, hi = min(values), max(values)
    span = hi - lo
    if span <= 0:
        return lambda _v: 0.5
    return lambda v: (v - lo) / span


def composite_rank(rows, now=None, limit=10, half_life_days=RECALL_HALF_LIFE_DAYS):
    """Re-rank FTS candidate rows by relevance + recency + engagement.

    rows: list of dicts, each with keys started_at, message_count, relevance
          (raw bm25 value; more negative = better match), plus any passthrough
          fields. Returns the top `limit` rows sorted by descending composite
          score, each annotated with a rounded `score`.

    Category, not a single query: relevance dominates, recency breaks near-ties,
    engagement is a mild tiebreaker; all three normalized within the pool.
    """
    if not rows:
        return []
    if now is None:
        now = datetime.now(timezone.utc)
    # bm25 is more negative for better matches, so relevance strength = -bm25.
    rel_strength = [-float(r.get("relevance") or 0.0) for r in rows]
    engagement = [math.log1p(max(0, int(r.get("message_count") or 0))) for r in rows]
    rel_norm = _minmax(rel_strength)
    eng_norm = _minmax(engagement)
    scored = []
    for r, rel, eng in zip(rows, rel_strength, engagement):
        dt = _parse_ts(r.get("started_at") or "")
        if dt is None:
            recency = 0.0
        else:
            age_days = max(0.0, (now - dt).total_seconds() / 86400.0)
            recency = 0.5 ** (age_days / half_life_days)
        score = (
            W_RELEVANCE * rel_norm(rel)
            + W_RECENCY * recency
            + W_ENGAGEMENT * eng_norm(eng)
        )
        out = dict(r)
        out["score"] = round(score, 4)
        scored.append(out)
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:limit]


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
    # Pull a wider bm25-ranked candidate pool, then re-rank by the composite
    # score (relevance + recency + engagement) and keep the top args.limit.
    pool = max(args.limit * CANDIDATE_POOL_MULT, CANDIDATE_POOL_MIN)
    raw = con.execute(
        """
        SELECT s.session_id, s.repo, s.started_at, s.topic_guess,
               substr(s.first_prompt, 1, 240) AS first_prompt_short,
               substr(s.last_response, 1, 240) AS last_response_short,
               s.message_count, bm25(sessions_fts) AS relevance
        FROM sessions_fts
        JOIN sessions s ON s.rowid = sessions_fts.rowid
        WHERE sessions_fts MATCH ?
        ORDER BY relevance
        LIMIT ?
        """,
        (q, pool),
    ).fetchall()
    candidates = [
        {
            "session_id": r[0],
            "repo": r[1],
            "started_at": r[2],
            "topic_guess": r[3],
            "first_prompt": r[4],
            "last_response": r[5],
            "message_count": r[6],
            "relevance": r[7],
        }
        for r in raw
    ]
    rows = composite_rank(candidates, limit=args.limit)
    if args.json:
        # Drop the internal bm25 value from the public payload; keep `score`.
        out = [{k: v for k, v in r.items() if k != "relevance"} for r in rows]
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    if not rows:
        print(f"no matches for: {args.query}")
        return 0
    for r in rows:
        sid_short = (r["session_id"] or "")[:8]
        date = (r["started_at"] or "")[:10]
        print(f"\n[{date}] {r['repo']} {sid_short} (msgs={r['message_count']}, score={r['score']})")
        print(f"  topic: {(r['topic_guess'] or '').strip()[:140]}")
        if r["first_prompt"]:
            print(f"  user : {r['first_prompt'].strip()[:200]}")
        if r["last_response"]:
            print(f"  amy  : {r['last_response'].strip()[:200]}")
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
    # tExampleCo cross-repo so we just instruct the caller. S3 path always works.
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
