#!/usr/bin/env python3
"""
Audio Dynamics Analyzer v2
EBU R128 short-term LUFS analysis for mastering quality assessment.

v2 upgrades over analyze-audio-dynamics.py v1:
  (1) EBU R128 short-term LUFS via ffmpeg ebur128 filter: collects M (momentary,
      400ms window) and S (short-term, 3s window) LUFS values throughout the video.
      Short-term LUFS stdev < 2 LU = over-compressed/brickwalled; > 12 LU = inconsistent
      mastering. ITU-R BS.1770-4 / EBU R128 (2014) is the industry standard, not the
      v1 single-pass volumedetect proxy.
  (2) Crest factor analysis (peak-to-RMS per second): measured via per-1s astats
      windows. Crest factor = peak_dB - rms_dB per window. Target: 8-16 dB for
      spoken-word content (Vickers 2010, Deruty 2014 "Loudness War" studies).
      Crest factor < 6 dB = brickwalled; > 22 dB = under-processed transients.
  (3) Temporal DR consistency: splits video into 4 quarters, measures DR per quarter
      via volumedetect (peak - mean). Variance across quarters > 8 dB = inconsistent
      mastering across edit -- common when inserting pre-mixed clips at different
      production levels.
  (4) Platform-specific LUFS targets: YouTube/Shorts = -14 LUFS (loudness normalization),
      LinkedIn = -16 LUFS (quieter professional context). Score penalizes off-target
      by distance, not just above/below.
  (5) Over-compression pattern: LRA + crest factor joint detection. LRA < 4 LU AND
      crest < 6 dB = brickwalled audio that will sound worse after YouTube
      normalization (Steinmetz & Reiss 2021 "pyloudnorm" research).

Research: EBU R128 (2014), ITU-R BS.1770-4, Vickers 2010, Deruty 2014,
          Steinmetz & Reiss 2021, YouTube/Spotify mastering best practices 2024.

Usage:
    python analyze-audio-dynamics-v2.py <video_path> [--platform youtube|shorts|linkedin]

Returns JSON with score (0-100) and mastering quality feedback.
"""

import subprocess
import json
import sys
import os
import re
import math
import statistics

TOOL_VERSION = "2.0.0"

# Platform loudness targets (integrated LUFS)
PLATFORM_TARGETS = {
    "youtube": -14.0,
    "shorts": -14.0,
    "linkedin": -16.0,
    "default": -14.0,
}


def get_duration(video_path):
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-print_format", "json",
        video_path,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(r.stdout)
        return float(data.get("format", {}).get("duration", 0))
    except Exception:
        return 0.0


def run_ebur128(video_path):
    """
    Run ffmpeg ebur128 filter to collect per-frame LUFS measurements.
    Returns (integrated_lufs, lra, true_peak, short_term_values, momentary_values).
    """
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "ebur128=peak=true:framelog=verbose",
        "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        output = r.stderr

        # Extract summary values
        integrated_lufs = None
        lra = None
        true_peak = None

        m = re.search(r"I:\s*([-\d.]+)\s*LUFS", output)
        if m:
            integrated_lufs = float(m.group(1))
        m = re.search(r"LRA:\s*([\d.]+)\s*LU", output)
        if m:
            lra = float(m.group(1))
        m = re.search(r"Peak:\s*([-\d.]+)\s*dBFS", output)
        if m:
            true_peak = float(m.group(1))
        if true_peak is None:
            m = re.search(r"True peak:\s*([-\d.]+)\s*dBFS", output)
            if m:
                true_peak = float(m.group(1))

        # Extract per-frame short-term and momentary values
        short_term = re.findall(r"S:\s*([-\d.]+)\s*LUFS", output)
        momentary = re.findall(r"M:\s*([-\d.]+)\s*LUFS", output)

        s_vals = [float(v) for v in short_term if float(v) > -90]
        m_vals = [float(v) for v in momentary if float(v) > -90]

        return integrated_lufs, lra, true_peak, s_vals, m_vals
    except Exception:
        return None, None, None, [], []


def run_astats_per_second(video_path):
    """
    Run astats per-second to collect (rms_level, peak_level) pairs for crest factor.
    Returns list of (rms_db, peak_db) tuples.
    """
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "astats=metadata=1:reset=1",
        "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        output = r.stderr
        # Find pairs of RMS level and Peak level per block
        # Each block prints both metrics
        rms_vals = re.findall(r"RMS level dB:\s*([-\d.]+)", output)
        peak_vals = re.findall(r"Peak level dB:\s*([-\d.]+)", output)
        pairs = []
        for i in range(min(len(rms_vals), len(peak_vals))):
            rms = float(rms_vals[i])
            peak = float(peak_vals[i])
            if rms > -90 and peak > -90:
                pairs.append((rms, peak))
        return pairs
    except Exception:
        return []


