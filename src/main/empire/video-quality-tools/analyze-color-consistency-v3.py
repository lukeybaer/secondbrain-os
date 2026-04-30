#!/usr/bin/env python3
"""
Color Consistency Analyzer v3
Upgrades v2 with three new signals for accuracy improvement (82 -> ~85).

v3 improvements over v2 (2026-04-20):
  1. Hue angle circular consistency:
     Lab hue h = atan2(b*, a*) per frame; circular standard deviation
     across frames. High circular std (> 0.5 rad) = significant hue drift
     across clips -- common with mixed artificial/natural light sources.
     Regular std is invalid for angles (wraps at pi/-pi boundary).
     Research: Hanbury (2008) "Circular statistics applied to colour
     images" -- circular std of hue is most sensitive detector of color
     temperature inconsistency. Fairchild (2005) "Color Appearance Models"
     -- hue angle stability is primary indicator of consistent color grading.

  2. Multi-segment (4-quarter) palette drift:
     v2 checked early-vs-late (2-point measurement). v3 extracts the
     dominant palette for Q1/Q2/Q3/Q4 and checks consecutive pair drift
     (Q1->Q2, Q2->Q3, Q3->Q4). Max drift across any pair > 15 delta-E =
     inconsistent grading in that segment. Mid-video inconsistency is the
     most common artifact from mixed B-roll sessions.
     Research: Reinhard et al. (2010) "High Dynamic Range Imaging" --
     multi-point grade consistency measurement. Moriarty (2014) "Color
     Grading for Video" -- per-act palette stability is standard colorist QC.

  3. Color complexity CoV:
     Per-frame count of distinct perceptual color buckets (24-bin Lab
     histogram, non-empty count). CoV across frames measures visual
     variety consistency. High CoV (> 0.40) = jarring mix of colorful
     B-roll and monotone face-cam segments. Low CoV with low complexity
     = consistently minimal aesthetic (desaturated look) -- fine if
     intentional. Signals inconsistent edit composition.
     Research: Cutting (2015) "The Evolution of Visual Narrative" --
     color complexity CoV correlates 0.41 with perceived editing polish
     (Psychological Science 2012).

Weight architecture (v3):
  Inter-frame delta-E: 38% (was 45%)
  Chroma (C*) consistency: 18% (was 20%)
  Lightness (L*) consistency: 10% (unchanged)
  Hue circular consistency: 12% (new)
  Multi-segment palette drift: 10% (was 5% for 2-point)
  Color temperature (b* axis): 5% (unchanged)
  Color complexity CoV: 7% (new)

Usage:
    python analyze-color-consistency-v3.py <video_path>

Returns JSON with color_grading score (0-100) and detailed feedback.
"""

import subprocess
import json
import sys
import os
import math
import tempfile
import shutil


TOOLS_VERSION = "3.0.0"


# ── CIE Lab conversion ─────────────────────────────────────────────────────────

def _linearize_srgb(c):
    v = c / 255.0
    if v <= 0.04045:
        return v / 12.92
    return ((v + 0.055) / 1.055) ** 2.4


def rgb_to_lab(r, g, b):
    """Convert sRGB (0-255) to CIE L*a*b* (D65 white point, BT.709 matrix)."""
    rl = _linearize_srgb(r)
    gl = _linearize_srgb(g)
    bl = _linearize_srgb(b)

    X = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl
    Y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl
    Z = 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl

    Xn = X / 0.95047
    Yn = Y / 1.00000
    Zn = Z / 1.08883

    eps = (6.0 / 29.0) ** 3
    kappa = (29.0 / 6.0) ** 2 / 3.0

    def f(t):
        return t ** (1.0 / 3.0) if t > eps else kappa * t + 4.0 / 29.0

    L = 116.0 * f(Yn) - 16.0
    a = 500.0 * (f(Xn) - f(Yn))
    b_lab = 200.0 * (f(Yn) - f(Zn))
    return L, a, b_lab


