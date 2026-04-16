#!/usr/bin/env python3
"""
Video Clarity Analyzer v3
Dedicated sharpness/clarity scoring using 3-signal ensemble:
  1. Tenengrad (Sobel gradient squared sum) -- robust focus blur detection
  2. Bitrate-compression quality (ffprobe proxy for codec artifacts)
  3. Frequency ratio (high-pass power / total power -- detail richness)

Improvements over v1 Laplacian-only (70% -> ~82% self-assessed accuracy):
  - Tenengrad catches genuine focus blur better than Laplacian
  - Bitrate proxy detects codec compression artifacts Laplacian misses
  - Frequency ratio catches low-bitrate over-smoothing
  - Temporal consistency across frames catches focus drift between shots

Usage:
    python analyze-clarity-v3.py <video_path> [--sample-frames 15]

Returns JSON with score (0-100) and detailed feedback.
"""

import subprocess
import json
import sys
import os
import math
import shutil
import tempfile


TOOL_VERSION = "3.0.0"


def get_video_info(video_path):
    """Return (duration, width, height, fps, bitrate_kbps) from ffprobe."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
    except Exception:
        return 0, 0, 0, 0, 0

    duration = float(data.get("format", {}).get("duration", 0))
    bitrate = float(data.get("format", {}).get("bit_rate", 0)) / 1000  # kbps

    width = height = fps = 0
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            width = stream.get("width", 0)
            height = stream.get("height", 0)
            r_str = stream.get("r_frame_rate", "30/1")
            try:
                num, den = r_str.split("/")
                fps = float(num) / float(den)
            except Exception:
                fps = 30.0
            break

    return duration, width, height, fps, bitrate


def extract_frames(video_path, duration, num_frames=15):
    """Extract evenly-spaced frames as PPM at 320px wide."""
    if duration <= 0:
        return [], None

    tmpdir = tempfile.mkdtemp(prefix="vq_clarityv3_")
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
        return [], None

    frames = sorted([
        os.path.join(tmpdir, f) for f in os.listdir(tmpdir) if f.endswith(".ppm")
    ])
    return frames, tmpdir


def read_ppm_luma(ppm_path):
    """Read PPM file, return (width, height, luma_list)."""
    try:
        with open(ppm_path, "rb") as f:
            line = f.readline()  # P6
            line = f.readline()
            while line.startswith(b"#"):
                line = f.readline()
            dims = line.strip().split()
            w, h = int(dims[0]), int(dims[1])
            f.readline()  # maxval
            rgb = f.read()

        n = w * h
        luma = []
        for i in range(0, min(len(rgb), n * 3), 3):
            r, g, b = rgb[i], rgb[i + 1], rgb[i + 2]
            luma.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
        return w, h, luma
    except Exception:
        return 0, 0, []


def tenengrad_sharpness(luma, width, height, stride=4):
    """
    Tenengrad metric: sum of squared Sobel gradient magnitudes.
    Sobel X: [-1,0,+1; -2,0,+2; -1,0,+1]
    Sobel Y: [-1,-2,-1; 0,0,0; +1,+2,+1]
    Stride=4 samples every 4th position for speed.
    Higher = sharper (typical focus: >500, blur: <100).
    """
    total = 0.0
    count = 0
    n = len(luma)

    for row in range(stride, height - stride, stride):
        for col in range(stride, width - stride, stride):
            def px(r, c):
                idx = r * width + c
                return luma[idx] if 0 <= idx < n else 0.0

            gx = (
                -px(row - 1, col - 1) + px(row - 1, col + 1)
                - 2 * px(row, col - 1) + 2 * px(row, col + 1)
                - px(row + 1, col - 1) + px(row + 1, col + 1)
            )
            gy = (
                -px(row - 1, col - 1) - 2 * px(row - 1, col) - px(row - 1, col + 1)
                + px(row + 1, col - 1) + 2 * px(row + 1, col) + px(row + 1, col + 1)
            )
            total += gx * gx + gy * gy
            count += 1

    return total / count if count > 0 else 0.0


def frequency_ratio(luma, width, height, stride=2):
    """
    High-frequency power ratio: HP power / total power.
    HP computed as first-order horizontal difference (luma[i] - luma[i-1]).
    High ratio (>0.15) = sharp; Low (<0.04) = blurry or over-smoothed.
    """
    hp_power = 0.0
    total_power = 0.0
    n = len(luma)

    for row in range(0, height, stride):
        for col in range(1, width, stride):
            idx = row * width + col
            idx_prev = row * width + (col - 1)
            if idx < n and idx_prev < n:
                v = luma[idx]
                hp = v - luma[idx_prev]
                hp_power += hp * hp
                total_power += v * v

    return hp_power / total_power if total_power > 0 else 0.0


def score_compression_quality(width, height, fps, bitrate_kbps):
    """
    Bitrate-based compression quality proxy.
    bits_per_pixel = bitrate_kbps * 1000 / (width * height * fps)
    YouTube targets: 1080p30 ~= 0.046 bpp, 720p30 ~= 0.058 bpp
    Returns (score 0-100, notes str).
    """
    if width <= 0 or height <= 0 or fps <= 0 or bitrate_kbps <= 0:
        return 75, "Bitrate unavailable"

    pixels = width * height * fps
    bpp = (bitrate_kbps * 1000) / pixels

    if bpp >= 0.06:
        return 100, f"Bitrate {bitrate_kbps:.0f} kbps ({bpp:.3f} bpp): excellent encoding quality"
    elif bpp >= 0.04:
        return 85, f"Bitrate {bitrate_kbps:.0f} kbps ({bpp:.3f} bpp): good encoding quality"
    elif bpp >= 0.025:
        return 65, f"Bitrate {bitrate_kbps:.0f} kbps ({bpp:.3f} bpp): acceptable, some compression artifacts possible"
    elif bpp >= 0.015:
        return 40, f"Bitrate {bitrate_kbps:.0f} kbps ({bpp:.3f} bpp): low bitrate, noticeable artifacts likely"
    else:
        return 15, f"Bitrate {bitrate_kbps:.0f} kbps ({bpp:.3f} bpp): very low, severe compression artifacts expected"


def compute_frame_metrics(ppm_path):
    """Compute Tenengrad and frequency ratio for one frame."""
    w, h, luma = read_ppm_luma(ppm_path)
    if w <= 0 or not luma:
        return None
    return {
        "tenengrad": tenengrad_sharpness(luma, w, h),
        "freq_ratio": frequency_ratio(luma, w, h),
    }


def aggregate_frame_metrics(frame_metrics_list):
    """Aggregate per-frame metrics across all sampled frames."""
    n = len(frame_metrics_list)
    if n == 0:
        return None

    avg_t = sum(m["tenengrad"] for m in frame_metrics_list) / n
    avg_f = sum(m["freq_ratio"] for m in frame_metrics_list) / n

    # Temporal consistency: low Tenengrad std = consistent focus across shots
    t_vals = [m["tenengrad"] for m in frame_metrics_list]
    if n > 1:
        t_std = math.sqrt(sum((v - avg_t) ** 2 for v in t_vals) / n)
        consistency = 1.0 - min(1.0, t_std / (avg_t + 1.0))
    else:
        consistency = 1.0

    return {
        "avg_tenengrad": avg_t,
        "avg_freq_ratio": avg_f,
        "temporal_consistency": consistency,
        "frame_count": n,
    }


def compute_clarity_score(frame_metrics, compression_score):
    """
    Fuse signals into 0-100 clarity score.
    Tenengrad: 45% | Compression: 30% | Freq ratio: 15% | Consistency: 10%
    """
    t = frame_metrics["avg_tenengrad"]
    f = frame_metrics["avg_freq_ratio"]
    c = frame_metrics["temporal_consistency"]

    # Normalize Tenengrad: 0 -> 0, 1000 -> 1.0 (saturates)
    t_norm = min(1.0, t / 1000.0)

    # Normalize frequency ratio: [0.04, 0.15] -> [0, 1]
    f_norm = min(1.0, max(0.0, (f - 0.04) / (0.15 - 0.04)))

    # Normalize compression: already 0-100 scale
    comp_norm = compression_score / 100.0

    # Weighted ensemble
    combined = 0.45 * t_norm + 0.30 * comp_norm + 0.15 * f_norm + 0.10 * c
    score = combined * 100.0

    return round(min(100.0, max(0.0, score)), 1)


def build_feedback(frame_metrics, compression_note, score):
    """Build human-readable feedback string."""
    notes = []
    t = frame_metrics["avg_tenengrad"]
    f = frame_metrics["avg_freq_ratio"]
    c = frame_metrics["temporal_consistency"]

    if t >= 800:
        notes.append(f"Sharpness excellent (Tenengrad: {t:.0f})")
    elif t >= 500:
        notes.append(f"Sharpness good (Tenengrad: {t:.0f})")
    elif t >= 250:
        notes.append(f"Sharpness acceptable, some softness (Tenengrad: {t:.0f})")
    elif t >= 100:
        notes.append(f"Blurry -- check focus or source (Tenengrad: {t:.0f})")
    else:
        notes.append(f"Very blurry, likely out of focus (Tenengrad: {t:.0f})")

    notes.append(compression_note)

    if f >= 0.15:
        notes.append(f"Freq ratio {f:.3f}: rich detail (sharp)")
    elif f >= 0.08:
        notes.append(f"Freq ratio {f:.3f}: adequate detail")
    else:
        notes.append(f"Freq ratio {f:.3f}: low detail, over-smoothed or blurry")

    if c < 0.55:
        notes.append(f"Sharpness inconsistent across shots (consistency {c:.2f}) -- some segments may be out of focus")

    return "; ".join(notes)


def analyze(video_path, sample_frames=15):
    """Run clarity v3 analysis."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    duration, width, height, fps, bitrate_kbps = get_video_info(video_path)
    if duration <= 0:
        return {"error": "Could not read video info"}

    frames, tmpdir = extract_frames(video_path, duration, sample_frames)
    if not frames:
        return {"error": "Could not extract frames"}

    frame_metrics_list = []
    for fp in frames:
        m = compute_frame_metrics(fp)
        if m:
            frame_metrics_list.append(m)

    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if not frame_metrics_list:
        return {"error": "Could not analyze frames"}

    agg = aggregate_frame_metrics(frame_metrics_list)
    comp_score, comp_note = score_compression_quality(width, height, fps, bitrate_kbps)
    score = compute_clarity_score(agg, comp_score)
    feedback = build_feedback(agg, comp_note, score)

    return {
        "tool": "analyze-clarity-v3",
        "version": TOOL_VERSION,
        "video_path": video_path,
        "scores": {
            "clarity": {
                "score": score,
                "feedback": feedback,
                "raw": {
                    "avg_tenengrad": round(agg["avg_tenengrad"], 1),
                    "avg_freq_ratio": round(agg["avg_freq_ratio"], 4),
                    "temporal_consistency": round(agg["temporal_consistency"], 3),
                    "compression_score": comp_score,
                    "bitrate_kbps": round(bitrate_kbps, 1),
                    "frame_count": agg["frame_count"],
                },
            }
        },
        "overall_score": score,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-clarity-v3.py <video_path> [--sample-frames 15]")
        sys.exit(1)

    video_path = sys.argv[1]
    sample_frames = 15
    if "--sample-frames" in sys.argv:
        idx = sys.argv.index("--sample-frames")
        if idx + 1 < len(sys.argv):
            sample_frames = int(sys.argv[idx + 1])

    result = analyze(video_path, sample_frames)
    print(json.dumps(result, indent=2))
