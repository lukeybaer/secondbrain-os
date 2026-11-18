#!/usr/bin/env python3
"""List the attachment understanding rows in the PC Life Archive and upload
them, so the EC2 attachment coverage report can show whether PC search holds
every attachment EC2 has read (owner decision). Each row is named by its
record path under attachment-understanding/ and its record checksum, the same
identity EC2 computes for its own copy. The receipt also carries the coverage
files of every secure chat Desktop history import, which exist only on the PC.

Read-only against the database. Writes data/agent/attachment-pc-parity.json and
copies it to the lake under attachment-understanding/, which EC2 can read (the
Life Archive indexer skips it: its schema is not a record's); ``--no-upload``
skips the copy.
"""

import argparse
import json
import os
import socket
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("SECONDBRAIN_DATA_DIR") or (REPO / "data"))
S3_TARGET = "s3://your-account-secondbrain-backups/data-lake/secondbrain/life-archive/data/attachment-understanding/pc-parity/attachment-pc-parity.json"
RECENT_DAYS = 30
SCHEMA = "amy.attachment-pc-parity.v2"
ROOT_SEGMENT = "attachment-understanding"


def count_kinds(db_path, now, recent_days=RECENT_DAYS):
    cutoff = (now - timedelta(days=recent_days)).strftime("%Y-%m-%d")
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "select kind, count(*), sum(case when substr(created_at, 1, 10) >= ? then 1 else 0 end) "
            "from items where kind like '%-attachment' group by kind",
            (cutoff,),
        ).fetchall()
    finally:
        con.close()
    return {kind: {"lifetime": int(total), "recent": int(recent or 0)} for kind, total, recent in rows}


def record_identities(db_path):
    """{record path relative to attachment-understanding/: checksum}."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute("select raw_path, checksum from items where kind like '%-attachment'").fetchall()
    finally:
        con.close()
    out = {}
    for raw_path, checksum in rows:
        parts = str(raw_path or "").replace("\\", "/").split("/")
        if ROOT_SEGMENT not in parts:
            continue
        at = len(parts) - 1 - parts[::-1].index(ROOT_SEGMENT)
        out["/".join(parts[at + 1:])] = checksum
    return out


def default_signal_history_runs():
    """Where scripts/signal-history-import.js writes each import's run folder."""
    app_data = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(app_data) / "secondbrain" / "data" / "signal" / "history" / "runs"


def signal_history(runs_root):
    """{import name: its attachment and life archive coverage counts}."""
    out = {}
    root = Path(runs_root)
    runs = sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
    for run in runs:
        files = {}
        for key, name in (("attachmentCoverage", "attachment-coverage.json"), ("lifeArchiveCoverage", "life-archive-coverage.json")):
            try:
                data = json.loads((run / name).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            # Counts plus schema and status only: no local paths leave the PC.
            files[key] = {k: v for k, v in data.items() if isinstance(v, (int, float, bool)) or k in ("schema", "status")}
        if "attachmentCoverage" in files:
            out[run.name] = files
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(DATA_DIR / "life-archive" / "life-archive.db"))
    parser.add_argument("--out", default=str(DATA_DIR / "agent" / "attachment-pc-parity.json"))
    parser.add_argument("--signal-history-runs", default=str(default_signal_history_runs()))
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    receipt = {
        "schema": SCHEMA,
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "host": socket.gethostname(),
        "recentDays": RECENT_DAYS,
        "kinds": count_kinds(args.db, now),
        "records": record_identities(args.db),
        "signalHistory": signal_history(args.signal_history_runs),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    if not args.no_upload:
        result = subprocess.run(["aws", "s3", "cp", str(out), S3_TARGET, "--only-show-errors", "--region", "us-east-1"])
        if result.returncode:
            print("[attachment-pc-parity] upload failed", file=sys.stderr)
            return result.returncode
    summary = {k: v for k, v in receipt.items() if k not in ("records", "signalHistory")}
    print(json.dumps(summary | {"records": len(receipt["records"]), "signalHistoryImports": sorted(receipt["signalHistory"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
