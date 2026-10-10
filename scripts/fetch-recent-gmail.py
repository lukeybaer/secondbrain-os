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
import re
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
FETCH_BATCH_SIZE = 25


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
            # "unknown-8bit". That must not crash the action-item rebuilder.
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
        "in_reply_to": decode_hdr(msg["In-Reply-To"]),
        "references": decode_hdr(msg["References"]),
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


def _uid_from_fetch_meta(meta):
    """Read the stable UID from one UID FETCH response metadata blob."""
    if isinstance(meta, str):
        meta = meta.encode()
    match = re.search(rb"\bUID\s+(\d+)\b", meta or b"", re.IGNORECASE)
    return match.group(1).decode() if match else None


def _thread_id_from_fetch_meta(meta):
    """Read Gmail's stable thread id from one UID FETCH metadata blob."""
    if isinstance(meta, str):
        meta = meta.encode()
    match = re.search(rb"\bX-GM-THRID\s+(\d+)\b", meta or b"", re.IGNORECASE)
    return match.group(1).decode() if match else ""


def _tokenize_imap_labels(raw, start=0):
    """Split an IMAP label list into discrete labels, honoring quoting.

    Quoting is load-bearing. A user label containing a space arrives QUOTED
    ("Sent Project"), and a naive whitespace split would mint a bare `Sent`
    token that looks like the \\Sent system flag. A quoted label may also
    contain the ')' terminator. Returns (labels, index_after_list).
    """
    labels = []
    i = start
    n = len(raw)
    while i < n:
        c = raw[i]
        if c in " \t":
            i += 1
            continue
        if c == ")":
            i += 1
            break
        if c == '"':
            i += 1
            buf = []
            while i < n and raw[i] != '"':
                if raw[i] == "\\" and i + 1 < n:
                    buf.append(raw[i + 1])
                    i += 2
                    continue
                buf.append(raw[i])
                i += 1
            i += 1
            labels.append("".join(buf))
            continue
        buf = []
        while i < n and raw[i] not in ' \t)':
            buf.append(raw[i])
            i += 1
        if buf:
            labels.append("".join(buf))
    return labels, i


def _labels_from_fetch_meta(meta):
    """Read Gmail's X-GM-LABELS list from one UID FETCH metadata blob.

    The \\Sent label is the origin proof for owner-to-owner mail, which carries
    no Authentication-Results header (scripts/lib/email-auth-check.js). Absent
    or unparseable labels return [] so the caller fails closed. Each returned
    element is ONE discrete label; the JS side never re-splits them.
    """
    if isinstance(meta, str):
        meta = meta.encode()
    text = (meta or b"").decode("utf-8", errors="replace")
    match = re.search(r"X-GM-LABELS\s+\(", text, re.IGNORECASE)
    if not match:
        return []
    labels, _ = _tokenize_imap_labels(text, match.end())
    return [label for label in labels if label]


def fetch_messages(n, after_uid=0, save_dir=None, connect=default_connect,
                   sleep=time.sleep, max_reconnects=MAX_RECONNECTS,
                   batch_size=FETCH_BATCH_SIZE):
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
    # Mutable so a mid-run downgrade survives the reconnect loop below.
    fetch_items = ["(RFC822 X-GM-LABELS X-GM-THRID)"]

    while True:
        try:
            if M is None:
                M = connect(user, password)
            if targets is None:
                targets = select_target_uids(M, n, after_uid)
            pending = [
                uid for uid in targets
                if (uid.decode() if isinstance(uid, bytes) else str(uid)) not in fetched_uids
            ]
            width = max(1, int(batch_size or FETCH_BATCH_SIZE))
            for start in range(0, len(pending), width):
                chunk = pending[start:start + width]
                requested = [uid.decode() if isinstance(uid, bytes) else str(uid) for uid in chunk]
                uid_set = ",".join(requested).encode()
                # X-GM-LABELS carries the \Sent proof the #Amy origin check
                # needs. It is a Gmail extension, so a server that rejects it
                # must degrade to a plain body fetch rather than skip messages.
                typ, msg_data = (None, None)
                if fetch_items[0] != "(RFC822)":
                    try:
                        typ, msg_data = M.uid("fetch", uid_set, fetch_items[0])
                    except TRANSIENT_IMAP_ERRORS:
                        raise
                    except Exception as label_err:
                        sys.stderr.write(
                            "[fetch-recent-gmail] X-GM-LABELS unsupported "
                            f"({label_err}); falling back to plain fetch\n"
                        )
                        typ, msg_data = (None, None)
                    if typ != "OK":
                        fetch_items[0] = "(RFC822)"
                        typ, msg_data = (None, None)
                if typ is None:
                    typ, msg_data = M.uid("fetch", uid_set, "(RFC822)")
                if typ != "OK" or not msg_data:
                    fetched_uids.update(requested)
                    continue
                parts = [part for part in msg_data if isinstance(part, tuple) and len(part) >= 2]
                for index, part in enumerate(parts):
                    key = _uid_from_fetch_meta(part[0])
                    if key is None and index < len(requested):
                        key = requested[index]
                    if key is None or key in fetched_uids:
                        continue
                    msg = email.message_from_bytes(part[1])
                    item = parse_message(key, msg, save_dir)
                    item["uid"] = key
                    item["gmail_labels"] = _labels_from_fetch_meta(part[0])
                    item["gmail_thread_id"] = _thread_id_from_fetch_meta(part[0])
                    out.append(item)
                    fetched_uids.add(key)
                # A successful FETCH may omit an expunged message. Preserve the
                # old behavior by treating that UID as handled, not retrying it
                # forever on every reconnect.
                fetched_uids.update(requested)
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
