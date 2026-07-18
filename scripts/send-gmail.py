#!/usr/bin/env python3
"""
send-gmail.py -- Send emails on the owner's behalf via Gmail SMTP + app password.

Why this exists:
  The Gmail MCP server connected to Claude Code exposes read + create_draft
  but no send_draft / send_email tool. Rather than make the owner click "Send" on
  every outbound email, this script gives Amy a native send capability via
  SMTP using a Gmail app password. Google requires one-time consent for any
  write scope to Gmail; we minimize that to generating a single app password
  at https://myaccount.google.com/apppasswords which takes about 15 seconds.

Setup (one time, the owner):
  1. Go to https://myaccount.google.com/apppasswords
     (requires 2FA on the account, which the owner has)
  2. Click "Select app" -> "Mail", "Select device" -> "Other (Custom name)"
     -> type "Amy" -> Create
  3. Copy the 16-character password that appears
  4. Save it to ~/.secrets/gmail_app_password.txt
     (create the .secrets folder first if it doesn't exist)
  5. Save the sender address to ~/.secrets/gmail_sender.txt
     (one line, just the email address -- e.g. "alice@example.com")

PII note: neither the sender address nor the password is in this script.
Both are read at runtime from ~/.secrets/ (outside any repo) or env vars.
This keeps the script git-clean under the no-pii-in-source test.

Usage (Amy):
  # Send one email from a JSON file:
  python scripts/send-gmail.py data/outbound/farm-insurance-quotes/clients-first.json

  # Send all emails in a directory (batch):
  python scripts/send-gmail.py data/outbound/farm-insurance-quotes/

JSON schema (one email per file):
  {
    "to": "recipient@example.com",
    "cc": "optional@example.com",
    "bcc": "optional@example.com",
    "subject": "Email subject",
    "body": "Plain text body",
    "reply_to": "optional-reply-to@example.com",
    "in_reply_to": "<original-msg-id@example.com>",
    "references": "<original-msg-id@example.com>",
    "attachments": ["C:/path/to/file.png", "/path/to/report.pdf"]
  }

The attachments field is optional. Each entry is a filesystem path; the MIME
type is inferred from the extension and the basename becomes the filename the
recipient sees. A missing file raises rather than sending a silently empty
email. On the CLI use --attach PATH (repeat the flag for multiple files).

The in_reply_to and references fields are optional. Set them when replying
to an existing thread so Gmail renders the reply inside the original thread.
Get the Message-ID header via gmail_read_message on the target message.

On success, the script moves the sent JSON file into a .sent/ subdirectory
alongside the outbound dir and writes a one-line confirmation to stdout. If
sending fails for any individual file, the script logs the error and moves
on to the next file instead of aborting the whole batch.
"""

from __future__ import annotations

import json
import mimetypes
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path
from typing import Iterable

SECRETS_DIR = Path.home() / ".secrets"
APP_PASSWORD_FILE = SECRETS_DIR / "gmail_app_password.txt"
SENDER_FILE = SECRETS_DIR / "gmail_sender.txt"
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587


def load_app_password() -> str:
    env = os.environ.get("GMAIL_APP_PASSWORD")
    if env:
        return env.strip().replace(" ", "")
    if not APP_PASSWORD_FILE.exists():
        sys.exit(
            f"ERROR: no GMAIL_APP_PASSWORD env var and no file at {APP_PASSWORD_FILE}.\n"
            "       Generate one at https://myaccount.google.com/apppasswords and paste\n"
            "       the 16-character password into that file. Then rerun."
        )
    text = APP_PASSWORD_FILE.read_text(encoding="utf-8").strip().replace(" ", "")
    if not text:
        sys.exit(f"ERROR: {APP_PASSWORD_FILE} is empty.")
    return text


def load_sender() -> str:
    env = os.environ.get("GMAIL_SENDER")
    if env:
        text = env.strip()
    elif SENDER_FILE.exists():
        text = SENDER_FILE.read_text(encoding="utf-8").strip()
    else:
        sys.exit(
            f"ERROR: no GMAIL_SENDER env var and no file at {SENDER_FILE}.\n"
            "       Create the file with the sender email address on a single line.\n"
            "       This file lives in ~/.secrets/ (outside any repo) to keep PII out of source."
        )
    if not text or "@" not in text:
        sys.exit(
            f"ERROR: sender '{text}' is not a valid email address (from {'env' if os.environ.get('GMAIL_SENDER') else SENDER_FILE})."
        )
    return text


def iter_payload_files(target: Path) -> Iterable[Path]:
    if target.is_file():
        yield target
        return
    if not target.is_dir():
        sys.exit(f"ERROR: {target} is neither a file nor a directory.")
    for path in sorted(target.glob("*.json")):
        yield path


def build_message(payload: dict, sender: str) -> EmailMessage:
    required = ("to", "subject", "body")
    missing = [k for k in required if not payload.get(k)]
    if missing:
        raise ValueError(f"payload missing required fields: {missing}")

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = payload["to"]
    if payload.get("cc"):
        msg["Cc"] = payload["cc"]
    if payload.get("bcc"):
        msg["Bcc"] = payload["bcc"]
    msg["Subject"] = payload["subject"]
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="gmail.com")
    if payload.get("reply_to"):
        msg["Reply-To"] = payload["reply_to"]
    if payload.get("in_reply_to"):
        msg["In-Reply-To"] = payload["in_reply_to"]
    if payload.get("references"):
        msg["References"] = payload["references"]
    msg.set_content(payload["body"])
    attach_files(msg, payload.get("attachments") or [])
    return msg


