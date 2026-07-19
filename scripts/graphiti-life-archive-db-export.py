#!/usr/bin/env python3
import argparse
import email.utils
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--db", required=True)
    p.add_argument("--since", default="1970-01-01T00:00:00Z")
    p.add_argument("--until", default=None)
    p.add_argument("--count-only", action="store_true")
    p.add_argument("--max", type=int, default=0)
    return p.parse_args()


def iso(dt):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        n = float(value)
        if n > 100000000000:
            n = n / 1000.0
        try:
            return datetime.fromtimestamp(n, tz=timezone.utc)
        except Exception:
            return None
    s = str(value).strip()
    if not s:
        return None
    if re.fullmatch(r"\d{10}(?:\.\d+)?", s):
        try:
            return datetime.fromtimestamp(float(s), tz=timezone.utc)
        except Exception:
            return None
    if re.fullmatch(r"\d{13}", s):
        try:
            return datetime.fromtimestamp(float(s) / 1000.0, tz=timezone.utc)
        except Exception:
            return None
    try:
        return email.utils.parsedate_to_datetime(s)
    except Exception:
        pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def first_time_from_text(text):
    if not text:
        return None
    m = re.search(r"(?im)^Date:\s*(.+)$", text)
    if m:
        dt = parse_time(m.group(1).strip())
        if dt:
            return dt
    m = re.search(r"\b(\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}:\d{2}:\d{2}\s*[AP]M)\b", text)
    if m:
        try:
            return datetime.strptime(m.group(1) + " " + m.group(2).upper().replace(" ", ""), "%m/%d/%Y %I:%M:%S%p").replace(tzinfo=timezone.utc)
        except Exception:
            return None
    return None


def time_from_path(raw_path):
    if not raw_path:
        return None
    norm = raw_path.replace("\\", "/")
    m = re.search(r"/data/gmail/raw/(\d{4})/(\d{2})/(\d{2})/", norm)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), 12, 0, tzinfo=timezone.utc)
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})[ _](\d{2})[ _](\d{2})[ _](\d{2})", norm)
    if m:
        return datetime(
            int(m.group(1)),
            int(m.group(2)),
            int(m.group(3)),
            int(m.group(4)),
            int(m.group(5)),
            int(m.group(6)),
            tzinfo=timezone.utc,
        )
    return None


def load_meta(raw):
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def best_reference_time(row, fts):
    meta = load_meta(row["metadata_json"])
    candidates = [
        row["created_at"],
        meta.get("date"),
        meta.get("createdAt"),
        meta.get("created_at"),
        meta.get("start_time"),
        meta.get("timestamp"),
        meta.get("scanned_at"),
        meta.get("savedAt"),
        first_time_from_text(fts.get("body") or meta.get("body") or meta.get("transcript")),
        time_from_path(row["raw_path"]),
        row["indexed_at"],
    ]
    for c in candidates:
        dt = c if isinstance(c, datetime) else parse_time(c)
        if dt:
            return iso(dt), "source"
    return iso(datetime.now(timezone.utc)), "fallback_now"


def clean(text, limit):
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(s) <= limit:
        return s
    return s[: max(0, limit - 38)].rstrip() + " ... [truncated for Graphiti]"


def body_for(row, fts):
    meta = load_meta(row["metadata_json"])
    body = fts.get("body") or meta.get("body") or meta.get("transcript") or meta.get("summary") or ""
    attachment = fts.get("attachment_text") or ""
    participants = fts.get("participants") or " ".join([str(row["author"] or ""), str(row["recipients"] or "")]).strip()
    parts = [
        f"Archive item source: {row['source']}",
        f"Kind: {row['kind'] or ''}",
        f"Title: {row['title'] or ''}",
        f"Author: {row['author'] or ''}",
        f"Recipients/participants: {participants}",
        f"Raw path: {row['raw_path'] or ''}",
        f"URL: {row['url'] or ''}" if row["url"] else "",
        "",
        clean(body, 8500),
    ]
    if attachment:
        parts.extend(["", "Attachment/OCR text:", clean(attachment, 2500)])
    return "\n".join([p for p in parts if p != ""]).strip()


def event_for(row, fts):
    ref, ref_source = best_reference_time(row, fts)
    body = body_for(row, fts)
    event_source = "archive-lifetime-generic-file" if row["source"] == "migrated-file" else "archive-lifetime-item"
    return {
        "source": event_source,
        "source_id": row["id"],
        "source_description": f"archive-lifetime:{row['source']}:{row['source_id']}",
        "name": f"Archive lifetime: {row['source']} - {row['title'] or row['source_id'] or row['id']}"[:180],
        "body": body,
        "reference_time": ref,
        "observed_at": row["indexed_at"] or ref,
        "raw_path": row["raw_path"],
        "contact_name": row["author"] or None,
        "direction": None,
        "priority": "normal",
        "metadata": {
            "archive_item_id": row["id"],
            "archive_source": row["source"],
            "archive_source_id": row["source_id"],
            "kind": row["kind"],
            "author": row["author"],
            "recipients": row["recipients"],
            "url": row["url"],
            "indexed_at": row["indexed_at"],
            "reference_time_source": ref_source,
            "body_chars": len(body),
        },
    }


def main():
    args = parse_args()
    since = parse_time(args.since) or datetime(1970, 1, 1, tzinfo=timezone.utc)
    until = parse_time(args.until) if args.until else datetime.now(timezone.utc)
    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row
    fts = {}
    for r in con.execute("select c0, c3, c4, c5 from item_fts_content"):
        fts[str(r["c0"])] = {
            "body": r["c3"] or "",
            "attachment_text": r["c4"] or "",
            "participants": r["c5"] or "",
        }

    summary = {
        "total": 0,
        "eligible": 0,
        "by_archive_source": {},
        "min_reference_time": None,
        "max_reference_time": None,
    }
    emitted = 0
    query = "select id, source, source_id, kind, title, author, recipients, created_at, raw_path, url, metadata_json, indexed_at from items order by id"
    for row in con.execute(query):
        summary["total"] += 1
        meta = load_meta(row["metadata_json"])
        if meta.get("graphiti_eligible") is False:
            continue
        item_fts = fts.get(str(row["id"]), {})
        event = event_for(row, item_fts)
        dt = parse_time(event["reference_time"])
        if not dt or dt < since or dt > until:
            continue
        summary["eligible"] += 1
        src = row["source"] or "ExampleCo"
        summary["by_archive_source"][src] = summary["by_archive_source"].get(src, 0) + 1
        if summary["min_reference_time"] is None or event["reference_time"] < summary["min_reference_time"]:
            summary["min_reference_time"] = event["reference_time"]
        if summary["max_reference_time"] is None or event["reference_time"] > summary["max_reference_time"]:
            summary["max_reference_time"] = event["reference_time"]
        if args.count_only:
            continue
        sys.stdout.buffer.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
        emitted += 1
        if args.max and emitted >= args.max:
            break

    if args.count_only:
        sys.stdout.buffer.write((json.dumps(summary, ensure_ascii=False) + "\n").encode("utf-8"))
    con.close()


if __name__ == "__main__":
    main()
