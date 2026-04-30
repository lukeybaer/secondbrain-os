#!/usr/bin/env python3
"""
Audio Dynamics Analyzer
Measures dynamic range, clipping, and mastering quality.

Technique:
  - Use ffmpeg's `volumedetect` filter to get peak and mean dBFS values
  - Use ffmpeg's `astats` filter for RMS, peak, dynamic range stats
  - Compute dynamic range ratio (peak_dBFS - mean_dBFS) as a proxy for DR score
  - Detect clipping: samples at or near 0 dBFS
  - Detect over-compression: DR < 6 dB indicates heavily "brickwalled" audio
  - Detect under-normalized audio: mean dBFS below -30 indicates too quiet
  - Check for clipping artifacts using peak sample detection

Research basis:
  Loudness War studies (Vickers 2010, Deruty 2014) show DR8+ correlates with
  higher listener fatigue resistance. YouTube's loudness normalization (-14 LUFS)
  means over-compressed audio (DR < 6) sounds worse after normalization than
  well-mastered audio. Streaming platform best practices recommend DR 8-12 for
  spoken-word content. Clipping artifacts are flagged by all major platforms.

Usage:
    python analyze-audio-dynamics.py <video_path>

Returns JSON with score (0-100) and mastering quality feedback.
"""

import subprocess
import json
import sys
import os
import re
import math

TOOLS_VERSION = "1.0.0"


def run_volumedetect(video_path):
    """Run ffmpeg volumedetect filter and parse output."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "volumedetect",
        "-vn", "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        output = r.stderr
        mean_volume = None
        max_volume = None
        m = re.search(r"mean_volume:\s*([-\d.]+)\s*dB", output)
        if m:
            mean_volume = float(m.group(1))
        m = re.search(r"max_volume:\s*([-\d.]+)\s*dB", output)
        if m:
            max_volume = float(m.group(1))
        return mean_volume, max_volume
    except Exception:
        return None, None


def run_astats(video_path):
    """Run ffmpeg astats filter and parse RMS, peak, dynamic range."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "astats=metadata=1:reset=1",
        "-vn", "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        output = r.stderr
        rms_level = None
        peak_level = None
        dynamic_range = None
        flat_factor = None

        m = re.search(r"RMS level dB:\s*([-\d.]+)", output)
        if m:
            rms_level = float(m.group(1))
        m = re.search(r"Peak level dB:\s*([-\d.]+)", output)
        if m:
            peak_level = float(m.group(1))
        m = re.search(r"Dynamic range:\s*([\d.]+)", output)
        if m:
            dynamic_range = float(m.group(1))
        m = re.search(r"Flat factor:\s*([\d.]+)", output)
        if m:
            flat_factor = float(m.group(1))

        return rms_level, peak_level, dynamic_range, flat_factor
    except Exception:
        return None, None, None, None


