#!/usr/bin/env python
"""Voice embedding model bake-off harness (voiceprint audit Phase D1).

Compares candidate speaker-embedding backends against the production ECAPA
baseline on THIS corpus's genuine/impostor pairs (Codex amendment 17: any model
upgrade is gated on a LOCAL bake-off plus a licensing/runtime check, because
meeting/far-field audio can reorder lab-benchmark winners).

Input: a JSON pairs manifest (built by scripts/voice-model-bakeoff.js) with
rows {pair_id, label: genuine|impostor, audio_a, audio_b}. Output: JSONL rows
{pair_id, label, score} (or {pair_id, label, error} per failed pair) on stdout.
The surrounding JavaScript computes EER/FRR and writes the bake-off artifact;
this script only turns audio pairs into similarity scores, mirroring the
division of labor in scripts/voice-embedding-ecapa.py.

Backends, exact model ids, and licenses (the offline license record):
  ecapa    speechbrain/spkrec-ecapa-voxceleb via SpeechBrain EncoderClassifier,
           the exact model-loading approach of scripts/voice-embedding-ecapa.py.
           License: Apache-2.0 (SpeechBrain code and the spkrec-ecapa-voxceleb
           model card; already the production baseline).
  campp    CAM++ id iic/speech_campplus_sv_en_voxceleb_16k (English VoxCeleb,
           16 kHz) via the modelscope speaker-verification pipeline, from the
           3D-Speaker project. License: Apache-2.0
           (github.com/modelscope/3D-Speaker, verified 2026-07-11; the
           modelscope.cn model page for this id exists).
  redimnet IDRnD ReDimNet via torch.hub repo IDRnD/ReDimNet, entrypoint
           ReDimNet(model_name="b6", train_type="ft_lm", dataset="vox2"),
           the best-EER published variant (0.37% Vox1-O). License: MIT
           (github.com/IDRnD/redimnet repo LICENSE, verified 2026-07-11; the
           pretrained weights carry no separately stated terms, so weight
           redistribution stays cautious until IDRnD states them explicitly).

Contract with the node driver (scripts/voice-model-bakeoff.js):
  - A missing/broken backend package NEVER stack-traces: it prints one clean
    JSON line {"error": "backend_unavailable", "backend": ..., "detail": ...}
    and exits 4. The driver records status backend_unavailable and moves on.
  - --preflight [--backend NAME] answers "can this host run the backend" fast,
    exactly like scripts/voice-embedding-ecapa.py: {"ok": true|false} and exit
    0/1, before any heavy work.
  - Per-pair failures (missing audio, decode errors) are error ROWS, exit 0.
"""

from __future__ import annotations

# --preflight runs BEFORE the heavy imports below so an unavailable runtime
# reports in milliseconds instead of stack-ExampleCong (same fail-fast contract as
# voice-embedding-ecapa.py Phase A1).
import sys as _sys
import json as _json

if "--preflight" in _sys.argv:

    def _preflight_backend() -> str:
        for i, arg in enumerate(_sys.argv):
            if arg == "--backend" and i + 1 < len(_sys.argv):
                return _sys.argv[i + 1]
            if arg.startswith("--backend="):
                return arg.split("=", 1)[1]
        return "ecapa"

    _backend = _preflight_backend()
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        import soundfile  # noqa: F401

        if _backend == "ecapa":
            from speechbrain.inference.speaker import EncoderClassifier  # noqa: F401
        elif _backend == "campp":
            from modelscope.pipelines import pipeline  # noqa: F401
        elif _backend == "redimnet":
            # torch.hub fetches the ReDimNet code + weights at load time; a
            # preflight must stay fast and offline, so only the torch runtime
            # is checked here. The real hub download is exercised (and guarded
            # into backend_unavailable) on the first scored pair run.
            pass
        else:
            print(_json.dumps({"ok": False, "backend": _backend, "error": f"ExampleCo backend: {_backend}"}))
            _sys.exit(1)
        _out = {"ok": True, "backend": _backend}
        if _backend == "redimnet":
            _out["note"] = "torch runtime present; torch.hub model download not attempted in preflight"
        print(_json.dumps(_out))
        _sys.exit(0)
    except Exception as exc:  # noqa: BLE001 - surfaced to the JS caller.
        print(_json.dumps({"ok": False, "backend": _backend, "error": str(exc)}))
        _sys.exit(1)

import argparse
import json
import math
import os
import tempfile
from pathlib import Path
from typing import Callable, Iterable

REPO = Path(__file__).resolve().parents[1]
SAMPLE_RATE = 16000
BACKENDS = ("ecapa", "campp", "redimnet")