def attach_files(msg: EmailMessage, paths: Iterable[str | os.PathLike]) -> None:
    """Attach each file to msg, inferring the MIME type from the extension.

    Fails loudly on a missing file: a silently attachment-less email looks
    delivered but isn't, and the caller has no way to notice.
    """
    for raw in paths:
        path = Path(raw).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"attachment not found: {path}")
        ctype, encoding = mimetypes.guess_type(path.name)
        if ctype is None or encoding is not None:
            ctype = "application/octet-stream"
        maintype, subtype = ctype.split("/", 1)
        msg.add_attachment(
            path.read_bytes(),
            maintype=maintype,
            subtype=subtype,
            filename=path.name,
        )


def send_one(smtp: smtplib.SMTP, path: Path, sender: str) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        msg = build_message(payload, sender)
        recipients = [msg["To"]]
        if msg["Cc"]:
            recipients.extend([a.strip() for a in str(msg["Cc"]).split(",")])
        if msg["Bcc"]:
            recipients.extend([a.strip() for a in str(msg["Bcc"]).split(",")])
        smtp.send_message(msg, from_addr=sender, to_addrs=recipients)
        sent_dir = path.parent / ".sent"
        sent_dir.mkdir(exist_ok=True)
        path.rename(sent_dir / path.name)
        print(f"SENT  {path.name} -> {payload['to']}")
        return True
    except Exception as exc:
        print(f"FAIL  {path.name}: {exc}", file=sys.stderr)
        return False


def send_inline(payload: dict) -> int:
    """One-shot send from an in-memory payload (used by CLI flag mode)."""
    sender = load_sender()
    app_password = load_app_password()
    msg = build_message(payload, sender)
    recipients = [msg["To"]]
    if msg["Cc"]:
        recipients.extend([a.strip() for a in str(msg["Cc"]).split(",")])
    if msg["Bcc"]:
        recipients.extend([a.strip() for a in str(msg["Bcc"]).split(",")])
    print(f"connecting to {SMTP_HOST}:{SMTP_PORT} as {sender}")
    ctx = ssl.create_default_context()
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as smtp:
        smtp.ehlo()
        smtp.starttls(context=ctx)
        smtp.ehlo()
        smtp.login(sender, app_password)
        smtp.send_message(msg, from_addr=sender, to_addrs=recipients)
    print(f"SENT  inline -> {payload['to']}")
    return 0


def parse_flag_args(argv: list[str]) -> dict | None:
    """Parse --to / --subject / --body style flags into a payload dict.
    Returns None if no recognized flags are present (falls back to file mode)."""
    flags = {"--to", "--subject", "--body", "--cc", "--bcc", "--reply-to",
             "--in-reply-to", "--references", "--attach"}
    if not any(a in flags for a in argv):
        return None
    payload: dict = {}
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--to" and i + 1 < len(argv):
            payload["to"] = argv[i + 1]; i += 2; continue
        if a == "--cc" and i + 1 < len(argv):
            payload["cc"] = argv[i + 1]; i += 2; continue
        if a == "--bcc" and i + 1 < len(argv):
            payload["bcc"] = argv[i + 1]; i += 2; continue
        if a == "--subject" and i + 1 < len(argv):
            payload["subject"] = argv[i + 1]; i += 2; continue
        if a == "--body" and i + 1 < len(argv):
            payload["body"] = argv[i + 1]; i += 2; continue
        if a == "--body-file" and i + 1 < len(argv):
            src = argv[i + 1]
            payload["body"] = sys.stdin.read() if src == "-" else Path(src).read_text(encoding="utf-8")
            i += 2; continue
        if a == "--reply-to" and i + 1 < len(argv):
            payload["reply_to"] = argv[i + 1]; i += 2; continue
        if a == "--in-reply-to" and i + 1 < len(argv):
            payload["in_reply_to"] = argv[i + 1]; i += 2; continue
        if a == "--references" and i + 1 < len(argv):
            payload["references"] = argv[i + 1]; i += 2; continue
        if a == "--attach" and i + 1 < len(argv):
            payload.setdefault("attachments", []).append(argv[i + 1]); i += 2; continue
        i += 1
    return payload


def main(argv: list[str]) -> int:
    flag_payload = parse_flag_args(argv)
    if flag_payload is not None:
        missing = [k for k in ("to", "subject", "body") if not flag_payload.get(k)]
        if missing:
            print(f"ERROR: flag mode missing required fields: {missing}", file=sys.stderr)
            return 2
        return send_inline(flag_payload)

    if len(argv) != 2:
        print(
            "usage:\n"
            "  send-gmail.py <file.json | directory>\n"
            "  send-gmail.py --to EMAIL --subject SUBJ --body TEXT [--cc ... --attach FILE --in-reply-to ... --references ...]",
            file=sys.stderr,
        )
        return 2

    target = Path(argv[1]).resolve()
    sender = load_sender()
    app_password = load_app_password()
    payloads = list(iter_payload_files(target))
    if not payloads:
        print(f"no .json files found under {target}", file=sys.stderr)
        return 1

    print(f"connecting to {SMTP_HOST}:{SMTP_PORT} as {sender}")
    ctx = ssl.create_default_context()
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as smtp:
        smtp.ehlo()
        smtp.starttls(context=ctx)
        smtp.ehlo()
        smtp.login(sender, app_password)
        sent = 0
        failed = 0
        for path in payloads:
            if send_one(smtp, path, sender):
                sent += 1
            else:
                failed += 1
    print(f"\ndone: {sent} sent, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
