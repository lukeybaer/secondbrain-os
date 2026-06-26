#!/usr/bin/env python3
import argparse
import email.utils
import json
import os
import re
import sys
from datetime import datetime, timezone


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--since", default="1970-01-01T00:00:00Z")
    p.add_argument("--until", default=None)
    p.add_argument("--count-only", action="store_true")
    return p.parse_args()


def parse_time(value):
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        dt = email.utils.parsedate_to_datetime(s)
        return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
    except Exception:
        pass
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def iso(dt):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def date_from_path(path):
    p = path.replace("\\", "/")
    m = re.search(r"/data/gmail/raw/(\d{4})/(\d{2})/(\d{2})/", p)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), 12, 0, tzinfo=timezone.utc)
    return None


def compact(text, limit=9000):
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(s) <= limit:
        return s
    return s[: limit - 38].rstrip() + " ... [truncated for Graphiti]"


def event_for(file, msg):
    ref_dt = parse_time(msg.get("date")) or date_from_path(file) or parse_time(msg.get("archived_at")) or datetime.fromtimestamp(os.path.getmtime(file), tz=timezone.utc)
    msg_id = str(msg.get("gmail_message_hex") or msg.get("message_id") or msg.get("id") or os.path.basename(os.path.dirname(file)))
    from_addr = msg.get("from") or ""
    direction = "outbound" if re.search(r"ExampleCo\.d\.ExampleCo|ExampleCo\.ExampleCo|@ExampleCogroup\.com", from_addr, re.I) else "inbound"
    body_text = msg.get("body") or "(body empty in message.json; raw.eml remains the provenance source)"
    body = "\n".join(filter(None, [
        "Gmail message",
        f"From: {from_addr}",
        f"To: {msg.get('to') or ''}",
        f"Cc: {msg.get('cc') or ''}" if msg.get("cc") else "",
        f"Subject: {msg.get('subject') or '(no subject)'}",
        f"Gmail URL: {msg.get('gmail_url')}" if msg.get("gmail_url") else "",
        "",
        compact(body_text),
    ]))
    return {
        "source": "archive-lifetime-gmail",
        "source_id": msg_id,
        "source_description": f"archive-lifetime-gmail:{msg_id}",
        "name": f"Gmail lifetime: {msg.get('subject') or '(no subject)'}"[:180],
        "body": body,
        "reference_time": iso(ref_dt),
        "observed_at": iso(parse_time(msg.get("archived_at")) or datetime.fromtimestamp(os.path.getmtime(file), tz=timezone.utc)),
        "raw_path": file,
        "contact_name": from_addr or None,
        "direction": direction,
        "priority": "normal",
        "metadata": {
            "archive_source": "gmail",
            "gmail_message_hex": msg.get("gmail_message_hex"),
            "thread_hex": msg.get("thread_hex"),
            "message_id": msg.get("message_id"),
            "gmail_url": msg.get("gmail_url"),
            "author": from_addr,
            "recipients": msg.get("to") or "",
            "attachment_count": len(msg.get("attachments") or []),
            "direction": direction,
            "captured_at": msg.get("archived_at"),
        },
    }


def reference_time_for(file, msg):
    return parse_time(msg.get("date")) or date_from_path(file) or parse_time(msg.get("archived_at")) or datetime.fromtimestamp(os.path.getmtime(file), tz=timezone.utc)


def main():
    args = parse_args()
    base = os.path.join(args.root, "data", "gmail", "raw")
    since = parse_time(args.since) or datetime(1970, 1, 1, tzinfo=timezone.utc)
    until = parse_time(args.until) if args.until else datetime.now(timezone.utc)
    count = 0
    for dirpath, _dirs, files in os.walk(base):
        if "message.json" not in files:
            continue
        file = os.path.join(dirpath, "message.json")
        if args.count_only:
            count += 1
            continue
        try:
            with open(file, "r", encoding="utf-8", errors="replace") as fh:
                msg = json.load(fh)
        except Exception:
            continue
        ev = event_for(file, msg)
        dt = parse_time(ev["reference_time"])
        if not dt or dt < since or dt > until:
            continue
        count += 1
        sys.stdout.buffer.write((json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8"))
    if args.count_only:
        sys.stdout.write(json.dumps({"archive-lifetime-gmail": count}) + "\n")


if __name__ == "__main__":
    main()
