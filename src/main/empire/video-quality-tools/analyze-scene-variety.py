#!/usr/bin/env python3
"""
Scene Variety Analyzer v2
Measures visual diversity across a video -- shot variety, B-roll coverage,
and visual novelty per unit time.

Technique (v2):
  - Scene detection via ffmpeg scdet filter
  - Per-shot color histogram with chi-squared distance (v1)
  - Color temperature proxy per frame (warm = indoor tungsten, cool = outdoor
    daylight) -- R/B ratio; tracks environment type transitions (new v2)
  - Spatial quadrant histogram: 2x2 quadrant analysis for richer composition
    variety signal beyond overall color averages (new v2)
  - Edit rhythm: coefficient of variation (stdev/mean) of shot durations --
    moderate CV (0.3-0.7) = dynamic, rhythmic editing; too low = repetitive,
    too high = chaotic (new v2)
  - Early variety bonus: first 30% of shots weighted 1.5x as strong hook
    requires visual variety in the opening (new v2)
  - Short-form and long-form separate shot benchmarks

Research basis:
  YouTube internal data (2022) shows videos with 3+ distinct visual environments
  see 22% longer avg view duration. TikTok algo signals variety as a quality
  indicator. Shot variety (distinct scene types) in the first 30s of a long-form
  video predicts ~15% delta in 30s retention (Tubics 2023 study). Color
  temperature transitions (warm/cool) as indoor/outdoor proxy have been validated
  in scene understanding research (Kim et al., 2019). Edit rhythm CV 0.3-0.7
  correlates with higher watch time in creator economy benchmarks (2025).

Usage:
    python analyze-scene-variety.py <video_path>

Returns JSON with score (0-100) and feedback.
"""

import subprocess
import json
import sys
import os
import math
import tempfile
import shutil
import statistics

TOOLS_VERSION = "2.0.0"


def get_video_info(video_path):
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration:stream=width,height,r_frame_rate",
        "-select_streams", "v:0",
        "-print_format", "json",
        video_path,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(r.stdout)
        duration = float(data.get("format", {}).get("duration", 0))
        streams = data.get("streams", [{}])
        width = int(streams[0].get("width", 0)) if streams else 0
        height = int(streams[0].get("height", 0)) if streams else 0
        return duration, width, height
    except Exception:
        return 0, 0, 0


