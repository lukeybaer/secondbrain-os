#!/usr/bin/env python3
"""
Video Visual Quality Analyzer
Evaluates: clarity/sharpness, lighting/exposure, color consistency, scene transition smoothness
Uses ffmpeg frame extraction + pixel analysis without requiring OpenCV or GPU.

Usage:
    python analyze-visual-quality.py <video_path> [--sample-frames 30]

Returns JSON with scores (0-100) and feedback for each criterion.
"""

import subprocess
import json
import sys
import os
import math
import re
import tempfile
import shutil


def extract_sample_frames(video_path, num_frames=30):
    """Extract evenly-spaced raw frames as PPM images to a temp directory."""
    tmpdir = tempfile.mkdtemp(prefix="vq_frames_")

    # Get duration first
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
        return [], 0, None

    # Extract frames at uniform intervals using fps filter
    fps_val = num_frames / duration
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"fps={fps_val:.6f},scale=320:-1",
        "-pix_fmt", "rgb24",
        "-f", "image2",
        os.path.join(tmpdir, "frame_%04d.ppm"),
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return [], duration, None

    frame_files = sorted([
        os.path.join(tmpdir, f) for f in os.listdir(tmpdir) if f.endswith(".ppm")
    ])
    return frame_files, duration, tmpdir


def read_ppm_pixels(ppm_path):
    """Read a raw PPM (P6) file and return (width, height, pixel_bytes)."""
    with open(ppm_path, "rb") as f:
        header = f.readline().strip()  # P6
        # Skip comments
        line = f.readline()
        while line.startswith(b"#"):
            line = f.readline()
        dims = line.strip().split()
        width, height = int(dims[0]), int(dims[1])
        f.readline()  # maxval (255)
        pixels = f.read()
    return width, height, pixels


def compute_frame_metrics(ppm_path):
    """Compute per-frame quality metrics from a PPM image."""
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

    avg_brightness = sum(luma_vals) / n
    shadows = sum(1 for v in luma_vals if v < 50) / n
    midtones = sum(1 for v in luma_vals if 50 <= v <= 200) / n
    highlights = sum(1 for v in luma_vals if v > 200) / n

    luma_min = min(luma_vals)
    luma_max = max(luma_vals)
    mean_l = avg_brightness
    variance = sum((v - mean_l) ** 2 for v in luma_vals) / n
    luma_std = math.sqrt(variance)

    # Sharpness via Laplacian (horizontal + vertical 2nd derivatives)
    gradient_sq_sum = 0
    gradient_count = 0
    for row in range(height):
        for col in range(1, width - 1):
            idx = row * width + col
            if idx < n and idx - 1 >= 0 and idx + 1 < n:
                laplacian = luma_vals[idx - 1] - 2 * luma_vals[idx] + luma_vals[idx + 1]
                gradient_sq_sum += laplacian * laplacian
                gradient_count += 1

    v_gradient_sq_sum = 0
    v_gradient_count = 0
    for row in range(1, height - 1):
        for col in range(width):
            idx = row * width + col
            idx_up = (row - 1) * width + col
            idx_down = (row + 1) * width + col
            if idx < n and idx_up >= 0 and idx_down < n:
                laplacian = luma_vals[idx_up] - 2 * luma_vals[idx] + luma_vals[idx_down]
                v_gradient_sq_sum += laplacian * laplacian
                v_gradient_count += 1

    h_sharp = gradient_sq_sum / gradient_count if gradient_count > 0 else 0
    v_sharp = v_gradient_sq_sum / v_gradient_count if v_gradient_count > 0 else 0
    combined_sharpness = (h_sharp + v_sharp) / 2

    # Color saturation (HSV-style)
    saturations = []
    for i in range(n):
        cmax = max(r_vals[i], g_vals[i], b_vals[i])
        cmin = min(r_vals[i], g_vals[i], b_vals[i])
        if cmax > 0:
            saturations.append((cmax - cmin) / cmax)
        else:
            saturations.append(0)
    avg_saturation = sum(saturations) / n

    return {
        "brightness": avg_brightness,
        "shadows_pct": round(shadows, 3),
        "midtones_pct": round(midtones, 3),
        "highlights_pct": round(highlights, 3),
        "contrast_range": luma_max - luma_min,
        "luma_std": luma_std,
        "sharpness_variance": combined_sharpness,
        "saturation": avg_saturation,
        "width": width,
        "height": height,
    }


