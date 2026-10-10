#!/usr/bin/env python3
"""Index normalized Signal history and linked attachment derivatives into Life Archive FTS."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path


def load_life_archive(script):
    spec = importlib.util.spec_from_file_location("secondbrain_life_archive", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_jsonl(file):
    with open(file, "r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def read_json(file, fallback=None):
    try:
        return json.loads(Path(file).read_text(encoding="utf-8"))
    except Exception:
        return fallback


def sha256_text(value):
    return hashlib.sha256(str(value or "").encode("utf-8", errors="replace")).hexdigest()


def scalar_label(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("title", "name", "label", "displayName"):
            label = scalar_label(value.get(key))
            if label:
                return label
    return ""


def attachment_row(reference, extraction_root):
    file_info = reference.get("file")
    if not file_info:
        return {
            "filename": reference.get("filename") or "missing-signal-attachment",
            "content_type": reference.get("contentType") or "application/octet-stream",
            "path": "",
            "size": reference.get("declaredBytes"),
            "checksum": reference.get("plaintextHash") or "",
            "extracted_text": "",
            "metadata": {
                "status": "missing_from_export",
                "reason": reference.get("missingReason"),
                "kind": reference.get("kind"),
                "pointer_path": reference.get("pointerPath"),
                "message_linked": True,
            },
        }
    receipt_file = Path(extraction_root) / file_info["sha256"] / "receipt.json"
    receipt = read_json(receipt_file, {}) or {}
    text_file = receipt.get("searchableTextPath")
    text = ""
    if text_file and Path(text_file).exists():
        text = Path(text_file).read_text(encoding="utf-8", errors="replace").strip()
    return {
        "filename": reference.get("filename") or Path(file_info["path"]).name,
        "content_type": reference.get("contentType") or "application/octet-stream",
        "path": file_info["path"],
        "size": file_info.get("bytes"),
        "checksum": file_info.get("sha256"),
        "extracted_text": text,
        "metadata": {
            "status": receipt.get("status") or "missing_extraction_receipt",
            "kind": reference.get("kind"),
            "pointer_path": reference.get("pointerPath"),
            "message_linked": True,
            "source_sha256": file_info.get("sha256"),
            "searchable_text_sha256": receipt.get("searchableTextSha256"),
            "methods": receipt.get("methods") or [],
            "receipt": str(receipt_file),
        },
    }


def message_body(message):
    parts = [message.get("text") or message.get("fallbackSummary") or "Signal message contained no text."]
    quote = message.get("quote") or {}
    if quote.get("text"):
        parts.extend(["", f"Quoted message context: {quote['text']}"])
    revisions = [row.get("text") for row in (message.get("revisions") or []) if row.get("text")]
    if revisions:
        parts.extend(["", "Earlier message revisions:", *revisions])
    previews = message.get("linkPreviews") or []
    for preview in previews:
        parts.extend([
            "",
            f"Shared link: {preview.get('url') or ''}",
            f"Link title: {preview.get('title') or ''}",
            f"Link description: {preview.get('description') or ''}",
        ])
    return "\n".join(value for value in parts if value is not None).strip()


def write_json_atomic(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(file.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, file)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--messages", required=True)
    parser.add_argument("--extraction-root", required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--life-archive-script", default=str(Path(__file__).with_name("life-archive.py")))
    return parser.parse_args()


def main():
    args = parse_args()
    life = load_life_archive(args.life_archive_script)
    con = life.connect_db(args.db)
    indexed = 0
    attachment_rows = 0
    missing_attachments = 0
    messages_with_missing = 0
    try:
        for message in read_jsonl(args.messages):
            attachments = [attachment_row(reference, args.extraction_root) for reference in message.get("attachments") or []]
            missing = sum(1 for row in attachments if row["metadata"].get("status") == "missing_from_export")
            missing_attachments += missing
            messages_with_missing += 1 if missing else 0
            attachment_rows += len(attachments)
            direction = message.get("direction") or "directionless"
            conversation = message.get("conversation") or {}
            author = message.get("author") or {}
            conversation_label = scalar_label(conversation.get("label"))
            author_label_value = scalar_label(author.get("label"))
            if direction == "outbound":
                author_label = "ExampleCo"
                recipients = conversation_label or "Signal recipient"
            elif direction == "inbound":
                author_label = author_label_value or conversation_label or "Signal participant"
                recipients = "ExampleCo"
            else:
                author_label = author_label_value or "Signal"
                recipients = conversation_label or "ExampleCo"
            body = message_body(message)
            raw_path = f"{Path(args.messages).resolve()}#record={message.get('recordIndex')}"
            metadata = {
                "schema": "amy.signal.history-message-index.v1",
                "event_id": message.get("eventId"),
                "record_indices": message.get("recordIndices") or [message.get("recordIndex")],
                "chat_id": message.get("chatId"),
                "direction": direction,
                "conversation_type": conversation.get("type"),
                "attachment_references": len(attachments),
                "attachment_coverage_complete": missing == 0 and all(
                    row["metadata"].get("status") in {"searchable", "inspected_no_text"} for row in attachments
                ),
                "missing_attachment_references": missing,
                "link_previews": len(message.get("linkPreviews") or []),
                "graphiti_eligible": True,
            }
            normalized_checksum = sha256_text(json.dumps(message, ensure_ascii=False, sort_keys=True))
            life.upsert_item(
                con,
                {
                    "source": "signal-history",
                    "source_id": message.get("eventId"),
                    "kind": "signal-message",
                    "title": f"Signal {direction} message with {conversation_label or 'unknown conversation'}",
                    "author": author_label,
                    "recipients": recipients,
                    "created_at": message.get("referenceTime"),
                    "raw_path": raw_path,
                    "url": "",
                    "checksum": normalized_checksum,
                    "metadata_json": life.safe_json_dumps(metadata),
                },
                body,
                attachments,
            )
            indexed += 1
            if indexed % 500 == 0:
                con.commit()
                print(f"[signal-history-index] {indexed}", file=sys.stderr, flush=True)
        con.commit()
        db_messages = con.execute("SELECT COUNT(*) FROM items WHERE source = 'signal-history'").fetchone()[0]
        db_attachments = con.execute(
            "SELECT COUNT(*) FROM attachments WHERE item_id IN (SELECT id FROM items WHERE source = 'signal-history')"
        ).fetchone()[0]
    finally:
        con.close()
    receipt = {
        "schema": "amy.signal.history-life-archive-coverage.v1",
        "status": "green" if db_messages == indexed and db_attachments == attachment_rows else "red",
        "database": str(Path(args.db).resolve()),
        "messagesIndexed": indexed,
        "databaseMessages": db_messages,
        "attachmentReferencesIndexed": attachment_rows,
        "databaseAttachmentReferences": db_attachments,
        "missingAttachmentReferences": missing_attachments,
        "messagesWithMissingAttachments": messages_with_missing,
    }
    write_json_atomic(args.receipt, receipt)
    print(json.dumps(receipt, indent=2))
    return 0 if receipt["status"] == "green" else 1


if __name__ == "__main__":
    import sys
    raise SystemExit(main())
