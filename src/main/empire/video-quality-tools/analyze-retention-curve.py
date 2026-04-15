#!/usr/bin/env python3
"""
Video Retention Curve Predictor v2
Predicts where viewers will drop off by analyzing engagement signals across
the video timeline: audio energy, scene changes, silence gaps, and pacing.

v2 upgrades:
  - Power-law decay model (research shows real retention follows power-law,
    not linear decay -- TikTok 2026 benchmarks, YouTube Retention Report 2025)
  - Re-hook event detection: audio energy spikes at 25-35% and 60-75% marks
    that reset/reduce the local decay rate (pattern interrupts)
  - Edit rhythm integration: CV of inter-cut intervals; high variance with
    cuts synced to audio peaks = +40% watch time (VQualA 2025 findings)
  - Audio spike detection: per-second RMS >1.5 sigma above mean = engagement
    event that measurably slows decay
  - Stronger platform calibration: power-law exponent tuned per format

Research basis:
  - YouTube/TikTok retention follows power-law decay R(t) = R0*(1+t/tau)^-alpha
    with alpha ~0.3-0.6 for short-form, ~0.15-0.35 for long-form
  - Re-hook events at 25-35% mark are standard creator practice; measurable
    via audio energy spikes relative to segment baseline
  - Inter-cut CV >0.6 when synced to audio peaks correlates +40% watch time
    (VQualA Engagement Prediction Challenge 2025)
  - 65% of viewer retention determined in first 3 seconds
  - Dead air >2s causes 15-25% viewer drop-off per occurrence

Usage:
    python analyze-retention-curve.py <video_path> [--platform shorts|youtube|linkedin]

Returns JSON with predicted retention curve, drop-off points, and score.
"""

import subprocess
import json
import sys
import os
import re
import math
import statistics


def get_video_info(video_path):
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout), None
    except Exception as e:
        return None, str(e)


def measure_audio_energy_per_second(video_path, duration):
    """Get per-second audio RMS energy using astats metadata."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rms_values = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr)
        values = [float(v) for v in rms_values if float(v) > -100]
        return values
    except Exception:
        return []


def detect_scene_changes_timed(video_path, threshold=0.3):
    """Get timestamps of all scene changes."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        timestamps = re.findall(r"pts_time:([\d.]+)", result.stderr)
        return [float(t) for t in timestamps]
    except Exception:
        return []