def score_clarity(frame_metrics_list):
    """Score visual clarity/sharpness across sampled frames."""
    if not frame_metrics_list:
        return {"score": 0, "feedback": "No frames analyzed", "raw": {}}

    sharpness_vals = [m["sharpness_variance"] for m in frame_metrics_list]
    avg_sharpness = sum(sharpness_vals) / len(sharpness_vals)

    score = 100
    notes = []

    if avg_sharpness >= 200:
        notes.append(f"Sharpness: {avg_sharpness:.0f} (excellent, very crisp image)")
    elif avg_sharpness >= 100:
        score -= 10
        notes.append(f"Sharpness: {avg_sharpness:.0f} (good clarity)")
    elif avg_sharpness >= 50:
        score -= 30
        notes.append(f"Sharpness: {avg_sharpness:.0f} (somewhat soft, check focus/encoding)")
    elif avg_sharpness >= 20:
        score -= 50
        notes.append(f"Sharpness: {avg_sharpness:.0f} (blurry, re-record or sharpen in post)")
    else:
        score -= 70
        notes.append(f"Sharpness: {avg_sharpness:.0f} (very blurry, likely out of focus)")

    if len(sharpness_vals) > 1:
        mean_s = avg_sharpness
        var_s = sum((v - mean_s) ** 2 for v in sharpness_vals) / len(sharpness_vals)
        std_s = math.sqrt(var_s)
        consistency = 1 - min(1, std_s / (avg_sharpness + 1))
        if consistency < 0.5:
            score -= 15
            notes.append(f"Sharpness varies significantly (consistency: {consistency:.2f}) -- some segments may be out of focus")

    return {
        "score": max(0, score),
        "feedback": "; ".join(notes),
        "raw": {"avg_sharpness_variance": round(avg_sharpness, 1), "frame_count": len(frame_metrics_list)},
    }


def score_lighting(frame_metrics_list):
    """Score lighting quality: exposure, shadows/highlights, consistency."""
    if not frame_metrics_list:
        return {"score": 0, "feedback": "No frames analyzed", "raw": {}}

    brightness_vals = [m["brightness"] for m in frame_metrics_list]
    avg_brightness = sum(brightness_vals) / len(brightness_vals)
    avg_shadows = sum(m["shadows_pct"] for m in frame_metrics_list) / len(frame_metrics_list)
    avg_highlights = sum(m["highlights_pct"] for m in frame_metrics_list) / len(frame_metrics_list)
    avg_midtones = sum(m["midtones_pct"] for m in frame_metrics_list) / len(frame_metrics_list)

    score = 100
    notes = []

    if 90 <= avg_brightness <= 170:
        notes.append(f"Exposure: {avg_brightness:.0f}/255 (well exposed)")
    elif 60 <= avg_brightness < 90:
        score -= 15
        notes.append(f"Exposure: {avg_brightness:.0f}/255 (slightly underexposed, boost brightness)")
    elif 170 < avg_brightness <= 200:
        score -= 15
        notes.append(f"Exposure: {avg_brightness:.0f}/255 (slightly overexposed)")
    elif avg_brightness < 60:
        score -= 35
        notes.append(f"Exposure: {avg_brightness:.0f}/255 (dark -- add lighting or boost in post)")
    else:
        score -= 35
        notes.append(f"Exposure: {avg_brightness:.0f}/255 (blown out -- reduce exposure)")

    if avg_shadows > 0.25:
        score -= 15
        notes.append(f"Crushed shadows: {avg_shadows*100:.0f}% pixels very dark")
    if avg_highlights > 0.15:
        score -= 15
        notes.append(f"Blown highlights: {avg_highlights*100:.0f}% pixels clipped")

    if avg_midtones >= 0.6:
        notes.append(f"Tonal range: {avg_midtones*100:.0f}% midtones (good)")
    elif avg_midtones >= 0.4:
        score -= 10
        notes.append(f"Tonal range: {avg_midtones*100:.0f}% midtones (could improve)")
    else:
        score -= 20
        notes.append(f"Tonal range: {avg_midtones*100:.0f}% midtones (poor exposure balance)")

    if len(brightness_vals) > 1:
        b_mean = avg_brightness
        b_var = sum((v - b_mean) ** 2 for v in brightness_vals) / len(brightness_vals)
        b_std = math.sqrt(b_var)
        if b_std > 30:
            score -= 20
            notes.append(f"Lighting flickers (std: {b_std:.0f}) -- stabilize lighting")
        elif b_std > 15:
            score -= 10
            notes.append(f"Minor lighting variation (std: {b_std:.0f})")
        else:
            notes.append(f"Consistent lighting (std: {b_std:.0f})")

    return {
        "score": max(0, score),
        "feedback": "; ".join(notes),
        "raw": {
            "avg_brightness": round(avg_brightness, 1),
            "avg_shadows_pct": round(avg_shadows, 3),
            "avg_highlights_pct": round(avg_highlights, 3),
            "avg_midtones_pct": round(avg_midtones, 3),
        },
    }


