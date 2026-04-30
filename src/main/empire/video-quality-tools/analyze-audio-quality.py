#!/usr/bin/env python3
"""
Video Audio Quality Analyzer
Evaluates: volume_levels, background_noise, pacing (dead air detection)
Uses ffmpeg/ffprobe for loudness measurement and silence detection.

Usage:
    python analyze-audio-quality.py <video_path>

Returns JSON with scores (0-100) and feedback for each criterion.
"""

import subprocess
import json
import sys
import os
import re


def run_ffprobe_audio(video_path):
    """Extract audio stream metadata."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        "-select_streams", "a:0",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        return streams[0] if streams else None, None
    except Exception as e:
        return None, str(e)


def measure_loudness(video_path):
    """Measure integrated loudness using ffmpeg loudnorm filter (2-pass measurement)."""
    cmd = [
        "ffmpeg",
        "-i", video_path,
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
        "-f", "null",
        "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        # loudnorm outputs JSON in stderr
        stderr = result.stderr

        # Find the JSON block in stderr
        json_match = re.search(r'\{[^{}]*"input_i"[^{}]*\}', stderr, re.DOTALL)
        if json_match:
            loudness_data = json.loads(json_match.group())
            return loudness_data, None

        return None, "Could not parse loudnorm output"
    except Exception as e:
        return None, str(e)


def detect_silence(video_path, noise_threshold_db=-40, min_duration=1.0):
    """Detect silence periods in audio using ffmpeg silencedetect."""
    cmd = [
        "ffmpeg",
        "-i", video_path,
        "-af", f"silencedetect=noise={noise_threshold_db}dB:d={min_duration}",
        "-f", "null",
        "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        stderr = result.stderr

        silence_periods = []
        starts = re.findall(r"silence_start: ([\d.]+)", stderr)
        ends = re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", stderr)

        for i, start in enumerate(starts):
            period = {"start": float(start)}
            if i < len(ends):
                period["end"] = float(ends[i][0])
                period["duration"] = float(ends[i][1])
            silence_periods.append(period)

        return silence_periods, None
    except Exception as e:
        return [], str(e)


def get_duration(video_path):
    """Get total duration of the video."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-show_entries", "format=duration",
        "-print_format", "json",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        return float(data.get("format", {}).get("duration", 0)), None
    except Exception as e:
        return 0, str(e)


