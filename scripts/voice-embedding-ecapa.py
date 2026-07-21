#!/usr/bin/env python
"""SpeechBrain ECAPA-TDNN speaker embedding helper.

This is the proven acoustic backend for the Otter identity pipeline. The
surrounding JavaScript decides evidence policy; this script only turns clean
audio windows into normalized speaker embeddings.
"""

from __future__ import annotations

# --preflight answers "can this host run ECAPA at all" BEFORE the heavy imports
# below, so an unavailable runtime reports {"ok": false} in milliseconds instead
# of stack-ExampleCong (Phase A1 fail-fast contract; the resolver reads this).
import sys as _sys
import json as _json

if "--preflight" in _sys.argv:
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        import soundfile  # noqa: F401
        from speechbrain.inference.speaker import EncoderClassifier  # noqa: F401

        print(_json.dumps({"ok": True}))
        _sys.exit(0)
    except Exception as exc:  # noqa: BLE001 - surfaced to the JS caller.
        print(_json.dumps({"ok": False, "error": str(exc)}))
        _sys.exit(1)

import argparse
import json
import math
import os
from pathlib import Path
from typing import Iterable

import torch
import torchaudio
import soundfile as sf
from speechbrain.inference.speaker import EncoderClassifier
from speechbrain.utils.fetching import LocalStrategy


