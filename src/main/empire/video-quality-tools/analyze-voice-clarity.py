#!/usr/bin/env python3
"""
Video Voice Clarity Analyzer
Evaluates voice quality using FFmpeg spectral analysis to determine:
  - Voice presence and frequency band energy (85-3000 Hz fundamental range)
  - Speech-to-noise ratio estimation
  - Voice consistency across the video
  - Spectral balance (muddy/thin/harsh detection)
  - Sibilance and harshness detection

Uses FFmpeg bandpass filters to isolate voice frequencies and compare
energy levels against noise floor to estimate clarity without ML models.

Usage:
    python analyze-voice-clarity.py <video_path>

Returns JSON with voice clarity scores and specific feedback.
"""

import subprocess
import json
import sys
import os
import re
import math


def get_video_duration(video_path):
    """Get video duration."""
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        return float(data.get("format", {}).get("duration", 0))
    except Exception:
        return 0


def measure_band_energy(video_path, low_freq, high_freq, label="band"):
    """Measure RMS energy in a specific frequency band using bandpass filter."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", f"bandpass=frequency={(low_freq + high_freq) / 2}:width_type=h:width={high_freq - low_freq},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rms_values = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr)
        values = [float(v) for v in rms_values if float(v) > -100]
        if values:
            avg = sum(values) / len(values)
            peak = max(values)
            variance = sum((v - avg) ** 2 for v in values) / len(values)
            std = variance ** 0.5
            return {"avg": avg, "peak": peak, "std": std, "samples": len(values)}
        return {"avg": -60, "peak": -60, "std": 0, "samples": 0}
    except Exception:
        return {"avg": -60, "peak": -60, "std": 0, "samples": 0}


def measure_overall_loudness(video_path):
    """Measure overall loudness stats."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "loudnorm=print_format=json",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        # Find the JSON block in stderr
        json_match = re.search(r'\{[^}]*"input_i"[^}]*\}', result.stderr, re.DOTALL)
        if json_match:
            return json.loads(json_match.group())
        return None
    except Exception:
        return None


def measure_segment_voice_energy(video_path, duration, segment_len=5.0):
    """Measure voice band energy per segment for consistency analysis."""
    segments = []
    num_segments = int(duration / segment_len)

    for i in range(min(num_segments, 24)):  # cap at 24 segments (2 min)
        start = i * segment_len
        cmd = [
            "ffmpeg", "-ss", str(start), "-t", str(segment_len),
            "-i", video_path,
            "-af", "bandpass=frequency=800:width_type=h:width=2400,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
            "-f", "null", "-",
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            rms_values = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr)
            values = [float(v) for v in rms_values if float(v) > -100]
            avg = sum(values) / len(values) if values else -60
            segments.append({"start": start, "avg_energy": round(avg, 1)})
        except Exception:
            segments.append({"start": start, "avg_energy": -60})

    return segments


