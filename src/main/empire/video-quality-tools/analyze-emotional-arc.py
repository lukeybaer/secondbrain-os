#!/usr/bin/env python3
"""
Video Emotional Arc Analyzer
Evaluates the emotional trajectory of a video by analyzing audio energy dynamics,
scene change density, and vocal variation over time segments.

Maps the video into segments and scores:
  - Emotional progression (does the video build toward a climax?)
  - Energy variance across segments (flat vs dynamic delivery)
  - Arc shape classification (rising, falling, peak-valley, flat, roller-coaster)
  - Predicted engagement from emotional dynamics

Research basis:
  - Audio-visual sentiment analysis for emotional arcs (Chu et al., ICCV 2017)
  - Certain emotional arc shapes are statistically significant predictors of engagement
  - Videos with clear rising action → climax → resolution outperform flat delivery
  - MultiSentimentArcs framework for multimodal narrative analysis

Usage:
    python analyze-emotional-arc.py <video_path> [--transcript <path>] [--segments 8]

Returns JSON with emotional arc scores, shape classification, and feedback.
"""

import subprocess
import json
import sys
import os
import re
import math


def get_video_duration(video_path):
    """Get video duration in seconds."""
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


def measure_segment_energy(video_path, start, duration):
    """Measure average audio RMS energy for a time segment."""
    cmd = [
        "ffmpeg", "-ss", str(start), "-t", str(duration),
        "-i", video_path,
        "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        rms_values = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr)
        values = [float(v) for v in rms_values if float(v) > -100]
        if values:
            return sum(values) / len(values)
        return -60  # silence
    except Exception:
        return -60


def count_scene_changes_in_range(video_path, start, duration, threshold=0.3):
    """Count scene changes within a time range."""
    cmd = [
        "ffmpeg", "-ss", str(start), "-t", str(duration),
        "-i", video_path,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        timestamps = re.findall(r"pts_time:([\d.]+)", result.stderr)
        return len(timestamps)
    except Exception:
        return 0


def classify_arc_shape(energy_values):
    """
    Classify the emotional arc shape based on energy trajectory.
    Returns one of: rising, falling, peak_middle, valley_middle, roller_coaster, flat
    """
    if not energy_values or len(energy_values) < 3:
        return "unknown", 0

    n = len(energy_values)
    # Normalize to 0-1 range
    min_e = min(energy_values)
    max_e = max(energy_values)
    rng = max_e - min_e
    if rng < 1:  # essentially flat
        return "flat", 0

    normalized = [(e - min_e) / rng for e in energy_values]

    # Find the peak and valley positions
    peak_idx = normalized.index(max(normalized))
    valley_idx = normalized.index(min(normalized))

    # Calculate trend (linear regression slope)
    x_mean = (n - 1) / 2
    y_mean = sum(normalized) / n
    numerator = sum((i - x_mean) * (normalized[i] - y_mean) for i in range(n))
    denominator = sum((i - x_mean) ** 2 for i in range(n))
    slope = numerator / denominator if denominator != 0 else 0

    # Calculate variance of differences (how roller-coaster-like)
    diffs = [normalized[i + 1] - normalized[i] for i in range(n - 1)]
    sign_changes = sum(1 for i in range(len(diffs) - 1) if diffs[i] * diffs[i + 1] < 0)

    # Classification logic
    if sign_changes >= n * 0.5:
        shape = "roller_coaster"
    elif slope > 0.08:
        shape = "rising"
    elif slope < -0.08:
        shape = "falling"
    elif peak_idx > n * 0.25 and peak_idx < n * 0.75:
        shape = "peak_middle"
    elif valley_idx > n * 0.25 and valley_idx < n * 0.75:
        shape = "valley_middle"
    else:
        shape = "gradual"

    # Dynamic range as a measure of emotional intensity
    dynamic_range = rng

    return shape, dynamic_range


# Arc shape quality ratings (research-backed)
# Rising and peak-middle arcs correlate with highest engagement
ARC_QUALITY = {
    "rising": {"score_bonus": 25, "label": "Rising Action", "feedback": "Energy builds throughout — strong engagement pattern"},
    "peak_middle": {"score_bonus": 20, "label": "Peak in Middle", "feedback": "Classic climax structure — builds then resolves"},
    "roller_coaster": {"score_bonus": 15, "label": "Roller Coaster", "feedback": "High-energy variation keeps viewers engaged"},
    "gradual": {"score_bonus": 10, "label": "Gradual Arc", "feedback": "Gentle progression — consider adding a clear climax moment"},
    "falling": {"score_bonus": 5, "label": "Falling Energy", "feedback": "Energy decreases over time — front-loaded content risks late drop-off"},
    "valley_middle": {"score_bonus": 0, "label": "Energy Dip", "feedback": "Energy drops in the middle — this is where viewers leave. Add a re-hook or visual change"},
    "flat": {"score_bonus": -10, "label": "Flat/Monotone", "feedback": "No emotional progression detected — vary energy, add emphasis, change scenes"},
    "unknown": {"score_bonus": 0, "label": "Unknown", "feedback": "Could not determine arc shape"},
}


def score_emotional_arc(segment_energies, scene_counts, duration, transcript_segments=None):
    """
    Score the emotional arc of the video.
    Returns score 0-100 with arc shape classification and feedback.
    """
    score = 50  # baseline
    notes = []
    raw_data = {}

    if not segment_energies or len(segment_energies) < 3:
        return {
            "score": 40,
            "feedback": "Video too short or audio too quiet for emotional arc analysis",
            "arc_shape": "unknown",
            "raw": {},
        }

    # Classify arc shape
    shape, dynamic_range = classify_arc_shape(segment_energies)
    arc_info = ARC_QUALITY.get(shape, ARC_QUALITY["unknown"])
    score += arc_info["score_bonus"]
    notes.append(f"Arc shape: {arc_info['label']} — {arc_info['feedback']}")

    # Score dynamic range (vocal energy variation)
    if dynamic_range > 15:
        score += 15
        notes.append(f"Excellent energy range ({dynamic_range:.1f} dB) — dynamic, engaging delivery")
    elif dynamic_range > 8:
        score += 10
        notes.append(f"Good energy range ({dynamic_range:.1f} dB)")
    elif dynamic_range > 4:
        score += 5
        notes.append(f"Moderate energy range ({dynamic_range:.1f} dB) — try more vocal emphasis")
    else:
        notes.append(f"Low energy range ({dynamic_range:.1f} dB) — monotone delivery, vary your tone")

    # Analyze visual activity arc (scene changes per segment)
    if scene_counts and sum(scene_counts) > 0:
        visual_shape, visual_range = classify_arc_shape(
            [float(c) for c in scene_counts]
        )
        if visual_shape in ("rising", "peak_middle", "roller_coaster"):
            score += 5
            notes.append(f"Visual pacing supports emotional arc ({visual_shape})")
        elif visual_shape == "flat" and sum(scene_counts) > 0:
            notes.append("Visual pacing is uniform — consider varying cut frequency to match energy")

    # Check for energy dips that predict viewer drop-off
    n = len(segment_energies)
    avg_energy = sum(segment_energies) / n
    dip_segments = []
    for i in range(1, n - 1):  # skip first and last
        if segment_energies[i] < avg_energy - 6:  # significant dip
            segment_pct = round((i / n) * 100)
            dip_segments.append(f"{segment_pct}%")

    if dip_segments:
        notes.append(f"Energy dips at {', '.join(dip_segments)} of video — viewers may drop off here")
    else:
        score += 5
        notes.append("No significant energy dips — consistent engagement throughout")

    # Transcript-based emotional analysis (if available)
    if transcript_segments:
        # Count exclamatory/question patterns per segment
        engagement_markers = 0
        for seg in transcript_segments:
            text = seg.get("text", "")
            if "?" in text:
                engagement_markers += 1
            if "!" in text:
                engagement_markers += 1
            # Power words that signal emotional peaks
            power_words = re.findall(
                r"\b(amazing|incredible|shocking|secret|powerful|critical|urgent|breakthrough|game.?changer|mind.?blowing)\b",
                text.lower()
            )
            engagement_markers += len(power_words)

        if engagement_markers >= 5:
            score += 5
            notes.append(f"{engagement_markers} engagement markers in transcript (questions, emphasis, power words)")
        elif engagement_markers == 0:
            notes.append("No engagement markers in transcript — add questions, emphasis, or power words")

    raw_data = {
        "arc_shape": shape,
        "dynamic_range_db": round(dynamic_range, 1),
        "segment_energies": [round(e, 1) for e in segment_energies],
        "scene_counts_per_segment": scene_counts,
        "energy_dip_locations": dip_segments,
        "segment_count": n,
    }

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes),
        "arc_shape": arc_info["label"],
        "raw": raw_data,
    }


