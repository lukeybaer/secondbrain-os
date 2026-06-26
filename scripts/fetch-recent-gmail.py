#!/usr/bin/env python3
"""
fetch-recent-gmail.py -- Read most recent inbox email via IMAP + app password.
Fallback for when the Gmail MCP integration is broken/stale.

Usage:
  python scripts/fetch-recent-gmail.py [n_messages]
  python scripts/fetch-recent-gmail.py 1 --save-attachments /path/to/dir
  python scripts/fetch-recent-gmail.py 25 --after-uid 12345

--after-uid <uid> only returns messages whose IMAP UID is strictly greater than
<uid>. The gmail-amy-scan watcher passes the highest UID it has already seen so a
steady-state cycle pulls 0 messages instead of re-fetching the same 300-message
window every run (which is what kept re-triggering the same IMAP EOF and
crash-looping the watcher 4783+ times, 2026-06-22).
"""
import imaplib
import email
import sys
import os
import json
import time
from pathlib import Path
from email.header import decode_header

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SECRETS = Path.home() / ".secrets"

# Transient IMAP failures we reconnect-and-resume on instead of dying. A single
# imaplib.IMAP4.abort (socket EOF mid-FETCH) is the exact crash that PM2
# fork-mode was relaunching forever. OSError covers raw socket EOF / reset /
# timeout. These are NOT fatal: reconnect, re-select, and resume from the last
# successfully-fetched UID.
TRANSIENT_IMAP_ERRORS = (imaplib.IMAP4.abort, OSError)
IMAP_HOST = "imap.gmail.com"
# The 30s socket timeout literal is kept inline at the IMAP4_SSL() call site in
# default_connect() so the category guard (gmail-imap-timeout.test.js: every
# IMAP4_SSL connection must carry timeout=<n>) can assert it at source.
# Cap reconnect attempts so a hard-down IMAP server can't hang the process
# forever. Once exhausted we raise, and the JS caller reports "fetch failed"
# and retries on the next 5-min cycle.
MAX_RECONNECTS = 5
BACKOFF_BASE_SEC = 1.0
BACKOFF_CAP_SEC = 15.0


def _read_secret(name):
    return (SECRETS / name).read_text().strip()


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
            # "ExampleCo-8bit". That must not crash the action-item rebuilder.
            return part.decode("utf-8", errors="replace")

    return "".join(decode_part(p, enc) for p, enc in parts)


def default_connect(user, password):
    """Open a fresh authenticated IMAP connection selected on INBOX.

    ExampleCo 2026-06-19: a socket timeout so a stuck IMAP read fails fast and
    HONESTLY instead of hanging until the gmail-amy-scan wrapper kills it.
    """
    M = imaplib.IMAP4_SSL(IMAP_HOST, timeout=30)
    M.login(user, password)
    M.select("INBOX")
    return M


def _quiet_logout(M):
    if M is None:
        return
    try:
        M.logout()
    except Exception:
        # Logout on an already-aborted connection itself raises; swallow it so
        # the reconnect path is clean.
        pass


