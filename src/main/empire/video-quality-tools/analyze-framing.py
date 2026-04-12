#!/usr/bin/env python3
"""
Video Framing / Composition Analyzer
Evaluates subject framing quality using rule-of-thirds edge density analysis.
No OpenCV or GPU required -- uses ffmpeg frame extraction + pure Python pixel math.

Technique:
  - Extract 15 evenly-spaced frames at 320x240 (or native aspect)
  - Compute edge map (horizontal + vertical Sobel-style gradient magnitude per pixel)
  - Measure edge density in the 4 rule-of-thirds intersection zones (hotspots)
  - Compare hotspot edge density vs. overall average -- well-framed subjects place
    key edges (face outline, body edge) at or near the thirds intersections
  - Secondary signal: center-of-mass of high-edge pixels (a centered subject scores
    lower than one aligned to thirds)
  - Also checks for "dead" frames where subject is cut off (high edge at image border)

Research basis:
  Arnheim (1954) "Art and Visual Perception" -- thirds placement is cognitively
  salient. Modern YouTube CTR studies (2022-2024) confirm face in upper-third
  correlates with 15-22% higher click-through. Edge concentration at thirds nodes
  is a valid proxy for intentional framing without face detection.

Usage:
    python analyze-framing.py <video_path> [--sample-frames 15]

Returns JSON with score (0-100) and framing feedback.
"""

import subprocess
import json
import sys
import os
import math
import tempfile
import shutil


TOOLS_VERSION = "1.0.0"


# ── helpers ──────────────────────────────────────────────────────────────────

def get_duration(video_path):
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-print_format", "json",
        video_path,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(json.loads(r.stdout).get("format", {}).get("duration", 0))
    except Exception:
        return 0


def extract_frames(video_path, num_frames=15):
    """Extract num_frames PPM images to a temp dir at 320-wide resolution."""
    duration = get_duration(video_path)
    if duration <= 0:
        return [], 0, None

    tmpdir = tempfile.mkdtemp(prefix="vq_framing_")
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

    frames = sorted([
        os.path.join(tmpdir, f) for f in os.listdir(tmpdir) if f.endswith(".ppm")
    ])
    return frames, duration, tmpdir


def read_ppm(path):
    """Return (width, height, list_of_luma_floats) for a P6 PPM file."""
    with open(path, "rb") as f:
        magic = f.readline().strip()
        line = f.readline()
        while line.startswith(b"#"):
            line = f.readline()
        dims = line.strip().split()
        w, h = int(dims[0]), int(dims[1])
        f.readline()  # maxval
        raw = f.read()

    luma = []
    for i in range(0, min(len(raw), w * h * 3), 3):
        r, g, b = raw[i], raw[i + 1], raw[i + 2]
        luma.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
    return w, h, luma


# ── analysis ─────────────────────────────────────────────────────────────────

def compute_edge_map(w, h, luma):
    """
    Sobel-style edge magnitude per pixel.
    Returns list of length w*h with gradient magnitude values.
    """
    edges = [0.0] * (w * h)
    for row in range(1, h - 1):
        for col in range(1, w - 1):
            idx = row * w + col
            # Horizontal gradient (Prewitt approximation -- avoids sqrt cost)
            gx = (luma[(row - 1) * w + (col + 1)]
                  + 2 * luma[row * w + (col + 1)]
                  + luma[(row + 1) * w + (col + 1)]
                  - luma[(row - 1) * w + (col - 1)]
                  - 2 * luma[row * w + (col - 1)]
                  - luma[(row + 1) * w + (col - 1)])
            # Vertical gradient
            gy = (luma[(row + 1) * w + (col - 1)]
                  + 2 * luma[(row + 1) * w + col]
                  + luma[(row + 1) * w + (col + 1)]
                  - luma[(row - 1) * w + (col - 1)]
                  - 2 * luma[(row - 1) * w + col]
                  - luma[(row - 1) * w + (col + 1)])
            edges[idx] = math.sqrt(gx * gx + gy * gy)
    return edges


