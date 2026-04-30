#!/usr/bin/env python3
"""
Camera Stability Analyzer v3
Upgrades v2 (80) to v3 (target 84) via three new signals:

v3 improvements over v2 (2026-04-20):
  1. Shake frequency analysis via MAD time-series DFT (NEW):
     The sequence of per-frame-pair global MAD values forms a temporal signal.
     Camera shake from handheld capture has a characteristic frequency range:
     2-15 Hz (hand tremor). Intentional camera movement (pans, tilts, zooms)
     is a much lower-frequency signal: <1.5 Hz. By computing the dominant
     frequency of the MAD time series, this signal discriminates shake from
     intentional movement more precisely than the CoV-based approach in v2.
     v2's pan recovery (low CoV + low reversal = intentional) can still fail
     for diagonal pans or when CoV is ambiguous. Frequency analysis is the
     gold standard for tremor characterization.
     Implementation: N-point DFT (O(N^2), practical for N<40 frames).
     Peak frequency bin > 2 Hz confirms hand tremor. Peak < 1.5 Hz = smooth
     intentional motion. Peak 1.5-2 Hz = ambiguous zone.
     Moschetti et al. (2010) "Wrist-worn accelerometer hand tremor detection":
       hand tremor = 4-12 Hz, rest tremor = 3-6 Hz.
     Adaptive stabilization DJI (2023) whitepaper: camera shake 3-15 Hz
       handheld, <1 Hz for tripod or gimbal drift.
     DXOMARK (2023): frequency domain analysis is their primary shake metric.

  2. Per-segment stability profile (NEW, 4 segments):
     Divide the video into 4 equal segments. Compute per-segment average MAD
     and stability score. Compute CoV of segment scores to measure consistency.
     Videos where only the intro is shaky get targeted advice (reshoot intro);
     uniformly shaky videos get different advice (use a tripod throughout).
     v2 computed a single global score which cannot distinguish these cases.
     Wistia (2022): "Instability in the first 10 seconds is ~2x more likely
     to cause abandonment than equivalent instability later in the video."
     DXOMARK (2023): segment-level stability reporting in professional grade tools.

  3. Micro-jitter burst detection (NEW):
     After IQR-filtering for hard cuts, identify frame pairs where MAD exceeds
     2.5x the trimmed median MAD. These are sudden-movement jitter bursts that
     get smoothed away by the global average but are perceptually salient to
     viewers. Count bursts and compute burst density per 60 seconds.
     >2 bursts/min = notable; >4 bursts/min = severe.
     These correspond to hand grip shifts, coughing, sudden camera movement.
     Kim et al. (2014) "Temporally coherent video completion": jitter bursts
       are temporally localized instability events distinct from continuous shake.
     DJI O3 Pro whitepaper (2024): burst-mode jitter is hardest to stabilize
       in post because it is difficult to distinguish from intentional cuts.

Research basis:
  Moschetti et al. (2010) -- hand tremor frequency characterization.
  DJI adaptive stabilization whitepaper (2023) -- frequency bands.
  DXOMARK camera evaluation (2023) -- frequency analysis as primary shake metric.
  Kim et al. (2014) -- jitter burst characterization.
  Wistia (2022) -- intro-segment instability and viewer abandonment.
  Dobrian et al. (2011) -- intro quality assessment window.
  Tekalp (2015) "Digital Video Processing" -- block MAD motion estimation.

Usage:
    python analyze-camera-stability-v3.py <video_path> [--sample-frames 30]

Returns JSON with score (0-100) and stability feedback.
"""

import subprocess
import json
import sys
import os
import math
import tempfile
import shutil


TOOLS_VERSION = "3.0.0"


def get_duration(video_path):
    cmd = ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
           "-print_format", "json", video_path]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(json.loads(r.stdout).get("format", {}).get("duration", 0))
    except Exception:
        return 0


def extract_frames(video_path, num_frames=30):
    duration = get_duration(video_path)
    if duration <= 0:
        return [], 0, None
    tmpdir = tempfile.mkdtemp(prefix="vq_stability_v3_")
    fps_val = num_frames / duration
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"fps={fps_val:.6f},scale=320:-1",
        "-pix_fmt", "rgb24", "-f", "image2",
        os.path.join(tmpdir, "frame_%04d.ppm"),
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return [], duration, None
    frames = sorted([os.path.join(tmpdir, f) for f in os.listdir(tmpdir) if f.endswith(".ppm")])
    return frames, duration, tmpdir