def score_voice_clarity(voice_band, low_band, high_band, sibilance_band, loudness_stats, voice_segments, duration):
    """
    Score voice clarity based on spectral analysis.
    """
    score = 50
    notes = []

    # === 1. Voice Presence (is there actually voice?) ===
    voice_avg = voice_band["avg"]
    if voice_avg > -25:
        score += 15
        notes.append(f"Strong voice presence ({voice_avg:.0f} dB in voice band)")
    elif voice_avg > -35:
        score += 10
        notes.append(f"Adequate voice presence ({voice_avg:.0f} dB)")
    elif voice_avg > -45:
        score += 5
        notes.append(f"Weak voice presence ({voice_avg:.0f} dB) — mic may be too far")
    else:
        notes.append(f"Very low voice energy ({voice_avg:.0f} dB) — check mic setup and distance")

    # === 2. Speech-to-Noise Ratio ===
    # Compare voice band energy to sub-bass noise
    noise_floor = low_band["avg"]
    snr_estimate = voice_avg - noise_floor

    if snr_estimate > 20:
        score += 15
        notes.append(f"Excellent speech-to-noise ratio (~{snr_estimate:.0f} dB)")
    elif snr_estimate > 12:
        score += 10
        notes.append(f"Good speech-to-noise ratio (~{snr_estimate:.0f} dB)")
    elif snr_estimate > 6:
        score += 5
        notes.append(f"Moderate SNR (~{snr_estimate:.0f} dB) — some background noise present")
    else:
        notes.append(f"Poor SNR (~{snr_estimate:.0f} dB) — voice competes with background noise")

    # === 3. Spectral Balance ===
    # Muddiness: excessive low-mid energy vs voice clarity
    low_mid_avg = low_band["avg"]
    voice_to_lowmid = voice_avg - low_mid_avg

    if voice_to_lowmid < -5:
        notes.append("Audio sounds muddy — too much low-frequency energy, apply highpass at 80-120 Hz")
    elif voice_to_lowmid > 15:
        notes.append("Audio may sound thin — very little low-end warmth")
    else:
        score += 5
        notes.append("Good spectral balance between low-end and voice frequencies")

    # === 4. Sibilance/Harshness Check ===
    sib_avg = sibilance_band["avg"]
    sib_to_voice = sib_avg - voice_avg

    if sib_to_voice > 5:
        notes.append("Sibilance detected (harsh 's' and 'sh' sounds) — consider a de-esser or EQ cut at 5-8 kHz")
    elif sib_to_voice > 0:
        notes.append("Slight sibilance — minor harshness in high frequencies")
    else:
        score += 5
        notes.append("No sibilance issues — clean high frequencies")

    # === 5. Voice Consistency ===
    if voice_segments and len(voice_segments) >= 3:
        energies = [s["avg_energy"] for s in voice_segments]
        non_silent = [e for e in energies if e > -50]

        if non_silent:
            avg_e = sum(non_silent) / len(non_silent)
            variance = sum((e - avg_e) ** 2 for e in non_silent) / len(non_silent)
            std_e = variance ** 0.5

            if std_e < 4:
                score += 10
                notes.append(f"Very consistent voice level (std: {std_e:.1f} dB)")
            elif std_e < 8:
                score += 5
                notes.append(f"Moderately consistent voice level (std: {std_e:.1f} dB)")
            else:
                notes.append(f"Inconsistent voice level (std: {std_e:.1f} dB) — normalize audio or maintain mic distance")

            # Check for sudden drops (might indicate turning away from mic)
            drops = []
            for i in range(1, len(non_silent)):
                if non_silent[i] < non_silent[i - 1] - 10:
                    drops.append(voice_segments[i]["start"])
            if drops:
                times = [f"{d:.0f}s" for d in drops[:3]]
                notes.append(f"Voice level drops at {', '.join(times)} — possible mic positioning issue")

    # === 6. Loudness Standards ===
    if loudness_stats:
        try:
            input_i = float(loudness_stats.get("input_i", "-24"))
            input_tp = float(loudness_stats.get("input_tp", "0"))

            if -18 <= input_i <= -14:
                score += 5
                notes.append(f"Loudness at {input_i:.1f} LUFS (within broadcast standard)")
            elif -20 <= input_i <= -12:
                notes.append(f"Loudness at {input_i:.1f} LUFS (slightly off target -16 LUFS)")
            else:
                notes.append(f"Loudness at {input_i:.1f} LUFS (far from -16 LUFS target — normalize audio)")

            if input_tp > -1.0:
                notes.append(f"True peak at {input_tp:.1f} dBTP — clipping risk, reduce gain")
        except (ValueError, TypeError):
            pass

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes),
        "raw": {
            "voice_band_avg_db": round(voice_avg, 1),
            "noise_floor_db": round(noise_floor, 1),
            "snr_estimate_db": round(snr_estimate, 1),
            "sibilance_ratio_db": round(sib_to_voice, 1),
        },
    }


def analyze(video_path):
    """Run voice clarity analysis."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    duration = get_video_duration(video_path)
    if duration <= 0:
        return {"error": "Could not determine video duration"}

    # Measure energy in key frequency bands
    # Sub-bass/noise floor: 20-150 Hz (room noise, HVAC, rumble)
    low_band = measure_band_energy(video_path, 20, 150, "low_noise")
    # Voice fundamental: 85-3000 Hz (main voice intelligibility range)
    voice_band = measure_band_energy(video_path, 85, 3000, "voice")
    # Presence/air: 3000-6000 Hz (voice clarity and presence)
    high_band = measure_band_energy(video_path, 3000, 6000, "presence")
    # Sibilance: 5000-10000 Hz (harsh 's' and 'sh' sounds)
    sibilance_band = measure_band_energy(video_path, 5000, 10000, "sibilance")

    # Overall loudness
    loudness_stats = measure_overall_loudness(video_path)

    # Voice consistency over time
    voice_segments = measure_segment_voice_energy(video_path, duration)

    # Score
    clarity_score = score_voice_clarity(
        voice_band, low_band, high_band, sibilance_band,
        loudness_stats, voice_segments, duration
    )

    result = {
        "tool": "analyze-voice-clarity",
        "version": "1.0.0",
        "video_path": video_path,
        "duration_s": round(duration, 1),
        "scores": {
            "voice_clarity": clarity_score,
        },
        "overall_score": clarity_score["score"],
        "frequency_bands": {
            "noise_floor_20_150Hz": round(low_band["avg"], 1),
            "voice_85_3000Hz": round(voice_band["avg"], 1),
            "presence_3k_6kHz": round(high_band["avg"], 1),
            "sibilance_5k_10kHz": round(sibilance_band["avg"], 1),
        },
        "voice_segments": voice_segments[:12],  # subsample for output
        "warnings": [],
    }

    if voice_band["samples"] == 0:
        result["warnings"].append("No audio data detected — file may not have an audio track")

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-voice-clarity.py <video_path>")
        sys.exit(1)

    video_path = sys.argv[1]
    result = analyze(video_path)
    print(json.dumps(result, indent=2))