def parse_transcript(transcript_path):
    """Parse transcript JSON or SRT."""
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    with open(transcript_path, "r") as f:
        content = f.read()
    try:
        data = json.loads(content)
        if "segments" in data:
            return data["segments"]
        return None
    except json.JSONDecodeError:
        pass
    # SRT fallback
    segments = []
    blocks = re.split(r"\n\n+", content.strip())
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) >= 3:
            time_match = re.match(
                r"(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})",
                lines[1]
            )
            if time_match:
                g = time_match.groups()
                start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
                end = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 1000
                text = " ".join(lines[2:])
                segments.append({"start": start, "end": end, "text": text})
    return segments if segments else None


def analyze(video_path, transcript_path=None, num_segments=8):
    """Run emotional arc analysis on a video."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    duration = get_video_duration(video_path)
    if duration <= 0:
        return {"error": "Could not determine video duration"}

    # Adaptive segment count based on duration
    if duration < 15:
        num_segments = max(3, int(duration / 3))
    elif duration < 30:
        num_segments = 6
    elif duration < 120:
        num_segments = 8
    else:
        num_segments = 12

    segment_duration = duration / num_segments

    # Measure energy and scene changes per segment
    segment_energies = []
    scene_counts = []

    for i in range(num_segments):
        start = i * segment_duration
        energy = measure_segment_energy(video_path, start, segment_duration)
        scenes = count_scene_changes_in_range(video_path, start, segment_duration)
        segment_energies.append(energy)
        scene_counts.append(scenes)

    transcript = parse_transcript(transcript_path)

    # Get transcript segments bucketed by video segment
    transcript_by_segment = None
    if transcript:
        transcript_by_segment = transcript  # pass all for now

    arc_score = score_emotional_arc(segment_energies, scene_counts, duration, transcript_by_segment)

    result = {
        "tool": "analyze-emotional-arc",
        "version": "1.0.0",
        "video_path": video_path,
        "duration_s": round(duration, 1),
        "num_segments": num_segments,
        "segment_duration_s": round(segment_duration, 1),
        "has_transcript": transcript is not None,
        "scores": {
            "emotional_arc": arc_score,
        },
        "overall_score": arc_score["score"],
        "arc_shape": arc_score.get("arc_shape", "Unknown"),
        "warnings": [],
    }

    if duration < 10:
        result["warnings"].append("Video very short — emotional arc analysis is limited")

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-emotional-arc.py <video_path> [--transcript <path>] [--segments <n>]")
        sys.exit(1)

    video_path = sys.argv[1]
    transcript_path = None
    num_segments = 8

    if "--transcript" in sys.argv:
        idx = sys.argv.index("--transcript")
        if idx + 1 < len(sys.argv):
            transcript_path = sys.argv[idx + 1]

    if "--segments" in sys.argv:
        idx = sys.argv.index("--segments")
        if idx + 1 < len(sys.argv):
            num_segments = int(sys.argv[idx + 1])

    result = analyze(video_path, transcript_path, num_segments)
    print(json.dumps(result, indent=2))
