"""Transcribe one downloaded audio window into timed cues.

Used by scripts/viral-tech-clip-proposals.js when YouTube refuses caption
downloads (HTTP 429 on every player client from EC2, 2026-10-02). Runs under
the local Telegram voice runtime, which already carries faster-whisper and the
cached "small" model, so no paid API and no new dependency.

Usage: python3 transcribe-audio-window.py <audio> <offset_seconds> [model]
Prints a JSON list of {"start", "dur", "text"} with start shifted by offset.
"""

import json
import os
import sys


def main():
    audio = sys.argv[1]
    offset = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    model_name = sys.argv[3] if len(sys.argv) > 3 else "small"
    # Same installed model as Telegram voice (install-telegram-voice-runtime.sh):
    # the runtime's own models folder, offline only, never a download.
    runtime_dir = os.path.dirname(os.path.dirname(os.path.abspath(sys.executable)))
    model_root = os.environ.get("TELEGRAM_VOICE_MODEL_ROOT") or os.path.join(runtime_dir, "models")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    from faster_whisper import WhisperModel

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        cpu_threads=4,
        download_root=model_root,
        local_files_only=True,
    )
    segments, _info = model.transcribe(audio, language="en", vad_filter=True)
    cues = []
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        cues.append(
            {
                "start": round(seg.start + offset, 2),
                "dur": round(seg.end - seg.start, 2),
                "text": text,
            }
        )
    print(json.dumps(cues))


if __name__ == "__main__":
    main()
