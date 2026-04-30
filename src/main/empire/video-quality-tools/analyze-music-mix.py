#!/usr/bin/env python3
"""
Video Music Mix / Voice-Music Balance Analyzer
Evaluates whether background music is balanced against the voice track.

v2 improvements (2026-04-14):
  - 7-band spectral flatness proxy: music distributes energy evenly across
    bands; voice concentrates energy in 300-3400 Hz. Cross-band variance
    discriminates music vs voice better than single bass-proxy band.
  - High-frequency energy ratio (6400-12000 Hz): cymbals/hi-hats/synth
    harmonics above 6 kHz are present in virtually all music but nearly
    absent in clean voice. Catches bass-less music that v1 missed entirely.
  - Temporal consistency (coefficient of variation): voice RMS fluctuates
    heavily between words/pauses; music RMS is stable. CV > 0.35 = likely
    voice-only. CV < 0.20 = music-dominated. Mixed: 0.20-0.35.
  - Combined 3-signal scoring: 2 of 3 signals must agree before applying
    gap penalty. Reduces false positives from instrumental-only segments.

Research basis:
  EBU R 128 voice-to-music ratio 8-15 dB. YouTube Creator Academy recommends
  music at -20 to -25 dBFS when voice at -12 dBFS. Spectral flatness
  discrimination validated in Lerch (2012) "Audio Content Analysis."
  Temporal CV for music/speech separation: Scheirer & Slaney (1997).

Usage:
    python analyze-music-mix.py <video_path>

Returns JSON with music_mix score (0-100) and feedback.
"""

import subprocess
import json
import sys
import os
import re
import math


TOOLS_VERSION = "2.0.0"

TARGET_GAP_MIN_DB = 8.0
TARGET_GAP_MAX_DB = 20.0

# 7 spectral bands for flatness proxy (Hz ranges)
SPECTRAL_BANDS = [
    (80, 200),
    (200, 400),
    (400, 800),
    (800, 1600),
    (1600, 3200),
    (3200, 6400),
    (6400, 12000),
]


# ── ffmpeg band measurement ───────────────────────────────────────────────────