def detect_silence_gaps(video_path, noise_threshold=-40, min_duration=1.0):
    """Detect silence gaps that predict viewer drop-off."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", f"silencedetect=noise={noise_threshold}dB:d={min_duration}",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        starts = re.findall(r"silence_start: ([\d.]+)", result.stderr)
        ends = re.findall(r"silence_end: ([\d.]+)", result.stderr)
        gaps = []
        for i in range(min(len(starts), len(ends))):
            s, e = float(starts[i]), float(ends[i])
            gaps.append({"start": round(s, 1), "end": round(e, 1), "duration": round(e - s, 1)})
        return gaps
    except Exception:
        return []


def detect_rehook_events(energy_per_second, scene_changes, duration):
    """
    Detect re-hook events: audio energy spikes at 25-35% and 60-75% marks.
    A re-hook is an audio energy spike >1.0 sigma above the global mean
    within the re-hook windows, optionally co-occurring with a scene change.

    Returns list of dicts: {time_s, type, strength}
    """
    rehook_events = []
    if not energy_per_second or duration <= 0:
        return rehook_events

    n = len(energy_per_second)
    if n < 10:
        return rehook_events

    mean_e = sum(energy_per_second) / n
    try:
        stdev_e = statistics.stdev(energy_per_second)
    except statistics.StatisticsError:
        return rehook_events
    if stdev_e == 0:
        return rehook_events

    # Re-hook windows as fraction of duration
    windows = [
        (0.22, 0.38, "first_rehook"),
        (0.58, 0.78, "second_rehook"),
    ]

    scene_set = set(int(t) for t in scene_changes)

    for w_start, w_end, label in windows:
        s_idx = int(w_start * n)
        e_idx = int(w_end * n)
        window_energies = energy_per_second[s_idx:e_idx]
        if not window_energies:
            continue
        # Find peak within window
        peak_val = max(window_energies)
        peak_offset = window_energies.index(peak_val)
        peak_abs_sec = s_idx + peak_offset
        z_score = (peak_val - mean_e) / stdev_e
        if z_score >= 1.0:
            has_cut = peak_abs_sec in scene_set or (peak_abs_sec + 1) in scene_set
            strength = min(1.0, z_score / 3.0)
            rehook_events.append({
                "time_s": peak_abs_sec,
                "time_pct": round(peak_abs_sec / n * 100, 1),
                "type": label,
                "z_score": round(z_score, 2),
                "has_cut": has_cut,
                "strength": round(strength, 2),
            })
    return rehook_events


def compute_audio_spikes(energy_per_second):
    """
    Identify per-second audio spikes (RMS > mean + 1.5 * stdev).
    These are micro-engagement events that briefly hold attention.
    Returns set of spike seconds.
    """
    if len(energy_per_second) < 5:
        return set()
    mean_e = sum(energy_per_second) / len(energy_per_second)
    try:
        stdev_e = statistics.stdev(energy_per_second)
    except statistics.StatisticsError:
        return set()
    threshold = mean_e + 1.5 * stdev_e
    return {i for i, e in enumerate(energy_per_second) if e >= threshold}


def compute_edit_rhythm_cv(scene_changes, duration):
    """
    Compute coefficient of variation of inter-cut intervals.
    High CV (>0.6) with cuts synced to audio peaks = strong engagement signal.
    """
    if len(scene_changes) < 3:
        return None
    sorted_cuts = sorted(scene_changes)
    intervals = [sorted_cuts[i + 1] - sorted_cuts[i] for i in range(len(sorted_cuts) - 1)]
    valid = [iv for iv in intervals if iv > 0.05]
    if len(valid) < 2:
        return None
    mean_iv = sum(valid) / len(valid)
    if mean_iv == 0:
        return None
    stdev_iv = statistics.stdev(valid)
    return stdev_iv / mean_iv


# Platform-specific power-law decay parameters
# R(t) = R0 * (1 + t/tau)^(-alpha)
# Higher alpha = faster decay (more competitive/demanding format)
# Lower tau = decay kicks in sooner
PLATFORM_PARAMS = {
    "shorts": {
        "alpha": 0.45,         # power-law exponent: steep early drop
        "tau": 8.0,            # seconds before decay accelerates
        "hook_weight": 0.35,
        "silence_penalty_factor": 0.12,
        "spike_boost": 0.008,  # per spike event: reduces effective alpha
        "rehook_boost": 0.10,  # rehook event: multiplicative retention bump
        "ideal_cv": 0.55,
    },
    "youtube": {
        "alpha": 0.28,
        "tau": 25.0,
        "hook_weight": 0.25,
        "silence_penalty_factor": 0.05,
        "spike_boost": 0.004,
        "rehook_boost": 0.06,
        "ideal_cv": 0.45,
    },
    "linkedin": {
        "alpha": 0.22,
        "tau": 30.0,
        "hook_weight": 0.20,
        "silence_penalty_factor": 0.04,
        "spike_boost": 0.003,
        "rehook_boost": 0.04,
        "ideal_cv": 0.35,
    },
}


def predict_retention_curve_powerlaw(duration, energy_per_second, scene_changes,
                                      silence_gaps, rehook_events, spike_seconds,
                                      platform="youtube"):
    """
    Power-law retention curve: R(t) = R0 * (1 + t/tau)^(-alpha)
    Modified by:
      - Silence gaps: increase effective alpha (faster decay) during dead air
      - Rehook events: apply multiplicative retention bump at event second
      - Audio spikes: micro-boost that marginally reduces local decay
      - Scene changes: small periodic decay reduction
    Returns list of (sec, retention_pct) dicts.
    """
    params = PLATFORM_PARAMS.get(platform, PLATFORM_PARAMS["youtube"])
    n_seconds = int(min(duration, 600))

    # Initial retention from hook strength (first 3s)
    if energy_per_second and len(energy_per_second) >= 3:
        hook_energy = sum(energy_per_second[:3]) / 3
        all_avg = sum(energy_per_second) / len(energy_per_second)
        hook_diff = hook_energy - all_avg
        initial_retention = min(97, max(62, 85 + hook_diff * 1.5))
    else:
        initial_retention = 80

    # Build lookup sets for O(1) access
    silence_seconds = set()
    for gap in silence_gaps:
        for s in range(int(gap["start"]), int(gap["end"]) + 1):
            silence_seconds.add(s)
    scene_seconds = set(int(t) for t in scene_changes)
    rehook_seconds = {ev["time_s"]: ev["strength"] for ev in rehook_events}

    alpha_base = params["alpha"]
    tau = params["tau"]
    rehook_boost = params["rehook_boost"]
    silence_penalty = params["silence_penalty_factor"]
    spike_boost = params["spike_boost"]

    curve = []
    retention = initial_retention

    for sec in range(n_seconds):
        if retention <= 0:
            curve.append({"time_s": sec, "retention_pct": 0.0})
            continue

        # Local alpha modifier
        local_alpha = alpha_base

        # Silence increases decay
        if sec in silence_seconds:
            local_alpha += silence_penalty

        # Scene change reduces decay slightly
        if sec in scene_seconds:
            local_alpha = max(0, local_alpha - 0.03)

        # Audio spikes reduce decay marginally
        if sec in spike_seconds:
            local_alpha = max(0, local_alpha - spike_boost * 10)

        # Power-law: instantaneous decay rate at time t
        # dR/dt = -R0 * alpha / tau * (1 + t/tau)^(-alpha-1)
        # Simplified: fractional change per second at current retention
        decay_rate = local_alpha / (tau + sec)
        delta = retention * decay_rate
        retention = max(0, retention - delta)

        # Rehook event: multiplicative bump (not additive, to stay realistic)
        if sec in rehook_seconds:
            strength = rehook_seconds[sec]
            bump = retention * rehook_boost * strength
            retention = min(initial_retention, retention + bump)

        curve.append({"time_s": sec, "retention_pct": round(retention, 1)})

    return curve, initial_retention


def find_dropoff_points(curve, threshold_drop=5.0):
    """Find significant drop-off points in the retention curve."""
    dropoffs = []
    window = 5

    for i in range(window, len(curve)):
        prev = curve[i - window]["retention_pct"]
        curr = curve[i]["retention_pct"]
        drop = prev - curr
        if drop >= threshold_drop:
            dropoffs.append({
                "time_s": curve[i]["time_s"],
                "retention_before": prev,
                "retention_after": curr,
                "drop_pct": round(drop, 1),
            })
    return dropoffs


def score_retention(curve, dropoff_points, duration, platform, rehook_events, rhythm_cv):
    """Score overall retention quality with v2 signals."""
    score = 50
    notes = []

    if not curve:
        return {"score": 40, "feedback": "Could not model retention curve", "raw": {}}

    final_retention = curve[-1]["retention_pct"] if curve else 0

    if final_retention >= 70:
        score += 30
        notes.append(f"Predicted {final_retention:.0f}% final retention (excellent)")
    elif final_retention >= 50:
        score += 20
        notes.append(f"Predicted {final_retention:.0f}% final retention (good)")
    elif final_retention >= 35:
        score += 10
        notes.append(f"Predicted {final_retention:.0f}% final retention (average)")
    elif final_retention >= 20:
        notes.append(f"Predicted {final_retention:.0f}% final retention (below average)")
    else:
        score -= 10
        notes.append(f"Predicted {final_retention:.0f}% final retention (poor -- major issues)")

    # Penalize significant drop-offs
    if dropoff_points:
        worst = max(dropoff_points, key=lambda x: x["drop_pct"])
        score -= min(15, int(worst["drop_pct"] * 1.5))
        times = [f"{d['time_s']}s (-{d['drop_pct']:.0f}%)" for d in dropoff_points[:3]]
        notes.append(f"Drop-off points: {', '.join(times)}")
    else:
        score += 10
        notes.append("No significant drop-off points -- smooth retention curve")

    # Average retention
    avg_retention = sum(p["retention_pct"] for p in curve) / len(curve)
    if avg_retention >= 65:
        score += 10
        notes.append(f"Average retention {avg_retention:.0f}% (strong)")
    elif avg_retention >= 45:
        score += 5
        notes.append(f"Average retention {avg_retention:.0f}%")
    else:
        notes.append(f"Average retention {avg_retention:.0f}% (weak -- improve pacing and engagement)")

    # Re-hook bonus (v2)
    if len(rehook_events) >= 2:
        score += 10
        notes.append(f"{len(rehook_events)} re-hook events detected -- strong content refresh pattern")
    elif len(rehook_events) == 1:
        score += 5
        notes.append(f"1 re-hook event at {rehook_events[0]['time_pct']:.0f}% -- add a second for better mid-video retention")
    else:
        notes.append("No re-hook events detected -- add pattern interrupts at ~30% and ~65% marks")

    # Edit rhythm bonus (v2)
    if rhythm_cv is not None:
        ideal_cv = PLATFORM_PARAMS.get(platform, PLATFORM_PARAMS["youtube"])["ideal_cv"]
        if abs(rhythm_cv - ideal_cv) <= 0.15:
            score += 5
            notes.append(f"Edit rhythm CV {rhythm_cv:.2f} near platform ideal ({ideal_cv}) -- dynamic pacing")
        elif rhythm_cv < 0.2:
            score -= 3
            notes.append(f"Edit rhythm too uniform (CV={rhythm_cv:.2f}) -- vary cut intervals to maintain tension")

    # Retention at key moments
    total = len(curve)
    if total > 10:
        mid_ret = curve[total // 2]["retention_pct"]
        q3_ret = curve[3 * total // 4]["retention_pct"]
        if mid_ret < 50:
            notes.append(f"Only {mid_ret:.0f}% retention at midpoint -- add re-hook or visual interrupt")
        if q3_ret < 30:
            notes.append(f"Only {q3_ret:.0f}% at 75% -- consider shortening the video")

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes),
        "raw": {
            "final_retention_pct": round(final_retention, 1),
            "avg_retention_pct": round(avg_retention, 1) if curve else 0,
            "dropoff_count": len(dropoff_points),
            "dropoff_points": dropoff_points[:5],
            "rehook_events": rehook_events,
            "edit_rhythm_cv": round(rhythm_cv, 3) if rhythm_cv is not None else None,
        },
    }


def analyze(video_path, platform=None):
    """Run retention curve prediction v2."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}", "tool": "analyze-retention-curve", "version": "2.0.0"}

    probe_data, err = get_video_info(video_path)
    if err:
        return {"error": err, "tool": "analyze-retention-curve", "version": "2.0.0"}

    duration = float(probe_data.get("format", {}).get("duration", 0))
    if duration <= 0:
        return {"error": "Could not determine video duration", "tool": "analyze-retention-curve", "version": "2.0.0"}

    # Auto-detect platform
    if not platform:
        streams = probe_data.get("streams", [])
        for s in streams:
            if s.get("codec_type") == "video":
                w = int(s.get("width", 0))
                h = int(s.get("height", 0))
                if h > w and duration < 62:
                    platform = "shorts"
                elif duration > 120:
                    platform = "youtube"
                else:
                    platform = "youtube"
                break
        if not platform:
            platform = "youtube"

    # Gather signals
    energy_per_second = measure_audio_energy_per_second(video_path, duration)
    scene_changes = detect_scene_changes_timed(video_path)
    silence_gaps = detect_silence_gaps(video_path)

    # v2 signals
    rehook_events = detect_rehook_events(energy_per_second, scene_changes, duration)
    spike_seconds = compute_audio_spikes(energy_per_second)
    rhythm_cv = compute_edit_rhythm_cv(scene_changes, duration)

    # Predict retention curve (power-law model)
    curve, initial_retention = predict_retention_curve_powerlaw(
        duration, energy_per_second, scene_changes, silence_gaps,
        rehook_events, spike_seconds, platform
    )

    # Find drop-off points
    dropoff_points = find_dropoff_points(curve)

    # Score
    retention_score = score_retention(curve, dropoff_points, duration, platform, rehook_events, rhythm_cv)

    # Subsample curve for output
    if len(curve) > 30:
        step = max(1, len(curve) // 20)
        sampled_curve = curve[::step]
        if curve[-1] not in sampled_curve:
            sampled_curve.append(curve[-1])
    else:
        sampled_curve = curve

    result = {
        "tool": "analyze-retention-curve",
        "version": "2.0.0",
        "video_path": video_path,
        "platform": platform,
        "duration_s": round(duration, 1),
        "initial_retention_pct": round(initial_retention, 1),
        "scores": {
            "retention_curve": retention_score,
        },
        "overall_score": retention_score["score"],
        "predicted_curve": sampled_curve,
        "silence_gaps": silence_gaps[:10],
        "rehook_events": rehook_events,
        "edit_rhythm_cv": round(rhythm_cv, 3) if rhythm_cv is not None else None,
        "audio_spikes_count": len(spike_seconds),
        "warnings": [],
    }

    if len(silence_gaps) > 5:
        result["warnings"].append(f"{len(silence_gaps)} silence gaps detected -- tighter editing recommended")
    if not rehook_events:
        result["warnings"].append("No re-hook events detected at standard timing windows (25-35%, 60-75%)")

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-retention-curve.py <video_path> [--platform shorts|youtube|linkedin]")
        sys.exit(1)

    video_path = sys.argv[1]
    platform = None

    if "--platform" in sys.argv:
        idx = sys.argv.index("--platform")
        if idx + 1 < len(sys.argv):
            platform = sys.argv[idx + 1]

    result = analyze(video_path, platform)
    print(json.dumps(result, indent=2))
