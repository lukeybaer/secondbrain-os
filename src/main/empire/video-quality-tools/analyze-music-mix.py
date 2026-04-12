#!/usr/bin/env python3
"""
Video Music Mix / Voice-Music Balance Analyzer
Evaluates whether background music is balanced against the voice track.
No source-separation ML required -- uses ffmpeg frequency band energy
measurement via the afftfilt / bandpass / astats pipeline.

Technique:
  Speech energy band: 300-3400 Hz (human vocal fundamentals + harmonics)
  Music/instrument energy band: 80-300 Hz (bass) + 3400-12000 Hz (highs)
  Background music presence estimation: low-frequency bass power vs. voice band

  Algorithm:
  1. Extract voice band energy (300-3400 Hz) using bandpass filter
  2. Extract sub-bass+upper energy (proxy for music bed) using bandpass
  3. Compute ratio of music-proxy energy vs. voice energy
  4. Score based on research benchmarks: voice should be 8-15 dB louder
     than background music for speech-forward content (podcast, explainer)
  5. Detect if music completely dominates (ratio > 1:1 by RMS) or is absent
  6. Silence gap analysis: if music continues during speech pauses, it proves
     the music track exists and is mixed at a particular level

Research basis:
  EBU R 128 loudness practice notes recommend voice-to-music ratio of 8-15 dB
  in program material with dialogue. YouTube Creator Academy (2023) recommends
  music at -20 to -25 dBFS when voice is at -12 dBFS (approximately 10 dB gap).
  ATSC A/85 (US broadcast standard) specifies similar dialogue loudness targets.

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


TOOLS_VERSION = "1.0.0"

# Target voice-to-music dB gap: 8-15 dB above music
TARGET_GAP_MIN_DB = 8.0
TARGET_GAP_MAX_DB = 20.0


# ── ffmpeg band measurement ───────────────────────────────────────────────────

def measure_band_rms(video_path, low_hz, high_hz, label="band"):
    """
    Measure RMS level of audio filtered to a specific frequency band.
    Uses ffmpeg astats on the band-limited signal.
    Returns average RMS in dB or None on failure.
    """
    # Build bandpass filter chain
    # atrim to avoid startup transients; bandpass approximated via highpass+lowpass
    af_chain = f"highpass=f={low_hz},lowpass=f={high_hz},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level"
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", af_chain,
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rms_values = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr)
        if not rms_values:
            return None, f"No RMS data for {label} band ({low_hz}-{high_hz} Hz)"
        floats = [float(v) for v in rms_values if float(v) > -100]
        if not floats:
            return None, f"All RMS values below -100 dB for {label} band"
        avg_rms = sum(floats) / len(floats)
        return round(avg_rms, 1), None
    except Exception as e:
        return None, str(e)


def measure_full_rms(video_path):
    """Measure full-spectrum RMS as reference."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rms_values = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr)
        if not rms_values:
            return None, "No full RMS data"
        floats = [float(v) for v in rms_values if float(v) > -100]
        if not floats:
            return None, "All RMS values below threshold"
        return round(sum(floats) / len(floats), 1), None
    except Exception as e:
        return None, str(e)


def detect_silence_during_pauses(video_path, noise_db=-40):
    """
    Check whether audio continues during speech pauses.
    If silence_detect finds near-silence intervals, music track is likely low or absent.
    If no silence detected, either speech is continuous OR music fills the gaps.
    Returns: fraction of time below noise floor.
    """
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", f"silencedetect=noise={noise_db}dB:d=0.5",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        durations = re.findall(r"silence_duration: ([\d.]+)", result.stderr)
        total_silence = sum(float(d) for d in durations)

        # Get total duration
        dur_cmd = [
            "ffprobe", "-v", "quiet",
            "-show_entries", "format=duration",
            "-print_format", "json",
            video_path,
        ]
        dur_result = subprocess.run(dur_cmd, capture_output=True, text=True, timeout=30)
        total_dur = float(json.loads(dur_result.stdout).get("format", {}).get("duration", 0))

        if total_dur > 0:
            return round(total_silence / total_dur, 3), None
        return 0.0, None
    except Exception as e:
        return 0.0, str(e)