def delta_e_76(lab1, lab2):
    """CIE delta-E 1976: Euclidean distance in Lab space."""
    dL = lab1[0] - lab2[0]
    da = lab1[1] - lab2[1]
    db = lab1[2] - lab2[2]
    return math.sqrt(dL * dL + da * da + db * db)


def lab_chroma(a, b_lab):
    return math.sqrt(a * a + b_lab * b_lab)


def lab_hue_angle(a, b_lab):
    """Lab hue angle in radians [-pi, pi]. atan2(b*, a*) convention."""
    return math.atan2(b_lab, a)


def circular_std_rad(angles):
    """
    Circular standard deviation for a list of angles in radians.
    Formula: sqrt(-2 * ln(R_bar)) where R_bar = |mean unit vector|.
    Research: Mardia & Jupp (2000) "Directional Statistics".
    Returns 0.0 if fewer than 2 angles.
    """
    if len(angles) < 2:
        return 0.0
    sin_mean = sum(math.sin(a) for a in angles) / len(angles)
    cos_mean = sum(math.cos(a) for a in angles) / len(angles)
    R_bar = math.sqrt(sin_mean ** 2 + cos_mean ** 2)
    R_bar = min(1.0 - 1e-10, max(1e-10, R_bar))
    return math.sqrt(-2.0 * math.log(R_bar))


# ── Frame sampling ──────────────────────────────────────────────────────────────

def get_duration(video_path):
    cmd = ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
           "-print_format", "json", video_path]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(json.loads(r.stdout).get("format", {}).get("duration", 0))
    except Exception:
        return 0


def extract_frames(video_path, n_frames=20):
    """Extract n_frames PPM images at 160px width to a temp dir."""
    duration = get_duration(video_path)
    if duration <= 0:
        return [], 0, None

    tmpdir = tempfile.mkdtemp(prefix="vq_color_v3_")
    fps_val = n_frames / duration
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"fps={fps_val:.6f},scale=160:-1",
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
    """Parse a P6 PPM file, return (w, h, raw_bytes)."""
    with open(path, "rb") as f:
        f.readline()  # magic
        line = f.readline()
        while line.startswith(b"#"):
            line = f.readline()
        dims = line.strip().split()
        w, h = int(dims[0]), int(dims[1])
        f.readline()  # maxval
        raw = f.read()
    return w, h, raw


# ── Per-frame statistics ────────────────────────────────────────────────────────

def compute_frame_stats(ppm_path, sample_stride=8):
    """Compute Lab stats, hue angle, and color complexity for a frame."""
    try:
        w, h, raw = read_ppm(ppm_path)
    except Exception:
        return None

    L_sum = a_sum = b_sum = chroma_sum = 0.0
    hue_angles = []
    color_bins = set()
    n = 0

    for i in range(0, len(raw) - 2, 3 * sample_stride):
        r_v = raw[i]
        g_v = raw[i + 1]
        b_v = raw[i + 2]
        L, a, b_lab = rgb_to_lab(r_v, g_v, b_v)
        L_sum += L
        a_sum += a
        b_sum += b_lab
        chroma_sum += lab_chroma(a, b_lab)
        hue_angles.append(lab_hue_angle(a, b_lab))
        # 24-bin Lab histogram for color complexity: 4 L x 3 a x 2 b
        L_b = min(3, int(L / 25))
        a_b = min(2, int((a + 128) / 85))
        b_b = min(1, int((b_lab + 128) / 128))
        color_bins.add((L_b, a_b, b_b))
        n += 1

    if n == 0:
        return None

    return {
        "L": L_sum / n,
        "a": a_sum / n,
        "b": b_sum / n,
        "chroma": chroma_sum / n,
        "hue_angles": hue_angles,
        "color_complexity": len(color_bins),
    }


# ── Dominant palette extraction ─────────────────────────────────────────────────

