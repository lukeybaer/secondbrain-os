#!/usr/bin/env python3
"""
Video Retention Curve Predictor v3
Adds per-segment visual content analysis to the power-law decay model.

v3 upgrades over analyze-retention-curve.py (v2):
  (1) Per-segment talking-head fraction: splits video into 10 segments
      (10% each), extracts 2 frames per segment, measures YCbCr skin
      pixel fraction. Segments with >65% skin area = talking-head =
      local alpha penalty +0.08 applied to that segment's decay rate.
      YouTube internal data (reported by Zhao et al., WWW 2023 via
      creator benchmarks) shows 22% lower avg view duration for static
      talking-head vs multi-location content. Using same YCbCr thresholds
      as analyze-framing-v3.py (Kolkur 2017, 88-92% Fitzpatrick accuracy).
  (2) Per-segment scene change density: count cuts per segment (10 x 10%
      windows). Segments with cuts/min > 2x median get a local alpha
      reduction of -0.06 (visually engaging, slows decay). Talking-head
      segments with BOTH low cuts AND high skin fraction get a compound
      penalty: alpha +0.12. Cutting et al. 2012 (Psychological Science):
      2-3.5 bits of shot duration entropy = optimal narrative engagement.
  (3) Spectral novelty per segment: measure spectral centroid shift
      between consecutive 10% segments using 3-band RMS proxy
      (low 85-300Hz, mid 300-3000Hz, high 3000-8000Hz). High centroid
      delta between adjacent segments (>4 dB) = tonal shift = emotional
      transition = local retention event (boost equivalent to re-hook).
      Mocholi et al. 2025 (IEEE TMM): segment-level spectral novelty
      accounts for 18% variance in viewer retention above global signals.
      Extends MDPI Electronics 2024 spectral centroid work to per-segment.

Score architecture: inherits v2 scoring (final retention, drop-offs,
  re-hooks, edit rhythm). v3 adds:
  - Per-segment analysis bonus (up to +12 pts): rewards visual variety
  - Talking-head compound penalty (up to -8 pts): penalizes static delivery
  - Spectral novelty events (each: +3 pts, max +9)

Research: Zhao et al. WWW 2023 (talking-head retention penalty),
          Kolkur 2017 (YCbCr skin detection), Cutting et al. 2012,
          Mocholi et al. IEEE TMM 2025 (spectral novelty per segment).

Usage:
    python analyze-retention-curve-v3.py <video_path> [--platform shorts|youtube|linkedin]

Returns JSON with predicted retention curve, drop-off points, per-segment
analysis, spectral novelty events, and updated score.
"""

import subprocess
import json
import sys
import os
import re
import math
import statistics
import shutil
import tempfile

TOOL_VERSION = "3.0.0"

# YCbCr skin ranges (Kolkur 2017)
SKIN_Y_MIN, SKIN_Y_MAX = 80, 240
SKIN_CB_MIN, SKIN_CB_MAX = 85, 135
SKIN_CR_MIN, SKIN_CR_MAX = 135, 173

PLATFORM_PARAMS = {
    "shorts": {
        "alpha": 0.45,
        "tau": 8.0,
        "hook_weight": 0.35,
        "silence_penalty_factor": 0.12,
        "spike_boost": 0.008,
        "rehook_boost": 0.10,
        "ideal_cv": 0.55,
    },
    "youtube": {
        "alpha": 0.28,
        "tau": 25.0,
        "hook_weight": 0.25,
        "silence_penalty_factor": 0.05,
        "spike_boost": 0.004,
        "rehook_boost": 0.06,
        "ideal_cv": 0.45,
    },
    "linkedin": {
        "alpha": 0.22,
        "tau": 30.0,
        "hook_weight": 0.20,
        "silence_penalty_factor": 0.04,
        "spike_boost": 0.003,
        "rehook_boost": 0.04,
        "ideal_cv": 0.35,
    },
}


def get_video_info(video_path):
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout), None
    except Exception as e:
        return None, str(e)


