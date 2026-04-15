#!/usr/bin/env python3
"""
Video Content Hook & CTA Analyzer
Evaluates: hook_strength (first 3s), cta_placement, pacing structure

v2 improvements (2026-04-14):
  - Loudness surge detection: measures energy delta between pre-hook (0-0.5s)
    and hook window (0.5-2.0s). A rapid ramp up is the signature of a
    deliberate hook punch-in, not just "audio is loud." Replaces the flat
    "first 3s energy vs video average" comparison that produced false positives
    when a music bed was present throughout.
  - Visual brightness burst: extracts a frame at t=0.1s and compares mean luma
    to the video median. A bright opening frame (>15% above median) is a
    known pattern interrupt signal.
  - Pattern interrupt via deliberate silence: a 0.15-0.5s gap in speech
    within the first 0-3s followed by a high-energy word is used by top
    creators. Detected via ffmpeg silencedetect on the first 3 seconds only.
  - Re-hook detection at 20-40% mark: YouTube retention data shows a second
    drop at 20-40%. Creators who survive it use a density spike of cuts or
    energy in that window. Raises pacing score.
  - CTA pattern expansion: added 2025-2026 common CTA phrases.

Usage:
    python analyze-content-hooks.py <video_path> [--transcript <path>]

Returns JSON with scores (0-100) and feedback for each criterion.
"""

import subprocess
import json
import sys
import os
import re
import math
import shutil
import tempfile


TOOLS_VERSION = "2.0.0"


def get_video_info(video_path):
    """Get basic video info via ffprobe."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout), None
    except Exception as e:
        return None, str(e)


def measure_audio_energy_segments(video_path, reset_sec=1):
    """Measure audio RMS energy per 1-second window."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", (
            f"astats=metadata=1:reset={reset_sec},"
            "ametadata=print:key=lavfi.astats.Overall.RMS_level"
        ),
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rms_values = re.findall(
            r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr
        )
        return [float(v) for v in rms_values if float(v) > -100], None
    except Exception as e:
        return [], str(e)