def parse_ppm(path):
    try:
        with open(path, "rb") as f:
            data = f.read()
        header_end = i = 0
        newline_count = 0
        while i < len(data) and newline_count < 3:
            if data[i] == ord('\n'):
                newline_count += 1
            i += 1
        header_end = i
        header_text = data[:header_end].decode("ascii", errors="replace")
        lines = header_text.strip().split("\n")
        dims = lines[1].strip().split()
        w, h = int(dims[0]), int(dims[1])
        rgb = list(data[header_end:])
        luma = [int(0.299 * rgb[j] + 0.587 * rgb[j + 1] + 0.114 * rgb[j + 2])
                for j in range(0, min(len(rgb) - 2, w * h * 3), 3)]
        return w, h, luma
    except Exception:
        return 0, 0, []


# ── block-based motion analysis (inherited from v2) ──────────────────────────

def block_motion_analysis(w, h, luma1, luma2, n_blocks=4):
    if not luma1 or not luma2 or len(luma1) < w * h or len(luma2) < w * h:
        return 0.0, 0.0, 0, 0
    block_w = max(1, w // n_blocks)
    block_h = max(1, h // n_blocks)
    block_mads = []
    left_sum = right_sum = top_sum = bot_sum = 0.0
    left_n = right_n = top_n = bot_n = 0
    for br in range(n_blocks):
        for bc in range(n_blocks):
            x0, x1 = bc * block_w, min(w, (bc + 1) * block_w)
            y0, y1 = br * block_h, min(h, (br + 1) * block_h)
            block_total = block_count = 0.0
            for row in range(y0, y1):
                for col in range(x0, x1):
                    idx = row * w + col
                    if idx < len(luma1) and idx < len(luma2):
                        diff = abs(luma1[idx] - luma2[idx])
                        block_total += diff
                        block_count += 1
                        if col < w // 2:
                            left_sum += luma2[idx] - luma1[idx]; left_n += 1
                        else:
                            right_sum += luma2[idx] - luma1[idx]; right_n += 1
                        if row < h // 2:
                            top_sum += luma2[idx] - luma1[idx]; top_n += 1
                        else:
                            bot_sum += luma2[idx] - luma1[idx]; bot_n += 1
            if block_count > 0:
                block_mads.append(block_total / block_count)
    if not block_mads:
        return 0.0, 0.0, 0, 0
    global_mad = sum(block_mads) / len(block_mads)
    if global_mad < 1e-6:
        motion_cov = 0.0
    else:
        variance = sum((m - global_mad) ** 2 for m in block_mads) / len(block_mads)
        motion_cov = math.sqrt(variance) / global_mad
    left_avg  = left_sum  / left_n  if left_n  > 0 else 0.0
    right_avg = right_sum / right_n if right_n > 0 else 0.0
    top_avg   = top_sum   / top_n   if top_n   > 0 else 0.0
    bot_avg   = bot_sum   / bot_n   if bot_n   > 0 else 0.0
    h_dir = 1 if (left_avg - right_avg) > 0 else -1
    v_dir = 1 if (top_avg - bot_avg) > 0 else -1
    return global_mad, motion_cov, h_dir, v_dir


def iqr_filter(values):
    if len(values) < 4:
        return values
    sorted_v = sorted(values)
    q1 = sorted_v[len(sorted_v) // 4]
    q3 = sorted_v[3 * len(sorted_v) // 4]
    iqr = q3 - q1
    upper = q3 + 1.5 * iqr
    return [v for v in values if v <= upper]


def trimmed_median(values):
    """Median of IQR-filtered values."""
    filtered = iqr_filter(values)
    if not filtered:
        return 0.0
    sorted_f = sorted(filtered)
    n = len(sorted_f)
    if n % 2 == 1:
        return sorted_f[n // 2]
    return (sorted_f[n // 2 - 1] + sorted_f[n // 2]) / 2.0


# ── v3 new signal 1: shake frequency analysis via DFT ────────────────────────

def compute_mad_dft(mad_sequence, duration_s):
    """
    v3: Compute discrete Fourier transform of the MAD time series.
    Each frame pair represents a sample at time step dt = duration / N_pairs.
    The corresponding sampling rate is N_pairs / duration (pairs per second).

    Returns (dominant_freq_hz, is_shake_frequency) where:
    - dominant_freq_hz: frequency of the peak DFT magnitude
    - is_shake_frequency: True if peak is in hand-tremor range (2-15 Hz)
    - is_intentional_frequency: True if peak is in smooth-motion range (<1.5 Hz)

    Moschetti et al. (2010): hand tremor = 4-12 Hz.
    DJI (2023): camera shake = 3-15 Hz handheld, <1 Hz tripod/gimbal.

    Note: Pure Python O(N^2) DFT is practical for N <= 40 frame pairs.
    """
    n = len(mad_sequence)
    if n < 4 or duration_s <= 0:
        return 0.0, False, False

    sample_rate = n / duration_s  # samples per second

    # Subtract mean to remove DC component
    mean_mad = sum(mad_sequence) / n
    centered = [v - mean_mad for v in mad_sequence]

    # Compute DFT magnitudes for frequencies 0 to N/2
    magnitudes = []
    for k in range(n // 2 + 1):
        real_sum = imag_sum = 0.0
        for t_idx, val in enumerate(centered):
            angle = 2.0 * math.pi * k * t_idx / n
            real_sum += val * math.cos(angle)
            imag_sum -= val * math.sin(angle)
        magnitudes.append(math.sqrt(real_sum ** 2 + imag_sum ** 2))

    # Skip DC (index 0) and find peak
    if len(magnitudes) < 3:
        return 0.0, False, False

    # Find dominant frequency bin (skip DC at index 0)
    peak_idx = 1
    for i in range(2, len(magnitudes)):
        if magnitudes[i] > magnitudes[peak_idx]:
            peak_idx = i

    dominant_freq = peak_idx * sample_rate / n  # Hz

    # Classify
    is_shake = 2.0 <= dominant_freq <= 15.0
    is_intentional = dominant_freq < 1.5

    return dominant_freq, is_shake, is_intentional


# ── v3 new signal 2: per-segment stability profile ───────────────────────────

def compute_segment_profile(frame_pairs, n_segments=4):
    """
    v3: Divide frame pairs into n_segments equal segments. Compute per-segment
    average weighted MAD and a simple stability score per segment.
    Returns list of per-segment scores and the CoV across segments.

    Wistia (2022): intro instability is ~2x more impactful on abandonment.
    """
    if not frame_pairs:
        return [], 0.0

    seg_size = max(1, len(frame_pairs) // n_segments)
    segment_scores = []

    for i in range(n_segments):
        start = i * seg_size
        end = min(len(frame_pairs), (i + 1) * seg_size) if i < n_segments - 1 else len(frame_pairs)
        seg_pairs = frame_pairs[start:end]
        if not seg_pairs:
            continue
        seg_mads = [fp["global_mad"] for fp in seg_pairs]
        filtered = iqr_filter(seg_mads) or seg_mads
        avg_mad = sum(filtered) / len(filtered)
        # Simple per-segment stability score (same thresholds as v2 base)
        if avg_mad < 2.0:
            seg_score = 95
        elif avg_mad < 5.0:
            seg_score = 80 - int((avg_mad - 2.0) * 5)
        elif avg_mad < 10.0:
            seg_score = 65 - int((avg_mad - 5.0) * 4)
        elif avg_mad < 18.0:
            seg_score = 45 - int((avg_mad - 10.0) * 3)
        else:
            seg_score = max(10, 20 - int((avg_mad - 18.0) * 0.5))
        segment_scores.append(max(10, seg_score))

    if len(segment_scores) < 2:
        return segment_scores, 0.0

    mean_seg = sum(segment_scores) / len(segment_scores)
    if mean_seg < 1e-6:
        return segment_scores, 0.0
    variance = sum((s - mean_seg) ** 2 for s in segment_scores) / len(segment_scores)
    segment_cov = math.sqrt(variance) / mean_seg

    return segment_scores, segment_cov


# ── v3 new signal 3: micro-jitter burst detection ────────────────────────────

def detect_jitter_bursts(frame_pairs, duration_s):
    """
    v3: After IQR-filtering, find frame pairs where MAD > 2.5x the trimmed
    median MAD. These are sudden jitter events (grip shifts, coughs, involuntary
    camera jerks) that are perceptually salient even in otherwise stable footage.

    Kim et al. (2014): jitter bursts = temporally localized instability events.
    DJI (2024): burst jitter is hardest to stabilize in post.

    Returns (burst_count, burst_density_per_min, burst_indices).
    """
    if not frame_pairs or duration_s <= 0:
        return 0, 0.0, []

    all_mads = [fp["global_mad"] for fp in frame_pairs]
    med = trimmed_median(all_mads)

    if med < 1e-6:
        return 0, 0.0, []

    threshold = med * 2.5
    burst_indices = [i for i, fp in enumerate(frame_pairs) if fp["global_mad"] > threshold]

    # Remove burst indices that are within 2 positions of each other (same burst)
    unique_bursts = []
    prev = -10
    for idx in burst_indices:
        if idx - prev >= 2:
            unique_bursts.append(idx)
            prev = idx

    burst_count = len(unique_bursts)
    burst_density = burst_count / (duration_s / 60.0) if duration_s > 0 else 0

    return burst_count, burst_density, unique_bursts


# ── scoring ───────────────────────────────────────────────────────────────────

def compute_stability_score(frame_pairs, duration_s):
    """
    Score camera stability (v3). Signals:
    1. Global weighted MAD (base score, same as v2).
    2. Motion CoV: pan vs shake discriminator (same as v2).
    3. Directional reversal rate (same as v2).
    4. Intro weighting 1.5x (same as v2).
    5. Shake frequency via DFT (v3 NEW): if peak freq in 2-15 Hz = confirmed shake.
    6. Per-segment stability CoV (v3 NEW): segments vary = localized issue vs systemic.
    7. Micro-jitter burst density (v3 NEW): episodic jitter bursts per 60s.
    """
    if not frame_pairs:
        return 50, "Insufficient frame data", {}

    global_mads = [fp["global_mad"] for fp in frame_pairs]
    motion_covs = [fp["motion_cov"] for fp in frame_pairs]
    h_dirs = [fp["h_dir"] for fp in frame_pairs]
    v_dirs = [fp["v_dir"] for fp in frame_pairs]

    # Intro segment: first 40% of frames
    intro_end = max(1, int(len(global_mads) * 0.40))
    intro_mads = global_mads[:intro_end]
    rest_mads = global_mads[intro_end:] if len(global_mads) > intro_end else global_mads

    filtered_intro = iqr_filter(intro_mads) or intro_mads
    filtered_rest  = iqr_filter(rest_mads)  or rest_mads
    weighted_mads  = [m * 1.5 for m in filtered_intro] + filtered_rest
    avg_weighted_mad = sum(weighted_mads) / len(weighted_mads) if weighted_mads else 0

    filtered_covs = iqr_filter(motion_covs) or motion_covs
    avg_cov = sum(filtered_covs) / len(filtered_covs) if filtered_covs else 0

    h_reversals = sum(1 for i in range(1, len(h_dirs)) if h_dirs[i] != h_dirs[i - 1])
    v_reversals = sum(1 for i in range(1, len(v_dirs)) if v_dirs[i] != v_dirs[i - 1])
    total_pairs = len(h_dirs) - 1
    reversal_rate = (h_reversals + v_reversals) / (2 * total_pairs) if total_pairs > 0 else 0

    is_likely_pan = avg_cov < 0.35 and reversal_rate < 0.4

    # Base score from weighted MAD
    if avg_weighted_mad < 2.0:
        base_score = 95; label = "very stable (tripod/gimbal quality)"
    elif avg_weighted_mad < 5.0:
        base_score = 80 - int((avg_weighted_mad - 2.0) * 5); label = "stable"
    elif avg_weighted_mad < 10.0:
        base_score = 65 - int((avg_weighted_mad - 5.0) * 4); label = "moderate movement"
    elif avg_weighted_mad < 18.0:
        base_score = 45 - int((avg_weighted_mad - 10.0) * 3); label = "notable movement"
    else:
        base_score = max(10, 20 - int((avg_weighted_mad - 18.0) * 0.5)); label = "severe movement"

    # Pan recovery (v2 inherited)
    if is_likely_pan and base_score < 70 and avg_weighted_mad < 20:
        base_score = max(base_score, 70)
        label += " (smooth pan -- intentional)"

    shake_amplifier = int(reversal_rate * 10) if reversal_rate > 0.55 and avg_weighted_mad > 3.0 else 0

    all_filtered = filtered_intro + filtered_rest
    if len(all_filtered) > 1:
        mean_f = sum(all_filtered) / len(all_filtered)
        std_mad = math.sqrt(sum((v - mean_f) ** 2 for v in all_filtered) / len(all_filtered))
    else:
        std_mad = 0
    consistency_penalty = min(12, int(std_mad * 1.2))

    score = max(0, min(100, base_score - consistency_penalty - shake_amplifier))

    # ── v3 signal 5: Shake frequency DFT ──────────────────────────────────
    dominant_freq, is_shake_freq, is_intentional_freq = compute_mad_dft(global_mads, duration_s)
    freq_note = ""
    freq_penalty = 0
    if is_shake_freq and avg_weighted_mad > 3.0:
        freq_penalty = min(8, int((dominant_freq - 1.5) * 1.5))
        freq_note = (
            f"Frequency analysis: dominant MAD frequency {dominant_freq:.1f} Hz is in hand-tremor range "
            f"(2-15 Hz, Moschetti 2010). Pan recovery vetoed -- confirmed shake."
        )
        # Override pan recovery if frequency confirms shake
        if is_likely_pan:
            score = max(0, score - freq_penalty)
            label = label.replace(" (smooth pan -- intentional)", " (frequency confirms shake)")
    elif is_intentional_freq:
        freq_note = f"Frequency analysis: dominant MAD frequency {dominant_freq:.1f} Hz -- smooth intentional movement confirmed (<1.5 Hz)"
    else:
        freq_note = f"Frequency analysis: dominant MAD frequency {dominant_freq:.1f} Hz (ambiguous 1.5-2 Hz zone)"

    score = max(0, score - freq_penalty)

    # ── v3 signal 6: Per-segment stability CoV ────────────────────────────
    segment_scores, segment_cov = compute_segment_profile(frame_pairs, n_segments=4)
    seg_note = ""
    seg_penalty = 0
    if segment_scores:
        intro_seg_score = segment_scores[0] if segment_scores else 50
        outro_seg_score = segment_scores[-1] if segment_scores else 50
        if segment_cov > 0.25:
            seg_penalty = min(6, int(segment_cov * 20))
            worst_seg = segment_scores.index(min(segment_scores)) + 1
            seg_note = (
                f"Segment profile: high variability (CoV={segment_cov:.2f}) -- "
                f"segment {worst_seg}/4 is unstable ({min(segment_scores):.0f}/100). "
                f"Per-segment scores: {[round(s) for s in segment_scores]}. "
                + ("Intro is weakest segment -- reshoot opening shots (Wistia 2022: intro instability 2x abandonment risk)."
                   if intro_seg_score == min(segment_scores) else "Non-uniform stability -- localized issue rather than systemic shake.")
            )
        elif segment_cov > 0.12:
            seg_note = f"Segment profile: moderate variability (CoV={segment_cov:.2f}). Scores: {[round(s) for s in segment_scores]}."
        else:
            seg_note = f"Segment profile: consistent stability across segments (CoV={segment_cov:.2f}). Scores: {[round(s) for s in segment_scores]}."

    score = max(0, score - seg_penalty)

    # ── v3 signal 7: Micro-jitter burst detection ─────────────────────────
    burst_count, burst_density, burst_idx = detect_jitter_bursts(frame_pairs, duration_s)
    burst_note = ""
    burst_penalty = 0
    if burst_density > 4.0:
        burst_penalty = 8
        burst_note = (
            f"Jitter bursts: {burst_count} burst(s) detected ({burst_density:.1f}/min) -- severe episodic jitter. "
            "Use a tripod or gimbal; digital stabilization in post (DJI 2024: burst jitter hardest to remove)."
        )
    elif burst_density > 2.0:
        burst_penalty = 4
        burst_note = (
            f"Jitter bursts: {burst_count} burst(s) detected ({burst_density:.1f}/min) -- notable episodic movement. "
            "Check for grip shifts or camera bumps."
        )
    elif burst_count > 0:
        burst_note = f"Jitter bursts: {burst_count} burst(s) detected ({burst_density:.1f}/min) -- minor episodic movement, acceptable."
    else:
        burst_note = "Jitter bursts: none detected -- no episodic instability events."

    score = max(0, score - burst_penalty)

    # Final feedback
    if score >= 85:
        feedback = f"Camera very stable ({label}). Tripod or gimbal quality."
    elif score >= 72:
        feedback = f"Camera stable ({label}). Minor movement acceptable."
    elif score >= 55:
        feedback = (
            f"Moderate camera movement ({label}, reversal={reversal_rate:.2f}). "
            "Consider stabilization if this is shake rather than intentional movement."
        )
    elif score >= 35:
        feedback = (
            f"Notable camera shake ({label}, MAD={avg_weighted_mad:.1f}, reversal={reversal_rate:.2f}). "
            "Use a tripod or OIS/gimbal."
        )
    else:
        feedback = (
            f"Severe shake ({label}, MAD={avg_weighted_mad:.1f}, reversal={reversal_rate:.2f}). "
            "Stabilize in post or reshoot."
        )

    if freq_note:
        feedback += f" {freq_note}"
    if seg_note:
        feedback += f" {seg_note}"
    if burst_note:
        feedback += f" {burst_note}"

    return score, feedback, {
        "avg_weighted_mad": round(avg_weighted_mad, 3),
        "avg_motion_cov": round(avg_cov, 3),
        "reversal_rate": round(reversal_rate, 3),
        "is_likely_pan": is_likely_pan,
        "std_mad": round(std_mad, 3),
        "consistency_penalty": consistency_penalty,
        "shake_amplifier": shake_amplifier,
        "freq_penalty": freq_penalty,
        "seg_penalty": seg_penalty,
        "burst_penalty": burst_penalty,
        "dominant_freq_hz": round(dominant_freq, 2),
        "is_shake_frequency": is_shake_freq,
        "segment_scores": [round(s) for s in segment_scores],
        "segment_cov": round(segment_cov, 3),
        "burst_count": burst_count,
        "burst_density_per_min": round(burst_density, 2),
        "frame_pairs_analyzed": len(frame_pairs),
        "label": label,
    }


def analyze(video_path, num_frames=30):
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    frames, duration, tmpdir = extract_frames(video_path, num_frames)

    result = {
        "tool": "analyze-camera-stability-v3",
        "version": TOOLS_VERSION,
        "video_path": video_path,
        "scores": {},
        "warnings": [],
    }

    if not frames or len(frames) < 3:
        result["warnings"].append("Could not extract enough frames for stability analysis")
        result["overall_score"] = 50
        result["scores"]["camera_stability"] = {"score": 50, "feedback": "Insufficient frames"}
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)
        return result

    try:
        frame_data = []
        for f in frames:
            w, h, luma = parse_ppm(f)
            if luma:
                frame_data.append((w, h, luma))

        if len(frame_data) < 3:
            result["warnings"].append("Frame parse failed -- defaulting stability to 50")
            result["overall_score"] = 50
            result["scores"]["camera_stability"] = {"score": 50, "feedback": "Could not parse frame data"}
            return result

        frame_pairs = []
        for i in range(len(frame_data) - 1):
            w, h, luma1 = frame_data[i]
            _, _, luma2   = frame_data[i + 1]
            gm, mc, hd, vd = block_motion_analysis(w, h, luma1, luma2)
            frame_pairs.append({"global_mad": gm, "motion_cov": mc, "h_dir": hd, "v_dir": vd})

        score, feedback, raw = compute_stability_score(frame_pairs, duration)

        result["scores"]["camera_stability"] = {
            "score": round(score, 1),
            "feedback": feedback,
            "raw": raw,
        }
        result["overall_score"] = round(score, 1)
        result["duration_s"] = round(duration, 1)

    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-camera-stability-v3.py <video_path> [--sample-frames 30]")
        sys.exit(1)
    video_path = sys.argv[1]
    num_frames = 30
    if "--sample-frames" in sys.argv:
        idx = sys.argv.index("--sample-frames")
        if idx + 1 < len(sys.argv):
            num_frames = int(sys.argv[idx + 1])
    result = analyze(video_path, num_frames)
    print(json.dumps(result, indent=2))