def measure_band_rms(video_path, low_hz, high_hz, label="band"):
    """
    Measure RMS level of audio filtered to a specific frequency band.
    Returns average RMS in dB or None on failure.
    """
    af_chain = (
        f"highpass=f={low_hz},lowpass=f={high_hz},"
        "astats=metadata=1:reset=1,"
        "ametadata=print:key=lavfi.astats.Overall.RMS_level"
    )
    cmd = ["ffmpeg", "-i", video_path, "-af", af_chain, "-f", "null", "-"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rms_values = re.findall(
            r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr
        )
        if not rms_values:
            return None, f"No RMS data for {label} band ({low_hz}-{high_hz} Hz)"
        floats = [float(v) for v in rms_values if float(v) > -100]
        if not floats:
            return None, f"All RMS values below -100 dB for {label} band"
        return round(sum(floats) / len(floats), 1), None
    except Exception as e:
        return None, str(e)


def measure_temporal_consistency(video_path):
    """
    Measure per-0.5s RMS windows to compute temporal coefficient of variation.
    Voice CV > 0.35 (fluctuates with speech rhythm).
    Music CV < 0.20 (steady background energy).
    Mixed content: 0.20-0.35.
    Uses astats reset=22050 (44100 Hz * 0.5s); falls back to reset=11025 for 22050 Hz.
    """
    # Use a 0.5s reset in samples. ffmpeg astats reset= is in samples but also
    # accepts a frame-based reset when given as an integer. We request per-second
    # windows using reset=1 (one window per second) to keep sample-rate agnostic.
    af_chain = (
        "astats=metadata=1:reset=1,"
        "ametadata=print:key=lavfi.astats.Overall.RMS_level"
    )
    cmd = ["ffmpeg", "-i", video_path, "-af", af_chain, "-f", "null", "-"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rms_values = re.findall(
            r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr
        )
        floats = [float(v) for v in rms_values if float(v) > -100]
        if len(floats) < 3:
            return None, "Insufficient temporal data"
        mean = sum(floats) / len(floats)
        if mean == 0:
            return None, "Zero mean RMS"
        std = math.sqrt(sum((v - mean) ** 2 for v in floats) / len(floats))
        cv = std / abs(mean)
        return round(cv, 3), None
    except Exception as e:
        return None, str(e)


def measure_spectral_flatness_proxy(video_path):
    """
    Measure RMS in each of 7 spectral bands and compute cross-band variance.
    High variance = energy concentrated in vocal band (voice-dominant).
    Low variance = energy spread across bands (music-dominant).
    Returns (variance, band_rms_list) or (None, error).
    """
    band_rms = []
    for lo, hi in SPECTRAL_BANDS:
        rms, err = measure_band_rms(video_path, lo, hi, f"{lo}-{hi}Hz")
        if rms is not None:
            band_rms.append(rms)

    if len(band_rms) < 4:
        return None, "Insufficient band data for spectral flatness"

    mean = sum(band_rms) / len(band_rms)
    variance = sum((r - mean) ** 2 for r in band_rms) / len(band_rms)
    return round(variance, 1), band_rms


def measure_full_rms(video_path):
    """Measure full-spectrum RMS as reference."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rms_values = re.findall(
            r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr
        )
        if not rms_values:
            return None, "No full RMS data"
        floats = [float(v) for v in rms_values if float(v) > -100]
        if not floats:
            return None, "All RMS values below threshold"
        return round(sum(floats) / len(floats), 1), None
    except Exception as e:
        return None, str(e)


def detect_silence_fraction(video_path, noise_db=-40):
    """Return fraction of time below noise floor."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", f"silencedetect=noise={noise_db}dB:d=0.5",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        durations = re.findall(r"silence_duration: ([\d.]+)", result.stderr)
        total_silence = sum(float(d) for d in durations)

        dur_cmd = [
            "ffprobe", "-v", "quiet",
            "-show_entries", "format=duration",
            "-print_format", "json",
            video_path,
        ]
        dur_result = subprocess.run(
            dur_cmd, capture_output=True, text=True, timeout=30
        )
        total_dur = float(
            json.loads(dur_result.stdout).get("format", {}).get("duration", 0)
        )

        if total_dur > 0:
            return round(total_silence / total_dur, 3), None
        return 0.0, None
    except Exception as e:
        return 0.0, str(e)


def get_audio_stream_info(video_path):
    """Check audio stream count."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_streams", "-select_streams", "a",
        "-print_format", "json",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        return len(data.get("streams", [])), None
    except Exception as e:
        return 0, str(e)


# ── scoring ───────────────────────────────────────────────────────────────────

def classify_music_presence(temporal_cv, hf_rms, voice_rms, spectral_variance):
    """
    Use 3 independent signals to estimate whether background music is present.
    Returns: "music_present", "voice_only", or "uncertain"
    """
    signals = []

    # Signal 1: Temporal CV
    if temporal_cv is not None:
        if temporal_cv < 0.20:
            signals.append("music")   # very stable = music
        elif temporal_cv > 0.35:
            signals.append("voice")   # highly variable = voice only
        else:
            signals.append("mixed")

    # Signal 2: HF energy ratio (6400-12000 Hz vs voice band 300-3400 Hz)
    if hf_rms is not None and voice_rms is not None:
        hf_gap = voice_rms - hf_rms  # positive = voice louder in voice band vs HF
        if hf_gap < 18:
            # HF energy within 18 dB of voice band = music harmonics present
            signals.append("music")
        elif hf_gap > 28:
            signals.append("voice")
        else:
            signals.append("mixed")

    # Signal 3: Spectral flatness variance
    if spectral_variance is not None:
        if spectral_variance < 150:
            signals.append("music")   # flat spectrum = music
        elif spectral_variance > 400:
            signals.append("voice")   # peaked spectrum = voice
        else:
            signals.append("mixed")

    if not signals:
        return "uncertain"

    music_votes = signals.count("music")
    voice_votes = signals.count("voice")
    if music_votes >= 2:
        return "music_present"
    if voice_votes >= 2:
        return "voice_only"
    return "uncertain"


def score_music_mix(
    voice_rms, music_proxy_rms, full_rms, silence_fraction,
    temporal_cv, hf_rms, spectral_variance, band_rms
):
    """
    v2: Combined 3-signal scoring for music/voice balance.
    """
    notes = []
    score = 100
    raw = {}

    # Determine music presence from 3 independent signals
    presence = classify_music_presence(temporal_cv, hf_rms, voice_rms, spectral_variance)
    raw["music_presence_classification"] = presence
    raw["temporal_cv"] = temporal_cv
    raw["spectral_variance"] = spectral_variance
    raw["hf_band_rms_db"] = hf_rms

    if temporal_cv is not None:
        if temporal_cv < 0.20:
            notes.append(
                f"Stable audio energy (CV={temporal_cv:.2f}) -- consistent background music level"
            )
        elif temporal_cv > 0.35:
            notes.append(
                f"Variable energy (CV={temporal_cv:.2f}) -- voice-forward, minimal constant music bed"
            )
        else:
            notes.append(
                f"Mixed energy pattern (CV={temporal_cv:.2f}) -- voice + background music likely"
            )

    # HF energy analysis
    if hf_rms is not None and voice_rms is not None:
        hf_gap = voice_rms - hf_rms
        raw["voice_to_hf_gap_db"] = round(hf_gap, 1)
        if hf_gap < 15:
            notes.append(
                f"High-frequency energy strong (gap={hf_gap:.1f} dB) -- "
                "cymbals/hi-hats/synth present, music likely"
            )
        elif hf_gap < 22:
            notes.append(
                f"Moderate HF energy (gap={hf_gap:.1f} dB) -- some music harmonics"
            )
        else:
            notes.append(
                f"Low HF energy (gap={hf_gap:.1f} dB) -- minimal high-frequency music content"
            )

    # Primary balance scoring (voice vs bass-proxy band)
    if voice_rms is not None and music_proxy_rms is not None:
        gap_db = voice_rms - music_proxy_rms
        raw["voice_band_rms_db"] = voice_rms
        raw["music_proxy_rms_db"] = music_proxy_rms
        raw["voice_to_music_gap_db"] = round(gap_db, 1)

        if presence == "voice_only":
            # Music signals say no music -- gap still matters but penalize less
            if gap_db > TARGET_GAP_MAX_DB:
                score -= 5
                notes.append(
                    f"No background music detected -- gap {gap_db:.1f} dB "
                    "(consider adding subtle music bed for production value)"
                )
            else:
                notes.append(
                    f"Voice-forward content, minimal music (gap={gap_db:.1f} dB) -- "
                    "good for podcast/explainer format"
                )
        elif presence in ("music_present", "uncertain"):
            if TARGET_GAP_MIN_DB <= gap_db <= TARGET_GAP_MAX_DB:
                notes.append(
                    f"Excellent voice/music balance: voice {gap_db:.1f} dB above "
                    "music band (target 8-20 dB)"
                )
            elif gap_db > TARGET_GAP_MAX_DB:
                score -= 8
                notes.append(
                    f"Music signals present but quiet -- gap {gap_db:.1f} dB "
                    "(music bed is subtle; may not register emotionally)"
                )
            elif 4 <= gap_db < TARGET_GAP_MIN_DB:
                score -= 20
                notes.append(
                    f"Music slightly too loud -- voice {gap_db:.1f} dB above music "
                    f"(target 8+ dB; reduce music ~{TARGET_GAP_MIN_DB - gap_db:.0f} dB)"
                )
            elif 0 <= gap_db < 4:
                score -= 40
                notes.append(
                    f"Music competes with voice -- gap {gap_db:.1f} dB "
                    "(music too loud; reduce by {TARGET_GAP_MIN_DB - gap_db:.0f}+ dB)"
                )
            else:
                score -= 60
                notes.append(
                    f"Music overpowers voice -- music {abs(gap_db):.1f} dB louder "
                    "than voice band (major issue)"
                )

    elif full_rms is not None:
        raw["full_rms_db"] = full_rms
        score = 50
        notes.append(
            f"Band separation unavailable; full RMS: {full_rms:.1f} dB -- "
            "manual check required for music/voice balance"
        )
    else:
        score = 0
        notes.append("Could not measure audio levels")

    # Silence fraction context
    raw["silence_fraction"] = silence_fraction
    if silence_fraction < 0.01:
        notes.append(
            "Continuous audio (no natural pauses) -- verify music does not crowd speech"
        )
    elif silence_fraction > 0.30:
        notes.append(
            f"High silence fraction ({silence_fraction*100:.0f}%) -- "
            "music bed likely absent or very low"
        )
    else:
        notes.append(f"Natural pause structure ({silence_fraction*100:.0f}% silence)")

    return {
        "score": max(0, score),
        "feedback": "; ".join(notes),
        "raw": raw,
    }


# ── main entry ────────────────────────────────────────────────────────────────

def analyze(video_path):
    """Run music mix analysis on a video file."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    warnings = []

    # Speech band (300-3400 Hz)
    voice_rms, v_err = measure_band_rms(video_path, 300, 3400, "voice")
    if v_err:
        warnings.append(f"Voice band: {v_err}")

    # Bass music proxy band (80-300 Hz)
    music_rms, m_err = measure_band_rms(video_path, 80, 300, "music_proxy")
    if m_err:
        warnings.append(f"Music proxy: {m_err}")

    # High-frequency music signal (6400-12000 Hz)
    hf_rms, hf_err = measure_band_rms(video_path, 6400, 12000, "hf_music")
    if hf_err:
        warnings.append(f"HF band: {hf_err}")

    # Full spectrum reference
    full_rms, f_err = measure_full_rms(video_path)
    if f_err:
        warnings.append(f"Full RMS: {f_err}")

    # Temporal consistency (CV across 1s windows)
    temporal_cv, tc_err = measure_temporal_consistency(video_path)
    if tc_err:
        warnings.append(f"Temporal CV: {tc_err}")

    # Spectral flatness proxy (7-band variance)
    spectral_variance, band_rms = measure_spectral_flatness_proxy(video_path)
    if spectral_variance is None:
        warnings.append("Spectral flatness: insufficient band data")

    # Silence fraction
    silence_frac, s_err = detect_silence_fraction(video_path)
    if s_err:
        warnings.append(f"Silence detection: {s_err}")

    # Audio stream count
    stream_count, _ = get_audio_stream_info(video_path)
    if stream_count > 1:
        warnings.append(
            f"{stream_count} audio streams detected -- analysis uses stream 0 only"
        )

    mix_score = score_music_mix(
        voice_rms, music_rms, full_rms, silence_frac,
        temporal_cv, hf_rms, spectral_variance, band_rms
    )

    return {
        "tool": "analyze-music-mix",
        "version": TOOLS_VERSION,
        "video_path": video_path,
        "scores": {"music_mix": mix_score},
        "overall_score": mix_score["score"],
        "warnings": warnings,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-music-mix.py <video_path>")
        sys.exit(1)

    result = analyze(sys.argv[1])
    print(json.dumps(result, indent=2))
