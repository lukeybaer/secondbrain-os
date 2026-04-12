#!/usr/bin/env python3
"""
Video Thumbnail Quality Analyzer
Extracts candidate thumbnail frames and scores them for:
  - Contrast and visibility
  - Color vibrancy
  - Composition (rule of thirds)
  - Face/subject presence (edge density as proxy)
  - Text readability at mobile size

Uses ffmpeg for frame extraction and pure Python pixel analysis.

Usage:
    python analyze-thumbnail.py <video_path> [--thumbnail <image_path>]

If --thumbnail is given, scores that image directly.
Otherwise, extracts 5 candidate frames and scores each, recommending the best.

Returns JSON with scores (0-100) per candidate and recommendations.
"""

import subprocess
import json
import sys
import os
import math
import tempfile
import shutil


def extract_thumbnail_candidates(video_path, num_candidates=5):
    """Extract candidate thumbnail frames at key moments."""
    tmpdir = tempfile.mkdtemp(prefix="vq_thumb_")

    # Get duration
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-print_format", "json",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        duration = float(json.loads(result.stdout).get("format", {}).get("duration", 0))
    except Exception:
        duration = 0

    if duration <= 0:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return [], None

    # Extract at strategic points: 10%, 25%, 40%, 60%, 75% of video
    # These typically have good content moments
    percentages = [0.10, 0.25, 0.40, 0.60, 0.75]
    timestamps = [duration * p for p in percentages[:num_candidates]]

    frame_files = []
    for i, ts in enumerate(timestamps):
        out_path = os.path.join(tmpdir, f"thumb_{i:02d}.ppm")
        cmd = [
            "ffmpeg", "-ss", str(ts),
            "-i", video_path,
            "-vframes", "1",
            "-pix_fmt", "rgb24",
            "-f", "image2",
            out_path,
        ]
        try:
            subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                frame_files.append({"path": out_path, "timestamp": round(ts, 1), "index": i})
        except Exception:
            continue

    return frame_files, tmpdir


