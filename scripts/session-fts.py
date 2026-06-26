#!/usr/bin/env python3
"""session-fts.py  (Layer 2: verbatim recall over raw session transcripts)

ExampleCo 2026-06-14: "it's searchable too by Amy verbatim? ... raw should be
searchable too." Graphiti stores extracted facts, not words, so it cannot do
exact-phrase recall. This is a full-text index over the RAW readable transcript
text, returning the actual passages verbatim.

Why Python sqlite3: the index must be queried by query_knowledge on EC2 (node
20, no node:sqlite, no sqlite3 CLI) and written from the PC sweep. Python's
stdlib sqlite3 has FTS5 on both hosts, with no native-module ABI mismatch
(better-sqlite3 is locked to Electron's node). Single-writer: the EC2 ingest
endpoint serializes writes.

Idempotent: a (session_id, byte_start, byte_end) part is inserted once; re-
indexing the same range is a no-op, so the sweep can retry safely.

Usage:
  python3 session-fts.py init
  echo "<body text>" | python3 session-fts.py index --session ID --repo R \
        --start 0 --end 4096 --ts 2026-06-14T00:00:00Z
  python3 session-fts.py search "dentist xrays" [--limit 5] [--session ID]

DB path: $SB_SESSION_FTS_DB, else /opt/secondbrain/data/session-fts.sqlite.
"""
import argparse
import json
import os
import sqlite3
import sys

DEFAULT_DB = os.environ.get(
    "SB_SESSION_FTS_DB", "/opt/secondbrain/data/session-fts.sqlite"
)


def connect(db_path):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    db = sqlite3.connect(db_path, timeout=30)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=30000")
    return db


def init(db):
    # Dedup ledger: one row per archived byte-range, so re-indexing is a no-op.
    db.execute(
        "CREATE TABLE IF NOT EXISTS parts ("
        "  session_id TEXT NOT NULL, repo TEXT, byte_start INTEGER NOT NULL,"
        "  byte_end INTEGER NOT NULL, ts TEXT,"
        "  PRIMARY KEY (session_id, byte_start, byte_end))"
    )
    # FTS5 over the raw readable body; metadata columns are UNINDEXED so search
    # is on words only, but the row still ExampleCos enough to return the exact
    # source passage (session, repo, byte range, time).
    db.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5("
        "  body, session_id UNINDEXED, repo UNINDEXED, ts UNINDEXED,"
        "  byte_range UNINDEXED, tokenize='porter unicode61')"
    )
    db.commit()


def cmd_index(db, args):
    body = sys.stdin.read()
    init(db)
    cur = db.execute(
        "INSERT OR IGNORE INTO parts(session_id, repo, byte_start, byte_end, ts)"
        " VALUES (?,?,?,?,?)",
        (args.session, args.repo, args.start, args.end, args.ts),
    )
    if cur.rowcount == 0:
        # Already indexed this exact range; idempotent no-op.
        db.commit()
        print(json.dumps({"indexed": False, "reason": "duplicate-range"}))
        return
    db.execute(
        "INSERT INTO fts(body, session_id, repo, ts, byte_range) VALUES (?,?,?,?,?)",
        (body, args.session, args.repo, args.ts, "%d-%d" % (args.start, args.end)),
    )
    db.commit()
    print(json.dumps({"indexed": True, "bytes": len(body)}))


def cmd_search(db, args):
    init(db)
    where = "fts MATCH ?"
    params = [args.query]
    if args.session:
        where += " AND session_id = ?"
        params.append(args.session)
    params.append(args.limit)
    rows = db.execute(
        "SELECT session_id, repo, ts, byte_range,"
        "  snippet(fts, 0, '[', ']', ' ... ', 16) AS snippet, body"
        " FROM fts WHERE " + where + " ORDER BY rank LIMIT ?",
        params,
    ).fetchall()
    out = [
        {
            "session_id": r[0],
            "repo": r[1],
            "ts": r[2],
            "byte_range": r[3],
            "snippet": r[4],
            "body": r[5],
        }
        for r in rows
    ]
    print(json.dumps({"query": args.query, "count": len(out), "results": out}))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=DEFAULT_DB)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    pi = sub.add_parser("index")
    pi.add_argument("--session", required=True)
    pi.add_argument("--repo", default="ExampleCo")
    pi.add_argument("--start", type=int, required=True)
    pi.add_argument("--end", type=int, required=True)
    pi.add_argument("--ts", default="")
    ps = sub.add_parser("search")
    ps.add_argument("query")
    ps.add_argument("--limit", type=int, default=5)
    ps.add_argument("--session", default="")
    args = p.parse_args()

    db = connect(args.db)
    try:
        if args.cmd == "init":
            init(db)
            print(json.dumps({"ok": True, "db": args.db}))
        elif args.cmd == "index":
            cmd_index(db, args)
        elif args.cmd == "search":
            cmd_search(db, args)
    finally:
        db.close()


if __name__ == "__main__":
    main()
