#!/usr/bin/env python3
"""Build searchable derivatives for a Signal plaintext-export attachment manifest."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

try:
    import pypdf
except Exception:
    pypdf = None


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
MEDIA_EXTENSIONS = {".mp4", ".m4a", ".mp3", ".wav", ".mov", ".webm"}
TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".jsonl", ".html", ".htm", ".log"}
SUPPORTED_EXTENSIONS = IMAGE_EXTENSIONS | MEDIA_EXTENSIONS | TEXT_EXTENSIONS | {".pdf", ".pkpass"}


def sha256_file(file):
    digest = hashlib.sha256()
    with open(file, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def write_json_atomic(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(file.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, file)


def write_text_atomic(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(file.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(str(value or "").strip() + "\n", encoding="utf-8")
    os.replace(temporary, file)


def command_path(name, explicit=""):
    if explicit and Path(explicit).exists():
        return explicit
    return shutil.which(name) or ""


# Known install roots, probed before falling back to PATH. A non-interactive run
# (scheduled task, service) does not inherit the interactive PATH, so a user-scoped
# install is invisible to shutil.which and every image payload would fail with
# "tesseract unavailable" without a single config change.
TESSERACT_INSTALL_LOCATIONS = (
    ("LOCALAPPDATA", "Programs/Tesseract-OCR/tesseract.exe"),
    ("PROGRAMFILES", "Tesseract-OCR/tesseract.exe"),
    ("PROGRAMFILES(X86)", "Tesseract-OCR/tesseract.exe"),
)


def tesseract_path(explicit=""):
    candidates = [
        explicit,
        os.environ.get("TESSERACT_EXE", ""),
        *(
            str(Path(os.environ[variable]) / relative)
            for variable, relative in TESSERACT_INSTALL_LOCATIONS
            if os.environ.get(variable)
        ),
        "C:/Program Files/Tesseract-OCR/tesseract.exe",
        shutil.which("tesseract") or "",
    ]
    return next((value for value in candidates if value and Path(value).exists()), "")


def image_ocr(file, executable):
    if not executable:
        raise RuntimeError("tesseract unavailable")
    with tempfile.TemporaryDirectory() as temporary:
        output = Path(temporary) / "ocr"
        result = subprocess.run(
            [executable, str(file), str(output), "--psm", "6"],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(f"tesseract exit {result.returncode}: {(result.stderr or '')[:300]}")
        text_file = output.with_suffix(".txt")
        return clean_text(text_file.read_text(encoding="utf-8", errors="replace") if text_file.exists() else "")


def pdf_text(file):
    if pypdf is None:
        raise RuntimeError("pypdf unavailable")
    reader = pypdf.PdfReader(str(file))
    return clean_text("\n".join((page.extract_text() or "") for page in reader.pages[:100]))


def pkpass_text(file):
    with zipfile.ZipFile(file) as archive:
        names = set(archive.namelist())
        candidates = [name for name in ("pass.json", "manifest.json") if name in names]
        if not candidates:
            raise RuntimeError("pkpass contains no pass.json or manifest.json")
        values = []
        for name in candidates:
            raw = archive.read(name).decode("utf-8", errors="replace")
            try:
                values.append(json.dumps(json.loads(raw), ensure_ascii=False))
            except Exception:
                values.append(raw)
        return clean_text("\n".join(values))


def ordinary_extraction(row, out_root, tesseract):
    source = Path(row["path"])
    digest = row["sha256"]
    output_dir = Path(out_root) / digest
    receipt_file = output_dir / "receipt.json"
    prior = None
    try:
        prior = json.loads(receipt_file.read_text(encoding="utf-8"))
    except Exception:
        pass
    if prior and prior.get("sourceSha256") == digest and prior.get("status") in {"searchable", "inspected_no_text"}:
        return prior

    extension = str(row.get("extension") or source.suffix).lower()
    methods = []
    text = ""
    try:
        if extension in IMAGE_EXTENSIONS:
            methods.append("tesseract-ocr")
            text = image_ocr(source, tesseract)
        elif extension == ".pdf":
            methods.append("pypdf-text")
            text = pdf_text(source)
        elif extension == ".pkpass":
            methods.append("pkpass-json")
            text = pkpass_text(source)
        elif extension in TEXT_EXTENSIONS:
            methods.append("utf8-text")
            text = clean_text(source.read_text(encoding="utf-8", errors="replace"))
        else:
            raise RuntimeError(f"unsupported extension {extension or '[none]'}")
        searchable_file = output_dir / "searchable.txt"
        write_text_atomic(searchable_file, text)
        receipt = {
            "schema": "amy.signal.history-attachment-extraction.v1",
            "status": "searchable" if text else "inspected_no_text",
            "supported": True,
            "sourcePath": str(source),
            "sourceSha256": digest,
            "sourceBytes": int(row.get("bytes") or source.stat().st_size),
            "extension": extension,
            "methods": methods,
            "searchableTextPath": str(searchable_file),
            "searchableTextChars": len(text),
            "searchableTextSha256": sha256_file(searchable_file),
            "references": row.get("references") or [],
        }
    except Exception as error:
        receipt = {
            "schema": "amy.signal.history-attachment-extraction.v1",
            "status": "failed",
            "supported": extension in SUPPORTED_EXTENSIONS,
            "sourcePath": str(source),
            "sourceSha256": digest,
            "sourceBytes": int(row.get("bytes") or source.stat().st_size),
            "extension": extension,
            "methods": methods,
            "searchableTextPath": None,
            "searchableTextChars": 0,
            "error": str(error)[:1000],
            "references": row.get("references") or [],
        }
    write_json_atomic(receipt_file, receipt)
    return receipt


def media_duration(file, ffprobe):
    result = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(file)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe exit {result.returncode}: {(result.stderr or '')[:300]}")
    return float((result.stdout or "0").strip() or 0)


def video_frame_ocr(file, duration, ffmpeg, tesseract):
    if not ffmpeg or not tesseract:
        raise RuntimeError("ffmpeg and tesseract are required for video frame OCR")
    timestamps = []
    cursor = 1.0 if duration > 1 else 0.0
    while cursor < max(duration, 0.1) and len(timestamps) < 12:
        timestamps.append(cursor)
        cursor += 30.0
    if not timestamps:
        timestamps = [0.0]
    rows = []
    with tempfile.TemporaryDirectory() as temporary:
        for index, timestamp in enumerate(timestamps):
            frame = Path(temporary) / f"frame-{index:03d}.jpg"
            result = subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", str(timestamp), "-i", str(file), "-frames:v", "1", "-q:v", "3", "-y", str(frame)],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            if result.returncode != 0 or not frame.exists():
                raise RuntimeError(f"ffmpeg frame extraction failed at {timestamp:.2f}s")
            text = image_ocr(frame, tesseract)
            if text:
                rows.append({"timestamp": round(timestamp, 2), "text": text})
    return {"rows": rows, "inspected": len(timestamps)}


def load_whisper(vendor, model_name, model_cache):
    if vendor:
        sys.path.insert(0, vendor)
    try:
        from faster_whisper import WhisperModel
    except Exception as error:
        raise RuntimeError(f"faster_whisper unavailable: {error}") from error
    return WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        download_root=model_cache or None,
        local_files_only=True,
    )


def cached_media_receipt(row, out_root):
    """The prior receipt for this payload when it is already covered, else None.

    Single definition of the resume predicate: the gate that decides whether to
    load transcription tooling and the extraction that reuses the receipt must
    never drift apart, or one would skip work the other still expects to do.
    """
    digest = row["sha256"]
    receipt_file = Path(out_root) / digest / "receipt.json"
    try:
        prior = json.loads(receipt_file.read_text(encoding="utf-8"))
    except Exception:
        return None
    if prior.get("sourceSha256") == digest and prior.get("status") in {"searchable", "inspected_no_text"}:
        return prior
    return None


def media_extraction(row, out_root, model, ffmpeg, ffprobe, tesseract):
    source = Path(row["path"])
    digest = row["sha256"]
    extension = str(row.get("extension") or source.suffix).lower()
    output_dir = Path(out_root) / digest
    receipt_file = output_dir / "receipt.json"
    prior = cached_media_receipt(row, out_root)
    if prior:
        return prior

    try:
        duration = media_duration(source, ffprobe)
        segments_iter, info = model.transcribe(
            str(source),
            beam_size=2,
            word_timestamps=False,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
        )
        segments = []
        transcript_parts = []
        for segment in segments_iter:
            value = clean_text(segment.text)
            if value:
                transcript_parts.append(value)
                segments.append({"start": round(float(segment.start), 2), "end": round(float(segment.end), 2), "text": value})
        transcript = clean_text(" ".join(transcript_parts))
        frame_result = video_frame_ocr(source, duration, ffmpeg, tesseract) if extension in {".mp4", ".mov", ".webm"} else {"rows": [], "inspected": 0}
        frame_rows = frame_result["rows"]
        frame_text = clean_text(" ".join(row["text"] for row in frame_rows))
        searchable = clean_text(" ".join(value for value in (transcript, frame_text) if value))
        searchable_file = output_dir / "searchable.txt"
        transcript_file = output_dir / "transcript.json"
        write_text_atomic(searchable_file, searchable)
        write_json_atomic(transcript_file, {
            "schema": "amy.signal.history-media-transcript.v1",
            "language": getattr(info, "language", None),
            "languageProbability": getattr(info, "language_probability", None),
            "durationSeconds": duration,
            "segments": segments,
            "frameOcr": frame_rows,
        })
        receipt = {
            "schema": "amy.signal.history-attachment-extraction.v1",
            "status": "searchable" if searchable else "inspected_no_text",
            "supported": True,
            "sourcePath": str(source),
            "sourceSha256": digest,
            "sourceBytes": int(row.get("bytes") or source.stat().st_size),
            "extension": extension,
            "methods": ["faster-whisper", *( ["sampled-frame-ocr"] if frame_rows or extension in {".mp4", ".mov", ".webm"} else [] )],
            "durationSeconds": duration,
            "searchableTextPath": str(searchable_file),
            "searchableTextChars": len(searchable),
            "searchableTextSha256": sha256_file(searchable_file),
            "transcriptPath": str(transcript_file),
            "transcriptSha256": sha256_file(transcript_file),
            "transcriptSegments": len(segments),
            "videoFramesInspected": frame_result["inspected"],
            "references": row.get("references") or [],
        }
    except Exception as error:
        receipt = {
            "schema": "amy.signal.history-attachment-extraction.v1",
            "status": "failed",
            "supported": True,
            "sourcePath": str(source),
            "sourceSha256": digest,
            "sourceBytes": int(row.get("bytes") or source.stat().st_size),
            "extension": extension,
            "methods": ["faster-whisper", "sampled-frame-ocr"] if extension in {".mp4", ".mov", ".webm"} else ["faster-whisper"],
            "searchableTextPath": None,
            "searchableTextChars": 0,
            "error": str(error)[:1000],
            "references": row.get("references") or [],
        }
    write_json_atomic(receipt_file, receipt)
    return receipt


def read_jsonl(file):
    with open(file, "r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out-root", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--workers", type=int, default=min(6, os.cpu_count() or 1))
    parser.add_argument("--tesseract", default="")
    parser.add_argument("--ffmpeg", default="")
    parser.add_argument("--ffprobe", default="")
    parser.add_argument("--whisper-vendor", default=os.environ.get("SIGNAL_HISTORY_WHISPER_VENDOR", ""))
    parser.add_argument("--whisper-model", default="base.en")
    parser.add_argument("--model-cache", default=str(Path.home() / ".cache" / "huggingface" / "hub"))
    return parser.parse_args()


def main():
    args = parse_args()
    expected_receipt = (Path(args.out_root).resolve().parent / "attachment-coverage.json").resolve()
    if Path(args.receipt).resolve() != expected_receipt:
        raise RuntimeError(f"attachment coverage receipt must be {expected_receipt}")
    rows = read_jsonl(args.manifest)
    unique = {}
    for row in rows:
        current = unique.setdefault(row["sha256"], dict(row))
        current["references"] = current.get("references", []) + row.get("references", [])
    unique_rows = list(unique.values())
    media = [row for row in unique_rows if str(row.get("extension") or "").lower() in MEDIA_EXTENSIONS]
    ordinary = [row for row in unique_rows if row not in media]
    out_root = Path(args.out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    tess = tesseract_path(args.tesseract)
    receipts = []
    if ordinary:
        with ProcessPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = {pool.submit(ordinary_extraction, row, str(out_root), tess): row for row in ordinary}
            for index, future in enumerate(as_completed(futures), 1):
                receipts.append(future.result())
                if index == 1 or index % 25 == 0 or index == len(ordinary):
                    print(f"[signal-history-extract] ordinary {index}/{len(ordinary)}", file=sys.stderr, flush=True)

    if media:
        # Resolve transcription tooling only for payloads that still need it. A
        # re-run over an already covered export reuses every cached receipt, so
        # demanding ffmpeg and the whisper model up front would abort the whole
        # run, discard the ordinary extractions just completed, and leave the
        # coverage receipt unwritten on any host without the model installed.
        ffmpeg = ""
        ffprobe = ""
        model = None
        if any(cached_media_receipt(row, out_root) is None for row in media):
            ffmpeg = command_path("ffmpeg", args.ffmpeg)
            ffprobe = command_path("ffprobe", args.ffprobe)
            if not ffmpeg or not ffprobe:
                raise RuntimeError("ffmpeg/ffprobe unavailable")
            model = load_whisper(args.whisper_vendor, args.whisper_model, args.model_cache)
        for index, row in enumerate(media, 1):
            receipts.append(media_extraction(row, str(out_root), model, ffmpeg, ffprobe, tess))
            print(f"[signal-history-extract] media {index}/{len(media)}", file=sys.stderr, flush=True)

    counts = {}
    for receipt in receipts:
        status = receipt.get("status") or "unknown"
        counts[status] = counts.get(status, 0) + 1
    aggregate = {
        "schema": "amy.signal.history-attachment-coverage.v1",
        "status": "green" if len(receipts) == len(unique_rows) and not counts.get("failed") else "red",
        "manifest": str(Path(args.manifest).resolve()),
        "physicalFiles": len(rows),
        "uniquePayloads": len(unique_rows),
        "deduplicatedPhysicalFiles": len(rows) - len(unique_rows),
        "supportedPayloads": sum(1 for receipt in receipts if receipt.get("supported")),
        "coveredPayloads": sum(1 for receipt in receipts if receipt.get("status") in {"searchable", "inspected_no_text"}),
        "searchableTextPayloads": counts.get("searchable", 0),
        "inspectedNoTextPayloads": counts.get("inspected_no_text", 0),
        "failedPayloads": counts.get("failed", 0),
        "statusCounts": counts,
        "searchableTextCharacters": sum(int(receipt.get("searchableTextChars") or 0) for receipt in receipts),
        "mediaDurationSeconds": sum(float(receipt.get("durationSeconds") or 0) for receipt in receipts),
        # Sorted, not in completion order: the pool finishes payloads in a
        # different order every run, and a coverage receipt that cannot be
        # diffed against its own baseline cannot prove a re-verification.
        "receipts": sorted(str(out_root / receipt["sourceSha256"] / "receipt.json") for receipt in receipts),
    }
    write_json_atomic(args.receipt, aggregate)
    print(json.dumps(aggregate, indent=2))
    return 0 if aggregate["status"] == "green" else 1


if __name__ == "__main__":
    raise SystemExit(main())