def run_volumedetect_segment(video_path, start_sec, dur_sec):
    """Run volumedetect on a segment, return (mean_dBFS, max_dBFS)."""
    cmd = [
        "ffmpeg",
        "-ss", str(start_sec), "-i", video_path,
        "-t", str(dur_sec),
        "-af", "volumedetect",
        "-vn", "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        output = r.stderr
        mean_vol = None
        max_vol = None
        m = re.search(r"mean_volume:\s*([-\d.]+)\s*dB", output)
        if m:
            mean_vol = float(m.group(1))
        m = re.search(r"max_volume:\s*([-\d.]+)\s*dB", output)
        if m:
            max_vol = float(m.group(1))
        return mean_vol, max_vol
    except Exception:
        return None, None


def compute_crest_factors(astats_pairs):
    """
    Compute crest factor (peak - rms) per second window.
    Returns list of crest values.
    """
    return [peak - rms for rms, peak in astats_pairs if peak > rms]


def analyze(video_path, platform=None):
    result = {
        "tool": "analyze-audio-dynamics-v2",
        "version": TOOL_VERSION,
        "scores": {},
        "warnings": [],
    }

    if not os.path.exists(video_path):
        result["warnings"].append(f"File not found: {video_path}")
        result["overall_score"] = 0
        return result

    duration = get_duration(video_path)
    target_lufs = PLATFORM_TARGETS.get(platform or "default", -14.0)

    # Run measurements
    integrated_lufs, lra, true_peak, s_vals, m_vals = run_ebur128(video_path)
    astats_pairs = run_astats_per_second(video_path)
    crest_factors = compute_crest_factors(astats_pairs)

    # Temporal DR: split into 4 quarters
    quarter_dr = []
    if duration >= 20:
        q_dur = duration / 4
        for i in range(4):
            mean_v, max_v = run_volumedetect_segment(video_path, i * q_dur, q_dur)
            if mean_v is not None and max_v is not None:
                quarter_dr.append(max_v - mean_v)

    score = 70  # neutral baseline
    issues = []
    strengths = []

    # ---- Check 1: True peak / clipping ----
    if true_peak is not None:
        if true_peak >= -0.5:
            score -= 22
            issues.append(f"Clipping detected (true peak={true_peak:.1f} dBFS). Hard-limit to -1.0 dBTP before export.")
        elif true_peak >= -1.0:
            score -= 8
            issues.append(f"Near clipping (true peak={true_peak:.1f} dBFS). Add 1 dB headroom.")
        elif true_peak < -6.0:
            score -= 4
            issues.append(f"True peak too low ({true_peak:.1f} dBFS). Maximize loudness without clipping.")
        else:
            strengths.append(f"Good headroom (true peak={true_peak:.1f} dBFS).")
    elif len(astats_pairs) > 0:
        # Fallback: use astats peak
        max_peak = max(p for _, p in astats_pairs)
        if max_peak >= -0.5:
            score -= 18
            issues.append(f"Peak near 0 dBFS ({max_peak:.1f}). Possible clipping.")

    # ---- Check 2: Integrated LUFS vs platform target ----
    if integrated_lufs is not None:
        diff = abs(integrated_lufs - target_lufs)
        if diff <= 1.5:
            score += 6
            strengths.append(f"Loudness on target ({integrated_lufs:.1f} LUFS, target {target_lufs:.0f}).")
        elif diff <= 4.0:
            score -= 5
            issues.append(f"Loudness {integrated_lufs:.1f} LUFS (target {target_lufs:.0f}, {diff:.1f} LU off).")
        else:
            score -= 14
            issues.append(f"Loudness significantly off target ({integrated_lufs:.1f} vs {target_lufs:.0f} LUFS). Platform will normalize, potentially causing audible artifacts.")

    # ---- Check 3: LRA (Loudness Range) ----
    if lra is not None:
        if lra < 3.0:
            score -= 18
            issues.append(f"Severely over-compressed (LRA={lra:.1f} LU). Audio will sound lifeless after platform normalization.")
        elif lra < 5.0:
            score -= 10
            issues.append(f"Over-compressed (LRA={lra:.1f} LU). Target 6-12 LU for speech content.")
        elif 6.0 <= lra <= 12.0:
            score += 5
            strengths.append(f"Good dynamic range (LRA={lra:.1f} LU).")
        elif lra > 18.0:
            score -= 6
            issues.append(f"Excessively wide LRA ({lra:.1f} LU). Quiet sections may be inaudible on mobile.")
        else:
            strengths.append(f"LRA: {lra:.1f} LU (acceptable).")

    # ---- Check 4: Short-term LUFS variance ----
    if len(s_vals) >= 5:
        try:
            s_stdev = statistics.stdev(s_vals)
            s_mean = statistics.mean(s_vals)
            if s_stdev < 1.5:
                score -= 10
                issues.append(f"Over-compressed short-term LUFS (stdev={s_stdev:.1f} LU) -- flat, fatiguing audio.")
            elif s_stdev > 14.0:
                score -= 6
                issues.append(f"Inconsistent short-term loudness (stdev={s_stdev:.1f} LU) -- mastering level varies widely.")
            else:
                strengths.append(f"Healthy short-term LUFS variation (stdev={s_stdev:.1f} LU).")
        except Exception:
            s_stdev = None
    else:
        s_stdev = None

    # ---- Check 5: Crest factor ----
    if len(crest_factors) >= 5:
        try:
            avg_crest = statistics.mean(crest_factors)
            if avg_crest < 5.0:
                score -= 12
                issues.append(f"Low crest factor ({avg_crest:.1f} dB) -- brickwalled audio, no transient headroom.")
            elif avg_crest < 8.0:
                score -= 5
                issues.append(f"Slightly compressed crest factor ({avg_crest:.1f} dB). Target 8-16 dB.")
            elif avg_crest <= 16.0:
                score += 4
                strengths.append(f"Good crest factor ({avg_crest:.1f} dB) -- healthy transient headroom.")
            elif avg_crest > 22.0:
                score -= 4
                issues.append(f"Very high crest factor ({avg_crest:.1f} dB) -- transients may be too prominent.")
        except Exception:
            avg_crest = None
    else:
        avg_crest = None

    # ---- Check 6: Temporal DR consistency across quarters ----
    if len(quarter_dr) >= 3:
        try:
            dr_stdev = statistics.stdev(quarter_dr)
            dr_mean = statistics.mean(quarter_dr)
            if dr_stdev > 8.0:
                score -= 8
                issues.append(f"Inconsistent mastering across edit (DR stdev={dr_stdev:.1f} dB across quarters). Different production levels in cuts.")
            else:
                strengths.append(f"Consistent mastering across edit (DR stdev={dr_stdev:.1f} dB).")
        except Exception:
            dr_stdev = None
    else:
        dr_stdev = None

    # ---- Over-compression joint pattern: LRA low AND crest factor low ----
    if lra is not None and avg_crest is not None:
        if lra < 5.0 and avg_crest < 6.0:
            score -= 8  # compound penalty -- both confirm brickwall
            issues.append("Joint brickwall pattern: low LRA + low crest factor. Audio will degrade after platform normalization (Steinmetz & Reiss 2021).")

    score = max(0, min(100, score))

    # Build feedback
    all_notes = issues[:3] + strengths[:2]
    feedback = " ".join(all_notes) if all_notes else "Audio dynamics appear healthy."

    result["scores"]["audio_dynamics"] = {
        "score": round(score, 1),
        "feedback": feedback,
        "raw": {
            "integrated_lufs": round(integrated_lufs, 2) if integrated_lufs is not None else None,
            "lra_lu": round(lra, 2) if lra is not None else None,
            "true_peak_dbfs": round(true_peak, 2) if true_peak is not None else None,
            "short_term_lufs_stdev": round(s_stdev, 3) if s_stdev is not None else None,
            "avg_crest_factor_db": round(avg_crest, 2) if avg_crest is not None else None,
            "temporal_dr_stdev": round(dr_stdev, 2) if dr_stdev is not None else None,
            "platform_target_lufs": target_lufs,
            "issues": issues,
            "strengths": strengths,
        },
    }
    result["overall_score"] = round(score, 1)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-audio-dynamics-v2.py <video_path> [--platform youtube|shorts|linkedin]")
        sys.exit(1)
    video_path = sys.argv[1]
    platform = None
    if "--platform" in sys.argv:
        idx = sys.argv.index("--platform")
        if idx + 1 < len(sys.argv):
            platform = sys.argv[idx + 1]
    result = analyze(video_path, platform)
    print(json.dumps(result, indent=2))
