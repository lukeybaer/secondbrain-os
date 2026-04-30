#!/usr/bin/env python3
"""
fetch-recent-gmail.py: Read recent inbox email via IMAP + app password.
Fallback for when the Gmail MCP integration is broken or stale.

Usage:
  python scripts/fetch-recent-gmail.py [n_messages]
  python scripts/fetch-recent-gmail.py 1 --save-attachments /path/to/dir
  python scripts/fetch-recent-gmail.py 50 --archive
  python scripts/fetch-recent-gmail.py 50 --archive --quiet

The --archive flag writes each fetched message to
data/gmail/raw/<safe_message_id>.json so the ingest-gmail-watcher can pick
it up and feed Graphiti via the unified ingest funnel. The watcher tracks
seen ids separately, so re-running with --archive is idempotent.

The --quiet flag suppresses stdout JSON when the caller only needs the
side effect of archiving.
"""
import imaplib
import email
import sys
import os
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from email.header import decode_header
from email.utils import parsedate_to_datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SECRETS = Path.home() / ".secrets"
USER = (SECRETS / "gmail_sender.txt").read_text().strip()
PASS = (SECRETS / "gmail_app_password.txt").read_text().strip()

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "gmail" / "raw"


def decode_hdr(h):
    if not h:
        return ""
    parts = decode_header(h)
    return "".join(
        (p.decode(enc or "utf-8", errors="replace") if isinstance(p, bytes) else p)
        for p, enc in parts
    )


def _safe_id(msg_id, fallback):
    base = (msg_id or fallback or "unknown").strip()
    base = re.sub(r"[<>]", "", base)
    base = re.sub(r"[^A-Za-z0-9._@-]", "_", base)
    return base[:200] or fallback or "unknown"


def _direction(from_hdr, to_hdr):
    me = (USER or "").lower()
    if me and me in (from_hdr or "").lower():
        return "outbound"
    return "inbound"


def _archive_message(item, raw_dir):
    raw_dir.mkdir(parents=True, exist_ok=True)
    msg_id = item.get("message_id") or item.get("id") or "unknown"
    filename = _safe_id(msg_id, item.get("id", "unknown")) + ".json"
    out = raw_dir / filename
    payload = dict(item)
    payload.setdefault(
        "fetched_at", datetime.now(timezone.utc).isoformat(timespec="seconds")
    )
    payload.setdefault(
        "direction", _direction(item.get("from", ""), item.get("to", ""))
    )
    out.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return out


def main():
    args = sys.argv[1:]
    n = 1
    if args and not args[0].startswith("--"):
        try:
            n = int(args[0])
        except ValueError:
            n = 1
    save_dir = None
    if "--save-attachments" in args:
        idx = args.index("--save-attachments")
        save_dir = Path(args[idx + 1])
        save_dir.mkdir(parents=True, exist_ok=True)
    archive = "--archive" in args
    quiet = "--quiet" in args

    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(USER, PASS)
    M.select("INBOX")
    typ, data = M.search(None, "ALL")
    ids = data[0].split()
    latest = ids[-n:]
    out = []
    for eid in reversed(latest):
        typ, msg_data = M.fetch(eid, "(RFC822)")
        msg = email.message_from_bytes(msg_data[0][1])
        body_text = ""
        body_is_html = False
        item = {
            "id": eid.decode(),
            "message_id": (msg["Message-ID"] or "").strip("<>") or None,
            "from": decode_hdr(msg["From"]),
            "to": decode_hdr(msg["To"]),
            "subject": decode_hdr(msg["Subject"]),
            "date": msg["Date"],
            "body": "",
            "body_is_html": False,
            "attachments": [],
        }
        try:
            if msg["Date"]:
                dt = parsedate_to_datetime(msg["Date"])
                if dt is not None:
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    item["timestamp"] = dt.astimezone(timezone.utc).isoformat(
                        timespec="seconds"
                    )
        except Exception:
            pass
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "")
            if "attachment" in disp or part.get_filename():
                fname = decode_hdr(part.get_filename() or "unnamed")
                payload = part.get_payload(decode=True) or b""
                att = {
                    "filename": fname,
                    "size": len(payload),
                    "content_type": ctype,
                }
                if save_dir:
                    outpath = save_dir / fname
                    outpath.write_bytes(payload)
                    att["saved_to"] = str(outpath)
                item["attachments"].append(att)
            elif ctype == "text/plain" and not body_text:
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                body_text = payload.decode(charset, errors="replace")
                body_is_html = False
            elif ctype == "text/html" and not body_text:
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                body_text = payload.decode(charset, errors="replace")
                body_is_html = True
        item["body"] = body_text
        item["body_is_html"] = body_is_html
        if archive:
            try:
                _archive_message(item, RAW_DIR)
            except Exception as e:
                print(f"[fetch-gmail] archive failed: {e}", file=sys.stderr)
        out.append(item)
    M.logout()
    if not quiet:
        print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