def parse_message(eid, msg, save_dir=None):
    item = {
        "id": eid.decode() if isinstance(eid, bytes) else str(eid),
        "message_id": (msg["Message-ID"] or "").strip("<>") or None,
        "from": decode_hdr(msg["From"]),
        "to": decode_hdr(msg["To"]),
        "subject": decode_hdr(msg["Subject"]),
        "date": msg["Date"],
        # Raw Authentication-Results header so the #Amy scanner can run
        # DMARC-aligned origin checks (scripts/lib/email-auth-check.js).
        "authentication_results": decode_hdr(msg["Authentication-Results"]),
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
    return item


def select_target_uids(M, n, after_uid=0):
    """Return up to n UIDs strictly greater than after_uid.

    UID search (not sequence-number search) so the watermark in after_uid is a
    stable identifier across cycles, which is what lets a steady-state run pull
    0 messages instead of re-walking the same window.

    Incremental mode (after_uid > 0) returns the OLDEST contiguous n UIDs above
    the watermark, not the newest n. This matters when a caller advances its
    watermark to the highest UID fetched: returning the oldest contiguous batch
    guarantees no UID between the watermark and the highest fetched UID is ever
    skipped, even when more than n messages arrived since the last run. The next
    run picks up exactly where this one stopped (Codex peer review 2026-06-23).
    Full mode (no watermark) keeps the newest n, the recent-inbox snapshot.
    """
    if after_uid and after_uid > 0:
        typ, data = M.uid("search", None, f"UID {int(after_uid) + 1}:*")
    else:
        typ, data = M.uid("search", None, "ALL")
    uids = (data[0] or b"").split()
    if after_uid and after_uid > 0:
        # Gmail returns the lone after_uid when nothing is newer; keep only UIDs
        # strictly greater, sorted ascending, and take the oldest contiguous n.
        uids = sorted((u for u in uids if int(u) > int(after_uid)), key=lambda u: int(u))
        return uids[:n] if n else uids
    return uids[-n:] if n else uids


def fetch_messages(n, after_uid=0, save_dir=None, connect=default_connect,
                   sleep=time.sleep, max_reconnects=MAX_RECONNECTS):
    """Fetch up to n recent messages, reconnecting on transient IMAP EOF.

    A single imaplib.IMAP4.abort / socket EOF during FETCH is treated as a
    TRANSIENT error: we reconnect, re-select INBOX, and RESUME from the UIDs we
    have not yet pulled (already-fetched UIDs are not re-fetched). Reconnects
    are capped + backed off so a hard-down server can't hang the process.
    """
    user = _read_secret("gmail_sender.txt")
    password = _read_secret("gmail_app_password.txt")

    M = None
    targets = None
    out = []
    fetched_uids = set()
    attempts = 0
    last_err = None

    while True:
        try:
            if M is None:
                M = connect(user, password)
            if targets is None:
                targets = select_target_uids(M, n, after_uid)
            for uid in targets:
                key = uid.decode() if isinstance(uid, bytes) else str(uid)
                if key in fetched_uids:
                    continue
                typ, msg_data = M.uid("fetch", uid, "(RFC822)")
                if not msg_data or msg_data[0] is None:
                    fetched_uids.add(key)
                    continue
                msg = email.message_from_bytes(msg_data[0][1])
                item = parse_message(uid, msg, save_dir)
                item["uid"] = key
                out.append(item)
                fetched_uids.add(key)
            _quiet_logout(M)
            # Newest-first to preserve the previous output ordering.
            out.sort(key=lambda it: int(it.get("uid", 0)), reverse=True)
            return out
        except TRANSIENT_IMAP_ERRORS as e:
            last_err = e
            attempts += 1
            _quiet_logout(M)
            M = None  # force a fresh connection; targets are preserved so we resume
            if attempts > max_reconnects:
                raise
            backoff = min(BACKOFF_BASE_SEC * (2 ** (attempts - 1)), BACKOFF_CAP_SEC)
            sys.stderr.write(
                f"[fetch-recent-gmail] transient IMAP error "
                f"({type(e).__name__}: {e}); reconnect {attempts}/{max_reconnects} "
                f"after {backoff:.1f}s, resuming from {len(fetched_uids)} fetched\n"
            )
            sleep(backoff)


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else 1
    after_uid = 0
    if "--after-uid" in sys.argv:
        idx = sys.argv.index("--after-uid")
        after_uid = int(sys.argv[idx + 1])
    save_dir = None
    if "--save-attachments" in sys.argv:
        idx = sys.argv.index("--save-attachments")
        save_dir = Path(sys.argv[idx + 1])
        save_dir.mkdir(parents=True, exist_ok=True)

    out = fetch_messages(n, after_uid=after_uid, save_dir=save_dir)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
