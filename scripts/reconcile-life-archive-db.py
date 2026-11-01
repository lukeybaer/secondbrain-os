#!/usr/bin/env python3
"""Reconcile existing Life Archive SQLite databases into one runtime database.

The command plans without writing by default.  An explicit --apply first takes
stable SQLite backup snapshots of every source, holds the canonical archive
writer lock, validates conflicts and coverage against those snapshots, and
atomically promotes a staged database.  It never moves or deletes source
Databases or raw archives.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import uuid
import re
import errno
from datetime import datetime, timezone

ITEM_COLUMNS = (
    "id", "source", "source_id", "kind", "title", "author", "recipients",
    "created_at", "raw_path", "url", "checksum", "metadata_json", "indexed_at",
)
ATTACHMENT_COLUMNS = (
    "id", "item_id", "filename", "content_type", "path", "size", "checksum",
    "extracted_text", "metadata_json",
)
FTS_COLUMNS = ("item_id", "source", "title", "body", "attachment_text", "participants", "raw_path")


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def resolved(path):
    return Path(path).expanduser().resolve()


def readonly_connection(path):
    # as_uri percent-escapes names such as `archive%2026.db`; interpolating a
    # Windows path into `file:` changes its meaning at %, ? and #.
    return sqlite3.connect(f"{resolved(path).as_uri()}?mode=ro", uri=True)


def write_connection(path):
    con = sqlite3.connect(str(path))
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def make_unique_file(directory, prefix, suffix):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    # O_EXCL avoids replacing any archive, receipt, or prior snapshot even
    # when two operators happen to start during the same second.
    for _ in range(100):
        candidate = directory / f"{prefix}.{datetime.now().strftime('%Y%m%dT%H%M%S%fZ')}.{uuid.uuid4().hex}{suffix}"
        try:
            fd = os.open(str(candidate), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            return candidate
        except FileExistsError:
            continue
    raise RuntimeError(f"could not create a unique file in {directory}")


def archive_lock_path(target):
    return Path(target).with_suffix(".lock")


def acquire_target_lock(target):
    lock = archive_lock_path(target)
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise RuntimeError(f"canonical Life Archive writer lock exists: {lock}") from exc
    token = uuid.uuid4().hex
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump({"owner": "life-archive-reconcile", "token": token, "created_at": utc_now(), "pid": os.getpid()}, handle)
    return lock, token


def release_target_lock(lock, token):
    try:
        payload = json.loads(Path(lock).read_text(encoding="utf-8"))
        if payload.get("token") == token:
            Path(lock).unlink()
    except FileNotFoundError:
        pass


def assert_target_lock(lock, token):
    try:
        return bool(lock.exists() and json.loads(lock.read_text(encoding="utf-8")).get("token") == token)
    except (OSError, ValueError, json.JSONDecodeError):
        return False


def required_columns(con, table, columns):
    actual = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
    missing = [column for column in columns if column not in actual]
    if missing:
        raise ValueError(f"{table} lacks required columns: {', '.join(missing)}")


def validate_archive(con, label):
    for table, columns in (("items", ITEM_COLUMNS), ("attachments", ATTACHMENT_COLUMNS), ("item_fts", FTS_COLUMNS)):
        try:
            required_columns(con, table, columns)
        except sqlite3.DatabaseError as exc:
            raise ValueError(f"{label} is not a compatible Life Archive database: {exc}") from exc
    schema = con.execute("SELECT sql FROM sqlite_master WHERE name='item_fts'").fetchone()
    sql = str(schema[0] if schema else "")
    if not re.search(r"\bUSING\s+fts5\s*\(", sql, re.I) or re.search(r"\bcontent\s*=", sql, re.I):
        raise ValueError(f"{label} requires a standalone FTS5 archive")
    triggers = con.execute("SELECT sql FROM sqlite_master WHERE type='trigger'")
    if any(re.search(r"\bitem_fts\b", str(row[0]), re.I) for row in triggers):
        raise ValueError(f"{label} has an unsupported FTS-maintenance trigger")
    orphan = con.execute("SELECT 1 FROM item_fts f LEFT JOIN items i ON i.id=f.item_id WHERE i.id IS NULL LIMIT 1").fetchone()
    if orphan:
        raise ValueError(f"{label} has an FTS row without an archive item")


def count_rows(con):
    return {table: int(con.execute(f"SELECT COUNT(*) FROM {table if table != 'fts' else 'item_fts'}").fetchone()[0]) for table in ("items", "attachments", "fts")}


def row_digest(con, table, columns, order="rowid"):
    digest = hashlib.sha256()
    query = f"SELECT {', '.join(columns)} FROM {table} ORDER BY {order}"
    for row in con.execute(query):
        digest.update(json.dumps([row[column] for column in columns], ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def archive_digest(con):
    return {
        "items": row_digest(con, "items", ITEM_COLUMNS, "id"),
        "attachments": row_digest(con, "attachments", ATTACHMENT_COLUMNS, "id"),
        "fts": row_digest(con, "item_fts", FTS_COLUMNS),
    }


def raw_roots(con):
    roots = {}
    for source, raw_path in con.execute("SELECT source, raw_path FROM items WHERE raw_path IS NOT NULL AND raw_path <> ''"):
        roots.setdefault(source or "unknown", set()).add(str(Path(raw_path).parent))
    compact = {}
    for source, paths in sorted(roots.items()):
        paths = sorted(paths)
        try:
            common_root = os.path.commonpath(paths)
        except ValueError:
            common_root = None
        compact[source] = {"common_root": common_root, "distinct_parent_count": len(paths)}
    return compact


def snapshot_database(source_path, destination_path):
    """Capture a WAL-consistent backup once; downstream code reads only it."""
    source = readonly_connection(source_path)
    destination = sqlite3.connect(str(destination_path))
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()


def snapshot_report(path, source_path=None):
    con = readonly_connection(path)
    con.row_factory = sqlite3.Row
    try:
        validate_archive(con, str(path))
        return {
            "path": str(resolved(source_path or path)),
            "snapshot_sha256": sha256_path(path),
            "counts": count_rows(con),
            "digests": archive_digest(con),
            "raw_roots": raw_roots(con),
        }
    finally:
        con.close()


def sha256_path(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def item_key(row):
    return (row["source"], row["source_id"]) if row["source"] and row["source_id"] else None


def find_logical_item(con, row):
    key = item_key(row)
    if not key:
        return None
    return con.execute("SELECT " + ", ".join(ITEM_COLUMNS) + " FROM items WHERE source=? AND source_id=? LIMIT 1", key).fetchone()


def item_conflict(existing, incoming):
    # A stable logical identity is source/source_id.  A database created under
    # another data root has a different derived item id and raw_path but is
    # still the same immutable record when its checksum agrees.
    if existing["id"] != incoming["id"]:
        return not existing["checksum"] or not incoming["checksum"] or existing["checksum"] != incoming["checksum"]
    return any(existing[field] != incoming[field] for field in ("source", "source_id", "raw_path", "checksum"))


def attachment_signature(row):
    return tuple(row[field] for field in ATTACHMENT_COLUMNS if field not in ("id", "item_id"))


def fts_signature(row):
    # raw_path changes when the same immutable source is mirrored under a new
    # runtime root.  It is provenance, not indexed content; the source report
    # retains both roots.  Any searchable/body difference still fails closed.
    return tuple(row[field] for field in FTS_COLUMNS if field not in ("item_id", "raw_path"))


def target_item_id(con, incoming):
    by_id = con.execute("SELECT " + ", ".join(ITEM_COLUMNS) + " FROM items WHERE id=?", (incoming["id"],)).fetchone()
    if by_id:
        return by_id["id"], by_id
    logical = find_logical_item(con, incoming)
    if logical:
        return logical["id"], logical
    return None, None


def ensure_fts_item_lookup(con):
    """Per-connection rowid map avoids an FTS scan for every item coverage lookup."""
    if con.execute("SELECT name FROM sqlite_temp_master WHERE type='table' AND name='fts_item_lookup'").fetchone():
        return
    con.execute("CREATE TEMP TABLE fts_item_lookup (item_id TEXT NOT NULL, fts_rowid INTEGER PRIMARY KEY)")
    con.execute("CREATE INDEX fts_item_lookup_item_id ON fts_item_lookup(item_id)")
    con.execute("INSERT INTO fts_item_lookup SELECT item_id, rowid FROM item_fts")


def rebuild_fts_item_lookup(con):
    """Coverage reads a fresh map from real FTS rows, independent of merge upkeep."""
    con.execute("DROP TABLE IF EXISTS temp.fts_item_lookup")
    ensure_fts_item_lookup(con)

def fts_rows(con, item_id):
    ensure_fts_item_lookup(con)
    columns = ", ".join(f"f.{column} AS {column}" for column in FTS_COLUMNS)
    query = f"SELECT {columns} FROM fts_item_lookup m JOIN item_fts f ON f.rowid=m.fts_rowid WHERE m.item_id=? ORDER BY m.fts_rowid"
    return list(con.execute(query, (item_id,)))


def source_fts(con, item_id):
    return [fts_signature(row) for row in fts_rows(con, item_id)]


def target_fts(con, item_id):
    return source_fts(con, item_id)


def collect_conflicts(target, source_snapshots):
    conflicts = []
    seen_logical = {}
    for source_path, source_label in source_snapshots:
        source = readonly_connection(source_path)
        source.row_factory = sqlite3.Row
        try:
            for incoming in source.execute("SELECT " + ", ".join(ITEM_COLUMNS) + " FROM items"):
                canonical_id, existing = target_item_id(target, incoming)
                if existing and item_conflict(existing, incoming):
                    conflicts.append({"kind": "item-id" if existing["id"] == incoming["id"] else "logical-item", "source_db": source_label, "id": incoming["id"]})
                    continue
                key = item_key(incoming)
                prior = seen_logical.get(key) if key else None
                if prior and prior["checksum"] != incoming["checksum"]:
                    conflicts.append({"kind": "logical-source", "source_db": source_label, "source": key[0], "source_id": key[1]})
                    continue
                if key:
                    seen_logical[key] = incoming
                if canonical_id:
                    incoming_fts = source_fts(source, incoming["id"])
                    existing_fts = target_fts(target, canonical_id)
                    if incoming_fts and existing_fts and incoming_fts != existing_fts:
                        conflicts.append({"kind": "fts-derived-content", "source_db": source_label, "id": incoming["id"]})
            for incoming in source.execute("SELECT " + ", ".join(ATTACHMENT_COLUMNS) + " FROM attachments"):
                existing = target.execute("SELECT " + ", ".join(ATTACHMENT_COLUMNS) + " FROM attachments WHERE id=?", (incoming["id"],)).fetchone()
                if existing and attachment_signature(existing) != attachment_signature(incoming):
                    conflicts.append({"kind": "attachment-id", "source_db": source_label, "id": incoming["id"]})
        finally:
            source.close()
    return conflicts


def insert_row(con, table, columns, row):
    con.execute(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", [row[column] for column in columns])


def merge_source(target, source_path, source_label):
    source = readonly_connection(source_path)
    source.row_factory = sqlite3.Row
    merged = {
        "source_db": source_label,
        "items": 0,
        "equivalent_items": 0,
        "attachments": 0,
        "fts": 0,
        # The first source is intentionally the baseline. Later equivalent
        # records retain their original files and are made auditable here.
        "logical_duplicate_provenance": [],
    }
    mappings = {}
    try:
        for incoming in source.execute("SELECT " + ", ".join(ITEM_COLUMNS) + " FROM items"):
            canonical_id, existing = target_item_id(target, incoming)
            if existing:
                mappings[incoming["id"]] = canonical_id
                merged["equivalent_items"] += 1
                if canonical_id != incoming["id"]:
                    merged["logical_duplicate_provenance"].append({
                        "source": incoming["source"],
                        "source_id": incoming["source_id"],
                        "canonical_item_id": canonical_id,
                        "duplicate_item_id": incoming["id"],
                        "retained_raw_path": existing["raw_path"],
                        "alternate_raw_path": incoming["raw_path"],
                    })
            else:
                insert_row(target, "items", ITEM_COLUMNS, incoming)
                mappings[incoming["id"]] = incoming["id"]
                merged["items"] += 1
        for incoming in source.execute("SELECT " + ", ".join(ATTACHMENT_COLUMNS) + " FROM attachments"):
            canonical_id = mappings.get(incoming["item_id"])
            if not canonical_id:
                raise RuntimeError(f"attachment references missing source item {incoming['item_id']}")
            existing = target.execute("SELECT " + ", ".join(ATTACHMENT_COLUMNS) + " FROM attachments WHERE id=?", (incoming["id"],)).fetchone()
            if existing:
                continue
            values = dict(incoming)
            values["item_id"] = canonical_id
            insert_row(target, "attachments", ATTACHMENT_COLUMNS, values)
            merged["attachments"] += 1
        ensure_fts_item_lookup(target)
        for source_item_id, canonical_id in mappings.items():
            incoming_rows = fts_rows(source, source_item_id)
            existing_rows = target_fts(target, canonical_id)
            if existing_rows:
                continue
            for incoming in incoming_rows:
                values = dict(incoming)
                values["item_id"] = canonical_id
                changes_before = target.total_changes
                insert_row(target, "item_fts", FTS_COLUMNS, values)
                # insert_row uses plain INSERT and raises on failure. Bind the
                # actual FTS row before maintaining the map; a suppressed or
                # unexpected write must roll the merge back, never invent proof.
                changed, inserted_rowid = target.execute("SELECT changes(), last_insert_rowid()").fetchone()
                inserted = target.execute("SELECT item_id FROM item_fts WHERE rowid=?", (inserted_rowid,)).fetchone()
                if target.total_changes <= changes_before or changed != 1 or not inserted or inserted["item_id"] != canonical_id:
                    raise RuntimeError("FTS insertion did not write exactly the mapped item")
                target.execute("INSERT INTO fts_item_lookup VALUES (?, ?)", (canonical_id, inserted_rowid))
                merged["fts"] += 1
    finally:
        source.close()
    return merged


def integrity_errors(con):
    quick = [row[0] for row in con.execute("PRAGMA quick_check")]
    foreign = [tuple(row) for row in con.execute("PRAGMA foreign_key_check")]
    try:
        con.execute("INSERT INTO item_fts(item_fts) VALUES('integrity-check')")
        fts_integrity = "ok"
    except sqlite3.DatabaseError as exc:
        fts_integrity = f"error:{exc}"
    return {"quick_check": quick, "foreign_key_check": foreign, "fts_integrity_check": fts_integrity}


def first_probe_token(row):
    for field in ("source", "title", "body", "attachment_text", "participants"):
        match = re.search(r"[A-Za-z0-9_]{2,}", str(row[field] or ""))
        if match:
            return match.group(0)
    return None


def fts_match_probe(target, snapshot_path, source_label):
    """Prove one FTS MATCH per source without storing searchable text."""
    source = readonly_connection(snapshot_path)
    source.row_factory = sqlite3.Row
    try:
        row = source.execute("SELECT " + ", ".join(FTS_COLUMNS) + " FROM item_fts ORDER BY rowid LIMIT 1").fetchone()
        if not row:
            return {"source_db": source_label, "probe_count": 0, "match_count": 0, "probe_hash": None}
        incoming_item = source.execute("SELECT " + ", ".join(ITEM_COLUMNS) + " FROM items WHERE id=?", (row["item_id"],)).fetchone()
        if not incoming_item:
            # A dangling FTS row is invalid evidence. Return a redacted failed
            # probe so the caller rolls back without writing its text to a receipt.
            return {
                "source_db": source_label,
                "probe_count": 1,
                "match_count": 0,
                "probe_hash": hashlib.sha256(str(row["item_id"]).encode()).hexdigest(),
            }
        canonical_id, existing = target_item_id(target, incoming_item)
        token = first_probe_token(row)
        if not existing or not token:
            return {"source_db": source_label, "probe_count": 1, "match_count": 0, "probe_hash": hashlib.sha256(str(row["item_id"]).encode()).hexdigest()}
        matches = target.execute("SELECT COUNT(*) FROM item_fts WHERE item_fts MATCH ? AND item_id=?", ('"' + token + '"', canonical_id)).fetchone()[0]
        return {
            "source_db": source_label,
            "probe_count": 1,
            "match_count": int(matches),
            "probe_hash": hashlib.sha256(f"{source_label}|{canonical_id}|{token}".encode()).hexdigest(),
        }
    finally:
        source.close()


def source_coverage(target, snapshot_path, source_label, source_report):
    source = readonly_connection(snapshot_path)
    source.row_factory = sqlite3.Row
    missing = {"items": 0, "attachments": 0, "fts": 0}
    try:
        mapping = {}
        for incoming in source.execute("SELECT " + ", ".join(ITEM_COLUMNS) + " FROM items"):
            canonical_id, existing = target_item_id(target, incoming)
            if not existing or existing["checksum"] != incoming["checksum"]:
                missing["items"] += 1
            else:
                mapping[incoming["id"]] = canonical_id
        for incoming in source.execute("SELECT " + ", ".join(ATTACHMENT_COLUMNS) + " FROM attachments"):
            canonical_id = mapping.get(incoming["item_id"])
            if not canonical_id:
                missing["attachments"] += 1
                continue
            candidates = target.execute("SELECT " + ", ".join(ATTACHMENT_COLUMNS) + " FROM attachments WHERE item_id=?", (canonical_id,)).fetchall()
            if not any(attachment_signature(candidate) == attachment_signature(incoming) for candidate in candidates):
                missing["attachments"] += 1
        for source_item_id, canonical_id in mapping.items():
            incoming = source_fts(source, source_item_id)
            candidates = target_fts(target, canonical_id)
            if incoming and incoming != candidates:
                missing["fts"] += len(incoming)
    finally:
        source.close()
    return {"source_db": source_label, "source_counts": source_report["counts"], "source_digests": source_report["digests"], "missing": missing, "ok": not any(missing.values())}


def normalize_inputs(target_path, source_paths):
    target = resolved(target_path)
    sources = [resolved(path) for path in source_paths]
    if not sources:
        raise ValueError("at least one --source-db is required")
    if any(source == target for source in sources):
        raise ValueError("source database aliases canonical target")
    if len(set(sources)) != len(sources):
        raise ValueError("duplicate source database aliases are not allowed")
    for source in sources:
        if not source.is_file():
            raise ValueError(f"source database does not exist: {source}")
    return target, sources


def plan(target, sources):
    source_reports = []
    for source in sources:
        con = readonly_connection(source)
        con.row_factory = sqlite3.Row
        try:
            validate_archive(con, str(source))
            source_reports.append({"path": str(source), "counts": count_rows(con), "digests": archive_digest(con), "raw_roots": raw_roots(con)})
        finally:
            con.close()
    target_report = {"exists": target.exists(), "path": str(target)}
    if target.exists():
        con = readonly_connection(target)
        con.row_factory = sqlite3.Row
        try:
            validate_archive(con, str(target))
            target_report.update({"counts": count_rows(con), "digests": archive_digest(con), "raw_roots": raw_roots(con)})
        finally:
            con.close()
    return {"schema": "amy.life-archive-reconciliation.v2", "created_at": utc_now(), "apply": False, "status": "planned", "conflict_scan": "deferred-to-apply-snapshots-before-write", "source_priority": [row["path"] for row in source_reports], "logical_duplicate_policy": "first source is baseline; later equivalent raw paths are recorded in apply receipt", "target": target_report, "sources": source_reports, "raw_path_policy": "preserve-original-paths; raw archives and source databases are neither moved nor deleted"}


def reconcile(target_path, source_paths, apply=False, backup_dir=None, before_promote=None):
    target, sources = normalize_inputs(target_path, source_paths)
    if not apply:
        return plan(target, sources)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock, token = acquire_target_lock(target)
    work_dir = None
    backup_path = None
    cleanup_warnings = []
    try:
        work_dir = Path(tempfile.mkdtemp(prefix=".life-archive-reconcile-", dir=str(target.parent)))
        snapshot_paths = []
        source_reports = []
        for index, source in enumerate(sources):
            snapshot = make_unique_file(work_dir, f"source-{index}", ".db")
            snapshot_database(source, snapshot)
            snapshot_paths.append(snapshot)
            source_reports.append(snapshot_report(snapshot, source))
        target_exists = target.exists()
        target_report = {"exists": target_exists, "path": str(target)}
        merge_snapshots = list(zip(snapshot_paths, [str(source) for source in sources]))
        if target_exists:
            if not backup_dir:
                raise ValueError("--backup-dir is required when --apply changes an existing target")
            backup_path = make_unique_file(backup_dir, f"{target.stem}.pre-reconcile", ".db")
            snapshot_database(target, backup_path)
            target_report.update(snapshot_report(backup_path, target))
            target_report["backup_snapshot"] = str(backup_path)
            # Existing SQLite readers keep their file/WAL identity.  Merge in
            # place under BEGIN IMMEDIATE instead of replacing the DB file.
            if before_promote:
                before_promote()
            live = write_connection(target)
            try:
                live.execute("BEGIN IMMEDIATE")
                if archive_digest(live) != target_report["digests"]:
                    raise RuntimeError("canonical target changed during reconciliation; refusing merge")
                conflicts = collect_conflicts(live, merge_snapshots)
                if conflicts:
                    live.rollback()
                    return {"schema": "amy.life-archive-reconciliation.v2", "created_at": utc_now(), "apply": True, "status": "conflict", "target": target_report, "sources": source_reports, "conflict_count": len(conflicts), "conflicts": conflicts[:50]}
                merged = [merge_source(live, snapshot, label) for snapshot, label in merge_snapshots]
                checks = integrity_errors(live)
                rebuild_fts_item_lookup(live)
                coverage = [source_coverage(live, snapshot, str(source), source_report) for snapshot, source, source_report in zip(snapshot_paths, sources, source_reports)]
                fts_probes = [fts_match_probe(live, snapshot, str(source)) for snapshot, source in zip(snapshot_paths, sources)]
                if checks["quick_check"] != ["ok"] or checks["foreign_key_check"] or checks["fts_integrity_check"] != "ok" or not all(row["ok"] for row in coverage) or not all(row["match_count"] >= row["probe_count"] for row in fts_probes):
                    live.rollback()
                    return {"schema": "amy.life-archive-reconciliation.v2", "created_at": utc_now(), "apply": True, "status": "validation-failed", "target": target_report, "sources": source_reports, "integrity": checks, "coverage": coverage, "fts_match_probes": fts_probes}
                post_counts = count_rows(live)
                post_digests = archive_digest(live)
                if not assert_target_lock(lock, token):
                    raise RuntimeError("canonical writer lock changed before commit; rolling back")
                live.commit()
            finally:
                live.close()
        else:
            stage = make_unique_file(work_dir, "stage", ".db")
            snapshot_database(snapshot_paths[0], stage)
            merge_snapshots = merge_snapshots[1:]
            staged = write_connection(stage)
            try:
                conflicts = collect_conflicts(staged, merge_snapshots)
                if conflicts:
                    return {"schema": "amy.life-archive-reconciliation.v2", "created_at": utc_now(), "apply": True, "status": "conflict", "target": target_report, "sources": source_reports, "conflict_count": len(conflicts), "conflicts": conflicts[:50]}
                with staged:
                    merged = [merge_source(staged, snapshot, label) for snapshot, label in merge_snapshots]
                checks = integrity_errors(staged)
                rebuild_fts_item_lookup(staged)
                coverage = [source_coverage(staged, snapshot, str(source), source_report) for snapshot, source, source_report in zip(snapshot_paths, sources, source_reports)]
                fts_probes = [fts_match_probe(staged, snapshot, str(source)) for snapshot, source in zip(snapshot_paths, sources)]
                if checks["quick_check"] != ["ok"] or checks["foreign_key_check"] or checks["fts_integrity_check"] != "ok" or not all(row["ok"] for row in coverage) or not all(row["match_count"] >= row["probe_count"] for row in fts_probes):
                    return {"schema": "amy.life-archive-reconciliation.v2", "created_at": utc_now(), "apply": True, "status": "validation-failed", "target": target_report, "sources": source_reports, "integrity": checks, "coverage": coverage, "fts_match_probes": fts_probes}
                post_counts = count_rows(staged)
                post_digests = archive_digest(staged)
            finally:
                staged.close()
            if before_promote:
                before_promote()
            if target.exists():
                raise RuntimeError("canonical target appeared during reconciliation; refusing creation")
            if not assert_target_lock(lock, token):
                raise RuntimeError("canonical writer lock changed before target creation")
            try:
                # link(2) creates the target only when its name remains absent;
                # unlike replace it cannot discard a concurrently-created DB.
                os.link(stage, target)
            except FileExistsError as exc:
                raise RuntimeError("canonical target appeared during reconciliation; refusing creation") from exc
            stage.unlink()
        return {"schema": "amy.life-archive-reconciliation.v2", "created_at": utc_now(), "apply": True, "status": "applied", "target": target_report, "sources": source_reports, "source_priority": [str(source) for source in sources], "logical_duplicate_policy": "first source is baseline; later equivalent raw paths are recorded in merged logical_duplicate_provenance", "snapshot": str(backup_path) if backup_path else None, "merged": merged, "post_counts": post_counts, "post_digests": post_digests, "integrity": checks, "coverage": coverage, "fts_match_probes": fts_probes, "cleanup_warnings": cleanup_warnings, "raw_path_policy": "preserve-original-paths; raw archives and source databases are neither moved nor deleted"}
    finally:
        # Cleanup must not hide a committed database or mask the original
        # failure. Only this invocation's token and unique directory qualify.
        for operation in (lambda: release_target_lock(lock, token),
                          lambda: cleanup_work_dir(work_dir)):
            try:
                operation()
            except (OSError, ValueError) as exc:
                warning = f"reconciliation cleanup incomplete: {exc}"
                cleanup_warnings.append(warning)
                print(warning, file=sys.stderr)


def cleanup_work_dir(work_dir):
    if work_dir is None:
        return
    for path in sorted(work_dir.rglob("*"), reverse=True):
        if path.is_file() or path.is_symlink():
            path.unlink()
        elif path.is_dir():
            path.rmdir()
    work_dir.rmdir()


def write_receipt(receipt, payload):
    receipt = Path(receipt)
    temporary = make_unique_file(receipt.parent, receipt.name, ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        deadline = time.monotonic() + 1.0
        while True:
            try:
                os.replace(temporary, receipt)
                break
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EPERM, errno.EBUSY) or time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Plan or safely reconcile Life Archive SQLite databases.")
    parser.add_argument("--target", required=True, help="Canonical runtime life-archive.db target.")
    parser.add_argument("--source-db", action="append", required=True, help="Existing archive DB to preserve and merge; repeatable.")
    parser.add_argument("--apply", action="store_true", help="Required to write the target; omitted is a no-write plan.")
    parser.add_argument("--backup-dir", help="Required for --apply when target exists; receives an exclusive SQLite backup snapshot.")
    parser.add_argument("--receipt", help="Optional JSON receipt path. Omit for stdout only.")
    args = parser.parse_args()
    try:
        report = reconcile(args.target, args.source_db, apply=args.apply, backup_dir=args.backup_dir)
        payload = json.dumps(report, indent=2, sort_keys=True)
        if args.receipt:
            try:
                write_receipt(args.receipt, payload)
            except OSError as exc:
                report["receipt_status"] = "write-failed"
                report["receipt_error"] = str(exc)
                print(json.dumps(report, indent=2, sort_keys=True), flush=True)
                print("Database outcome above is unchanged; durable receipt write failed.", file=sys.stderr)
                return 3
        print(payload, flush=True)
        return 0 if report["status"] in ("planned", "applied") else 2
    except (ValueError, RuntimeError, OSError, sqlite3.DatabaseError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
