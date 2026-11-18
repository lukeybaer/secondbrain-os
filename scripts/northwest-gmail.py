#!/usr/bin/env python3
"""
northwest-gmail.py -- Gmail lookups for the PRIVATE_NAME reader.

  python3 scripts/northwest-gmail.py notices [--days 365]
      "Unread document(s) available" notices, newest first.
  python3 scripts/northwest-gmail.py code --after <epoch-seconds>
      The newest PRIVATE_NAME verification code received after that time.

Prints one JSON value. Uses the same IMAP app password as fetch-recent-gmail.py.
"""
import email
import html
import imaplib
import json
import re
import socket
import sys
import time
from email.header import decode_header
from email.utils import parsedate_to_datetime
from pathlib import Path

SECRETS = Path.home() / ".secrets"
# Singular until 2026-10-30, then "Unread documents available".
NOTICE_QUERY = 'from:reminder.PRIVATE_NAME.com {subject:"Unread document available" subject:"Unread documents available"}'
CODE_QUERY = 'from:PRIVATE_NAME.com subject:"Verification Code" newer_than:1d'


def _read_secret(name):
    return (SECRETS / name).read_text().strip()


def _hdr(value):
    out = []
    for part, enc in decode_header(value or ""):
        out.append(part.decode(enc or "utf-8", errors="replace") if isinstance(part, bytes) else part)
    return "".join(out)


def _text(msg):
    for part in msg.walk() if msg.is_multipart() else [msg]:
        if part.get_content_type() in ("text/plain", "text/html"):
            payload = part.get_payload(decode=True) or b""
            return payload.decode(part.get_content_charset() or "utf-8", errors="replace")
    return ""


def _plain(text):
    """Strip tags but keep block boundaries as newlines: the plural notice lists one type per block."""
    text = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|td|h\d)>", "\n", text)
    return html.unescape(re.sub(r"<[^>]+>", " ", text)).replace("​", "")


def _search(M, query, limit):
    typ, data = M.uid("SEARCH", "X-GM-RAW", '"%s"' % query.replace('"', '\\"'))
    if typ != "OK":
        raise RuntimeError("IMAP search failed: %s" % typ)
    uids = (data[0] or b"").split()[-limit:]
    rows = []
    for uid in reversed(uids):
        typ, fetched = M.uid("FETCH", uid, "(RFC822)")
        if typ != "OK" or not fetched or not isinstance(fetched[0], tuple):
            continue
        msg = email.message_from_bytes(fetched[0][1])
        date = parsedate_to_datetime(msg.get("Date"))
        rows.append({
            "uid": int(uid),
            "message_id": (msg.get("Message-ID") or "").strip(),
            "date": date.isoformat(),
            "epoch": date.timestamp(),
            "subject": _hdr(msg.get("Subject")),
            "body": _plain(_text(msg)),
        })
    return rows


CONNECT_ATTEMPTS = 4
RETRY_PAUSE_SECONDS = 8
TRANSIENT = (socket.timeout, TimeoutError, ConnectionError, OSError, imaplib.IMAP4.abort)


def _connect(sleep=time.sleep):
    """Open and log in, retrying transient network errors (Oct 23-25 2026: login
    socket timeouts failed three reader runs in a row). A bad password
    (IMAP4.error) is not transient and raises at once."""
    last = None
    for attempt in range(1, CONNECT_ATTEMPTS + 1):
        M = None
        try:
            M = imaplib.IMAP4_SSL("imap.gmail.com", timeout=60)
            M.login(_read_secret("gmail_sender.txt"), _read_secret("gmail_app_password.txt"))
            M.select('"[Gmail]/All Mail"', readonly=True)
            return M
        except TRANSIENT as e:
            last = e
            try:
                if M is not None:
                    M.shutdown()
            except Exception:
                pass
            if attempt < CONNECT_ATTEMPTS:
                sleep(RETRY_PAUSE_SECONDS * attempt)
    raise RuntimeError("IMAP connect failed after %d attempts: %s" % (CONNECT_ATTEMPTS, last))


def main(argv):
    mode = argv[1] if len(argv) > 1 else "notices"
    M = _connect()
    try:
        if mode == "notices":
            days = int(argv[argv.index("--days") + 1]) if "--days" in argv else 365
            print(json.dumps(_search(M, "%s newer_than:%dd" % (NOTICE_QUERY, days), 100)))
        elif mode == "code":
            after = float(argv[argv.index("--after") + 1])
            fresh = [r for r in _search(M, CODE_QUERY, 10) if r["epoch"] >= after]
            print(json.dumps(fresh[0] if fresh else None))
        else:
            raise SystemExit("unknown mode: %s" % mode)
    finally:
        try:
            M.logout()
        except Exception:
            pass


if __name__ == "__main__":
    main(sys.argv)
