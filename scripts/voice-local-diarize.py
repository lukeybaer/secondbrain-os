#!/usr/bin/env python
"""Local overlap-aware diarization helper (pyannote community-1).

Phase D2 of dev-plans/voiceprint-matching-audit-2026-07-11.html (Codex
amendment 16): a local diarizer that recovers overlapped speech Otter's own
labels cannot represent, so channel-drift and over-splitting can be measured.
The node wrapper (scripts/voice-local-diarize.js) owns the default-off gate and
the compare logic; this script only turns audio into diarized segments.

Contract with the wrapper:
  --preflight            -> prints {"ok": true} (exit 0) or
                            {"ok": false, "reason": "..."} (exit 4) after a
                            heavy-import + HF-token check, no audio touched.
  <audio.wav>            -> prints {"segments": [{start, end, speaker}],
                            "overlap_seconds": <float>, "speaker_count": <int>,
                            "model": "..."} (exit 0), or
                            {"error": "diarization_unavailable"|"diarization_failed",
                            "detail": "..."} with exit 4 (unavailable) / 1.

Guarded like scripts/voice-embedding-ecapa.py: a missing pyannote package or a
missing HF token prints a clean JSON error and exits 4, never a stack trace.
"""

from __future__ import annotations

import json
import os
import sys

EXIT_UNAVAILABLE = 4

MODEL_ID = os.environ.get("VOICE_DIARIZE_MODEL", "pyannote/speaker-diarization-community-1")


def hf_token() -> str:
    for name in ("HF_TOKEN", "HUGGINGFACE_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def check_backend() -> tuple[bool, str]:
    """Return (ok, reason) WITHOUT loading the model or any audio."""
    try:
        import torch  # noqa: F401
        from pyannote.audio import Pipeline  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - surfaced to the JS caller.
        return False, f"pyannote/torch not importable: {exc}"
    if not hf_token():
        return False, "no HF token (set HF_TOKEN or HUGGINGFACE_TOKEN)"
    return True, ""


_PIPELINE = None


def pipeline():
    global _PIPELINE
    if _PIPELINE is None:
        import torch
        from pyannote.audio import Pipeline

        _PIPELINE = Pipeline.from_pretrained(MODEL_ID, use_auth_token=hf_token())
        threads = int(os.environ.get("VOICE_DIARIZE_TORCH_THREADS", "2"))
        try:
            torch.set_num_threads(threads)
        except Exception:  # noqa: BLE001
            pass
    return _PIPELINE


def diarize(audio_path: str) -> dict:
    diarization = pipeline()(audio_path)
    raw = []
    speakers = set()
    for turn, _track, speaker in diarization.itertracks(yield_label=True):
        raw.append({"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)})
        speakers.add(str(speaker))
    raw.sort(key=lambda seg: (seg["start"], seg["end"]))
    # Overlap seconds: total time where two or more turns are simultaneously
    # active. Sweep-line over start/end events; overlap accrues whenever the
    # active-turn count is >= 2. This is exactly what Otter's single-label
    # segments cannot represent.
    events = []
    for seg in raw:
        events.append((seg["start"], 1))
        events.append((seg["end"], -1))
    events.sort(key=lambda e: (e[0], -e[1]))
    overlap_seconds = 0.0
    active = 0
    prev_t = None
    for t, delta in events:
        if prev_t is not None and active >= 2:
            overlap_seconds += t - prev_t
        active += delta
        prev_t = t
    return {
        "segments": raw,
        "overlap_seconds": round(overlap_seconds, 3),
        "speaker_count": len(speakers),
        "model": MODEL_ID,
    }


def main() -> None:
    args = sys.argv[1:]
    if "--preflight" in args:
        ok, reason = check_backend()
        if ok:
            print(json.dumps({"ok": True, "model": MODEL_ID}))
            sys.exit(0)
        print(json.dumps({"ok": False, "reason": reason}))
        sys.exit(EXIT_UNAVAILABLE)

    audio_paths = [a for a in args if not a.startswith("--")]
    if not audio_paths:
        print(json.dumps({"error": "usage", "detail": "voice-local-diarize.py <audio> | --preflight"}))
        sys.exit(1)

    ok, reason = check_backend()
    if not ok:
        print(json.dumps({"error": "diarization_unavailable", "detail": reason}))
        sys.exit(EXIT_UNAVAILABLE)

    try:
        result = diarize(audio_paths[0])
    except Exception as exc:  # noqa: BLE001 - surfaced to the JS caller.
        print(json.dumps({"error": "diarization_failed", "detail": str(exc)[:2000]}))
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