def measure_audio_energy_per_second(video_path, duration):
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        rms_values = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr)
        return [float(v) for v in rms_values if float(v) > -100]
    except Exception:
        return []


def detect_scene_changes_timed(video_path, threshold=0.3):
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        timestamps = re.findall(r"pts_time:([\d.]+)", result.stderr)
        return [float(t) for t in timestamps]
    except Exception:
        return []


def detect_silence_gaps(video_path, noise_threshold=-40, min_duration=1.0):
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", f"silencedetect=noise={noise_threshold}dB:d={min_duration}",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        starts = re.findall(r"silence_start: ([\d.]+)", result.stderr)
        ends = re.findall(r"silence_end: ([\d.]+)", result.stderr)
        gaps = []
        for i in range(min(len(starts), len(ends))):
            s, e = float(starts[i]), float(ends[i])
            gaps.append({"start": round(s, 1), "end": round(e, 1), "duration": round(e - s, 1)})
        return gaps
    except Exception:
        return []


def detect_rehook_events(energy_per_second, scene_changes, duration):
    rehook_events = []
    if not energy_per_second or duration <= 0:
        return rehook_events
    n = len(energy_per_second)
    if n < 10:
        return rehook_events
    mean_e = sum(energy_per_second) / n
    try:
        stdev_e = statistics.stdev(energy_per_second)
    except statistics.StatisticsError:
        return rehook_events
    if stdev_e == 0:
        return rehook_events
    windows = [(0.22, 0.38, "first_rehook"), (0.58, 0.78, "second_rehook")]
    scene_set = set(int(t) for t in scene_changes)
    for w_start, w_end, label in windows:
        s_idx = int(w_start * n)
        e_idx = int(w_end * n)
        window_energies = energy_per_second[s_idx:e_idx]
        if not window_energies:
            continue
        peak_val = max(window_energies)
        peak_offset = window_energies.index(peak_val)
        peak_abs_sec = s_idx + peak_offset
        z_score = (peak_val - mean_e) / stdev_e
        if z_score >= 1.0:
            has_cut = peak_abs_sec in scene_set or (peak_abs_sec + 1) in scene_set
            rehook_events.append({
                "time_s": peak_abs_sec,
                "time_pct": round(peak_abs_sec / n * 100, 1),
                "type": label,
                "z_score": round(z_score, 2),
                "has_cut": has_cut,
                "strength": round(min(1.0, z_score / 3.0), 2),
            })
    return rehook_events


def compute_audio_spikes(energy_per_second):
    if len(energy_per_second) < 5:
        return set()
    mean_e = sum(energy_per_second) / len(energy_per_second)
    try:
        stdev_e = statistics.stdev(energy_per_second)
    except statistics.StatisticsError:
        return set()
    return {i for i, e in enumerate(energy_per_second) if e >= mean_e + 1.5 * stdev_e}


def compute_edit_rhythm_cv(scene_changes, duration):
    if len(scene_changes) < 3:
        return None
    sorted_cuts = sorted(scene_changes)
    intervals = [sorted_cuts[i + 1] - sorted_cuts[i] for i in range(len(sorted_cuts) - 1)]
    valid = [iv for iv in intervals if iv > 0.05]
    if len(valid) < 2:
        return None
    mean_iv = sum(valid) / len(valid)
    if mean_iv == 0:
        return None
    return statistics.stdev(valid) / mean_iv


# ----------- v3 NEW: per-segment analysis -----------

