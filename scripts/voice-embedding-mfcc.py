#!/usr/bin/env python3
"""Local speaker-oriented audio embedding helper.

This is intentionally dependency-light: ffmpeg provides decoding, numpy handles
the signal math. It is not a biometric-grade neural speaker model, but it is a
much stronger local baseline than the old RMS/ZCR fingerprint and it exposes
quality gates so bad review clips do not get promoted.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000


def decode_audio(path: Path) -> np.ndarray:
    run = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "1",
            "-f",
            "f32le",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if run.returncode != 0 or not run.stdout:
        raise RuntimeError((run.stderr or b"ffmpeg failed").decode("utf-8", "ignore")[:500])
    return np.frombuffer(run.stdout, dtype=np.float32).copy()


def hz_to_mel(hz: np.ndarray | float) -> np.ndarray | float:
    return 2595.0 * np.log10(1.0 + np.asarray(hz) / 700.0)


def mel_to_hz(mel: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (np.asarray(mel) / 2595.0) - 1.0)


def frame_audio(samples: np.ndarray) -> np.ndarray:
    if samples.size == 0:
        return np.zeros((0, 400), dtype=np.float32)
    frame_len = int(0.025 * SAMPLE_RATE)
    hop = int(0.010 * SAMPLE_RATE)
    if samples.size < frame_len:
        samples = np.pad(samples, (0, frame_len - samples.size))
    count = 1 + max(0, (samples.size - frame_len) // hop)
    idx = np.arange(frame_len)[None, :] + hop * np.arange(count)[:, None]
    return samples[idx] * np.hamming(frame_len).astype(np.float32)


def mel_filterbank(n_fft: int = 512, n_mels: int = 40) -> np.ndarray:
    low_mel = hz_to_mel(60.0)
    high_mel = hz_to_mel(SAMPLE_RATE / 2)
    mel_points = np.linspace(low_mel, high_mel, n_mels + 2)
    hz_points = mel_to_hz(mel_points)
    bins = np.floor((n_fft + 1) * hz_points / SAMPLE_RATE).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float32)
    for m in range(1, n_mels + 1):
        left, center, right = bins[m - 1], bins[m], bins[m + 1]
        if center <= left:
            center = left + 1
        if right <= center:
            right = center + 1
        for k in range(left, min(center, fb.shape[1])):
            fb[m - 1, k] = (k - left) / max(1, center - left)
        for k in range(center, min(right, fb.shape[1])):
            fb[m - 1, k] = (right - k) / max(1, right - center)
    return fb


def dct_matrix(n_mels: int = 40, n_coeffs: int = 20) -> np.ndarray:
    n = np.arange(n_mels)
    k = np.arange(n_coeffs)[:, None]
    mat = np.cos(np.pi / n_mels * (n + 0.5) * k).astype(np.float32)
    mat[0, :] *= math.sqrt(1.0 / n_mels)
    mat[1:, :] *= math.sqrt(2.0 / n_mels)
    return mat


def voiced_mask(frames: np.ndarray) -> tuple[np.ndarray, dict]:
    if frames.size == 0:
        return np.zeros((0,), dtype=bool), {"voiced_ratio": 0, "voiced_frames": 0}
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    zcr = np.mean(frames[:, 1:] * frames[:, :-1] < 0, axis=1)
    floor = max(0.004, float(np.percentile(rms, 35)) * 1.35)
    ceiling = float(np.percentile(rms, 98))
    mask = (rms >= floor) & (zcr < 0.35)
    # Very loud non-speech spikes are often clicks/noise; drop only the most
    # extreme frames so expressive speech is preserved.
    if ceiling > 0:
        mask &= rms <= ceiling * 1.8
    return mask, {
        "rms_p50": round(float(np.percentile(rms, 50)), 8),
        "rms_p90": round(float(np.percentile(rms, 90)), 8),
        "zcr_p50": round(float(np.percentile(zcr, 50)), 8),
        "voiced_frames": int(np.sum(mask)),
        "total_frames": int(mask.size),
        "voiced_ratio": round(float(np.mean(mask)), 4) if mask.size else 0,
    }


def quantile_stats(arr: np.ndarray) -> np.ndarray:
    if arr.size == 0:
        return np.zeros((0,), dtype=np.float32)
    qs = np.quantile(arr, [0.1, 0.25, 0.5, 0.75, 0.9], axis=0)
    mean = np.mean(arr, axis=0, keepdims=True)
    std = np.std(arr, axis=0, keepdims=True)
    return np.concatenate([mean, std, qs], axis=0).T.reshape(-1).astype(np.float32)


def estimate_pitch_stats(voiced_frames: np.ndarray) -> list[float]:
    if voiced_frames.size == 0:
        return [0.0, 0.0, 0.0]
    values: list[float] = []
    min_lag = int(SAMPLE_RATE / 350)
    max_lag = int(SAMPLE_RATE / 70)
    for frame in voiced_frames[:: max(1, len(voiced_frames) // 250)]:
        x = frame - np.mean(frame)
        energy = float(np.dot(x, x))
        if energy <= 1e-7:
            continue
        corr = np.correlate(x, x, mode="full")[len(x) - 1 :]
        window = corr[min_lag:max_lag]
        if window.size == 0:
            continue
        lag = int(np.argmax(window)) + min_lag
        strength = float(corr[lag] / (energy + 1e-9))
        if strength < 0.25:
            continue
        values.append(SAMPLE_RATE / lag)
    if not values:
        return [0.0, 0.0, 0.0]
    arr = np.asarray(values, dtype=np.float32)
    return [round(float(np.median(arr)), 4), round(float(np.percentile(arr, 25)), 4), round(float(np.percentile(arr, 75)), 4)]


def embed(samples: np.ndarray) -> dict:
    duration = samples.size / SAMPLE_RATE
    if samples.size > 1:
        samples = np.append(samples[0], samples[1:] - 0.97 * samples[:-1]).astype(np.float32)
    frames = frame_audio(samples)
    mask, quality = voiced_mask(frames)
    voiced = frames[mask]

    n_fft = 512
    if voiced.size:
        spec = np.abs(np.fft.rfft(voiced, n=n_fft, axis=1)) ** 2
        fb = mel_filterbank(n_fft=n_fft)
        log_mel = np.log(np.maximum(spec @ fb.T, 1e-10))
        mfcc = log_mel @ dct_matrix().T
        # Per-clip cepstral normalization reduces channel/volume effects.
        mfcc_norm = mfcc.copy()
        if mfcc_norm.shape[0] > 1:
            mfcc_norm[:, 1:] = (mfcc_norm[:, 1:] - np.mean(mfcc_norm[:, 1:], axis=0)) / (np.std(mfcc_norm[:, 1:], axis=0) + 1e-6)
        mfcc_stats = quantile_stats(mfcc_norm[:, 1:20])
        energy_stats = quantile_stats(np.log(np.maximum(np.mean(voiced * voiced, axis=1, keepdims=True), 1e-12)))
        zcr_stats = quantile_stats(np.mean(voiced[:, 1:] * voiced[:, :-1] < 0, axis=1, keepdims=True))
    else:
        mfcc_stats = np.zeros((19 * 7,), dtype=np.float32)
        energy_stats = np.zeros((7,), dtype=np.float32)
        zcr_stats = np.zeros((7,), dtype=np.float32)

    pitch = np.asarray(estimate_pitch_stats(voiced), dtype=np.float32)
    vector = np.concatenate([mfcc_stats, energy_stats, zcr_stats, pitch]).astype(np.float32)
    norm = float(np.linalg.norm(vector))
    if norm > 0:
        vector = vector / norm
    quality.update(
        {
            "duration_seconds": round(float(duration), 3),
            "usable": bool(duration >= 6 and quality["voiced_frames"] >= 120 and quality["voiced_ratio"] >= 0.22),
        }
    )
    return {
        "schema": "life_archive_voice_embedding.v2",
        "model": "local_mfcc_speaker_embedding.v2",
        "sample_rate": SAMPLE_RATE,
        "dimensions": int(vector.size),
        "duration_seconds": round(float(duration), 3),
        "quality": quality,
        "vector": [round(float(v), 8) for v in vector],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", nargs="+")
    parser.add_argument("--jsonl", action="store_true")
    args = parser.parse_args()
    rows = []
    for item in args.audio:
        path = Path(item)
        try:
            row = {"path": str(path), "embedding": embed(decode_audio(path))}
        except Exception as exc:  # pragma: no cover - CLI diagnostics
            row = {"path": str(path), "error": str(exc)}
        if args.jsonl:
            print(json.dumps(row, separators=(",", ":")))
        else:
            rows.append(row)
    if not args.jsonl:
        print(json.dumps(rows[0] if len(rows) == 1 else rows, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