def extract_single_thumbnail(image_path):
    """Convert a given image to PPM for analysis."""
    tmpdir = tempfile.mkdtemp(prefix="vq_thumb_")
    out_path = os.path.join(tmpdir, "thumb.ppm")

    cmd = [
        "ffmpeg", "-i", image_path,
        "-pix_fmt", "rgb24",
        "-f", "image2",
        out_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if os.path.exists(out_path):
            return [{"path": out_path, "timestamp": 0, "index": 0, "source": image_path}], tmpdir
    except Exception:
        pass

    shutil.rmtree(tmpdir, ignore_errors=True)
    return [], None


def read_ppm_pixels(ppm_path):
    """Read a raw PPM (P6) file."""
    with open(ppm_path, "rb") as f:
        header = f.readline().strip()
        line = f.readline()
        while line.startswith(b"#"):
            line = f.readline()
        dims = line.strip().split()
        width, height = int(dims[0]), int(dims[1])
        f.readline()  # maxval
        pixels = f.read()
    return width, height, pixels


def score_thumbnail_frame(ppm_path):
    """Score a single thumbnail frame on multiple criteria."""
    width, height, pixels = read_ppm_pixels(ppm_path)
    num_pixels = width * height

    if num_pixels == 0:
        return None

    r_vals = []
    g_vals = []
    b_vals = []
    luma_vals = []

    for i in range(0, min(len(pixels), num_pixels * 3), 3):
        r, g, b = pixels[i], pixels[i + 1], pixels[i + 2]
        r_vals.append(r)
        g_vals.append(g)
        b_vals.append(b)
        luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
        luma_vals.append(luma)

    n = len(luma_vals)
    if n == 0:
        return None

    # === 1. CONTRAST SCORE ===
    # Standard deviation of luminance -- higher = more contrast = more eye-catching
    mean_luma = sum(luma_vals) / n
    variance = sum((v - mean_luma) ** 2 for v in luma_vals) / n
    luma_std = math.sqrt(variance)

    # Good thumbnails have luma_std > 50
    if luma_std >= 60:
        contrast_score = 100
        contrast_note = f"High contrast (std: {luma_std:.0f}) -- eye-catching"
    elif luma_std >= 45:
        contrast_score = 80
        contrast_note = f"Good contrast (std: {luma_std:.0f})"
    elif luma_std >= 30:
        contrast_score = 55
        contrast_note = f"Moderate contrast (std: {luma_std:.0f}) -- could pop more"
    else:
        contrast_score = 30
        contrast_note = f"Low contrast (std: {luma_std:.0f}) -- will look flat at small size"

    # === 2. COLOR VIBRANCY ===
    saturations = []
    for i in range(n):
        cmax = max(r_vals[i], g_vals[i], b_vals[i])
        cmin = min(r_vals[i], g_vals[i], b_vals[i])
        if cmax > 0:
            saturations.append((cmax - cmin) / cmax)
        else:
            saturations.append(0)
    avg_saturation = sum(saturations) / n

    # Thumbnails benefit from slightly higher saturation than video frames
    if 0.35 <= avg_saturation <= 0.65:
        vibrancy_score = 100
        vibrancy_note = f"Vibrant colors (sat: {avg_saturation:.2f}) -- stands out in feed"
    elif 0.25 <= avg_saturation < 0.35:
        vibrancy_score = 70
        vibrancy_note = f"Moderate color (sat: {avg_saturation:.2f}) -- boost saturation for thumbnail"
    elif avg_saturation > 0.65:
        vibrancy_score = 65
        vibrancy_note = f"Oversaturated (sat: {avg_saturation:.2f}) -- may look unnatural"
    else:
        vibrancy_score = 40
        vibrancy_note = f"Dull colors (sat: {avg_saturation:.2f}) -- significantly boost for thumbnail use"

    # === 3. COMPOSITION (Rule of Thirds) ===
    # Compute edge density in rule-of-thirds zones
    # High edge density at intersection points = good subject placement
    edge_density_map = {}
    for zone_name, (x_start_pct, x_end_pct, y_start_pct, y_end_pct) in {
        "top_left_third": (0.25, 0.42, 0.25, 0.42),
        "top_right_third": (0.58, 0.75, 0.25, 0.42),
        "bottom_left_third": (0.25, 0.42, 0.58, 0.75),
        "bottom_right_third": (0.58, 0.75, 0.58, 0.75),
        "center": (0.35, 0.65, 0.35, 0.65),
    }.items():
        x_start = int(width * x_start_pct)
        x_end = int(width * x_end_pct)
        y_start = int(height * y_start_pct)
        y_end = int(height * y_end_pct)

        zone_edge_sum = 0
        zone_count = 0
        for row in range(max(1, y_start), min(height - 1, y_end)):
            for col in range(max(1, x_start), min(width - 1, x_end)):
                idx = row * width + col
                if idx + 1 < n and idx - 1 >= 0:
                    h_grad = abs(luma_vals[idx + 1] - luma_vals[idx - 1])
                    v_idx_up = (row - 1) * width + col
                    v_idx_down = (row + 1) * width + col
                    if v_idx_up >= 0 and v_idx_down < n:
                        v_grad = abs(luma_vals[v_idx_down] - luma_vals[v_idx_up])
                        zone_edge_sum += (h_grad + v_grad)
                        zone_count += 1

        edge_density_map[zone_name] = zone_edge_sum / zone_count if zone_count > 0 else 0

    # Good composition: high edge density in thirds intersections or center
    thirds_density = max(
        edge_density_map.get("top_left_third", 0),
        edge_density_map.get("top_right_third", 0),
        edge_density_map.get("bottom_left_third", 0),
        edge_density_map.get("bottom_right_third", 0),
    )
    center_density = edge_density_map.get("center", 0)
    best_density = max(thirds_density, center_density)

    if best_density >= 30:
        composition_score = 90
        composition_note = "Strong subject presence at focal points"
    elif best_density >= 20:
        composition_score = 70
        composition_note = "Moderate subject presence"
    elif best_density >= 10:
        composition_score = 50
        composition_note = "Weak subject placement -- position subject at rule-of-thirds intersections"
    else:
        composition_score = 30
        composition_note = "Low visual interest at focal points -- reframe subject"

    # === 4. BRIGHTNESS / VISIBILITY ===
    # Thumbnails need good brightness to be visible at small sizes
    if 100 <= mean_luma <= 180:
        brightness_score = 100
        brightness_note = "Good brightness for thumbnail visibility"
    elif 70 <= mean_luma < 100:
        brightness_score = 70
        brightness_note = "Slightly dark -- brighten for thumbnail use"
    elif 180 < mean_luma <= 210:
        brightness_score = 75
        brightness_note = "Slightly bright -- may wash out at small size"
    elif mean_luma < 70:
        brightness_score = 40
        brightness_note = f"Too dark ({mean_luma:.0f}/255) -- will be invisible in feed"
    else:
        brightness_score = 45
        brightness_note = f"Too bright ({mean_luma:.0f}/255) -- overexposed for thumbnail"

    # === 5. OVERALL THUMBNAIL SCORE ===
    overall = round(
        contrast_score * 0.25 +
        vibrancy_score * 0.20 +
        composition_score * 0.30 +
        brightness_score * 0.25
    )

    # CTR estimate (baseline ~3.5% average, good thumbnails 7-10%)
    baseline_ctr = 3.5
    ctr_multiplier = 0.7 + (overall / 100) * 1.3  # Range: 0.7x to 2.0x
    estimated_ctr = round(baseline_ctr * ctr_multiplier, 1)

    if overall >= 80:
        quality_label = "Excellent"
    elif overall >= 65:
        quality_label = "Good"
    elif overall >= 50:
        quality_label = "Fair"
    else:
        quality_label = "Poor"

    recommendations = []
    if contrast_score < 70:
        recommendations.append("Increase contrast -- add text overlay or darken background")
    if vibrancy_score < 70:
        recommendations.append("Boost color saturation by 15-25% for thumbnail version")
    if composition_score < 70:
        recommendations.append("Reframe: place subject face at rule-of-thirds intersection")
    if brightness_score < 70:
        recommendations.append("Adjust brightness -- thumbnails need to pop at 120x90px")

    return {
        "overall_score": overall,
        "quality_label": quality_label,
        "estimated_ctr_pct": estimated_ctr,
        "ctr_multiplier": round(ctr_multiplier, 2),
        "scores": {
            "contrast": {"score": contrast_score, "feedback": contrast_note},
            "vibrancy": {"score": vibrancy_score, "feedback": vibrancy_note},
            "composition": {"score": composition_score, "feedback": composition_note},
            "brightness": {"score": brightness_score, "feedback": brightness_note},
        },
        "recommendations": recommendations,
    }


def analyze(video_path, thumbnail_path=None):
    """Run thumbnail analysis on video or provided image."""
    if thumbnail_path:
        if not os.path.exists(thumbnail_path):
            return {"error": f"Thumbnail not found: {thumbnail_path}"}
        candidates, tmpdir = extract_single_thumbnail(thumbnail_path)
    else:
        if not os.path.exists(video_path):
            return {"error": f"Video not found: {video_path}"}
        candidates, tmpdir = extract_thumbnail_candidates(video_path)

    if not candidates:
        return {"error": "Could not extract thumbnail candidates"}

    results = {
        "tool": "analyze-thumbnail",
        "version": "1.0.0",
        "video_path": video_path,
        "thumbnail_provided": thumbnail_path is not None,
        "candidates": [],
        "warnings": [],
    }

    best_score = -1
    best_idx = 0

    for candidate in candidates:
        try:
            score_data = score_thumbnail_frame(candidate["path"])
            if score_data:
                entry = {
                    "index": candidate["index"],
                    "timestamp_s": candidate["timestamp"],
                    **score_data,
                }
                results["candidates"].append(entry)

                if score_data["overall_score"] > best_score:
                    best_score = score_data["overall_score"]
                    best_idx = candidate["index"]
        except Exception as e:
            results["warnings"].append(f"Failed to score candidate {candidate['index']}: {str(e)}")

    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if results["candidates"]:
        best_candidate = next((c for c in results["candidates"] if c["index"] == best_idx), results["candidates"][0])
        results["best_candidate"] = {
            "index": best_idx,
            "timestamp_s": best_candidate["timestamp_s"],
            "score": best_candidate["overall_score"],
            "quality_label": best_candidate["quality_label"],
            "estimated_ctr_pct": best_candidate["estimated_ctr_pct"],
        }
        results["overall_score"] = best_candidate["overall_score"]

        # Summary scores for rubric integration
        results["scores"] = {
            "thumbnail_appeal": {
                "score": best_candidate["overall_score"],
                "feedback": f"Best thumbnail at {best_candidate['timestamp_s']}s: {best_candidate['quality_label']} (est. CTR: {best_candidate['estimated_ctr_pct']}%). " +
                           "; ".join(best_candidate.get("recommendations", [])[:2]),
            }
        }
    else:
        results["overall_score"] = 0

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-thumbnail.py <video_path> [--thumbnail <image_path>]")
        sys.exit(1)

    video_path = sys.argv[1]
    thumbnail_path = None
    if "--thumbnail" in sys.argv:
        idx = sys.argv.index("--thumbnail")
        if idx + 1 < len(sys.argv):
            thumbnail_path = sys.argv[idx + 1]

    result = analyze(video_path, thumbnail_path)
    print(json.dumps(result, indent=2))