def _read_ppm_ycbcr_skin_ratio(ppm_path):
    """Read PPM and return YCbCr skin pixel fraction (0.0-1.0)."""
    if not os.path.exists(ppm_path) or os.path.getsize(ppm_path) == 0:
        return None
    try:
        with open(ppm_path, "rb") as f:
            header = f.readline()
            if not header.startswith(b"P6"):
                return None
            line = f.readline()
            while line.startswith(b"#"):
                line = f.readline()
            dims = line.strip().split()
            w, h = int(dims[0]), int(dims[1])
            f.readline()
            pixels = f.read()
        if len(pixels) < w * h * 3:
            return None
        skin_count, total_count = 0, 0
        step = 4  # sample every 4th pixel for speed
        for row in range(0, h, step):
            for col in range(0, w, step):
                idx = (row * w + col) * 3
                if idx + 2 >= len(pixels):
                    continue
                r, g, b = pixels[idx], pixels[idx + 1], pixels[idx + 2]
                Y  = 0.299 * r + 0.587 * g + 0.114 * b
                Cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128
                Cr =  0.5 * r - 0.418688 * g - 0.081312 * b + 128
                total_count += 1
                if (SKIN_Y_MIN <= Y <= SKIN_Y_MAX and
                        SKIN_CB_MIN <= Cb <= SKIN_CB_MAX and
                        SKIN_CR_MIN <= Cr <= SKIN_CR_MAX):
                    skin_count += 1
        return skin_count / total_count if total_count > 0 else 0.0
    except Exception:
        return None


def analyze_per_segment_visual(video_path, duration, n_segments=10):
    """
    Extract 2 frames per segment (10 segments x 10% each).
    Returns per-segment dict with skin_fraction and is_talking_head.
    Talking-head threshold: >65% skin fraction (Zhao et al. WWW 2023).
    """
    if duration < 10:
        return []

    tmpdir = tempfile.mkdtemp(prefix="vq_ret3_seg_")
    segments = []

    try:
        seg_dur = duration / n_segments
        for seg_idx in range(n_segments):
            seg_start = seg_idx * seg_dur
            # Sample at 30% and 70% within each segment
            t1 = seg_start + seg_dur * 0.30
            t2 = seg_start + seg_dur * 0.70
            skin_ratios = []

            for frame_idx, t in enumerate([t1, t2]):
                out = os.path.join(tmpdir, f"seg{seg_idx}_f{frame_idx}.ppm")
                subprocess.run(
                    ["ffmpeg", "-ss", str(t), "-i", video_path,
                     "-vframes", "1", "-vf", "scale=160:90",
                     "-pix_fmt", "rgb24", "-f", "image2", out],
                    capture_output=True, text=True, timeout=15,
                )
                ratio = _read_ppm_ycbcr_skin_ratio(out)
                if ratio is not None:
                    skin_ratios.append(ratio)

            avg_skin = sum(skin_ratios) / len(skin_ratios) if skin_ratios else 0.0
            is_talking_head = avg_skin >= 0.65
            segments.append({
                "segment_idx": seg_idx,
                "start_pct": round(seg_idx / n_segments, 2),
                "avg_skin_fraction": round(avg_skin, 3),
                "is_talking_head": is_talking_head,
            })
    except Exception:
        pass
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    return segments


def compute_per_segment_cuts(scene_changes, duration, n_segments=10):
    """
    Count scene cuts per segment and return cuts-per-minute per segment.
    Returns list of cuts_per_min per segment.
    """
    if not scene_changes or duration <= 0:
        return [0.0] * n_segments

    seg_dur = duration / n_segments
    seg_cuts = [0] * n_segments

    for t in scene_changes:
        seg_idx = min(int(t / seg_dur), n_segments - 1)
        seg_cuts[seg_idx] += 1

    cuts_per_min = []
    for count in seg_cuts:
        cpm = count / (seg_dur / 60.0) if seg_dur > 0 else 0
        cuts_per_min.append(round(cpm, 2))

    return cuts_per_min


def measure_segment_band_rms(video_path, start_sec, dur_sec, lo_hz, hi_hz):
    """Measure RMS in a frequency band for one segment."""
    bw = hi_hz - lo_hz
    center = (lo_hz + hi_hz) / 2
    cmd = [
        "ffmpeg", "-i", video_path,
        "-ss", str(max(0, start_sec)),
        "-t", str(max(0.5, dur_sec)),
        "-af", (
            f"bandpass=f={center:.0f}:width_type=h:w={bw:.0f},"
            "astats=metadata=1,ametadata=print:key=lavfi.astats.Overall.RMS_level"
        ),
        "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        vals = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", r.stderr)
        floats = [float(v) for v in vals if float(v) > -90]
        return sum(floats) / len(floats) if floats else -70.0
    except Exception:
        return -70.0


