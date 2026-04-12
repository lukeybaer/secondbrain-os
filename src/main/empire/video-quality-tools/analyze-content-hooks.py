#!/usr/bin/env python3
"""
Video Content Hook & CTA Analyzer
Evaluates: hook_strength (first 3s), cta_placement, pacing structure
Uses ffmpeg silence detection + basic audio energy analysis to evaluate
content structure without requiring external AI APIs.

Usage:
    python analyze-content-hooks.py <video_path> [--transcript <transcript_path>]

If a transcript JSON/SRT file is provided, uses it for deeper analysis.
Otherwise falls back to audio-energy-based heuristics.

Returns JSON with scores (0-100) and feedback for each criterion.
"""

import subprocess
import json
import sys
import os
import re


def get_video_info(video_path):
    """Get basic video info."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout), None
    except Exception as e:
        return None, str(e)


def measure_audio_energy_segments(video_path, segment_duration=1.0):
    """Measure audio energy per segment using astats filter."""
    cmd = [
        "ffmpeg",
        "-i", video_path,
        "-af", f"astats=metadata=1:reset={int(1/segment_duration)},ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null",
        "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rms_values = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr)
        return [float(v) for v in rms_values if float(v) > -100], None
    except Exception as e:
        return [], str(e)


def detect_scene_changes(video_path, threshold=0.3):
    """Detect visual scene changes using ffmpeg scene detection."""
    cmd = [
        "ffmpeg",
        "-i", video_path,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-f", "null",
        "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        # Parse scene change timestamps
        timestamps = re.findall(r"pts_time:([\d.]+)", result.stderr)
        return [float(t) for t in timestamps], None
    except Exception as e:
        return [], str(e)


def parse_transcript(transcript_path):
    """Parse a transcript file (JSON with timestamps or SRT format)."""
    if not transcript_path or not os.path.exists(transcript_path):
        return None

    with open(transcript_path, "r") as f:
        content = f.read()

    # Try JSON format (Whisper output)
    try:
        data = json.loads(content)
        if "segments" in data:
            return data["segments"]
        return None
    except json.JSONDecodeError:
        pass

    # Try SRT format
    segments = []
    blocks = re.split(r"\n\n+", content.strip())
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) >= 3:
            time_match = re.match(r"(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})", lines[1])
            if time_match:
                g = time_match.groups()
                start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
                end = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 1000
                text = " ".join(lines[2:])
                segments.append({"start": start, "end": end, "text": text})

    return segments if segments else None


# CTA keyword patterns
CTA_PATTERNS = [
    r"\b(subscribe|like|comment|share|follow|click|tap|link|bio|description)\b",
    r"\b(check out|sign up|join|download|get|grab|visit|head to)\b",
    r"\b(let me know|tell me|drop a comment|hit the bell)\b",
    r"\b(swipe up|link in bio|pinned comment)\b",
]


def score_hook_strength(energy_segments, scene_changes, duration, transcript=None):
    """Score the strength of the first 3 seconds."""
    score = 50  # baseline
    notes = []

    # Audio energy in first 3 seconds
    if energy_segments:
        # Each segment is ~1 frame worth of data, take first 3 seconds
        fps_estimate = len(energy_segments) / duration if duration > 0 else 30
        first_3s_count = int(3 * fps_estimate)
        first_3s = energy_segments[:max(1, first_3s_count)]
        all_avg = sum(energy_segments) / len(energy_segments)
        first_3s_avg = sum(first_3s) / len(first_3s)

        # Voice should start quickly — high energy in first 3s is good
        if first_3s_avg > all_avg + 3:
            score += 20
            notes.append("Strong audio presence in first 3s (voice starts immediately)")
        elif first_3s_avg > all_avg - 3:
            score += 10
            notes.append("Audio present in first 3s")
        else:
            notes.append("Low audio energy in first 3s — may lose viewers (start talking sooner)")

    # Scene changes in first 3 seconds — visual variety grabs attention
    early_scenes = [t for t in scene_changes if t <= 3.0]
    if len(early_scenes) >= 2:
        score += 15
        notes.append(f"{len(early_scenes)} scene changes in first 3s (visually engaging)")
    elif len(early_scenes) == 1:
        score += 5
        notes.append("1 scene change in first 3s")
    else:
        notes.append("No scene changes in first 3s — consider a dynamic opening")

    # Transcript-based hook analysis
    if transcript:
        first_3s_text = " ".join(
            seg["text"] for seg in transcript if seg.get("start", 99) < 3.0
        ).strip()
        if first_3s_text:
            word_count = len(first_3s_text.split())
            if word_count >= 5:
                score += 15
                notes.append(f"Hook text ({word_count} words in 3s): '{first_3s_text[:80]}'")
            else:
                score += 5
                notes.append(f"Brief hook text: '{first_3s_text[:80]}'")

            # Check for question or surprising statement (engagement hooks)
            if "?" in first_3s_text:
                score += 5
                notes.append("Opens with a question (good engagement hook)")
        else:
            notes.append("No speech detected in first 3s — add a verbal hook")

    return {"score": min(100, max(0, score)), "feedback": "; ".join(notes) if notes else "Analysis based on audio energy heuristics"}


def score_cta_placement(transcript, duration):
    """Score CTA presence and placement."""
    if not transcript:
        return {
            "score": 30,
            "feedback": "No transcript provided — cannot analyze CTA placement. Provide a transcript for full analysis.",
            "raw": {},
        }

    full_text = " ".join(seg["text"] for seg in transcript).lower()
    cta_segments = []

    for seg in transcript:
        text = seg["text"].lower()
        for pattern in CTA_PATTERNS:
            if re.search(pattern, text):
                cta_segments.append({
                    "time": seg.get("start", 0),
                    "text": seg["text"][:80],
                })
                break

    score = 50
    notes = []

    if not cta_segments:
        score = 20
        notes.append("No CTA detected — add a call-to-action (subscribe, like, etc.)")
    else:
        score += 10
        notes.append(f"{len(cta_segments)} CTA moment(s) found")

        # Best CTA placement: near the end but not last second
        if duration > 0:
            cta_times = [c["time"] for c in cta_segments]
            last_cta_ratio = max(cta_times) / duration

            if 0.7 <= last_cta_ratio <= 0.95:
                score += 25
                notes.append(f"CTA at {last_cta_ratio*100:.0f}% — good placement near end")
            elif last_cta_ratio > 0.95:
                score += 10
                notes.append("CTA at very end — might be cut off, move slightly earlier")
            elif last_cta_ratio < 0.3:
                score += 5
                notes.append("CTA too early — add another near the end")
            else:
                score += 15
                notes.append(f"CTA at {last_cta_ratio*100:.0f}% of video")

        # Multiple CTAs is good
        if len(cta_segments) >= 2:
            score += 10
            notes.append("Multiple CTA touchpoints (reinforces engagement)")

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes),
        "raw": {"cta_count": len(cta_segments), "cta_moments": cta_segments[:5]},
    }


def score_content_pacing(energy_segments, scene_changes, duration):
    """Score overall content pacing and visual variety."""
    score = 50
    notes = []

    if duration <= 0:
        return {"score": 50, "feedback": "Could not determine duration", "raw": {}}

    # Scene change frequency
    if scene_changes:
        avg_interval = duration / (len(scene_changes) + 1)
        changes_per_min = len(scene_changes) / (duration / 60)

        if 6 <= changes_per_min <= 30:
            score += 25
            notes.append(f"{changes_per_min:.1f} cuts/min (good visual variety)")
        elif 3 <= changes_per_min < 6:
            score += 15
            notes.append(f"{changes_per_min:.1f} cuts/min (could use more variety)")
        elif changes_per_min > 30:
            score += 10
            notes.append(f"{changes_per_min:.1f} cuts/min (very fast, may be disorienting)")
        else:
            notes.append(f"{changes_per_min:.1f} cuts/min (too static, add B-roll or angle changes)")
    else:
        notes.append("No scene changes detected — add visual variety")

    # Audio energy variance (indicates vocal dynamics)
    if energy_segments and len(energy_segments) > 10:
        avg_energy = sum(energy_segments) / len(energy_segments)
        variance = sum((e - avg_energy) ** 2 for e in energy_segments) / len(energy_segments)
        std_dev = variance ** 0.5

        if std_dev > 8:
            score += 20
            notes.append(f"Good vocal dynamics (energy std: {std_dev:.1f} dB)")
        elif std_dev > 4:
            score += 10
            notes.append(f"Moderate vocal dynamics (energy std: {std_dev:.1f} dB)")
        else:
            notes.append(f"Flat delivery (energy std: {std_dev:.1f} dB) — vary tone and emphasis")

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes),
        "raw": {
            "scene_changes": len(scene_changes),
            "duration_s": round(duration, 1),
        },
    }


def analyze(video_path, transcript_path=None):
    """Run content hook and structure analysis."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    probe_data, err = get_video_info(video_path)
    if err:
        return {"error": err}

    duration = float(probe_data.get("format", {}).get("duration", 0))
    transcript = parse_transcript(transcript_path)

    # Run measurements
    energy_segments, _ = measure_audio_energy_segments(video_path)
    scene_changes, _ = detect_scene_changes(video_path)

    results = {
        "tool": "analyze-content-hooks",
        "version": "1.0.0",
        "video_path": video_path,
        "has_transcript": transcript is not None,
        "scores": {
            "hook_strength": score_hook_strength(energy_segments, scene_changes, duration, transcript),
            "cta_placement": score_cta_placement(transcript, duration),
            "content_pacing": score_content_pacing(energy_segments, scene_changes, duration),
        },
    }

    scores = [v["score"] for v in results["scores"].values()]
    results["overall_score"] = round(sum(scores) / len(scores), 1)

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-content-hooks.py <video_path> [--transcript <path>]")
        sys.exit(1)

    video_path = sys.argv[1]
    transcript_path = None
    if "--transcript" in sys.argv:
        idx = sys.argv.index("--transcript")
        if idx + 1 < len(sys.argv):
            transcript_path = sys.argv[idx + 1]

    result = analyze(video_path, transcript_path)
    print(json.dumps(result, indent=2))