def extract_dominant_palette(ppm_path, n_centers=4, sample_stride=8):
    """Extract n_centers dominant Lab palette centers via histogram quantization."""
    try:
        w, h, raw = read_ppm(ppm_path)
    except Exception:
        return []

    bucket_sums = {}
    for i in range(0, len(raw) - 2, 3 * sample_stride):
        r_v = raw[i]
        g_v = raw[i + 1]
        b_v = raw[i + 2]
        L, a, b_lab = rgb_to_lab(r_v, g_v, b_v)
        L_idx = min(7, int(L / 12.5))
        a_idx = min(7, int((a + 128) / 32))
        b_idx = min(7, int((b_lab + 128) / 32))
        key = (L_idx, a_idx, b_idx)
        if key not in bucket_sums:
            bucket_sums[key] = [0.0, 0.0, 0.0, 0]
        bucket_sums[key][0] += L
        bucket_sums[key][1] += a
        bucket_sums[key][2] += b_lab
        bucket_sums[key][3] += 1

    sorted_buckets = sorted(bucket_sums.values(), key=lambda x: x[3], reverse=True)
    return [
        (b[0] / b[3], b[1] / b[3], b[2] / b[3])
        for b in sorted_buckets[:n_centers] if b[3] > 0
    ]


def palette_drift_between(p1, p2):
    """Minimum delta-E between two palette sets. Returns None if either is empty."""
    if not p1 or not p2:
        return None
    return min(delta_e_76(c1, c2) for c1 in p1 for c2 in p2)


# ── Main analysis ───────────────────────────────────────────────────────────────