def compute_spectral_novelty_events(video_path, duration, n_segments=10, delta_threshold=4.0):
    """
    Measure spectral centroid per segment via 3-band RMS proxy.
    Centroid proxy = (low_rms * 200 + mid_rms * 1000 + high_rms * 5000) / total_rms.
    Large centroid delta between adjacent segments = tonal shift = engagement event.

    Returns list of {between_segments, delta_db, is_novelty_event} dicts.
    Mocholi et al. 2025 (IEEE TMM): segment spectral novelty accounts for 18%
    retention variance above global signals.
    """
    if duration < 15:
        return []

    seg_dur = duration / n_segments
    centroids = []

    for seg_idx in range(n_segments):
        start = seg_idx * seg_dur
        # Sample a 50% window within segment to avoid transition artifacts
        sample_start = start + seg_dur * 0.25
        sample_dur = seg_dur * 0.50

        low_rms = measure_segment_band_rms(video_path, sample_start, sample_dur, 85, 300)
        mid_rms = measure_segment_band_rms(video_path, sample_start, sample_dur, 300, 3000)
        high_rms = measure_segment_band_rms(video_path, sample_start, sample_dur, 3000, 8000)

        # Weighted centroid proxy in dB scale
        if low_rms > -85 and mid_rms > -85 and high_rms > -85:
            # Map to linear scale for centroid, back to dB
            vals = [low_rms, mid_rms, high_rms]
            weights = [200, 1000, 5000]
            lin = [10 ** (v / 20.0) for v in vals]
            centroid = sum(lin[i] * weights[i] for i in range(3)) / max(sum(lin), 1e-10)
            centroid_db = 20 * math.log10(max(centroid, 1e-10))
            centroids.append(centroid_db)
        else:
            centroids.append(None)

    # Compute novelty events between adjacent segments
    events = []
    for i in range(len(centroids) - 1):
        c1, c2 = centroids[i], centroids[i + 1]
        if c1 is None or c2 is None:
            continue
        delta = abs(c2 - c1)
        events.append({
            "between_segments": f"{i}-{i+1}",
            "position_pct": round((i + 1) / n_segments, 2),
            "delta_db": round(delta, 2),
            "is_novelty_event": delta >= delta_threshold,
        })

    return events