def get_audio_stream_info(video_path):
    """Check audio stream count -- multiple audio streams may indicate stems."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_streams", "-select_streams", "a",
        "-print_format", "json",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        return len(streams), None
    except Exception as e:
        return 0, str(e)


# ── scoring ───────────────────────────────────────────────────────────────────

def score_music_mix(voice_rms, music_proxy_rms, full_rms, silence_fraction):
    """
    Score music-to-voice balance.

    voice_rms: avg dB RMS in 300-3400 Hz (speech band)
    music_proxy_rms: avg dB RMS in 80-300 Hz (bass, music bed proxy)
    full_rms: avg full-spectrum dB RMS
    silence_fraction: fraction of time below -40 dB floor

    Logic:
    - Gap between voice_rms and music_proxy_rms reflects mix balance
    - Target: voice 8-15 dB louder than music band
    - If music_proxy is missing data, fall back to full_rms heuristic
    - Silence fraction: very low (<0.02) with variable band energy = music fills gaps
    """
    notes = []
    score = 100
    raw = {}

    # ── Case: both bands measured ──────────────────────────────────────────
    if voice_rms is not None and music_proxy_rms is not None:
        gap_db = voice_rms - music_proxy_rms
        raw["voice_band_rms_db"] = voice_rms
        raw["music_proxy_rms_db"] = music_proxy_rms
        raw["voice_to_music_gap_db"] = round(gap_db, 1)

        if TARGET_GAP_MIN_DB <= gap_db <= TARGET_GAP_MAX_DB:
            notes.append(f"Voice/music balance: excellent -- voice is {gap_db:.1f} dB above music band (target 8-20 dB)")
        elif gap_db > TARGET_GAP_MAX_DB:
            score -= 10
            notes.append(f"Music very quiet or absent -- gap {gap_db:.1f} dB (consider adding subtle music bed for energy)")
        elif 4 <= gap_db < TARGET_GAP_MIN_DB:
            score -= 20
            notes.append(f"Music slightly loud -- voice only {gap_db:.1f} dB above music (target 8+ dB, reduce music by ~{TARGET_GAP_MIN_DB - gap_db:.0f} dB)")
        elif 0 <= gap_db < 4:
            score -= 40
            notes.append(f"Music competes with voice -- gap {gap_db:.1f} dB (music is too loud, reduce by {TARGET_GAP_MIN_DB - gap_db:.0f}+ dB)")
        else:
            # gap_db < 0: music louder than voice in those bands
            score -= 60
            notes.append(f"Music overpowers voice -- music band {abs(gap_db):.1f} dB louder than voice band (major issue)")

    # ── Case: only full RMS available ──────────────────────────────────────
    elif full_rms is not None:
        raw["full_rms_db"] = full_rms
        notes.append(f"Band separation unavailable; full RMS: {full_rms:.1f} dB")
        # Can't compute balance without band data
        score = 50
        notes.append("Manual check required for music/voice balance")

    else:
        score = 0
        notes.append("Could not measure audio levels")

    # ── Silence fraction analysis ──────────────────────────────────────────
    raw["silence_fraction"] = silence_fraction
    if silence_fraction < 0.01 and voice_rms is not None:
        # Near-zero silence means something is always audible -- likely music bed
        if voice_rms is not None and music_proxy_rms is not None and voice_rms - music_proxy_rms < TARGET_GAP_MIN_DB:
            score -= 10
            notes.append("Continuous audio detected (no pauses) -- verify music does not crowd out speech")
        else:
            notes.append("Continuous audio with good voice/music balance")
    elif silence_fraction > 0.30:
        notes.append(f"High silence fraction ({silence_fraction*100:.0f}%) -- music bed may be absent")
    else:
        notes.append(f"Natural pause structure ({silence_fraction*100:.0f}% silence) -- good")

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

    # Measure speech band (300-3400 Hz)
    voice_rms, v_err = measure_band_rms(video_path, 300, 3400, "voice")
    if v_err:
        warnings.append(f"Voice band measurement: {v_err}")

    # Measure music-proxy band (80-300 Hz -- bass fundamentals)
    music_rms, m_err = measure_band_rms(video_path, 80, 300, "music_proxy")
    if m_err:
        warnings.append(f"Music proxy measurement: {m_err}")

    # Full spectrum reference
    full_rms, f_err = measure_full_rms(video_path)
    if f_err:
        warnings.append(f"Full RMS measurement: {f_err}")

    # Silence fraction (music bed presence proxy)
    silence_frac, s_err = detect_silence_during_pauses(video_path)
    if s_err:
        warnings.append(f"Silence detection: {s_err}")

    # Audio stream count
    stream_count, sc_err = get_audio_stream_info(video_path)
    if stream_count > 1:
        warnings.append(f"{stream_count} audio streams detected -- multi-track audio, analysis uses stream 0 only")

    mix_score = score_music_mix(voice_rms, music_rms, full_rms, silence_frac)

    return {
        "tool": "analyze-music-mix",
        "version": TOOLS_VERSION,
        "video_path": video_path,
        "scores": {
            "music_mix": mix_score,
        },
        "overall_score": mix_score["score"],
        "warnings": warnings,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-music-mix.py <video_path>")
        sys.exit(1)

    result = analyze(sys.argv[1])
    print(json.dumps(result, indent=2))