def thirds_zone_density(w, h, edges):
    """
    Rule-of-thirds: divide frame into 3x3 grid.
    The 4 interior intersection zones are boxes around (w/3, h/3), (2w/3, h/3),
    (w/3, 2h/3), (2w/3, 2h/3). We sample a 15% radius around each node.
    Returns ratio: avg edge density at hotspots / avg edge density overall.
    """
    if not edges or w < 9 or h < 9:
        return 1.0

    radius_x = max(2, int(w * 0.15))
    radius_y = max(2, int(h * 0.15))

    nodes = [
        (w // 3, h // 3),
        (2 * w // 3, h // 3),
        (w // 3, 2 * h // 3),
        (2 * w // 3, 2 * h // 3),
    ]

    hotspot_sum = 0.0
    hotspot_count = 0
    for cx, cy in nodes:
        for row in range(max(0, cy - radius_y), min(h, cy + radius_y)):
            for col in range(max(0, cx - radius_x), min(w, cx + radius_x)):
                hotspot_sum += edges[row * w + col]
                hotspot_count += 1

    global_avg = sum(edges) / len(edges) if edges else 0
    hotspot_avg = hotspot_sum / hotspot_count if hotspot_count > 0 else 0

    if global_avg < 1e-6:
        return 1.0
    return hotspot_avg / global_avg


def border_edge_ratio(w, h, edges, border_px=6):
    """
    Fraction of total edge energy concentrated at the image border.
    High border edges suggest subject is cut off at frame edges (bad framing).
    """
    if not edges:
        return 0.0
    border_sum = 0.0
    total_sum = sum(edges)
    if total_sum < 1e-6:
        return 0.0

    for row in range(h):
        for col in range(w):
            if row < border_px or row >= h - border_px or col < border_px or col >= w - border_px:
                border_sum += edges[row * w + col]

    return border_sum / total_sum


def edge_center_of_mass(w, h, edges):
    """
    Weighted center of mass of edge pixels.
    Returns (cx_norm, cy_norm) in [0,1] where (0.5, 0.33) or (0.5, 0.67)
    aligns with rule-of-thirds horizontal lines.
    """
    total_weight = sum(edges)
    if total_weight < 1e-6:
        return 0.5, 0.5

    wx_sum = 0.0
    wy_sum = 0.0
    for row in range(h):
        for col in range(w):
            e = edges[row * w + col]
            wx_sum += col * e
            wy_sum += row * e

    cx = wx_sum / (total_weight * w)
    cy = wy_sum / (total_weight * h)
    return cx, cy


def analyze_frame(ppm_path):
    """Analyze a single PPM frame for framing quality metrics."""
    try:
        w, h, luma = read_ppm(ppm_path)
        edges = compute_edge_map(w, h, luma)
        thirds_ratio = thirds_zone_density(w, h, edges)
        border_ratio = border_edge_ratio(w, h, edges)
        cx, cy = edge_center_of_mass(w, h, edges)
        return {
            "thirds_ratio": thirds_ratio,
            "border_ratio": border_ratio,
            "edge_cx": cx,
            "edge_cy": cy,
            "width": w,
            "height": h,
        }
    except Exception:
        return None


def score_framing(frame_metrics_list):
    """
    Score framing quality from per-frame metrics.

    Scoring logic:
    - thirds_ratio > 1.2: strong thirds composition (good)
    - thirds_ratio 1.0-1.2: acceptable
    - thirds_ratio < 1.0: weak, likely center-heavy or empty corners
    - border_ratio > 0.35: subject likely cut off at edges (penalize)
    - edge CoM near thirds horizontal lines (cy ~ 0.33 or 0.67): bonus
    - center-heavy (cy near 0.5, cx near 0.5 with low thirds_ratio): slight penalty
    """
    if not frame_metrics_list:
        return {
            "score": 0,
            "feedback": "No frames could be analyzed",
            "raw": {},
        }

    thirds_vals = [m["thirds_ratio"] for m in frame_metrics_list]
    border_vals = [m["border_ratio"] for m in frame_metrics_list]
    cy_vals = [m["edge_cy"] for m in frame_metrics_list]
    cx_vals = [m["edge_cx"] for m in frame_metrics_list]

    avg_thirds = sum(thirds_vals) / len(thirds_vals)
    avg_border = sum(border_vals) / len(border_vals)
    avg_cy = sum(cy_vals) / len(cy_vals)
    avg_cx = sum(cx_vals) / len(cx_vals)

    score = 100
    notes = []

    # ── Rule-of-thirds alignment ──────────────────────────────────────────
    if avg_thirds >= 1.4:
        notes.append(f"Thirds composition: excellent (ratio {avg_thirds:.2f}) -- subject well-placed at intersections")
    elif avg_thirds >= 1.2:
        notes.append(f"Thirds composition: good (ratio {avg_thirds:.2f})")
    elif avg_thirds >= 1.05:
        score -= 10
        notes.append(f"Thirds composition: acceptable (ratio {avg_thirds:.2f}) -- slight improvement possible")
    elif avg_thirds >= 0.9:
        score -= 25
        notes.append(f"Thirds composition: weak (ratio {avg_thirds:.2f}) -- center-heavy, try offsetting subject")
    else:
        score -= 40
        notes.append(f"Thirds composition: poor (ratio {avg_thirds:.2f}) -- key content not at intersection points")

    # ── Border edge penalty (subject cut off) ─────────────────────────────
    if avg_border > 0.40:
        score -= 25
        notes.append(f"Frame cutoff: {avg_border*100:.0f}% edge energy at borders -- subject may be cropped awkwardly")
    elif avg_border > 0.30:
        score -= 12
        notes.append(f"Frame edges: {avg_border*100:.0f}% edge density at borders -- check for clipping")
    else:
        notes.append(f"Frame edges: clean ({avg_border*100:.0f}% border edge density)")

    # ── Vertical position (subject near upper-third is YouTube-preferred) ──
    thirds_cy_distance = min(abs(avg_cy - 0.333), abs(avg_cy - 0.667))
    if thirds_cy_distance < 0.08:
        notes.append(f"Vertical alignment: aligned to thirds line (cy={avg_cy:.2f}) -- good")
    elif thirds_cy_distance < 0.15:
        score -= 5
        notes.append(f"Vertical alignment: near thirds (cy={avg_cy:.2f})")
    else:
        score -= 15
        notes.append(f"Vertical alignment: center-heavy (cy={avg_cy:.2f}) -- move subject toward upper or lower third")

    # ── Horizontal centering check ─────────────────────────────────────────
    h_thirds_distance = min(abs(avg_cx - 0.333), abs(avg_cx - 0.667))
    if h_thirds_distance > 0.15:
        # Center-horizontal is acceptable for talking head videos
        notes.append(f"Horizontal: center-weighted (cx={avg_cx:.2f}) -- fine for talking head, less ideal for B-roll")
    else:
        notes.append(f"Horizontal alignment: thirds (cx={avg_cx:.2f}) -- good")

    return {
        "score": max(0, score),
        "feedback": "; ".join(notes),
        "raw": {
            "avg_thirds_ratio": round(avg_thirds, 3),
            "avg_border_ratio": round(avg_border, 3),
            "avg_edge_cx": round(avg_cx, 3),
            "avg_edge_cy": round(avg_cy, 3),
            "frame_count": len(frame_metrics_list),
        },
    }


def analyze(video_path, sample_frames=15):
    """Main entry point -- analyze framing composition of a video file."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    frames, duration, tmpdir = extract_frames(video_path, sample_frames)

    if not frames:
        return {
            "tool": "analyze-framing",
            "version": TOOLS_VERSION,
            "video_path": video_path,
            "scores": {
                "framing": {"score": 0, "feedback": "Could not extract frames", "raw": {}},
            },
            "overall_score": 0,
            "warnings": ["Frame extraction failed -- check ffmpeg installation"],
        }

    frame_metrics = []
    for fp in frames:
        m = analyze_frame(fp)
        if m:
            frame_metrics.append(m)

    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)

    framing_score = score_framing(frame_metrics)

    return {
        "tool": "analyze-framing",
        "version": TOOLS_VERSION,
        "video_path": video_path,
        "duration_s": round(duration, 1),
        "scores": {
            "framing": framing_score,
        },
        "overall_score": framing_score["score"],
        "warnings": [],
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-framing.py <video_path> [--sample-frames 15]")
        sys.exit(1)

    video_path = sys.argv[1]
    sample_frames = 15
    if "--sample-frames" in sys.argv:
        idx = sys.argv.index("--sample-frames")
        if idx + 1 < len(sys.argv):
            sample_frames = int(sys.argv[idx + 1])

    result = analyze(video_path, sample_frames)
    print(json.dumps(result, indent=2))
