#!/usr/bin/env python
"""build-sessions-db-py.py

Standalone Python implementation of `session-search.ts build`. Used when
the better-sqlite3 native module is broken on the host (see Electron rebuild
quirks on Windows). Reads meta JSONs from ~/.secondbrain/meta-cache and
populates ~/.secondbrain/sessions.db with the same schema the TS module
expects (sessions table + sessions_fts FTS5 virtual table). Idempotent:
INSERT OR REPLACE on session_id.

Run after `aws s3 sync s3://<bucket>/meta/ ~/.secondbrain/meta-cache/`.
"""
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

HOME = Path(os.environ.get("USERPROFILE") or os.environ.get("HOME") or "")
DB_DIR = HOME / ".secondbrain"
DB_PATH = DB_DIR / "sessions.db"
CACHE_DIR = DB_DIR / "meta-cache"


def init_db(con: sqlite3.Connection) -> None:
    # v1 schema (pre-corpus) created sessions_fts without corpus_user /
    # corpus_assistant columns. If we encounter a v1 db we drop the FTS
    # table and the triggers so the v2 statements below recreate them.
    cur = con.execute("SELECT sql FROM sqlite_master WHERE name='sessions_fts' AND type='table'")
    row = cur.fetchone()
    if row and row[0] and "corpus_user" not in row[0]:
        con.executescript(
            """
            DROP TRIGGER IF EXISTS sessions_ai;
            DROP TRIGGER IF EXISTS sessions_ad;
            DROP TRIGGER IF EXISTS sessions_au;
            DROP TABLE IF EXISTS sessions_fts;
            """
        )

    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          repo TEXT,
          started_at TEXT,
          ended_at TEXT,
          message_count INTEGER,
          tool_calls TEXT,
          first_prompt TEXT,
          last_response TEXT,
          topic_guess TEXT,
          corpus_user TEXT,
          corpus_assistant TEXT,
          s3_date TEXT,
          indexed_at TEXT
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
          session_id UNINDEXED,
          first_prompt,
          last_response,
          topic_guess,
          tool_calls,
          corpus_user,
          corpus_assistant,
          content='sessions',
          content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
          INSERT INTO sessions_fts(rowid, session_id, first_prompt, last_response, topic_guess, tool_calls, corpus_user, corpus_assistant)
          VALUES (new.rowid, new.session_id, new.first_prompt, new.last_response, new.topic_guess, new.tool_calls, new.corpus_user, new.corpus_assistant);
        END;

        CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
          INSERT INTO sessions_fts(sessions_fts, rowid, session_id, first_prompt, last_response, topic_guess, tool_calls, corpus_user, corpus_assistant)
          VALUES('delete', old.rowid, old.session_id, old.first_prompt, old.last_response, old.topic_guess, old.tool_calls, old.corpus_user, old.corpus_assistant);
        END;

        CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
          INSERT INTO sessions_fts(sessions_fts, rowid, session_id, first_prompt, last_response, topic_guess, tool_calls, corpus_user, corpus_assistant)
          VALUES('delete', old.rowid, old.session_id, old.first_prompt, old.last_response, old.topic_guess, old.tool_calls, old.corpus_user, old.corpus_assistant);
          INSERT INTO sessions_fts(rowid, session_id, first_prompt, last_response, topic_guess, tool_calls, corpus_user, corpus_assistant)
          VALUES (new.rowid, new.session_id, new.first_prompt, new.last_response, new.topic_guess, new.tool_calls, new.corpus_user, new.corpus_assistant);
        END;
        """
    )

    # If sessions table existed pre-v2, ALTER ADD nullable columns.
    cur = con.execute("PRAGMA table_info(sessions)")
    cols = {row[1] for row in cur.fetchall()}
    for col in ("corpus_user", "corpus_assistant"):
        if col not in cols:
            con.execute(f"ALTER TABLE sessions ADD COLUMN {col} TEXT")


def upsert(con: sqlite3.Connection, meta: dict, s3_date: str) -> None:
    con.execute(
        """
        INSERT INTO sessions (
          session_id, repo, started_at, ended_at, message_count, tool_calls,
          first_prompt, last_response, topic_guess, corpus_user, corpus_assistant,
          s3_date, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          repo=excluded.repo,
          started_at=excluded.started_at,
          ended_at=excluded.ended_at,
          message_count=excluded.message_count,
          tool_calls=excluded.tool_calls,
          first_prompt=excluded.first_prompt,
          last_response=excluded.last_response,
          topic_guess=excluded.topic_guess,
          corpus_user=excluded.corpus_user,
          corpus_assistant=excluded.corpus_assistant,
          s3_date=excluded.s3_date,
          indexed_at=excluded.indexed_at
        """,
        (
            meta.get("session_id"),
            meta.get("repo"),
            meta.get("started_at"),
            meta.get("ended_at"),
            meta.get("message_count"),
            ",".join(meta.get("tool_calls", []) or []),
            meta.get("first_prompt"),
            meta.get("last_response"),
            meta.get("topic_guess"),
            meta.get("corpus_user"),
            meta.get("corpus_assistant"),
            s3_date,
            datetime.now(timezone.utc).isoformat(),
        ),
    )


def upsert_one(meta_path: Path, s3_date: str) -> int:
    """Upsert a single meta JSON file. Returns 0 on success, 1 on failure."""
    if not meta_path.exists():
        print(f"meta file missing: {meta_path}", file=sys.stderr)
        return 1
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"parse failed: {exc}", file=sys.stderr)
        return 1
    DB_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    try:
        init_db(con)
        upsert(con, data, s3_date)
        con.commit()
    finally:
        con.close()
    print(f"upserted {data.get('session_id', '?')[:8]} for {s3_date} -> {DB_PATH}")
    return 0


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--upsert":
        # --upsert <meta_path> [<s3_date>]
        if len(args) < 2:
            print("usage: build-sessions-db-py.py --upsert <meta_path> [<s3_date>]", file=sys.stderr)
            return 2
        meta_path = Path(args[1])
        s3_date = args[2] if len(args) > 2 else (meta_path.parent.name if meta_path.parent.name else "")
        return upsert_one(meta_path, s3_date)
    if not CACHE_DIR.exists():
        print(f"meta-cache missing: {CACHE_DIR}; run aws s3 sync first", file=sys.stderr)
        return 1
    DB_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    try:
        init_db(con)
        inserted = 0
        failed = 0
        for path in CACHE_DIR.rglob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:
                failed += 1
                print(f"skip {path}: {exc}", file=sys.stderr)
                continue
            # Layout: meta-cache/{repo}/{yyyy-mm-dd}/{session-id}.json
            s3_date = path.parent.name
            upsert(con, data, s3_date)
            inserted += 1
        con.commit()
    finally:
        con.close()
    print(f"indexed {inserted} sessions, {failed} failed -> {DB_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