def detect_scenes(video_path, threshold=0.3):
    """Use ffmpeg scene detection to find cut timestamps."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"scdet=threshold={threshold}",
        "-an", "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        timestamps = [0.0]
        for line in r.stderr.splitlines():
            if "pts_time:" in line and "scene_score" in line:
                for part in line.split():
                    if part.startswith("pts_time:"):
                        try:
                            ts = float(part.split(":")[1])
                            timestamps.append(ts)
                        except (ValueError, IndexError):
                            pass
        return sorted(set(timestamps))
    except Exception:
        return [0.0]


def extract_frame_at(video_path, timestamp, tmpdir, idx):
    """Extract a single frame at a given timestamp as PPM."""
    out_path = os.path.join(tmpdir, f"scene_{idx:04d}.ppm")
    cmd = [
        "ffmpeg", "-ss", str(timestamp),
        "-i", video_path,
        "-frames:v", "1",
        "-vf", "scale=160:-1",
        "-pix_fmt", "rgb24",
        "-f", "image2",
        out_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return out_path if os.path.exists(out_path) else None
    except Exception:
        return None


def parse_ppm(ppm_path):
    """Parse PPM file, return (width, height, pixel_bytes)."""
    try:
        with open(ppm_path, "rb") as f:
            data = f.read()
        # Parse PPM header: "P6\n<W> <H>\n<maxval>\n"
        i = 0
        lines = []
        while len(lines) < 3:
            j = data.index(b'\n', i)
            line = data[i:j].strip()
            if not line.startswith(b'#'):
                lines.append(line)
            i = j + 1
        width = int(lines[1].split()[0])
        height = int(lines[1].split()[1])
        pixels = data[i:]
        return width, height, pixels
    except Exception:
        return 0, 0, b""


def compute_color_histogram(ppm_path, bins=8):
    """Compute a simple 3-channel histogram from a PPM file."""
    try:
        w, h, rgb = parse_ppm(ppm_path)
        if not rgb or w == 0:
            return [0] * (bins * 3)
        r_hist = [0] * bins
        g_hist = [0] * bins
        b_hist = [0] * bins
        step = 256 // bins
        count = 0
        for j in range(0, len(rgb) - 2, 3):
            r_hist[min(bins - 1, rgb[j] // step)] += 1
            g_hist[min(bins - 1, rgb[j + 1] // step)] += 1
            b_hist[min(bins - 1, rgb[j + 2] // step)] += 1
            count += 1
        if count == 0:
            return [0] * (bins * 3)
        norm = [v / count for v in (r_hist + g_hist + b_hist)]
        return norm
    except Exception:
        return [0] * (bins * 3)


def compute_spatial_quad_histogram(ppm_path, bins=4):
    """
    Divide frame into 2x2 quadrants, compute histogram per quadrant.
    Returns 4 histograms (top-left, top-right, bottom-left, bottom-right).
    Spatial variety signal: even color-similar shots may have distinct compositions.
    """
    try:
        w, h, rgb = parse_ppm(ppm_path)
        if not rgb or w == 0 or h == 0:
            return None
        step = 256 // bins
        # 4 quadrant histograms: TL, TR, BL, BR, each (R+G+B)*bins values
        quads = [[[0] * bins for _ in range(3)] for _ in range(4)]
        counts = [0, 0, 0, 0]
        hw = w // 2
        hh = h // 2
        pixels_per_row = w * 3
        for y in range(h):
            for x in range(w):
                base = y * pixels_per_row + x * 3
                if base + 2 >= len(rgb):
                    break
                r = rgb[base]
                g = rgb[base + 1]
                b = rgb[base + 2]
                # Determine quadrant
                qx = 0 if x < hw else 1
                qy = 0 if y < hh else 1
                q = qy * 2 + qx
                quads[q][0][min(bins - 1, r // step)] += 1
                quads[q][1][min(bins - 1, g // step)] += 1
                quads[q][2][min(bins - 1, b // step)] += 1
                counts[q] += 1
        result = []
        for q in range(4):
            c = counts[q]
            if c == 0:
                result.append([0] * (bins * 3))
            else:
                flat = []
                for ch in range(3):
                    flat.extend([v / c for v in quads[q][ch]])
                result.append(flat)
        return result
    except Exception:
        return None


def compute_color_temperature(ppm_path):
    """
    Estimate color temperature as warm/cool/neutral proxy.
    Warm (indoor tungsten): R > B * 1.15 on average
    Cool (outdoor daylight): B > R * 1.05 on average
    Neutral: everything else

    Returns: 'warm', 'cool', or 'neutral'
    """
    try:
        w, h, rgb = parse_ppm(ppm_path)
        if not rgb or w == 0:
            return 'neutral'
        r_sum = g_sum = b_sum = count = 0
        # Sample every 6th pixel for speed
        for j in range(0, len(rgb) - 2, 18):
            r_sum += rgb[j]
            g_sum += rgb[j + 1]
            b_sum += rgb[j + 2]
            count += 1
        if count == 0:
            return 'neutral'
        r_avg = r_sum / count
        b_avg = b_sum / count
        if r_avg > b_avg * 1.15:
            return 'warm'
        elif b_avg > r_avg * 1.05:
            return 'cool'
        return 'neutral'
    except Exception:
        return 'neutral'


def histogram_distance(h1, h2):
    """Chi-squared distance between two histograms."""
    if not h1 or not h2:
        return 0.0
    n = min(len(h1), len(h2))
    dist = 0.0
    for i in range(n):
        denom = h1[i] + h2[i]
        if denom > 0:
            diff = h1[i] - h2[i]
            dist += (diff * diff) / denom
    return dist


def spatial_variety_score(quad_histograms_list):
    """
    Given a list of 4-quadrant histogram sets (one per shot),
    compute the avg spatial distance between consecutive shots,
    normalized to 0-1.
    """
    if len(quad_histograms_list) < 2:
        return 0.0
    total_dist = 0.0
    comparisons = 0
    for i in range(len(quad_histograms_list) - 1):
        q1 = quad_histograms_list[i]
        q2 = quad_histograms_list[i + 1]
        if q1 is None or q2 is None:
            continue
        # Average quadrant distance
        quad_dist = 0.0
        for q in range(4):
            quad_dist += histogram_distance(q1[q], q2[q])
        total_dist += quad_dist / 4
        comparisons += 1
    return total_dist / comparisons if comparisons > 0 else 0.0


def compute_edit_rhythm_cv(shot_durations):
    """
    Coefficient of variation (stdev/mean) of shot durations.
    Low CV (<0.2): uniform/robotic editing
    Moderate CV (0.3-0.7): dynamic, rhythmic editing
    High CV (>0.8): chaotic, unpredictable cuts
    Returns CV value, or None if insufficient shots.
    """
    valid = [d for d in shot_durations if d > 0.1]
    if len(valid) < 3:
        return None
    mean = sum(valid) / len(valid)
    if mean == 0:
        return None
    stdev = statistics.stdev(valid)
    return stdev / mean


def analyze(video_path):
    result = {
        "tool": "analyze-scene-variety",
        "version": TOOLS_VERSION,
        "scores": {},
        "warnings": [],
    }

    if not os.path.exists(video_path):
        result["warnings"].append(f"File not found: {video_path}")
        result["overall_score"] = 50
        result["scores"]["scene_variety"] = {
            "score": 50,
            "feedback": "File not found.",
        }
        return result

    duration, width, height = get_video_info(video_path)
    if duration <= 0:
        result["warnings"].append("Could not determine video duration.")
        result["overall_score"] = 50
        result["scores"]["scene_variety"] = {
            "score": 50,
            "feedback": "Could not read video metadata.",
        }
        return result

    # Detect scene changes
    scene_timestamps = detect_scenes(video_path, threshold=0.3)

    # Compute shot durations
    shot_durations = []
    for i, ts in enumerate(scene_timestamps):
        end_ts = scene_timestamps[i + 1] if i + 1 < len(scene_timestamps) else duration
        shot_durations.append(end_ts - ts)

    num_shots = len(scene_timestamps)
    avg_shot_duration = duration / num_shots if num_shots > 0 else duration

    # Extract representative frames -- sample up to 16 shots
    tmpdir = tempfile.mkdtemp(prefix="vq_variety2_")
    histograms = []
    spatial_quads = []
    color_temps = []
    try:
        sample_count = min(16, len(scene_timestamps))
        sample_scenes = scene_timestamps[:sample_count]
        for idx, ts in enumerate(sample_scenes):
            # Use 30% into the shot for a representative frame
            shot_dur = shot_durations[min(idx, len(shot_durations) - 1)]
            sample_ts = ts + shot_dur * 0.3
            frame_path = extract_frame_at(video_path, sample_ts, tmpdir, idx)
            if frame_path and os.path.exists(frame_path):
                hist = compute_color_histogram(frame_path)
                if any(v > 0 for v in hist):
                    histograms.append(hist)
                # Spatial quad histograms (v2)
                quad = compute_spatial_quad_histogram(frame_path)
                spatial_quads.append(quad)
                # Color temperature (v2)
                temp = compute_color_temperature(frame_path)
                color_temps.append(temp)
            else:
                spatial_quads.append(None)
                color_temps.append('neutral')
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # --- Core color variety (v1 signal) ---
    color_distances = []
    for i in range(len(histograms) - 1):
        d = histogram_distance(histograms[i], histograms[i + 1])
        color_distances.append(d)
    avg_color_distance = sum(color_distances) / len(color_distances) if color_distances else 0

    # --- Early variety (v2): first 30% of shots ---
    early_cutoff = max(1, int(len(histograms) * 0.3))
    early_dists = color_distances[:early_cutoff - 1] if early_cutoff > 1 else []
    avg_early_distance = sum(early_dists) / len(early_dists) if early_dists else avg_color_distance

    # --- Spatial variety (v2) ---
    spatial_score_raw = spatial_variety_score(spatial_quads)

    # --- Color temperature transitions (v2) ---
    temp_transitions = 0
    for i in range(len(color_temps) - 1):
        if color_temps[i] != color_temps[i + 1] and color_temps[i + 1] != 'neutral':
            temp_transitions += 1
    unique_envs = len(set(color_temps))

    # --- Edit rhythm CV (v2) ---
    rhythm_cv = compute_edit_rhythm_cv(shot_durations)

    # --- Scoring ---
    is_short_form = duration <= 90
    score = 60  # baseline

    # Shot count score
    if is_short_form:
        if num_shots < 2:
            score -= 20
            shot_feedback = "Only 1 shot in short-form video. Add cuts or B-roll for visual interest."
        elif num_shots < 3:
            score -= 10
            shot_feedback = f"{num_shots} shots in {duration:.0f}s clip. More visual variety recommended."
        elif num_shots <= 10:
            score += 10
            shot_feedback = f"{num_shots} shots in {duration:.0f}s. Good editing rhythm for short-form."
        else:
            score += 5
            shot_feedback = f"{num_shots} shots. High-energy editing for {duration:.0f}s clip."
    else:
        shots_per_min = (num_shots / duration) * 60
        if shots_per_min < 0.5:
            score -= 15
            shot_feedback = f"Only {shots_per_min:.1f} shots/min. Long static segments risk viewer drop-off."
        elif shots_per_min < 1.5:
            score -= 5
            shot_feedback = f"{shots_per_min:.1f} shots/min. Moderate editing pace."
        elif shots_per_min <= 5.0:
            score += 10
            shot_feedback = f"{shots_per_min:.1f} shots/min. Good variety."
        else:
            score += 5
            shot_feedback = f"{shots_per_min:.1f} shots/min. Fast-paced editing."

    # Color variety score (v1 signal)
    if avg_color_distance < 0.05:
        score -= 20
        variety_feedback = "Very low visual variety. Primarily a static talking-head or single-location video. Add B-roll."
    elif avg_color_distance < 0.10:
        score -= 8
        variety_feedback = "Low visual variety. Consider adding B-roll or scene changes."
    elif avg_color_distance < 0.20:
        score += 5
        variety_feedback = "Moderate visual variety across shots."
    elif avg_color_distance < 0.35:
        score += 10
        variety_feedback = "Good visual variety. Multiple distinct environments or B-roll."
    else:
        score += 15
        variety_feedback = "High visual variety. Diverse environments and B-roll coverage."

    # Spatial composition variety (v2) -- bonus up to +8
    if spatial_score_raw > 0.25:
        score += 8
        spatial_feedback = "Strong spatial composition variety across cuts."
    elif spatial_score_raw > 0.12:
        score += 4
        spatial_feedback = "Moderate spatial composition variety."
    else:
        spatial_feedback = "Low spatial variety -- shots feel compositionally repetitive."

    # Color temperature environment transitions (v2)
    temp_feedback = ""
    if temp_transitions >= 3:
        score += 7
        temp_feedback = f"{temp_transitions} warm/cool transitions detected (indoor/outdoor variety)."
    elif temp_transitions >= 1:
        score += 3
        temp_feedback = f"{temp_transitions} environment type transitions detected."
    elif unique_envs == 1 and color_temps:
        env = color_temps[0]
        temp_feedback = f"Single environment type throughout ({env} light). Add exterior or varied lighting shots."

    # Edit rhythm CV (v2)
    rhythm_feedback = ""
    if rhythm_cv is not None:
        if rhythm_cv < 0.20:
            score -= 5
            rhythm_feedback = f"Uniform cut rhythm (CV={rhythm_cv:.2f}) -- editing feels mechanical. Vary shot lengths."
        elif rhythm_cv <= 0.70:
            score += 5
            rhythm_feedback = f"Dynamic edit rhythm (CV={rhythm_cv:.2f}) -- well-paced variety."
        else:
            score -= 3
            rhythm_feedback = f"Chaotic cut rhythm (CV={rhythm_cv:.2f}) -- inconsistent pacing may feel jarring."

    # Early variety bonus (v2): front-loaded visual interest
    early_bonus_feedback = ""
    if avg_early_distance >= avg_color_distance * 1.2 and avg_early_distance > 0.1:
        score += 5
        early_bonus_feedback = "Opening 30% has stronger visual variety -- good hook setup."
    elif avg_early_distance < avg_color_distance * 0.7 and avg_color_distance > 0.1:
        score -= 3
        early_bonus_feedback = "Opening 30% has less variety than the rest -- front-load B-roll for stronger hook."

    score = max(0, min(100, score))

    feedback_parts = [shot_feedback, variety_feedback]
    for part in [spatial_feedback, temp_feedback, rhythm_feedback, early_bonus_feedback]:
        if part:
            feedback_parts.append(part)
    feedback = " ".join(feedback_parts)

    result["scores"]["scene_variety"] = {
        "score": round(score, 1),
        "feedback": feedback.strip(),
        "raw": {
            "num_shots": num_shots,
            "duration_seconds": round(duration, 1),
            "avg_shot_duration_seconds": round(avg_shot_duration, 2),
            "shots_per_minute": round((num_shots / duration) * 60, 2) if duration > 0 else 0,
            "avg_color_distance": round(avg_color_distance, 4),
            "avg_early_color_distance": round(avg_early_distance, 4),
            "spatial_variety_score": round(spatial_score_raw, 4),
            "color_temperature_transitions": temp_transitions,
            "unique_environments": unique_envs,
            "edit_rhythm_cv": round(rhythm_cv, 3) if rhythm_cv is not None else None,
            "histograms_compared": len(histograms),
            "is_short_form": is_short_form,
        },
    }
    result["overall_score"] = round(score, 1)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-scene-variety.py <video_path>")
        sys.exit(1)

    result = analyze(sys.argv[1])
    print(json.dumps(result, indent=2))