ECAPA_MODEL_ID = os.environ.get("VOICE_ECAPA_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
CAMPP_MODEL_ID = os.environ.get("VOICE_CAMPP_MODEL", "iic/speech_campplus_sv_en_voxceleb_16k")
REDIMNET_REPO = os.environ.get("VOICE_REDIMNET_REPO", "IDRnD/ReDimNet")
REDIMNET_VARIANT = os.environ.get("VOICE_REDIMNET_VARIANT", "b6")
REDIMNET_TRAIN_TYPE = os.environ.get("VOICE_REDIMNET_TRAIN_TYPE", "ft_lm")
REDIMNET_DATASET = os.environ.get("VOICE_REDIMNET_DATASET", "vox2")

# ECAPA weights cache: same default and override as voice-embedding-ecapa.py so
# both scripts share one on-disk copy of the baseline model.
_ECAPA_CACHE_OVERRIDE = os.environ.get("VOICE_ECAPA_MODEL_CACHE", "").strip()
ECAPA_CACHE_DIR = (
    Path(_ECAPA_CACHE_OVERRIDE)
    if _ECAPA_CACHE_OVERRIDE
    else REPO / "data" / "life-archive" / "voiceprints" / "model-cache" / "speechbrain-ecapa-voxceleb"
)
_REDIMNET_HUB_OVERRIDE = os.environ.get("VOICE_REDIMNET_HUB_DIR", "").strip()
REDIMNET_HUB_DIR = (
    Path(_REDIMNET_HUB_OVERRIDE)
    if _REDIMNET_HUB_OVERRIDE
    else REPO / "data" / "life-archive" / "voiceprints" / "model-cache" / "torch-hub"
)


def repo_abs(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def normalize(values: Iterable[float]) -> list[float]:
    vector = [float(v) for v in values]
    norm = math.sqrt(sum(v * v for v in vector))
    if norm:
        vector = [v / norm for v in vector]
    return [round(v, 8) for v in vector]


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        raise RuntimeError(f"embedding dimension mismatch: {len(a)} vs {len(b)}")
    dot = sum(x * y for x, y in zip(a, b))
    return max(-1.0, min(1.0, dot))


def backend_unavailable(backend: str, exc: Exception) -> None:
    """The exit-4 contract: one clean JSON line, never a stack trace."""
    print(json.dumps({"error": "backend_unavailable", "backend": backend, "detail": str(exc)}, ensure_ascii=True))
    _sys.exit(4)


def build_pair_scorer(backend: str, max_seconds: float) -> Callable[[Path, Path], float]:
    """Load one backend and return score(audio_a, audio_b) -> similarity.

    Every heavy import and model load is guarded: any failure here (missing
    package, no network for a first-time model download) is a clean
    backend_unavailable exit 4.
    """
    try:
        import torch
        import torchaudio
        import soundfile as sf
    except Exception as exc:  # noqa: BLE001
        backend_unavailable(backend, exc)

    torch.set_num_threads(
        int(os.environ.get("VOICE_BAKEOFF_TORCH_THREADS", os.environ.get("VOICE_ECAPA_TORCH_THREADS", "2")))
    )

    def load_audio(path: Path) -> "torch.Tensor":
        # Identical audio front end for every backend (mono mean, resample to
        # 16 kHz, cap at max_seconds, peak-normalize) so the bake-off compares
        # models, not preprocessing differences. Mirrors voice-embedding-ecapa.py.
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

    def make_embedding_scorer(embed: Callable[[Path], list[float]]) -> Callable[[Path, Path], float]:
        cache: dict[str, list[float]] = {}

        def embedding(path: Path) -> list[float]:
            key = str(path)
            if key not in cache:
                cache[key] = embed(path)
            return cache[key]

        return lambda a, b: cosine(embedding(a), embedding(b))

    if backend == "ecapa":
        # Exact model-loading approach of scripts/voice-embedding-ecapa.py:
        # speechbrain/spkrec-ecapa-voxceleb, COPY strategy, CPU.
        try:
            from speechbrain.inference.speaker import EncoderClassifier
            from speechbrain.utils.fetching import LocalStrategy

            ECAPA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            classifier = EncoderClassifier.from_hparams(
                source=ECAPA_MODEL_ID,
                savedir=str(ECAPA_CACHE_DIR),
                local_strategy=LocalStrategy.COPY,
                run_opts={"device": "cpu"},
            )
            classifier.eval()
        except Exception as exc:  # noqa: BLE001
            backend_unavailable(backend, exc)

        def embed_ecapa(path: Path) -> list[float]:
            wav = load_audio(path)
            with torch.no_grad():
                out = classifier.encode_batch(wav.unsqueeze(0))
            return normalize(out.squeeze().detach().cpu().tolist())

        return make_embedding_scorer(embed_ecapa)

    if backend == "campp":
        # CAM++ id iic/speech_campplus_sv_en_voxceleb_16k (3D-Speaker project,
        # Apache-2.0) through the modelscope speaker-verification pipeline.
        try:
            from modelscope.pipelines import pipeline

            sv = pipeline(task="speaker-verification", model=CAMPP_MODEL_ID)
        except Exception as exc:  # noqa: BLE001
            backend_unavailable(backend, exc)

        def write_clip(tmp: str, name: str, wav: "torch.Tensor") -> str:
            clip = str(Path(tmp) / name)
            sf.write(clip, wav.numpy(), SAMPLE_RATE)
            return clip

        def embed_campp(path: Path) -> list[float]:
            # Feed the SAME trimmed/resampled window every backend sees, via a
            # temp wav (the pipeline wants file paths). output_emb=True is the
            # 3D-Speaker documented way to get raw embeddings from the pipeline.
            wav = load_audio(path)
            with tempfile.TemporaryDirectory() as tmp:
                clip = write_clip(tmp, "clip.wav", wav)
                result = sv([clip, clip], output_emb=True)
            embs = result.get("embs") if isinstance(result, dict) else None
            if embs is None:
                raise RuntimeError("campp_no_embeddings")
            return normalize([float(v) for v in list(embs[0])])

        emb_scorer = make_embedding_scorer(embed_campp)
        state = {"emb_supported": True}

        def score_campp(a: Path, b: Path) -> float:
            if state["emb_supported"]:
                try:
                    return emb_scorer(a, b)
                except (TypeError, RuntimeError) as exc:
                    # Older modelscope versions reject output_emb (TypeError) or
                    # return no embs; fall back to the pipeline's own pair score
                    # (a cosine-family similarity, rank-equivalent for EER/FRR).
                    # Any other error is a real per-pair failure and propagates.
                    if isinstance(exc, RuntimeError) and str(exc) != "campp_no_embeddings":
                        raise
                    state["emb_supported"] = False
            wav_a = load_audio(a)
            wav_b = load_audio(b)
            with tempfile.TemporaryDirectory() as tmp:
                clip_a = write_clip(tmp, "a.wav", wav_a)
                clip_b = write_clip(tmp, "b.wav", wav_b)
                result = sv([clip_a, clip_b])
            score = result.get("score") if isinstance(result, dict) else None
            if score is None:
                raise RuntimeError(f"campp pipeline returned no score: {result!r}")
            return float(score)

        return score_campp

    if backend == "redimnet":
        # IDRnD ReDimNet via torch.hub (repo IDRnD/ReDimNet, MIT, verified
        # 2026-07-11), variant b6 ft_lm vox2: the published best-EER checkpoint.
        # First load downloads code + weights from GitHub into REDIMNET_HUB_DIR;
        # an offline host fails cleanly into backend_unavailable.
        try:
            REDIMNET_HUB_DIR.mkdir(parents=True, exist_ok=True)
            torch.hub.set_dir(str(REDIMNET_HUB_DIR))
            model = torch.hub.load(
                REDIMNET_REPO,
                "ReDimNet",
                model_name=REDIMNET_VARIANT,
                train_type=REDIMNET_TRAIN_TYPE,
                dataset=REDIMNET_DATASET,
                trust_repo=True,
            )
            model.eval()
        except Exception as exc:  # noqa: BLE001
            backend_unavailable(backend, exc)

        def embed_redimnet(path: Path) -> list[float]:
            wav = load_audio(path)
            with torch.no_grad():
                out = model(wav.unsqueeze(0))
            return normalize(out.squeeze().detach().cpu().tolist())

        return make_embedding_scorer(embed_redimnet)

    backend_unavailable(backend, RuntimeError(f"ExampleCo backend: {backend}"))
    raise AssertionError("unreachable")


def main() -> None:
    parser = argparse.ArgumentParser(description="Score genuine/impostor audio pairs with one embedding backend.")
    parser.add_argument("pairs_manifest", help="JSON manifest with pairs: [{pair_id, label, audio_a, audio_b}]")
    parser.add_argument("--backend", required=True, choices=BACKENDS)
    parser.add_argument(
        "--max-seconds",
        type=float,
        default=float(os.environ.get("VOICE_EMBEDDING_MAX_SECONDS", "30")),
    )
    args = parser.parse_args()

    manifest_path = repo_abs(args.pairs_manifest)
    if not manifest_path.exists():
        # A missing manifest is a caller bug, not a backend problem: loud, exit 2.
        print(json.dumps({"error": "pairs_manifest_not_found", "path": str(manifest_path)}, ensure_ascii=True))
        _sys.exit(2)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    pairs = manifest.get("pairs") or []

    score_pair = build_pair_scorer(args.backend, args.max_seconds)

    for pair in pairs:
        pair_id = str(pair.get("pair_id") or "")
        label = str(pair.get("label") or "")
        try:
            audio_a = repo_abs(str(pair.get("audio_a") or ""))
            audio_b = repo_abs(str(pair.get("audio_b") or ""))
            for side in (audio_a, audio_b):
                if not side.exists():
                    raise FileNotFoundError(f"audio not found: {side}")
            row = {"pair_id": pair_id, "label": label, "score": round(float(score_pair(audio_a, audio_b)), 6)}
        except Exception as exc:  # noqa: BLE001 - per-pair failures are rows, not crashes.
            row = {"pair_id": pair_id, "label": label, "error": str(exc)}
        print(json.dumps(row, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
