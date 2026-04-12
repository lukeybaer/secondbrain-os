#!/usr/bin/env python3
"""
Video Retention Curve Predictor
Predicts where viewers will drop off by analyzing engagement signals across
the video timeline: audio energy, scene changes, silence gaps, and pacing.

Models a synthetic retention curve based on:
  - Hook strength (first 3s determines initial retention)
  - Scene change density (visual variety keeps viewers)
  - Audio energy drops (silence = viewer exits)
  - Pacing consistency (irregular pacing causes drop-off)
  - Content density per segment (dead spots = exits)

Research basis:
  - 65% of viewer retention is determined in first 3 seconds
  - Dead air >2s causes 15-25% viewer drop-off per occurrence
  - Scene changes every 2-4s optimal for shorts, 5-8s for long-form
  - Retention curves follow exponential decay modified by engagement events

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


def get_video_info(video_path):
    """Get video metadata."""
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
    """Get per-second audio RMS energy."""
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


# Platform-specific retention model parameters
PLATFORM_RETENTION = {
    "shorts": {
        "base_decay_rate": 0.02,      # % drop per second baseline
        "hook_weight": 0.35,           # Hook determines 35% of initial retention
        "silence_penalty": 0.08,       # 8% drop per second of silence
        "scene_change_boost": 0.005,   # Each scene change reduces decay
        "ideal_scene_interval": 3.0,   # seconds between cuts
    },
    "youtube": {
        "base_decay_rate": 0.008,
        "hook_weight": 0.25,
        "silence_penalty": 0.04,
        "scene_change_boost": 0.003,
        "ideal_scene_interval": 6.0,
    },
    "linkedin": {
        "base_decay_rate": 0.01,
        "hook_weight": 0.20,
        "silence_penalty": 0.05,
        "scene_change_boost": 0.002,
        "ideal_scene_interval": 8.0,
    },
}


def predict_retention_curve(duration, energy_per_second, scene_changes, silence_gaps, platform="youtube"):
    """
    Model a synthetic retention curve second by second.
    Returns a list of (timestamp, predicted_retention_pct) tuples.
    """
    params = PLATFORM_RETENTION.get(platform, PLATFORM_RETENTION["youtube"])
    n_seconds = int(min(duration, 600))  # cap at 10 min

    # Initial retention based on hook energy (first 3s)
    hook_energy = -60
    if energy_per_second and len(energy_per_second) >= 3:
        hook_energy = sum(energy_per_second[:3]) / 3
        all_avg = sum(energy_per_second) / len(energy_per_second)
        hook_diff = hook_energy - all_avg
        # Strong hook = 95% initial retention, weak = 70%
        initial_retention = min(98, max(60, 85 + hook_diff * 1.5))
    else:
        initial_retention = 80  # default without audio data

    # Build scene change map (which seconds have cuts)
    scene_seconds = set()
    for t in scene_changes:
        scene_seconds.add(int(t))

    # Build silence map
    silence_seconds = set()
    for gap in silence_gaps:
        for s in range(int(gap["start"]), int(gap["end"]) + 1):
            silence_seconds.add(s)

    # Simulate retention curve
    curve = []
    retention = initial_retention

    for sec in range(n_seconds):
        # Base decay
        decay = params["base_decay_rate"]

        # Silence penalty
        if sec in silence_seconds:
            decay += params["silence_penalty"]

        # Scene change boost (reduces decay)
        if sec in scene_seconds:
            decay = max(0, decay - params["scene_change_boost"] * 3)

        # Audio energy influence (lower energy = faster decay)
        if energy_per_second and sec < len(energy_per_second):
            energy = energy_per_second[sec]
            if energy < -45:  # very quiet
                decay += 0.02
            elif energy > -20:  # very energetic
                decay = max(0, decay - 0.005)

        retention = max(0, retention - decay * 100 / max(1, (n_seconds / 60)))
        curve.append({"time_s": sec, "retention_pct": round(retention, 1)})

    return curve, initial_retention


def find_dropoff_points(curve, threshold_drop=5.0):
    """Find significant drop-off points in the retention curve."""
    dropoffs = []
    window = 5  # look at 5-second windows

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


def score_retention(curve, dropoff_points, duration, platform):
    """Score overall retention quality."""
    score = 50
    notes = []

    if not curve:
        return {"score": 40, "feedback": "Could not model retention curve", "raw": {}}

    # Final retention (what % of viewers stay to the end)
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
        notes.append(f"Predicted {final_retention:.0f}% final retention (poor — major issues)")

    # Penalize significant drop-offs
    if dropoff_points:
        worst = max(dropoff_points, key=lambda x: x["drop_pct"])
        score -= min(15, int(worst["drop_pct"] * 1.5))
        times = [f"{d['time_s']}s (-{d['drop_pct']:.0f}%)" for d in dropoff_points[:3]]
        notes.append(f"Drop-off points: {', '.join(times)}")
    else:
        score += 10
        notes.append("No significant drop-off points detected — smooth retention")

    # Average retention across the video
    avg_retention = sum(p["retention_pct"] for p in curve) / len(curve)
    if avg_retention >= 65:
        score += 10
        notes.append(f"Average retention {avg_retention:.0f}% (strong)")
    elif avg_retention >= 45:
        score += 5
        notes.append(f"Average retention {avg_retention:.0f}%")
    else:
        notes.append(f"Average retention {avg_retention:.0f}% (weak — improve pacing and engagement)")

    # Retention at key moments
    total = len(curve)
    if total > 10:
        # 25% mark
        q1_ret = curve[total // 4]["retention_pct"]
        # 50% mark
        mid_ret = curve[total // 2]["retention_pct"]
        # 75% mark
        q3_ret = curve[3 * total // 4]["retention_pct"]

        if mid_ret < 50:
            notes.append(f"Only {mid_ret:.0f}% retention at midpoint — add a re-hook or pattern interrupt")
        if q3_ret < 30:
            notes.append(f"Only {q3_ret:.0f}% retention at 75% — consider shortening the video")

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes),
        "raw": {
            "final_retention_pct": round(final_retention, 1),
            "avg_retention_pct": round(avg_retention, 1) if curve else 0,
            "dropoff_count": len(dropoff_points),
            "dropoff_points": dropoff_points[:5],
        },
    }


def analyze(video_path, platform=None):
    """Run retention curve prediction."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    probe_data, err = get_video_info(video_path)
    if err:
        return {"error": err}

    duration = float(probe_data.get("format", {}).get("duration", 0))
    if duration <= 0:
        return {"error": "Could not determine video duration"}

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

    # Predict retention curve
    curve, initial_retention = predict_retention_curve(
        duration, energy_per_second, scene_changes, silence_gaps, platform
    )

    # Find drop-off points
    dropoff_points = find_dropoff_points(curve)

    # Score
    retention_score = score_retention(curve, dropoff_points, duration, platform)

    # Subsample curve for output (every 5 seconds for videos > 30s)
    if len(curve) > 30:
        step = max(1, len(curve) // 20)
        sampled_curve = curve[::step]
        if curve[-1] not in sampled_curve:
            sampled_curve.append(curve[-1])
    else:
        sampled_curve = curve

    result = {
        "tool": "analyze-retention-curve",
        "version": "1.0.0",
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
        "warnings": [],
    }

    if len(silence_gaps) > 5:
        result["warnings"].append(f"{len(silence_gaps)} silence gaps detected — consider tighter editing")

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