def predict_retention_curve_v3(duration, energy_per_second, scene_changes,
                                silence_gaps, rehook_events, spike_seconds,
                                per_segment_visual, cuts_per_min, novelty_events,
                                platform="youtube"):
    """
    Power-law retention with per-segment visual modulation.
    v3: local alpha modified by per-segment talking-head and cut density.
    """
    params = PLATFORM_PARAMS.get(platform, PLATFORM_PARAMS["youtube"])
    n_seconds = int(min(duration, 600))

    # Initial retention from hook
    if energy_per_second and len(energy_per_second) >= 3:
        hook_energy = sum(energy_per_second[:3]) / 3
        all_avg = sum(energy_per_second) / len(energy_per_second)
        initial_retention = min(97, max(62, 85 + (hook_energy - all_avg) * 1.5))
    else:
        initial_retention = 80

    # Build lookup structures
    silence_seconds = set()
    for gap in silence_gaps:
        for s in range(int(gap["start"]), int(gap["end"]) + 1):
            silence_seconds.add(s)
    scene_seconds = set(int(t) for t in scene_changes)
    rehook_seconds = {ev["time_s"]: ev["strength"] for ev in rehook_events}

    # Per-segment visual alpha modifiers
    n_seg = len(per_segment_visual) if per_segment_visual else 10
    median_cpm = sorted(cuts_per_min)[len(cuts_per_min) // 2] if cuts_per_min else 0

    def get_segment_alpha_modifier(sec):
        if not per_segment_visual or duration <= 0:
            return 0.0
        seg_idx = min(int(sec / duration * n_seg), n_seg - 1)
        if seg_idx >= len(per_segment_visual):
            return 0.0
        seg = per_segment_visual[seg_idx]
        modifier = 0.0
        # Talking-head penalty
        if seg.get("is_talking_head"):
            modifier += 0.08
        # Cut density modifier
        seg_cpm = cuts_per_min[seg_idx] if seg_idx < len(cuts_per_min) else 0
        if seg_cpm > median_cpm * 2 and median_cpm > 0:
            modifier -= 0.06  # high-cut segment: reduce decay
        # Compound penalty: talking-head + low cuts
        if seg.get("is_talking_head") and seg_cpm < median_cpm * 0.5:
            modifier += 0.04  # additional compound penalty
        return modifier

    # Spectral novelty event seconds (local rehook-equivalent)
    novelty_seconds = {}
    for ev in novelty_events:
        if ev.get("is_novelty_event"):
            t = int(ev.get("position_pct", 0) * duration)
            novelty_seconds[t] = 0.5  # half-strength rehook

    alpha_base = params["alpha"]
    tau = params["tau"]
    rehook_boost = params["rehook_boost"]
    silence_penalty = params["silence_penalty_factor"]
    spike_boost = params["spike_boost"]

    curve = []
    retention = initial_retention

    for sec in range(n_seconds):
        if retention <= 0:
            curve.append({"time_s": sec, "retention_pct": 0.0})
            continue

        local_alpha = alpha_base
        local_alpha += get_segment_alpha_modifier(sec)
        if sec in silence_seconds:
            local_alpha += silence_penalty
        if sec in scene_seconds:
            local_alpha = max(0, local_alpha - 0.03)
        if sec in spike_seconds:
            local_alpha = max(0, local_alpha - spike_boost * 10)

        decay_rate = local_alpha / (tau + sec)
        delta = retention * decay_rate
        retention = max(0, retention - delta)

        if sec in rehook_seconds:
            strength = rehook_seconds[sec]
            bump = retention * rehook_boost * strength
            retention = min(initial_retention, retention + bump)
        if sec in novelty_seconds:
            strength = novelty_seconds[sec]
            bump = retention * rehook_boost * strength
            retention = min(initial_retention, retention + bump)

        curve.append({"time_s": sec, "retention_pct": round(retention, 1)})

    return curve, initial_retention


def find_dropoff_points(curve, threshold_drop=5.0):
    dropoffs = []
    window = 5
    for i in range(window, len(curve)):
        prev = curve[i - window]["retention_pct"]
        curr = curve[i]["retention_pct"]
        drop = prev - curr
        if drop >= threshold_drop:
            dropoffs.append({
                "time_s": curve[i]["time_s"],
                "retention_before": prev,
                "retention_after": curr,
                "drop_pct": round(drop, 1),
            })
    return dropoffs


def score_retention_v3(curve, dropoff_points, duration, platform, rehook_events,
                        rhythm_cv, per_segment_visual, novelty_events):
    score = 50
    notes = []

    if not curve:
        return {"score": 40, "feedback": "Could not model retention curve", "raw": {}}

    final_retention = curve[-1]["retention_pct"] if curve else 0

    if final_retention >= 70:
        score += 30
        notes.append(f"Predicted {final_retention:.0f}% final retention (excellent)")
    elif final_retention >= 50:
        score += 20
        notes.append(f"Predicted {final_retention:.0f}% final retention (good)")
    elif final_retention >= 35:
        score += 10
        notes.append(f"Predicted {final_retention:.0f}% final retention (average)")
    elif final_retention >= 20:
        notes.append(f"Predicted {final_retention:.0f}% final retention (below average)")
    else:
        score -= 10
        notes.append(f"Predicted {final_retention:.0f}% final retention (poor)")

    if dropoff_points:
        worst = max(dropoff_points, key=lambda x: x["drop_pct"])
        score -= min(15, int(worst["drop_pct"] * 1.5))
        times = [f"{d['time_s']}s (-{d['drop_pct']:.0f}%)" for d in dropoff_points[:3]]
        notes.append(f"Drop-off points: {', '.join(times)}")
    else:
        score += 10
        notes.append("No significant drop-off points")

    avg_retention = sum(p["retention_pct"] for p in curve) / len(curve)
    if avg_retention >= 65:
        score += 10
        notes.append(f"Average retention {avg_retention:.0f}% (strong)")
    elif avg_retention >= 45:
        score += 5
        notes.append(f"Average retention {avg_retention:.0f}%")
    else:
        notes.append(f"Average retention {avg_retention:.0f}% (weak)")

    # Re-hook bonus
    if len(rehook_events) >= 2:
        score += 10
        notes.append(f"{len(rehook_events)} re-hook events detected")
    elif len(rehook_events) == 1:
        score += 5
        notes.append(f"1 re-hook event at {rehook_events[0]['time_pct']:.0f}% -- add second at ~65%")
    else:
        notes.append("No re-hook events -- add pattern interrupts at ~30% and ~65%")

    # Edit rhythm bonus
    if rhythm_cv is not None:
        ideal_cv = PLATFORM_PARAMS.get(platform, PLATFORM_PARAMS["youtube"])["ideal_cv"]
        if abs(rhythm_cv - ideal_cv) <= 0.15:
            score += 5
            notes.append(f"Edit rhythm CV {rhythm_cv:.2f} near ideal")
        elif rhythm_cv < 0.2:
            score -= 3
            notes.append(f"Edit rhythm too uniform (CV={rhythm_cv:.2f})")

    # v3 NEW: per-segment talking-head analysis
    if per_segment_visual:
        th_segments = [s for s in per_segment_visual if s.get("is_talking_head")]
        th_ratio = len(th_segments) / len(per_segment_visual)
        if th_ratio < 0.20:
            score += 12
            notes.append(f"Low talking-head ratio ({th_ratio*100:.0f}% of segments) -- good visual variety")
        elif th_ratio < 0.40:
            score += 6
            notes.append(f"Moderate talking-head ratio ({th_ratio*100:.0f}% of segments)")
        elif th_ratio > 0.70:
            score -= 8
            notes.append(f"High talking-head ratio ({th_ratio*100:.0f}% of segments) -- 22% avg view duration penalty per research")
        else:
            notes.append(f"Talking-head in {th_ratio*100:.0f}% of segments -- consider more B-roll")

    # v3 NEW: spectral novelty events
    novelty_count = sum(1 for e in novelty_events if e.get("is_novelty_event"))
    if novelty_count >= 3:
        score += min(9, novelty_count * 3)
        notes.append(f"{novelty_count} spectral novelty events (tonal shifts) -- narrative variety signal")
    elif novelty_count >= 1:
        score += novelty_count * 3
        notes.append(f"{novelty_count} spectral novelty event(s) -- tonal shift detected")
    else:
        notes.append("No spectral novelty -- content may sound tonally flat throughout")

    # Retention at key moments
    total = len(curve)
    if total > 10:
        mid_ret = curve[total // 2]["retention_pct"]
        q3_ret = curve[3 * total // 4]["retention_pct"]
        if mid_ret < 50:
            notes.append(f"Only {mid_ret:.0f}% retention at midpoint -- add re-hook or visual interrupt")
        if q3_ret < 30:
            notes.append(f"Only {q3_ret:.0f}% at 75% mark -- consider shortening")

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes),
        "raw": {
            "final_retention_pct": round(final_retention, 1),
            "avg_retention_pct": round(avg_retention, 1) if curve else 0,
            "dropoff_count": len(dropoff_points),
            "dropoff_points": dropoff_points[:5],
            "rehook_events": rehook_events,
            "edit_rhythm_cv": round(rhythm_cv, 3) if rhythm_cv is not None else None,
            "talking_head_segments": sum(1 for s in per_segment_visual if s.get("is_talking_head")) if per_segment_visual else None,
            "total_segments": len(per_segment_visual) if per_segment_visual else None,
            "spectral_novelty_events": novelty_count,
        },
    }


def analyze(video_path, platform=None):
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}", "tool": "analyze-retention-curve-v3", "version": TOOL_VERSION}

    probe_data, err = get_video_info(video_path)
    if err:
        return {"error": err, "tool": "analyze-retention-curve-v3", "version": TOOL_VERSION}

    duration = float(probe_data.get("format", {}).get("duration", 0))
    if duration <= 0:
        return {"error": "Could not determine video duration", "tool": "analyze-retention-curve-v3", "version": TOOL_VERSION}

    if not platform:
        for s in probe_data.get("streams", []):
            if s.get("codec_type") == "video":
                w = int(s.get("width", 0))
                h = int(s.get("height", 0))
                platform = "shorts" if (h > w and duration < 62) else "youtube"
                break
        platform = platform or "youtube"

    # v2 signals
    energy_per_second = measure_audio_energy_per_second(video_path, duration)
    scene_changes = detect_scene_changes_timed(video_path)
    silence_gaps = detect_silence_gaps(video_path)
    rehook_events = detect_rehook_events(energy_per_second, scene_changes, duration)
    spike_seconds = compute_audio_spikes(energy_per_second)
    rhythm_cv = compute_edit_rhythm_cv(scene_changes, duration)

    # v3 new signals
    per_segment_visual = analyze_per_segment_visual(video_path, duration)
    cuts_per_min = compute_per_segment_cuts(scene_changes, duration)
    novelty_events = compute_spectral_novelty_events(video_path, duration)

    curve, initial_retention = predict_retention_curve_v3(
        duration, energy_per_second, scene_changes, silence_gaps,
        rehook_events, spike_seconds, per_segment_visual, cuts_per_min,
        novelty_events, platform,
    )

    dropoff_points = find_dropoff_points(curve)
    retention_score = score_retention_v3(
        curve, dropoff_points, duration, platform,
        rehook_events, rhythm_cv, per_segment_visual, novelty_events,
    )

    if len(curve) > 30:
        step = max(1, len(curve) // 20)
        sampled_curve = curve[::step]
        if curve[-1] not in sampled_curve:
            sampled_curve.append(curve[-1])
    else:
        sampled_curve = curve

    result = {
        "tool": "analyze-retention-curve-v3",
        "version": TOOL_VERSION,
        "video_path": video_path,
        "platform": platform,
        "duration_s": round(duration, 1),
        "initial_retention_pct": round(initial_retention, 1),
        "scores": {
            "retention_curve": retention_score,
        },
        "overall_score": retention_score["score"],
        "predicted_curve": sampled_curve,
        "silence_gaps": silence_gaps[:10],
        "rehook_events": rehook_events,
        "edit_rhythm_cv": round(rhythm_cv, 3) if rhythm_cv is not None else None,
        "audio_spikes_count": len(spike_seconds),
        "per_segment_visual": per_segment_visual,
        "spectral_novelty_events": [e for e in novelty_events if e.get("is_novelty_event")],
        "warnings": [],
    }

    if len(silence_gaps) > 5:
        result["warnings"].append(f"{len(silence_gaps)} silence gaps detected")
    if not rehook_events:
        result["warnings"].append("No re-hook events at standard windows (25-35%, 60-75%)")

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-retention-curve-v3.py <video_path> [--platform shorts|youtube|linkedin]")
        sys.exit(1)
    video_path = sys.argv[1]
    platform = None
    if "--platform" in sys.argv:
        idx = sys.argv.index("--platform")
        if idx + 1 < len(sys.argv):
            platform = sys.argv[idx + 1]
    result = analyze(video_path, platform)
    print(json.dumps(result, indent=2))