def measure_noise_floor(video_path):
    """Estimate noise floor using astats filter on a quiet segment."""
    cmd = [
        "ffmpeg",
        "-i", video_path,
        "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null",
        "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        stderr = result.stderr

        # Extract RMS levels
        rms_values = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", stderr)
        if rms_values:
            rms_floats = [float(v) for v in rms_values if float(v) > -100]
            if rms_floats:
                # Sort and take bottom 10% as noise floor estimate
                rms_floats.sort()
                floor_count = max(1, len(rms_floats) // 10)
                noise_floor = sum(rms_floats[:floor_count]) / floor_count
                avg_rms = sum(rms_floats) / len(rms_floats)
                return {"noise_floor_db": round(noise_floor, 1), "avg_rms_db": round(avg_rms, 1)}, None

        return None, "Could not extract RMS values"
    except Exception as e:
        return None, str(e)


def score_volume_levels(loudness_data):
    """Score volume against broadcast standard (I=-16 LUFS)."""
    if not loudness_data:
        return {"score": 0, "feedback": "Could not measure loudness", "raw": {}}

    input_i = float(loudness_data.get("input_i", -99))
    input_tp = float(loudness_data.get("input_tp", 0))
    input_lra = float(loudness_data.get("input_lra", 0))

    score = 100
    notes = []

    # Integrated loudness (target: -16 LUFS)
    loudness_diff = abs(input_i - (-16))
    if loudness_diff <= 1:
        notes.append(f"Loudness: {input_i:.1f} LUFS (excellent, target -16)")
    elif loudness_diff <= 3:
        score -= 15
        notes.append(f"Loudness: {input_i:.1f} LUFS (acceptable, target -16)")
    elif loudness_diff <= 6:
        score -= 35
        notes.append(f"Loudness: {input_i:.1f} LUFS (needs normalization to -16)")
    else:
        score -= 55
        notes.append(f"Loudness: {input_i:.1f} LUFS (significantly off target -16)")

    # True peak (target: <= -1.5 dBTP)
    if input_tp <= -1.5:
        notes.append(f"True peak: {input_tp:.1f} dBTP (good)")
    elif input_tp <= 0:
        score -= 10
        notes.append(f"True peak: {input_tp:.1f} dBTP (slightly hot, target <= -1.5)")
    else:
        score -= 25
        notes.append(f"True peak: {input_tp:.1f} dBTP (clipping! target <= -1.5)")

    # Loudness range (target: ~11 LU)
    if 6 <= input_lra <= 15:
        notes.append(f"Loudness range: {input_lra:.1f} LU (good dynamic range)")
    elif input_lra < 6:
        score -= 10
        notes.append(f"Loudness range: {input_lra:.1f} LU (overly compressed)")
    else:
        score -= 10
        notes.append(f"Loudness range: {input_lra:.1f} LU (too dynamic, needs compression)")

    return {
        "score": max(0, score),
        "feedback": "; ".join(notes),
        "raw": {
            "integrated_lufs": input_i,
            "true_peak_dbtp": input_tp,
            "loudness_range_lu": input_lra,
        },
    }


def score_background_noise(noise_data):
    """Score background noise levels."""
    if not noise_data:
        return {"score": 50, "feedback": "Could not measure noise floor", "raw": {}}

    noise_floor = noise_data["noise_floor_db"]
    avg_rms = noise_data["avg_rms_db"]
    snr = avg_rms - noise_floor  # signal-to-noise ratio estimate

    score = 100
    notes = []

    if noise_floor < -55:
        notes.append(f"Noise floor: {noise_floor:.1f} dB (excellent, very clean)")
    elif noise_floor < -45:
        score -= 10
        notes.append(f"Noise floor: {noise_floor:.1f} dB (good)")
    elif noise_floor < -35:
        score -= 30
        notes.append(f"Noise floor: {noise_floor:.1f} dB (noticeable background noise)")
    else:
        score -= 55
        notes.append(f"Noise floor: {noise_floor:.1f} dB (high noise, consider noise reduction)")

    if snr > 30:
        notes.append(f"SNR: ~{snr:.0f} dB (excellent)")
    elif snr > 20:
        score -= 10
        notes.append(f"SNR: ~{snr:.0f} dB (acceptable)")
    else:
        score -= 25
        notes.append(f"SNR: ~{snr:.0f} dB (poor, voice may be hard to hear)")

    return {
        "score": max(0, score),
        "feedback": "; ".join(notes),
        "raw": noise_data,
    }


def score_pacing(silence_periods, total_duration):
    """Score audio pacing based on dead air detection."""
    if total_duration <= 0:
        return {"score": 50, "feedback": "Could not determine duration", "raw": {}}

    total_silence = sum(p.get("duration", 0) for p in silence_periods)
    silence_ratio = total_silence / total_duration
    long_gaps = [p for p in silence_periods if p.get("duration", 0) > 3.0]

    score = 100
    notes = []

    # Silence ratio scoring
    if silence_ratio < 0.05:
        notes.append(f"Silence: {silence_ratio*100:.1f}% (tight pacing)")
    elif silence_ratio < 0.15:
        score -= 10
        notes.append(f"Silence: {silence_ratio*100:.1f}% (good pacing)")
    elif silence_ratio < 0.25:
        score -= 30
        notes.append(f"Silence: {silence_ratio*100:.1f}% (some dead air, tighten edits)")
    else:
        score -= 50
        notes.append(f"Silence: {silence_ratio*100:.1f}% (too much dead air)")

    # Long gap penalty
    if long_gaps:
        score -= min(30, len(long_gaps) * 10)
        gap_times = [f"{p['start']:.1f}s ({p.get('duration', 0):.1f}s)" for p in long_gaps[:5]]
        notes.append(f"Long gaps (>3s): {len(long_gaps)} at {', '.join(gap_times)}")
    else:
        notes.append("No long gaps detected (good)")

    return {
        "score": max(0, score),
        "feedback": "; ".join(notes),
        "raw": {
            "total_silence_s": round(total_silence, 1),
            "silence_ratio": round(silence_ratio, 3),
            "long_gap_count": len(long_gaps),
            "silence_periods_count": len(silence_periods),
        },
    }


def analyze(video_path):
    """Run full audio quality analysis."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    # Run all measurements
    loudness_data, loud_err = measure_loudness(video_path)
    silence_periods, silence_err = detect_silence(video_path)
    noise_data, noise_err = measure_noise_floor(video_path)
    total_duration, dur_err = get_duration(video_path)

    results = {
        "tool": "analyze-audio-quality",
        "version": "1.0.0",
        "video_path": video_path,
        "scores": {
            "volume_levels": score_volume_levels(loudness_data),
            "background_noise": score_background_noise(noise_data),
            "pacing": score_pacing(silence_periods, total_duration),
        },
    }

    if loud_err:
        results["warnings"] = results.get("warnings", [])
        results["warnings"].append(f"Loudness measurement: {loud_err}")

    # Overall score
    scores = [v["score"] for v in results["scores"].values()]
    results["overall_score"] = round(sum(scores) / len(scores), 1)

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-audio-quality.py <video_path>")
        sys.exit(1)

    result = analyze(sys.argv[1])
    print(json.dumps(result, indent=2))
