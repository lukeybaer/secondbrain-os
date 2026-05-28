#!/usr/bin/env python3
"""
fetch-recent-gmail.py -- Read most recent inbox email via IMAP + app password.
Fallback for when the Gmail MCP integration is broken/stale.

Usage:
  python scripts/fetch-recent-gmail.py [n_messages]
  python scripts/fetch-recent-gmail.py 1 --save-attachments /path/to/dir
"""
import imaplib
import email
import sys
import os
import json
from pathlib import Path
from email.header import decode_header

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SECRETS = Path.home() / ".secrets"
USER = (SECRETS / "gmail_sender.txt").read_text().strip()
PASS = (SECRETS / "gmail_app_password.txt").read_text().strip()

def decode_hdr(h):
    if not h:
        return ""
    parts = decode_header(h)
    def decode_part(part, enc):
        if not isinstance(part, bytes):
            return part
        codec = enc or "utf-8"
        try:
            return part.decode(codec, errors="replace")
        except LookupError:
            # Some Gmail/marketing senders emit RFC2047 headers with
            # "unknown-8bit". That must not crash the action-item rebuilder.
            return part.decode("utf-8", errors="replace")
    return "".join(
        decode_part(p, enc)
        for p, enc in parts
    )

def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    save_dir = None
    if "--save-attachments" in sys.argv:
        idx = sys.argv.index("--save-attachments")
        save_dir = Path(sys.argv[idx + 1])
        save_dir.mkdir(parents=True, exist_ok=True)

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
        item = {
            "id": eid.decode(),
            "message_id": (msg["Message-ID"] or "").strip("<>") or None,
            "from": decode_hdr(msg["From"]),
            "to": decode_hdr(msg["To"]),
            "subject": decode_hdr(msg["Subject"]),
            "date": msg["Date"],
            "body": "",
            "attachments": [],
        }
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "")
            if "attachment" in disp or part.get_filename():
                fname = decode_hdr(part.get_filename() or "unnamed")
                payload = part.get_payload(decode=True) or b""
                att = {"filename": fname, "size": len(payload), "content_type": ctype}
                if save_dir:
                    outpath = save_dir / fname
                    outpath.write_bytes(payload)
                    att["saved_to"] = str(outpath)
                item["attachments"].append(att)
            elif ctype == "text/plain" and not item["body"]:
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                item["body"] = payload.decode(charset, errors="replace")
            elif ctype == "text/html" and not item["body"]:
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                item["body"] = payload.decode(charset, errors="replace")
        out.append(item)
    M.logout()
    print(json.dumps(out, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