REPO = Path(__file__).resolve().parents[1]
MODEL_ID = os.environ.get("VOICE_ECAPA_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
# Model weights cache. Default lives under the repo data dir (works on the PC).
# In the Fargate container, EFS overlays data/life-archive/..., which would hide
# the weights baked into the image and force a runtime download. Set
# VOICE_ECAPA_MODEL_CACHE to a non-overlaid baked path (e.g. /opt/models/ecapa)
# so the container loads offline. (Codex Phase 2 review P1.)
_CACHE_OVERRIDE = os.environ.get("VOICE_ECAPA_MODEL_CACHE", "").strip()
CACHE_DIR = (
    Path(_CACHE_OVERRIDE)
    if _CACHE_OVERRIDE
    else REPO / "data" / "life-archive" / "voiceprints" / "model-cache" / "speechbrain-ecapa-voxceleb"
)
SAMPLE_RATE = 16000


_CLASSIFIER: EncoderClassifier | None = None


def repo_abs(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def repo_rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO).as_posix()
    except ValueError:
        return str(path)


def classifier() -> EncoderClassifier:
    global _CLASSIFIER
    if _CLASSIFIER is None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        torch.set_num_threads(int(os.environ.get("VOICE_ECAPA_TORCH_THREADS", "2")))
        _CLASSIFIER = EncoderClassifier.from_hparams(
            source=MODEL_ID,
            savedir=str(CACHE_DIR),
            local_strategy=LocalStrategy.COPY,
            run_opts={"device": "cpu"},
        )
        _CLASSIFIER.eval()
    return _CLASSIFIER


def audio_quality(wav: torch.Tensor, sample_rate: int) -> dict:
    values = wav.detach().cpu().float()
    duration = values.numel() / sample_rate if sample_rate else 0
    frame = max(1, int(sample_rate * 0.025))
    hop = max(1, int(sample_rate * 0.010))
    if values.numel() < frame:
        rms_values = torch.tensor([], dtype=torch.float32)
    else:
        windows = values.unfold(0, frame, hop)
        rms_values = torch.sqrt(torch.mean(windows * windows, dim=1))
    peak = float(values.abs().max().item()) if values.numel() else 0.0
    sorted_rms = torch.sort(rms_values).values if rms_values.numel() else torch.tensor([], dtype=torch.float32)

    def q(p: float) -> float:
        if not sorted_rms.numel():
            return 0.0
        idx = min(sorted_rms.numel() - 1, max(0, int(round((sorted_rms.numel() - 1) * p))))
        return float(sorted_rms[idx].item())

    floor = max(0.004, q(0.35) * 1.35)
    voiced = sorted_rms[sorted_rms >= floor]
    voiced_ratio = float(voiced.numel() / sorted_rms.numel()) if sorted_rms.numel() else 0.0
    # The original gate only accepted frames above -48 dBFS (0.004 RMS).
    # Quiet, continuously spoken meeting audio can sit below that level while
    # still carrying a strong, valid speaker signal. In that shape the
    # quantile-relative threshold also rises above almost every frame, so a
    # real 30-second utterance was misclassified as silence even though ECAPA
    # returned a complete embedding. Keep the burst/voiced-frame gate, but also
    # accept a sustained audible signal. The median and p90 floors reject true
    # silence; the peak floor rejects low-level codec hiss.
    sustained_signal = q(0.5) >= 0.001 and q(0.9) >= 0.0015 and peak >= 0.02
    burst_signal = voiced.numel() >= 120 and voiced_ratio >= 0.22
    return {
        "duration_seconds": round(duration, 3),
        "total_frames": int(sorted_rms.numel()),
        "voiced_frames": int(voiced.numel()),
        "voiced_ratio": round(voiced_ratio, 4),
        "rms_p50": round(q(0.5), 8),
        "rms_p90": round(q(0.9), 8),
        "peak": round(peak, 8),
        "burst_signal": bool(burst_signal),
        "sustained_signal": bool(sustained_signal),
        "usable": duration >= 6 and (burst_signal or sustained_signal),
    }


def load_audio(path: Path, max_seconds: float) -> torch.Tensor:
    data, sr = sf.read(str(path), always_2d=True, dtype="float32")
    wav = torch.from_numpy(data).mean(dim=1)
    if sr != SAMPLE_RATE:
        wav = torchaudio.functional.resample(wav, sr, SAMPLE_RATE)
    if max_seconds and max_seconds > 0:
        wav = wav[: int(SAMPLE_RATE * max_seconds)]
    if wav.numel() == 0:
        raise RuntimeError("decoded audio is empty")
    peak = wav.abs().max()
    if float(peak) > 1.0:
        wav = wav / peak
    return wav.contiguous().float()


def normalize(values: Iterable[float]) -> list[float]:
    vector = [float(v) for v in values]
    norm = math.sqrt(sum(v * v for v in vector))
    if norm:
        vector = [v / norm for v in vector]
    return [round(v, 8) for v in vector]


def embed_one(audio_path: str, max_seconds: float) -> dict:
    abs_path = repo_abs(audio_path)
    if not abs_path.exists():
        raise FileNotFoundError(f"audio not found: {audio_path}")
    wav = load_audio(abs_path, max_seconds)
    quality = audio_quality(wav, SAMPLE_RATE)
    with torch.no_grad():
        embeddings = classifier().encode_batch(wav.unsqueeze(0))
    vector = normalize(embeddings.squeeze().detach().cpu().tolist())
    return {
        "schema": "life_archive_voice_embedding.v4",
        "model": "speechbrain_ecapa_tdnn",
        "model_id": MODEL_ID,
        "sample_rate": SAMPLE_RATE,
        "max_duration_seconds": max_seconds,
        "dimensions": len(vector),
        "quality": quality,
        "vector": vector,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", nargs="+")
    parser.add_argument("--max-seconds", type=float, default=float(os.environ.get("VOICE_EMBEDDING_MAX_SECONDS", "30")))
    parser.add_argument("--jsonl", action="store_true")
    args = parser.parse_args()
    rows = []
    for audio in args.audio:
        try:
            row = {"path": audio, "embedding": embed_one(audio, args.max_seconds)}
        except Exception as exc:  # noqa: BLE001 - surfaced to JS caller.
            row = {"path": audio, "error": str(exc)}
        if args.jsonl:
            print(json.dumps(row, ensure_ascii=True), flush=True)
        else:
            rows.append(row)
    if not args.jsonl:
        print(json.dumps(rows[0] if len(rows) == 1 else rows, indent=2, ensure_ascii=True))


if __name__ == "__main__":
    main()
