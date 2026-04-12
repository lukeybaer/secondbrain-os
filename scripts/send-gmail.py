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
  4. Save it to ${USERPROFILE:-~}/.secrets/gmail_app_password.txt
     (create the .secrets folder first if it doesn't exist)

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
    "reply_to": "owner.d.baer@gmail.com"
  }

On success, the script moves the sent JSON file into a .sent/ subdirectory
alongside the outbound dir and writes a one-line confirmation to stdout. If
sending fails for any individual file, the script logs the error and moves
on to the next file instead of aborting the whole batch.
"""

from __future__ import annotations

import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path
from typing import Iterable

APP_PASSWORD_FILE = Path(r"${USERPROFILE:-~}/.secrets/gmail_app_password.txt")
SENDER_ADDRESS = "owner.d.baer@gmail.com"
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


def iter_payload_files(target: Path) -> Iterable[Path]:
    if target.is_file():
        yield target
        return
    if not target.is_dir():
        sys.exit(f"ERROR: {target} is neither a file nor a directory.")
    for path in sorted(target.glob("*.json")):
        yield path


def build_message(payload: dict) -> EmailMessage:
    required = ("to", "subject", "body")
    missing = [k for k in required if not payload.get(k)]
    if missing:
        raise ValueError(f"payload missing required fields: {missing}")

    msg = EmailMessage()
    msg["From"] = f"the owner <{SENDER_ADDRESS}>"
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
    msg.set_content(payload["body"])
    return msg


def send_one(smtp: smtplib.SMTP, path: Path) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        msg = build_message(payload)
        recipients = [msg["To"]]
        if msg["Cc"]:
            recipients.extend([a.strip() for a in str(msg["Cc"]).split(",")])
        if msg["Bcc"]:
            recipients.extend([a.strip() for a in str(msg["Bcc"]).split(",")])
        smtp.send_message(msg, from_addr=SENDER_ADDRESS, to_addrs=recipients)
        sent_dir = path.parent / ".sent"
        sent_dir.mkdir(exist_ok=True)
        path.rename(sent_dir / path.name)
        print(f"SENT  {path.name} -> {payload['to']}")
        return True
    except Exception as exc:
        print(f"FAIL  {path.name}: {exc}", file=sys.stderr)
        return False


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: send-gmail.py <file.json | directory>", file=sys.stderr)
        return 2

    target = Path(argv[1]).resolve()
    app_password = load_app_password()
    payloads = list(iter_payload_files(target))
    if not payloads:
        print(f"no .json files found under {target}", file=sys.stderr)
        return 1

    print(f"connecting to {SMTP_HOST}:{SMTP_PORT} as {SENDER_ADDRESS}")
    ctx = ssl.create_default_context()
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as smtp:
        smtp.ehlo()
        smtp.starttls(context=ctx)
        smtp.ehlo()
        smtp.login(SENDER_ADDRESS, app_password)
        sent = 0
        failed = 0
        for path in payloads:
            if send_one(smtp, path):
                sent += 1
            else:
                failed += 1
    print(f"\ndone: {sent} sent, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
