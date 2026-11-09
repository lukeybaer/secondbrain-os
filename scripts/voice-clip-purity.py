#!/usr/bin/env python3
"""Cut each voice clip into short pieces and report how alike the pieces sound.

A clip recorder filed under one speaker can hold two people (one long block that
merged a back-and-forth). Each audible piece gets its own ECAPA embedding; the
caller reads the piece-by-piece similarity matrix and decides whether the clip
is one voice (scripts/lib/voice-clip-purity.js).

Reads one audio path per line on stdin, prints one JSON row per path. The
model loads once for the whole batch.
"""
import importlib.util
import json
import sys
from pathlib import Path

import torch

_SPEC = importlib.util.spec_from_file_location(
    "voice_embedding_ecapa", Path(__file__).resolve().parent / "voice-embedding-ecapa.py"
)
ecapa = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(ecapa)

PIECE_SECONDS = 5.0
MAX_SECONDS = 30.0


def audible(piece: torch.Tensor) -> bool:
    q = ecapa.audio_quality(piece, ecapa.SAMPLE_RATE)
    return bool(q["burst_signal"] or q["sustained_signal"])


def purity_row(audio_path: str) -> dict:
    wav = ecapa.load_audio(ecapa.repo_abs(audio_path), MAX_SECONDS)
    step = int(ecapa.SAMPLE_RATE * PIECE_SECONDS)
    pieces = []
    for start in range(0, wav.numel() - step + 1, step):
        piece = wav[start : start + step]
        if audible(piece):
            pieces.append((start / ecapa.SAMPLE_RATE, piece))
    if not pieces:
        return {"piece_seconds": PIECE_SECONDS, "starts": [], "similarity": []}
    with torch.no_grad():
        batch = torch.stack([p for _, p in pieces])
        vectors = ecapa.classifier().encode_batch(batch).squeeze(1)
    vectors = torch.nn.functional.normalize(vectors, dim=1)
    sim = (vectors @ vectors.T).tolist()
    return {
        "piece_seconds": PIECE_SECONDS,
        "starts": [round(s, 2) for s, _ in pieces],
        "similarity": [[round(v, 3) for v in row] for row in sim],
    }


def main() -> None:
    for line in sys.stdin:
        audio = line.strip()
        if not audio:
            continue
        try:
            row = {"path": audio, **purity_row(audio)}
        except Exception as exc:  # noqa: BLE001 - surfaced to the JS caller.
            row = {"path": audio, "error": str(exc)}
        print(json.dumps(row, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