def score_color_grading(frame_metrics_list):
    """Score color consistency and saturation quality."""
    if not frame_metrics_list:
        return {"score": 0, "feedback": "No frames analyzed", "raw": {}}

    sat_vals = [m["saturation"] for m in frame_metrics_list]
    avg_saturation = sum(sat_vals) / len(sat_vals)
    contrast_vals = [m["luma_std"] for m in frame_metrics_list]
    avg_contrast_std = sum(contrast_vals) / len(contrast_vals)

    score = 100
    notes = []

    if 0.25 <= avg_saturation <= 0.55:
        notes.append(f"Saturation: {avg_saturation:.2f} (natural, appealing)")
    elif 0.15 <= avg_saturation < 0.25:
        score -= 10
        notes.append(f"Saturation: {avg_saturation:.2f} (slightly desaturated)")
    elif 0.55 < avg_saturation <= 0.70:
        score -= 10
        notes.append(f"Saturation: {avg_saturation:.2f} (slightly oversaturated)")
    elif avg_saturation < 0.15:
        score -= 25
        notes.append(f"Saturation: {avg_saturation:.2f} (washed out -- boost saturation)")
    else:
        score -= 25
        notes.append(f"Saturation: {avg_saturation:.2f} (oversaturated -- dial back)")

    if avg_contrast_std >= 50:
        notes.append(f"Contrast: good (luma std: {avg_contrast_std:.1f})")
    elif avg_contrast_std >= 35:
        score -= 10
        notes.append(f"Contrast: moderate (luma std: {avg_contrast_std:.1f})")
    else:
        score -= 20
        notes.append(f"Contrast: flat (luma std: {avg_contrast_std:.1f}) -- add contrast")

    if len(sat_vals) > 1:
        s_mean = avg_saturation
        s_var = sum((v - s_mean) ** 2 for v in sat_vals) / len(sat_vals)
        s_std = math.sqrt(s_var)
        if s_std > 0.1:
            score -= 15
            notes.append(f"Color shifts between scenes (sat std: {s_std:.3f})")

    return {
        "score": max(0, score),
        "feedback": "; ".join(notes),
        "raw": {"avg_saturation": round(avg_saturation, 3), "avg_contrast_std": round(avg_contrast_std, 1)},
    }


def score_transition_smoothness(video_path):
    """Score scene transition quality using ffmpeg scene detection."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", "select='gt(scene,0.3)',showinfo",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        timestamps = re.findall(r"pts_time:([\d.]+)", result.stderr)
        scene_scores_raw = re.findall(r"scene_score=([\d.]+)", result.stderr)
        hard_cuts = len(timestamps)
    except Exception:
        hard_cuts = 0
        scene_scores_raw = []

    # Also check for very jarring cuts (>0.7 threshold)
    cmd2 = [
        "ffmpeg", "-i", video_path,
        "-vf", "select='gt(scene,0.7)',showinfo",
        "-f", "null", "-",
    ]
    try:
        result2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=120)
        jarring_ts = re.findall(r"pts_time:([\d.]+)", result2.stderr)
        jarring_cuts = len(jarring_ts)
    except Exception:
        jarring_cuts = 0

    score = 100
    notes = []

    if hard_cuts == 0:
        score = 65
        notes.append("No visible scene changes -- single continuous shot or very smooth edits")
    else:
        notes.append(f"{hard_cuts} scene transitions detected")

        if jarring_cuts > 0:
            score -= min(25, jarring_cuts * 8)
            notes.append(f"{jarring_cuts} jarring cuts (score >0.7) -- add dissolves or smooth these")
        else:
            notes.append("No jarring cuts (good)")

    return {
        "score": max(0, score),
        "feedback": "; ".join(notes),
        "raw": {"hard_cuts": hard_cuts, "jarring_cuts": jarring_cuts},
    }


def analyze(video_path, sample_frames=30):
    """Run full visual quality analysis."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    frame_files, duration, tmpdir = extract_sample_frames(video_path, sample_frames)

    if not frame_files:
        return {"error": "Could not extract frames from video"}

    frame_metrics = []
    for fp in frame_files:
        try:
            metrics = compute_frame_metrics(fp)
            if metrics:
                frame_metrics.append(metrics)
        except Exception:
            continue

    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if not frame_metrics:
        return {"error": "Could not analyze any frames"}

    results = {
        "tool": "analyze-visual-quality",
        "version": "1.0.0",
        "video_path": video_path,
        "scores": {
            "clarity": score_clarity(frame_metrics),
            "lighting": score_lighting(frame_metrics),
            "color_grading": score_color_grading(frame_metrics),
            "transitions": score_transition_smoothness(video_path),
        },
        "warnings": [],
    }

    scores = [v["score"] for v in results["scores"].values()]
    results["overall_score"] = round(sum(scores) / len(scores), 1)

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-visual-quality.py <video_path> [--sample-frames 30]")
        sys.exit(1)

    video_path = sys.argv[1]
    sample_frames = 30
    if "--sample-frames" in sys.argv:
        idx = sys.argv.index("--sample-frames")
        if idx + 1 < len(sys.argv):
            sample_frames = int(sys.argv[idx + 1])

    result = analyze(video_path, sample_frames)
    print(json.dumps(result, indent=2))