def detect_scene_changes(video_path, threshold=0.3):
    """Detect visual scene changes via ffmpeg scdet."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        timestamps = re.findall(r"pts_time:([\d.]+)", result.stderr)
        return [float(t) for t in timestamps], None
    except Exception as e:
        return [], str(e)


def detect_loudness_surge(video_path, duration):
    """
    Detect a rapid energy ramp-up in the first 3 seconds.
    Measures RMS in 0.5s windows for the first 4 seconds.
    A hook signature: energy in [1.0-2.0s] window is > 5 dB above [0-0.5s] window.
    Returns (surge_db, pre_rms, hook_rms) or (None, None, None).
    """
    if duration < 2.0:
        return None, None, None

    # Extract just first 4 seconds to keep this fast
    cmd = [
        "ffmpeg", "-i", video_path,
        "-t", "4",
        "-af", (
            "astats=metadata=1:reset=1,"
            "ametadata=print:key=lavfi.astats.Overall.RMS_level"
        ),
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        rms_values = re.findall(
            r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr
        )
        floats = [float(v) for v in rms_values if float(v) > -100]
        if len(floats) < 2:
            return None, None, None

        # Window 0: pre-hook (first available window)
        pre_rms = floats[0]
        # Window 1-2: hook window
        hook_rms = sum(floats[1:3]) / len(floats[1:3]) if len(floats) >= 3 else floats[1]
        surge = hook_rms - pre_rms
        return round(surge, 1), round(pre_rms, 1), round(hook_rms, 1)
    except Exception as e:
        return None, None, None


def detect_pattern_interrupt(video_path):
    """
    Detect a deliberate silence gap (0.15-0.5s) in the first 3 seconds.
    A brief pause before the key phrase is a known pattern interrupt hook.
    Returns True if found, False otherwise.
    """
    cmd = [
        "ffmpeg", "-i", video_path,
        "-t", "3.0",
        "-af", "silencedetect=noise=-35dB:d=0.15",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        # Find silence events
        starts = re.findall(r"silence_start: ([\d.]+)", result.stderr)
        ends = re.findall(r"silence_end: ([\d.]+)", result.stderr)

        for i, start_s in enumerate(starts):
            start = float(start_s)
            # Only consider silences that begin after 0.3s (not pre-roll)
            if start < 0.3:
                continue
            if i < len(ends):
                end = float(ends[i])
                gap = end - start
                if 0.15 <= gap <= 0.6:
                    return True
        return False
    except Exception:
        return False


def extract_frame_brightness(video_path, timestamp):
    """
    Extract a single frame at given timestamp, return mean luma.
    Uses PPM format for pure Python pixel reading.
    """
    tmpdir = tempfile.mkdtemp(prefix="vq_hook_")
    out_path = os.path.join(tmpdir, "frame.ppm")

    cmd = [
        "ffmpeg", "-ss", str(timestamp),
        "-i", video_path,
        "-vframes", "1",
        "-pix_fmt", "rgb24",
        "-f", "image2",
        out_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            shutil.rmtree(tmpdir, ignore_errors=True)
            return None

        with open(out_path, "rb") as f:
            header = f.readline().strip()
            line = f.readline()
            while line.startswith(b"#"):
                line = f.readline()
            dims = line.strip().split()
            width, height = int(dims[0]), int(dims[1])
            f.readline()  # maxval
            pixels = f.read()

        num_pixels = width * height
        if num_pixels == 0:
            shutil.rmtree(tmpdir, ignore_errors=True)
            return None

        luma_sum = 0
        count = 0
        # Sample every 8th pixel for speed
        step = 8
        for i in range(0, min(len(pixels) - 2, num_pixels * 3), 3 * step):
            r, g, b = pixels[i], pixels[i + 1], pixels[i + 2]
            luma_sum += 0.2126 * r + 0.7152 * g + 0.0722 * b
            count += 1

        shutil.rmtree(tmpdir, ignore_errors=True)
        return luma_sum / count if count > 0 else None
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return None


def parse_transcript(transcript_path):
    """Parse a transcript file (JSON with timestamps or SRT format)."""
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

    segments = []
    blocks = re.split(r"\n\n+", content.strip())
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) >= 3:
            time_match = re.match(
                r"(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})",
                lines[1],
            )
            if time_match:
                g = time_match.groups()
                start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
                end = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 1000
                text = " ".join(lines[2:])
                segments.append({"start": start, "end": end, "text": text})

    return segments if segments else None


# CTA keyword patterns (expanded for 2025-2026 creator language)
CTA_PATTERNS = [
    r"\b(subscribe|like|comment|share|follow|click|tap|link|bio|description)\b",
    r"\b(check out|sign up|join|download|get|grab|visit|head to)\b",
    r"\b(let me know|tell me|drop a comment|hit the bell)\b",
    r"\b(swipe up|link in bio|pinned comment|in the comments)\b",
    r"\b(save this|bookmark|turn on notifications|notification bell)\b",
    r"\b(dm me|message me|reach out|connect with me)\b",
    r"\b(use code|promo code|discount|affiliate)\b",
]

# Verbal hook trigger patterns (curiosity gap / pattern interrupt phrases)
HOOK_VERBAL_PATTERNS = [
    r"\b(did you know|here'?s? (what|why|how)|you'?re? (doing|making)|most people)\b",
    r"\b(number[s]?|[0-9]+\s+(ways|tips|reasons|things|mistakes|steps))\b",
    r"\b(stop|wait|before you|i was wrong|i can'?t believe|this changed)\b",
    r"\b(what if|imagine|here'?s? the thing|the truth (is|about))\b",
    r"\b(nobody tells you|they don'?t want you|secret|hidden|untold)\b",
]


def score_hook_strength(
    energy_segments, scene_changes, duration,
    surge_db, pattern_interrupt, first_frame_luma, video_median_luma,
    transcript=None
):
    """
    v2: Score hook strength using surge detection, brightness burst,
    pattern interrupt, and scene changes. Removes flat energy comparison.
    """
    score = 40  # conservative baseline
    notes = []

    # --- Signal 1: Loudness surge ---
    if surge_db is not None:
        if surge_db >= 6:
            score += 20
            notes.append(
                f"Strong hook punch-in: +{surge_db:.0f} dB energy surge in first 2s"
            )
        elif surge_db >= 3:
            score += 12
            notes.append(f"Moderate energy ramp in first 2s (+{surge_db:.0f} dB)")
        elif surge_db <= -4:
            notes.append("Energy drops in first 2s -- opens quietly, may lose viewers")
        else:
            score += 5
            notes.append("Gradual audio start -- consider a louder opening punch")
    elif energy_segments:
        # Fallback: compare first 3s to video average
        fps_estimate = len(energy_segments) / duration if duration > 0 else 1
        first_3 = energy_segments[: max(1, int(3 * fps_estimate))]
        avg_all = sum(energy_segments) / len(energy_segments)
        avg_first = sum(first_3) / len(first_3)
        if avg_first > avg_all + 3:
            score += 15
            notes.append("Strong audio presence in first 3s")
        elif avg_first > avg_all - 3:
            score += 8
            notes.append("Average audio energy in first 3s")
        else:
            notes.append("Low audio energy in opening -- add verbal hook earlier")

    # --- Signal 2: Visual brightness burst ---
    if first_frame_luma is not None and video_median_luma is not None and video_median_luma > 0:
        brightness_ratio = first_frame_luma / video_median_luma
        if brightness_ratio >= 1.20:
            score += 12
            notes.append(
                f"Bright opening frame ({first_frame_luma:.0f} luma, "
                f"{brightness_ratio:.0%} of video median) -- visual hook"
            )
        elif brightness_ratio >= 1.08:
            score += 6
            notes.append("Slightly brighter opening frame")
        elif brightness_ratio < 0.80:
            notes.append("Dark opening frame -- consider a brighter or more dynamic first shot")

    # --- Signal 3: Pattern interrupt (deliberate silence) ---
    if pattern_interrupt:
        score += 12
        notes.append("Pattern interrupt: brief silence gap detected in first 3s (deliberate pause)")

    # --- Signal 4: Scene changes in first 3s ---
    early_scenes = [t for t in scene_changes if t <= 3.0]
    if len(early_scenes) >= 2:
        score += 12
        notes.append(f"{len(early_scenes)} scene changes in first 3s (dynamic opening)")
    elif len(early_scenes) == 1:
        score += 5
        notes.append("1 scene change in first 3s")
    else:
        notes.append("No scene changes in first 3s -- consider a dynamic cut")

    # --- Signal 5: Transcript verbal hook patterns ---
    if transcript:
        first_3s_text = " ".join(
            seg["text"] for seg in transcript if seg.get("start", 99) < 3.0
        ).strip().lower()
        if first_3s_text:
            word_count = len(first_3s_text.split())
            if word_count >= 5:
                score += 10
                notes.append(
                    f"Hook speech present ({word_count} words in 3s)"
                )
            if "?" in first_3s_text:
                score += 8
                notes.append("Opens with question (curiosity gap hook)")
            for pattern in HOOK_VERBAL_PATTERNS:
                if re.search(pattern, first_3s_text, re.IGNORECASE):
                    score += 8
                    match = re.search(pattern, first_3s_text, re.IGNORECASE)
                    notes.append(
                        f"Strong verbal hook pattern: '{match.group(0)}'"
                    )
                    break  # count only once
        else:
            notes.append("No speech in first 3s -- add verbal hook")

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes) if notes else "Audio-energy heuristics only",
    }


def score_cta_placement(transcript, duration):
    """Score CTA presence and placement timing."""
    if not transcript:
        return {
            "score": 30,
            "feedback": (
                "No transcript -- cannot analyze CTA. Provide transcript for full analysis."
            ),
            "raw": {},
        }

    cta_segments = []
    for seg in transcript:
        text = seg["text"].lower()
        for pattern in CTA_PATTERNS:
            if re.search(pattern, text):
                cta_segments.append(
                    {"time": seg.get("start", 0), "text": seg["text"][:80]}
                )
                break

    score = 50
    notes = []

    if not cta_segments:
        score = 20
        notes.append("No CTA detected -- add a call-to-action")
    else:
        score += 10
        notes.append(f"{len(cta_segments)} CTA moment(s) found")

        if duration > 0:
            cta_times = [c["time"] for c in cta_segments]
            last_ratio = max(cta_times) / duration

            if 0.7 <= last_ratio <= 0.95:
                score += 25
                notes.append(f"CTA at {last_ratio*100:.0f}% -- ideal end placement")
            elif last_ratio > 0.95:
                score += 10
                notes.append("CTA at very end -- move slightly earlier to avoid cutoff")
            elif last_ratio < 0.3:
                score += 5
                notes.append("CTA too early -- add another near the end")
            else:
                score += 15
                notes.append(f"CTA at {last_ratio*100:.0f}% of video")

        if len(cta_segments) >= 2:
            score += 10
            notes.append("Multiple CTA touchpoints -- reinforces engagement")

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes),
        "raw": {"cta_count": len(cta_segments), "cta_moments": cta_segments[:5]},
    }


def score_content_pacing(energy_segments, scene_changes, duration):
    """
    v2: Score pacing + re-hook detection at 20-40% mark.
    """
    score = 50
    notes = []

    if duration <= 0:
        return {"score": 50, "feedback": "Could not determine duration", "raw": {}}

    # Scene change frequency
    if scene_changes:
        changes_per_min = len(scene_changes) / (duration / 60)
        if 6 <= changes_per_min <= 30:
            score += 20
            notes.append(f"{changes_per_min:.1f} cuts/min (good visual variety)")
        elif 3 <= changes_per_min < 6:
            score += 12
            notes.append(f"{changes_per_min:.1f} cuts/min (could use more variety)")
        elif changes_per_min > 30:
            score += 8
            notes.append(f"{changes_per_min:.1f} cuts/min (very fast, verify not disorienting)")
        else:
            notes.append(f"{changes_per_min:.1f} cuts/min -- too static, add B-roll")
    else:
        notes.append("No scene changes -- add visual variety")

    # Re-hook detection at 20-40% mark
    if duration > 10 and scene_changes:
        window_start = duration * 0.20
        window_end = duration * 0.40
        rehook_scenes = [t for t in scene_changes if window_start <= t <= window_end]
        window_dur = window_end - window_start
        rehook_density = len(rehook_scenes) / window_dur if window_dur > 0 else 0
        overall_density = len(scene_changes) / duration if duration > 0 else 0
        if rehook_density > overall_density * 1.4:
            score += 18
            notes.append(
                f"Re-hook detected at 20-40% mark "
                f"({len(rehook_scenes)} cuts in {window_dur:.0f}s window vs "
                f"{overall_density * window_dur:.1f} expected) -- "
                "strong retention signal"
            )
        elif rehook_density > overall_density * 1.1:
            score += 8
            notes.append("Moderate re-hook activity at 20-40% mark")

    # Audio dynamics (vocal engagement)
    if energy_segments and len(energy_segments) > 10:
        avg_energy = sum(energy_segments) / len(energy_segments)
        variance = sum((e - avg_energy) ** 2 for e in energy_segments) / len(energy_segments)
        std_dev = variance ** 0.5
        if std_dev > 8:
            score += 15
            notes.append(f"Good vocal dynamics (energy std: {std_dev:.1f} dB)")
        elif std_dev > 4:
            score += 8
            notes.append(f"Moderate vocal dynamics (std: {std_dev:.1f} dB)")
        else:
            notes.append(f"Flat delivery (std: {std_dev:.1f} dB) -- vary tone")

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

    energy_segments, _ = measure_audio_energy_segments(video_path)
    scene_changes, _ = detect_scene_changes(video_path)

    # v2 signals
    surge_db, pre_rms, hook_rms = detect_loudness_surge(video_path, duration)
    pattern_interrupt = detect_pattern_interrupt(video_path)

    # Brightness burst: compare first frame to median of sampled frames
    first_frame_luma = extract_frame_brightness(video_path, 0.1)
    sample_lumas = []
    if duration > 5:
        for pct in [0.25, 0.50, 0.75]:
            luma = extract_frame_brightness(video_path, duration * pct)
            if luma is not None:
                sample_lumas.append(luma)
    video_median_luma = sorted(sample_lumas)[len(sample_lumas) // 2] if sample_lumas else None

    results = {
        "tool": "analyze-content-hooks",
        "version": TOOLS_VERSION,
        "video_path": video_path,
        "has_transcript": transcript is not None,
        "scores": {
            "hook_strength": score_hook_strength(
                energy_segments, scene_changes, duration,
                surge_db, pattern_interrupt, first_frame_luma, video_median_luma,
                transcript,
            ),
            "cta_placement": score_cta_placement(transcript, duration),
            "content_pacing": score_content_pacing(
                energy_segments, scene_changes, duration
            ),
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