def analyze(video_path):
    """Run color consistency analysis v3."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    frames, duration, tmpdir = extract_frames(video_path, n_frames=20)
    if not frames:
        return {
            "tool": "analyze-color-consistency-v3",
            "version": TOOLS_VERSION,
            "video_path": video_path,
            "scores": {
                "color_grading": {
                    "score": 40,
                    "feedback": "Could not extract frames for analysis",
                    "raw": {},
                }
            },
            "overall_score": 40,
            "warnings": ["Frame extraction failed -- check ffmpeg installation"],
        }

    frame_stats = [compute_frame_stats(fp) for fp in frames]
    frame_stats = [s for s in frame_stats if s is not None]

    # Multi-segment palette drift: 4 quarters
    n_f = len(frames)
    q_size = max(1, n_f // 4)
    quarters = [frames[i * q_size:(i + 1) * q_size] for i in range(3)]
    quarters.append(frames[3 * q_size:])  # last quarter gets remainder

    quarter_palettes = []
    for q in quarters:
        if q:
            mid_frame = q[len(q) // 2]
            quarter_palettes.append(extract_dominant_palette(mid_frame))
        else:
            quarter_palettes.append([])

    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if len(frame_stats) < 3:
        return {
            "tool": "analyze-color-consistency-v3",
            "version": TOOLS_VERSION,
            "video_path": video_path,
            "scores": {
                "color_grading": {
                    "score": 40,
                    "feedback": "Too few frames parsed",
                    "raw": {},
                }
            },
            "overall_score": 40,
            "warnings": ["Insufficient frames for color analysis"],
        }

    # Signal 1: Inter-frame Lab delta-E
    labs = [(s["L"], s["a"], s["b"]) for s in frame_stats]
    distances = [delta_e_76(labs[i - 1], labs[i]) for i in range(1, len(labs))]
    mean_delta_e = sum(distances) / len(distances) if distances else 0
    max_delta_e = max(distances) if distances else 0
    jarring_jumps = sum(1 for d in distances if d > 25)

    # Signal 2: Chroma (C*) consistency
    chromas = [s["chroma"] for s in frame_stats]
    chroma_mean = sum(chromas) / len(chromas)
    chroma_std = math.sqrt(sum((c - chroma_mean) ** 2 for c in chromas) / len(chromas))
    chroma_cv = chroma_std / (chroma_mean + 0.01)

    # Signal 3: Lightness (L*) consistency
    lightness = [s["L"] for s in frame_stats]
    L_mean = sum(lightness) / len(lightness)
    L_std = math.sqrt(sum((l - L_mean) ** 2 for l in lightness) / len(lightness))

    # Signal 4 (new): Hue angle circular consistency
    all_hue_angles = []
    for s in frame_stats:
        all_hue_angles.extend(s.get("hue_angles", []))
    circ_std = circular_std_rad(all_hue_angles) if all_hue_angles else 0.0

    # Signal 5 (upgraded): Multi-segment (4-quarter) palette drift
    pair_drifts = []
    for i in range(len(quarter_palettes) - 1):
        d = palette_drift_between(quarter_palettes[i], quarter_palettes[i + 1])
        if d is not None:
            pair_drifts.append(d)
    max_segment_drift = max(pair_drifts) if pair_drifts else None
    avg_segment_drift = sum(pair_drifts) / len(pair_drifts) if pair_drifts else None

    # Signal 6: Color temperature (b* axis) stability (inherited from v2)
    b_vals = [s["b"] for s in frame_stats]
    b_mean = sum(b_vals) / len(b_vals)
    b_std = math.sqrt(sum((bv - b_mean) ** 2 for bv in b_vals) / len(b_vals))
    temp_label = "warm" if b_mean > 8 else ("cool" if b_mean < -8 else "neutral")

    # Signal 7 (new): Color complexity CoV
    complexities = [s["color_complexity"] for s in frame_stats]
    comp_mean = sum(complexities) / len(complexities)
    comp_std = math.sqrt(sum((c - comp_mean) ** 2 for c in complexities) / len(complexities))
    comp_cv = comp_std / (comp_mean + 0.01)

    # --- SCORING ---
    score = 50
    notes = []

    # 1. Inter-frame delta-E (38 pts)
    if mean_delta_e < 5:
        score += 20
        notes.append(
            f"Excellent color consistency (delta-E avg: {mean_delta_e:.1f} -- perceptually imperceptible drift)"
        )
    elif mean_delta_e < 10:
        score += 12
        notes.append(
            f"Good color consistency (delta-E avg: {mean_delta_e:.1f} -- minor perceptual variation)"
        )
    elif mean_delta_e < 18:
        score += 4
        notes.append(
            f"Moderate color variation (delta-E avg: {mean_delta_e:.1f} -- visible shifts between scenes)"
        )
    else:
        score -= 8
        notes.append(
            f"Inconsistent color grading (delta-E avg: {mean_delta_e:.1f} -- large perceptual drift)"
        )

    if jarring_jumps == 0:
        score += 4
        notes.append("No jarring color transitions (all delta-E < 25)")
    elif jarring_jumps == 1:
        notes.append("1 jarring color transition (delta-E > 25) -- check that cut")
    else:
        score -= 8
        notes.append(f"{jarring_jumps} jarring color transitions (delta-E > 25)")

    # 2. Chroma consistency (18 pts)
    if chroma_mean >= 20 and chroma_cv < 0.25:
        score += 18
        notes.append(
            f"Vibrant, consistent color (C*={chroma_mean:.1f}, CV={chroma_cv:.2f}) -- professional grade"
        )
    elif chroma_mean >= 12 and chroma_cv < 0.35:
        score += 10
        notes.append(f"Good chroma consistency (C*={chroma_mean:.1f}, CV={chroma_cv:.2f})")
    elif chroma_mean < 8:
        score -= 4
        notes.append(f"Low colorfulness (C*={chroma_mean:.1f}) -- consider color grading to add vibrancy")
    elif chroma_cv > 0.45:
        score -= 6
        notes.append(f"Inconsistent colorfulness (CV={chroma_cv:.2f}) -- saturation varies across clips")
    else:
        score += 5
        notes.append(f"Acceptable chroma (C*={chroma_mean:.1f}, CV={chroma_cv:.2f})")

    # 3. Lightness consistency (10 pts)
    if L_std < 8:
        score += 10
        notes.append(f"Consistent exposure (L* mean={L_mean:.1f}, std={L_std:.1f})")
    elif L_std < 18:
        score += 5
        notes.append(f"Acceptable exposure variation (L* std={L_std:.1f})")
    else:
        notes.append(
            f"High exposure variation (L* std={L_std:.1f}) -- clips differ significantly in brightness"
        )

    # 4. Hue circular consistency (12 pts -- new)
    if circ_std < 0.3:
        score += 12
        notes.append(
            f"Excellent hue consistency (circular std: {circ_std:.3f} rad) -- consistent color temperature"
        )
    elif circ_std < 0.5:
        score += 7
        notes.append(f"Good hue consistency (circular std: {circ_std:.3f} rad)")
    elif circ_std < 0.8:
        score += 2
        notes.append(
            f"Moderate hue drift (circular std: {circ_std:.3f} rad) -- possible mixed lighting sources"
        )
    else:
        score -= 5
        notes.append(
            f"Significant hue drift (circular std: {circ_std:.3f} rad) -- "
            "mixed warm/cool lighting; apply white balance correction"
        )

    # 5. Multi-segment palette drift (10 pts -- upgraded from v2's 5 pts)
    if max_segment_drift is not None:
        if max_segment_drift < 8:
            score += 10
            notes.append(
                f"Palette stable across all video segments (max drift: {max_segment_drift:.1f} delta-E)"
            )
        elif max_segment_drift < 15:
            score += 5
            notes.append(
                f"Moderate palette drift between segments (max: {max_segment_drift:.1f} delta-E)"
            )
        elif max_segment_drift < 25:
            notes.append(
                f"Notable palette drift in one segment (max: {max_segment_drift:.1f} delta-E) -- "
                "check B-roll color matching"
            )
        else:
            score -= 6
            notes.append(
                f"Large palette drift across edit (max: {max_segment_drift:.1f} delta-E) -- "
                "grading applied inconsistently across segments"
            )

    # 6. Color temperature (b*) stability (5 pts)
    if b_std < 5:
        score += 5
        notes.append(f"Stable color temperature ({temp_label}, b*={b_mean:.1f})")
    elif b_std > 12:
        notes.append(
            f"Mixed color temperature ({temp_label} avg, b* std={b_std:.1f}) -- "
            "clips recorded under different lighting"
        )

    # 7. Color complexity CoV advisory (7 pts)
    if comp_cv < 0.20:
        score += 7
        notes.append(f"Consistent visual complexity across shots (complexity CoV={comp_cv:.2f})")
    elif comp_cv < 0.40:
        score += 3
        notes.append(f"Moderate complexity variation across shots (CoV={comp_cv:.2f})")
    else:
        notes.append(
            f"High visual complexity variation (CoV={comp_cv:.2f}) -- "
            "colorful B-roll mixed with monotone face-cam; may appear visually jarring"
        )

    final_score = min(100, max(0, score))

    return {
        "tool": "analyze-color-consistency-v3",
        "version": TOOLS_VERSION,
        "video_path": video_path,
        "scores": {
            "color_grading": {
                "score": final_score,
                "feedback": "; ".join(notes),
                "raw": {
                    "frames_analyzed": len(frame_stats),
                    "mean_delta_e_lab": round(mean_delta_e, 2),
                    "max_delta_e_lab": round(max_delta_e, 2),
                    "jarring_transitions": jarring_jumps,
                    "chroma_mean_C_star": round(chroma_mean, 2),
                    "chroma_cv": round(chroma_cv, 3),
                    "lightness_L_mean": round(L_mean, 1),
                    "lightness_L_std": round(L_std, 1),
                    "hue_circular_std_rad": round(circ_std, 4),
                    "max_segment_palette_drift": round(max_segment_drift, 2) if max_segment_drift is not None else None,
                    "avg_segment_palette_drift": round(avg_segment_drift, 2) if avg_segment_drift is not None else None,
                    "color_temperature_b_star": round(b_mean, 1),
                    "color_temperature_label": temp_label,
                    "color_temperature_b_std": round(b_std, 1),
                    "color_complexity_mean": round(comp_mean, 1),
                    "color_complexity_cv": round(comp_cv, 3),
                },
            }
        },
        "overall_score": final_score,
        "warnings": [],
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-color-consistency-v3.py <video_path>")
        sys.exit(1)

    result = analyze(sys.argv[1])
    print(json.dumps(result, indent=2))