def run_loudnorm_scan(video_path):
    """Run ffmpeg loudnorm filter to get integrated LUFS."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "loudnorm=print_format=json",
        "-vn", "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        # loudnorm outputs JSON at the end of stderr
        output = r.stderr
        m = re.search(r'\{[^}]+\}', output, re.DOTALL)
        if m:
            data = json.loads(m.group(0))
            return data
        return {}
    except Exception:
        return {}


def analyze(video_path):
    result = {
        "tool": "analyze-audio-dynamics",
        "version": TOOLS_VERSION,
        "scores": {},
        "warnings": [],
    }

    if not os.path.exists(video_path):
        result["warnings"].append(f"File not found: {video_path}")
        result["overall_score"] = 0
        return result

    mean_vol, max_vol = run_volumedetect(video_path)
    rms_level, peak_level, dynamic_range, flat_factor = run_astats(video_path)
    loudnorm_data = run_loudnorm_scan(video_path)

    # Extract integrated LUFS from loudnorm
    integrated_lufs = None
    true_peak = None
    try:
        integrated_lufs = float(loudnorm_data.get("input_i", 0) or 0)
        true_peak = float(loudnorm_data.get("input_tp", -96) or -96)
    except (TypeError, ValueError):
        pass

    score = 70  # neutral baseline
    issues = []
    strengths = []

    # -- Clipping detection --
    # true peak >= -0.5 dBTP is clipping territory on most platforms
    if true_peak is not None:
        if true_peak >= -0.5:
            score -= 25
            issues.append(f"Audio clipping detected (true peak={true_peak:.1f} dBTP). Hard limit to -1.0 dBTP before export.")
        elif true_peak >= -1.0:
            score -= 10
            issues.append(f"Audio near clipping (true peak={true_peak:.1f} dBTP). Target -1.0 dBTP headroom.")
        elif true_peak < -6.0:
            score -= 5
            issues.append(f"True peak too low ({true_peak:.1f} dBTP). Maximize loudness without clipping.")
        else:
            strengths.append(f"Good headroom (true peak={true_peak:.1f} dBTP).")
    elif max_vol is not None:
        if max_vol >= -0.5:
            score -= 20
            issues.append(f"Peak near 0 dBFS ({max_vol:.1f}). Possible clipping.")

    # -- Dynamic range score --
    # DR target for spoken-word content: 8-18 dB
    if dynamic_range is not None:
        if dynamic_range < 4:
            score -= 20
            issues.append(f"Severely over-compressed (DR={dynamic_range:.1f} dB). Audio will sound flat and fatiguing after platform normalization.")
        elif dynamic_range < 8:
            score -= 10
            issues.append(f"Over-compressed audio (DR={dynamic_range:.1f} dB). Aim for DR 8-12 for spoken content.")
        elif dynamic_range > 30:
            score -= 5
            issues.append(f"Very wide dynamic range (DR={dynamic_range:.1f} dB). Quiet sections may be inaudible on mobile.")
        else:
            strengths.append(f"Good dynamic range (DR={dynamic_range:.1f} dB).")
    elif mean_vol is not None and max_vol is not None:
        dr_proxy = max_vol - mean_vol
        if dr_proxy < 6:
            score -= 10
            issues.append(f"Audio appears over-compressed (peak-mean gap={dr_proxy:.1f} dB).")

    # -- Loudness normalization target (YouTube: -14 LUFS, Shorts: -14 LUFS) --
    if integrated_lufs is not None and integrated_lufs != 0:
        if integrated_lufs > -10:
            score -= 10
            issues.append(f"Audio too loud ({integrated_lufs:.1f} LUFS). YouTube will turn it down to -14 LUFS, potentially causing distortion.")
        elif integrated_lufs < -23:
            score -= 10
            issues.append(f"Audio too quiet ({integrated_lufs:.1f} LUFS). Target -14 LUFS for YouTube.")
        elif -16 <= integrated_lufs <= -12:
            score += 5
            strengths.append(f"Loudness near YouTube target ({integrated_lufs:.1f} LUFS).")

    # -- Flat factor (silence/dead air indicator in astats) --
    if flat_factor is not None and flat_factor > 0.5:
        score -= 5
        issues.append(f"High flat factor ({flat_factor:.2f}) suggests extended silence or clipped sections.")

    score = max(0, min(100, score))

    # Build feedback
    if not issues and not strengths:
        if score >= 70:
            feedback = "Audio dynamics appear healthy. No major mastering issues detected."
        else:
            feedback = "Audio dynamics could not be fully evaluated. Verify levels manually."
    elif issues:
        feedback = " ".join(issues[:2])
        if strengths:
            feedback += " Strengths: " + strengths[0]
    else:
        feedback = " ".join(strengths[:2])

    result["scores"]["audio_dynamics"] = {
        "score": round(score, 1),
        "feedback": feedback,
        "raw": {
            "integrated_lufs": round(integrated_lufs, 2) if integrated_lufs is not None else None,
            "true_peak_dbtp": round(true_peak, 2) if true_peak is not None else None,
            "dynamic_range_db": round(dynamic_range, 2) if dynamic_range is not None else None,
            "rms_level_db": round(rms_level, 2) if rms_level is not None else None,
            "mean_volume_db": round(mean_vol, 2) if mean_vol is not None else None,
            "max_volume_db": round(max_vol, 2) if max_vol is not None else None,
            "flat_factor": round(flat_factor, 4) if flat_factor is not None else None,
            "issues": issues,
            "strengths": strengths,
        },
    }
    result["overall_score"] = round(score, 1)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-audio-dynamics.py <video_path>")
        sys.exit(1)

    result = analyze(sys.argv[1])
    print(json.dumps(result, indent=2))
