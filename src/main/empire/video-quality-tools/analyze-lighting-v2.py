#!/usr/bin/env python3
"""
Video Lighting Quality Analyzer v2
Dedicated lighting analysis with 4 new signals over the original analyze-visual-quality.py approach:

  1. Subject-background exposure differential (zone analysis)
     - Compare center-zone brightness vs border-zone brightness
     - Well-lit subject should be 1.05-1.40x brighter than background
     - >1.6x = blown-out subject; <0.85x = silhouette/underlit

  2. Color temperature consistency (warm/cool cast stability)
     - Track R/B channel ratio per frame (proxy for Kelvin temperature shift)
     - Daylight: ~1.3-1.5; Tungsten: ~2.0+; Fluorescent: ~0.9-1.1
     - High frame-to-frame variance = mixed lighting = color shift problem

  3. Shadow harshness via local gradient density
     - Measure Sobel gradient magnitude on luminance map
     - Dense high-magnitude gradients at mid-luma transitions = harsh shadow edges
     - Professional lighting has soft falloff; amateur has abrupt shadow walls

  4. Temporal flicker index (frame-to-frame luma delta CoV)
     - Coefficient of variation of per-frame mean luma deltas
     - Periodic spikes in consecutive-frame luma differences = artificial light flicker
     - More precise than simple luma std which can flag intentional exposure changes

Accuracy improvement target: 80% -> 84% (vs analyze-visual-quality.py)

Research basis:
  SMPTE RP 168-2002: broadcast luminance targets (90-170/255 range)
  Wyszecki & Stiles (2000): Color Science -- R/B ratio as color temperature proxy
  Reinhard et al. (2010): High Dynamic Range Imaging -- zone analysis for exposure
  YouTube Creator Academy (2024): even subject lighting as top production quality signal

Usage:
    python analyze-lighting-v2.py <video_path> [--sample-frames 25]

Returns JSON with score (0-100) and detailed lighting feedback.
"""

import subprocess
import json
import sys
import os
import math
import shutil
import tempfile

TOOL_VERSION = "2.0.0"


def get_duration(video_path):
    """Get video duration in seconds via ffprobe."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-print_format", "json",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(json.loads(result.stdout).get("format", {}).get("duration", 0))
    except Exception:
        return 0


def extract_frames(video_path, num_frames=25):
    """Extract evenly-spaced RGB PPM frames scaled to 320px wide."""
    tmpdir = tempfile.mkdtemp(prefix="vq_light_")
    duration = get_duration(video_path)
    if duration <= 0:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return [], 0, None

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


def read_ppm(ppm_path):
    """Read a P6 PPM file, return (width, height, pixel_bytes)."""
    with open(ppm_path, "rb") as f:
        magic = f.readline().strip()
        if magic not in (b"P6", b"P3"):
            return None, None, None
        line = f.readline()
        while line.startswith(b"#"):
            line = f.readline()
        dims = line.strip().split()
        if len(dims) < 2:
            return None, None, None
        width, height = int(dims[0]), int(dims[1])
        f.readline()  # maxval
        pixels = f.read()
    return width, height, pixels


def analyze_frame(ppm_path):
    """Extract per-frame lighting metrics from a PPM image."""
    width, height, pixels = read_ppm(ppm_path)
    if width is None or width * height == 0:
        return None

    n = width * height
    expected = n * 3
    if len(pixels) < expected:
        return None

    r_vals, g_vals, b_vals, luma_vals = [], [], [], []
    for i in range(0, expected, 3):
        r, g, b = pixels[i], pixels[i + 1], pixels[i + 2]
        r_vals.append(r)
        g_vals.append(g)
        b_vals.append(b)
        luma_vals.append(0.2126 * r + 0.7152 * g + 0.0722 * b)

    # -- Signal 1: Zone-based subject/background exposure ----------------------
    # Center zone = inner 50% width x 60% height (subject area)
    # Border zone = outer ring of pixels (background area)
    cx0 = width // 4
    cx1 = width * 3 // 4
    cy0 = height // 5
    cy1 = height * 4 // 5

    center_luma, border_luma = [], []
    for row in range(height):
        for col in range(width):
            idx = row * width + col
            if idx < n:
                lv = luma_vals[idx]
                if cx0 <= col < cx1 and cy0 <= row < cy1:
                    center_luma.append(lv)
                else:
                    border_luma.append(lv)

    avg_center = sum(center_luma) / len(center_luma) if center_luma else 0
    avg_border = sum(border_luma) / len(border_luma) if border_luma else 0
    zone_ratio = avg_center / (avg_border + 1.0)

    # -- Signal 2: Color temperature proxy (R/B ratio) -------------------------
    avg_r = sum(r_vals) / n
    avg_b = sum(b_vals) / n
    rb_ratio = avg_r / (avg_b + 1.0)

    # -- Signal 3: Shadow harshness (gradient density at mid-luma) --------------
    # Sample horizontal Sobel at every 4th pixel for speed
    harsh_gradients = 0
    gradient_samples = 0
    stride = 4
    for row in range(0, height, stride):
        for col in range(1, width - 1, stride):
            idx = row * width + col
            if idx - 1 >= 0 and idx + 1 < n:
                L_center = luma_vals[idx]
                L_left = luma_vals[idx - 1]
                L_right = luma_vals[idx + 1]
                grad = abs(L_right - L_left) / 2.0
                # Only count gradients at mid-luma transitions (shadow edge = 40-160 range)
                if 40 <= L_center <= 160 and grad > 25:
                    harsh_gradients += 1
                gradient_samples += 1

    shadow_harshness = harsh_gradients / max(gradient_samples, 1)

    # -- Base signals (from v1 approach) ----------------------------------------
    avg_luma = sum(luma_vals) / n
    shadows_pct = sum(1 for v in luma_vals if v < 50) / n
    highlights_pct = sum(1 for v in luma_vals if v > 200) / n
    midtones_pct = sum(1 for v in luma_vals if 50 <= v <= 200) / n

    return {
        "avg_luma": avg_luma,
        "shadows_pct": shadows_pct,
        "highlights_pct": highlights_pct,
        "midtones_pct": midtones_pct,
        "zone_ratio": zone_ratio,
        "rb_ratio": rb_ratio,
        "shadow_harshness": shadow_harshness,
    }


def score_lighting(frame_data_list):
    """Compute lighting score from multi-frame metrics (0-100)."""
    if not frame_data_list:
        return {"score": 0, "feedback": "No frames analyzed", "raw": {}}

    n = len(frame_data_list)
    score = 100
    notes = []

    # -- Aggregate per-frame metrics -------------------------------------------
    avg_luma_vals = [f["avg_luma"] for f in frame_data_list]
    avg_luma = sum(avg_luma_vals) / n

    shadows_vals = [f["shadows_pct"] for f in frame_data_list]
    avg_shadows = sum(shadows_vals) / n

    highlights_vals = [f["highlights_pct"] for f in frame_data_list]
    avg_highlights = sum(highlights_vals) / n

    midtones_vals = [f["midtones_pct"] for f in frame_data_list]
    avg_midtones = sum(midtones_vals) / n

    zone_ratios = [f["zone_ratio"] for f in frame_data_list]
    avg_zone_ratio = sum(zone_ratios) / n

    rb_ratios = [f["rb_ratio"] for f in frame_data_list]
    avg_rb_ratio = sum(rb_ratios) / n

    harshness_vals = [f["shadow_harshness"] for f in frame_data_list]
    avg_harshness = sum(harshness_vals) / n

    # -- Signal: Overall exposure (SMPTE broadcast targets) --------------------
    if 90 <= avg_luma <= 170:
        notes.append(f"Exposure: {avg_luma:.0f}/255 (well exposed)")
    elif 60 <= avg_luma < 90:
        score -= 15
        notes.append(f"Exposure: {avg_luma:.0f}/255 (slightly underexposed -- boost brightness)")
    elif 170 < avg_luma <= 200:
        score -= 15
        notes.append(f"Exposure: {avg_luma:.0f}/255 (slightly overexposed)")
    elif avg_luma < 60:
        score -= 35
        notes.append(f"Exposure: {avg_luma:.0f}/255 (underlit -- add lighting or boost in post)")
    else:
        score -= 35
        notes.append(f"Exposure: {avg_luma:.0f}/255 (blown out -- reduce exposure)")

    # -- Signal: Clipping check ------------------------------------------------
    if avg_shadows > 0.25:
        score -= 15
        notes.append(f"Crushed shadows: {avg_shadows*100:.0f}% pixels very dark")
    if avg_highlights > 0.15:
        score -= 15
        notes.append(f"Blown highlights: {avg_highlights*100:.0f}% pixels clipped")

    # -- Signal: Tonal balance -------------------------------------------------
    if avg_midtones >= 0.6:
        notes.append(f"Tonal balance: {avg_midtones*100:.0f}% midtones (good)")
    elif avg_midtones >= 0.4:
        score -= 5
        notes.append(f"Tonal balance: {avg_midtones*100:.0f}% midtones (could improve)")
    else:
        score -= 15
        notes.append(f"Tonal balance: {avg_midtones*100:.0f}% midtones (poor -- flat or high-contrast scene)")

    # -- Signal 1: Subject-background zone ratio (NEW) -------------------------
    if 1.05 <= avg_zone_ratio <= 1.40:
        notes.append(f"Subject exposure: zone ratio {avg_zone_ratio:.2f} (good -- subject well-separated from background)")
    elif 0.85 <= avg_zone_ratio < 1.05:
        score -= 8
        notes.append(f"Subject exposure: zone ratio {avg_zone_ratio:.2f} (flat -- subject barely brighter than background, add key light)")
    elif avg_zone_ratio < 0.85:
        score -= 15
        notes.append(f"Subject exposure: zone ratio {avg_zone_ratio:.2f} (silhouette risk -- subject darker than background, reposition lights)")
    elif 1.40 < avg_zone_ratio <= 1.60:
        score -= 5
        notes.append(f"Subject exposure: zone ratio {avg_zone_ratio:.2f} (slightly overlit subject vs background)")
    else:
        score -= 12
        notes.append(f"Subject exposure: zone ratio {avg_zone_ratio:.2f} (subject severely overlit vs background -- diffuse key light)")

    # -- Signal 2: Color temperature consistency (NEW) --------------------------
    if n > 1:
        rb_mean = avg_rb_ratio
        rb_std = math.sqrt(sum((v - rb_mean) ** 2 for v in rb_ratios) / n)
        rb_cv = rb_std / (rb_mean + 0.01)

        if rb_cv <= 0.06:
            notes.append(f"Color temperature: consistent (R/B ratio CoV {rb_cv:.3f}) -- stable lighting across video")
        elif rb_cv <= 0.12:
            score -= 8
            notes.append(f"Color temperature: minor shifts (R/B CoV {rb_cv:.3f}) -- possible window light variation")
        else:
            score -= 15
            notes.append(f"Color temperature: mixed lighting detected (R/B CoV {rb_cv:.3f}) -- separate warm/cool sources; white balance inconsistency")

        # Absolute cast check: very warm (tungsten-heavy) or very cool (fluorescent)
        if avg_rb_ratio > 1.90:
            score -= 8
            notes.append(f"Warm cast: R/B ratio {avg_rb_ratio:.2f} (strong tungsten/orange tint -- consider white balance or LUT)")
        elif avg_rb_ratio < 0.85:
            score -= 8
            notes.append(f"Cool cast: R/B ratio {avg_rb_ratio:.2f} (blue/fluorescent tint -- correct white balance)")
        else:
            notes.append(f"Color temperature: {avg_rb_ratio:.2f} R/B ratio (within acceptable range)")

    # -- Signal 3: Shadow harshness (NEW) ---------------------------------------
    if avg_harshness <= 0.08:
        notes.append(f"Shadow quality: soft edges (harshness {avg_harshness:.3f}) -- professional lighting setup")
    elif avg_harshness <= 0.16:
        score -= 7
        notes.append(f"Shadow quality: moderate harshness ({avg_harshness:.3f}) -- consider diffuser or reflector to soften shadows")
    else:
        score -= 14
        notes.append(f"Shadow quality: harsh shadows ({avg_harshness:.3f}) -- direct undiffused light source; use softbox or bounce lighting")

    # -- Signal 4: Temporal flicker (NEW) ---------------------------------------
    if n > 2:
        luma_deltas = [abs(avg_luma_vals[i] - avg_luma_vals[i - 1]) for i in range(1, n)]
        mean_delta = sum(luma_deltas) / len(luma_deltas)
        std_delta = math.sqrt(sum((v - mean_delta) ** 2 for v in luma_deltas) / len(luma_deltas))
        flicker_cv = std_delta / (mean_delta + 0.5)

        if flicker_cv <= 0.50:
            notes.append(f"Lighting stability: no flicker (delta CoV {flicker_cv:.2f})")
        elif flicker_cv <= 1.0:
            score -= 8
            notes.append(f"Lighting stability: slight flicker (delta CoV {flicker_cv:.2f}) -- check for AC frequency mismatch with shutter speed (50/60 Hz)")
        else:
            score -= 18
            notes.append(f"Lighting stability: significant flicker (delta CoV {flicker_cv:.2f}) -- artificial light cycling; adjust shutter angle or switch lights")

    return {
        "score": max(0, min(100, score)),
        "feedback": "; ".join(notes),
        "raw": {
            "avg_luma": round(avg_luma, 1),
            "avg_shadows_pct": round(avg_shadows, 3),
            "avg_highlights_pct": round(avg_highlights, 3),
            "avg_midtones_pct": round(avg_midtones, 3),
            "zone_ratio": round(avg_zone_ratio, 3),
            "rb_ratio": round(avg_rb_ratio, 3),
            "shadow_harshness": round(avg_harshness, 3),
            "frame_count": n,
        },
    }


def analyze(video_path, sample_frames=25):
    """Run full lighting v2 analysis."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    frame_files, duration, tmpdir = extract_frames(video_path, sample_frames)
    if not frame_files:
        return {"error": "Could not extract frames from video"}

    frame_data = []
    for fp in frame_files:
        try:
            metrics = analyze_frame(fp)
            if metrics:
                frame_data.append(metrics)
        except Exception:
            continue

    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if not frame_data:
        return {"error": "Could not analyze any frames"}

    result = score_lighting(frame_data)

    return {
        "tool": "analyze-lighting-v2",
        "version": TOOL_VERSION,
        "video_path": video_path,
        "scores": {
            "lighting": result,
        },
        "overall_score": result["score"],
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-lighting-v2.py <video_path> [--sample-frames 25]")
        sys.exit(1)

    video_path = sys.argv[1]
    sample_frames = 25
    if "--sample-frames" in sys.argv:
        idx = sys.argv.index("--sample-frames")
        if idx + 1 < len(sys.argv):
            sample_frames = int(sys.argv[idx + 1])

    result = analyze(video_path, sample_frames)
    print(json.dumps(result, indent=2))
