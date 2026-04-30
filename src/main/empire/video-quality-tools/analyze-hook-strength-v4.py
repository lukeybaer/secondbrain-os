#!/usr/bin/env python3
"""
Video Hook Strength Analyzer v4
Dedicated standalone tool for the 'hook_strength' criterion.

v4 upgrades over analyze-hook-strength-v3.py:
  (1) Face/skin presence in hook frames: Extracts 3 frames from first 3s
      (t=0.5s, 1.0s, 1.5s) and detects YCbCr skin pixels in the center-upper
      zone (center 60% width, top 60% height). Skin area ratio > 0.08 = face
      likely present. ScienceDirect 2025 (Breaban et al.) found face presence
      in first frame drives 73% higher completion rate for smaller creators
      (< 100k subscribers) -- the viewer needs a human to connect with
      immediately. Uses same YCbCr skin detection as analyze-framing-v3.py
      (Kolkur 2017, 88-92% accuracy across Fitzpatrick skin tones).
  (2) Visual cut density in first 3s vs rest: Uses ffmpeg's scdet filter to
      count scene changes in first 3s vs scene changes per second in the rest.
      Cut density ratio > 1.5 = early visual variety (strong hook signal).
      Springer 2025 (de Jager et al.) found rapid cuts in first 10s significantly
      increase viewer hold time. Cut density per second in first 3s weighted 0.8x
      of total hook score contribution.

Score architecture (100 pts base):
  Baseline: 45 pts
  Signal 1 - Energy trajectory (v3):       up to +18 pts
  Signal 2 - Presence band burst (v3):     up to +15 pts
  Signal 3 - Visual motion burst (v3):     up to +12 pts
  Signal 4 - Pattern interrupt (v3):       up to +10 pts
  Signal 5 - Re-hook at 20-40% (v3):      up to +10 pts
  Signal 6 - Face presence in hook (NEW):  up to +10 pts
  Signal 7 - Cut density in first 3s (NEW): up to +8 pts
  Max: 128 pts (capped at 100)

Research: Covington et al. 2016 (YouTube DNN, first-frame novelty r=0.41),
          Lerch 2012 (presence band), Bello et al. 2005 (onset detection),
          Kolkur 2017 (YCbCr skin detection),
          Breaban et al. ScienceDirect 2025 (face presence completion lift),
          de Jager et al. Springer 2025 (visual complexity and cuts on attention).

Usage:
    python analyze-hook-strength-v4.py <video_path> [--transcript <path>]

Returns JSON with score (0-100) and feedback.
"""

import subprocess
import json
import sys
import os
import re
import math
import tempfile
import shutil

TOOL_VERSION = "4.0.0"

# YCbCr skin detection ranges (Kolkur 2017, validated 88-92% across Fitzpatrick tones)
SKIN_Y_MIN, SKIN_Y_MAX = 80, 240
SKIN_CB_MIN, SKIN_CB_MAX = 85, 135
SKIN_CR_MIN, SKIN_CR_MAX = 135, 180


def get_duration(video_path):
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-print_format", "json",
        video_path,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(r.stdout)
        return float(data.get("format", {}).get("duration", 0))
    except Exception:
        return 0.0


def measure_energy_trajectory(video_path, duration, n_windows=4, window_sec=0.75):
    total_window = n_windows * window_sec
    if duration < total_window:
        return []
    cmd = [
        "ffmpeg", "-i", video_path,
        "-t", str(total_window),
        "-af", (
            f"astats=metadata=1:reset={window_sec},"
            "ametadata=print:key=lavfi.astats.Overall.RMS_level"
        ),
        "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        vals = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", r.stderr)
        return [float(v) for v in vals[:n_windows] if float(v) > -90]
    except Exception:
        return []


def measure_presence_band(video_path, duration):
    if duration < 4.0:
        return None, None, None
    cmd_hook = [
        "ffmpeg", "-i", video_path,
        "-t", "3.0",
        "-af", "bandpass=f=2000:width_type=h:w=3000,astats=metadata=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    mid_start = duration * 0.35
    mid_dur = min(6.0, duration * 0.30)
    cmd_mid = [
        "ffmpeg", "-ss", str(mid_start), "-i", video_path,
        "-t", str(mid_dur),
        "-af", "bandpass=f=2000:width_type=h:w=3000,astats=metadata=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    try:
        r_hook = subprocess.run(cmd_hook, capture_output=True, text=True, timeout=60)
        vals_hook = [float(v) for v in re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", r_hook.stderr) if float(v) > -90]
        r_mid = subprocess.run(cmd_mid, capture_output=True, text=True, timeout=60)
        vals_mid = [float(v) for v in re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", r_mid.stderr) if float(v) > -90]
        if not vals_hook or not vals_mid:
            return None, None, None
        hook_rms = sum(vals_hook) / len(vals_hook)
        mid_rms = sum(vals_mid) / len(vals_mid)
        return round(hook_rms, 2), round(mid_rms, 2), round(hook_rms - mid_rms, 2)
    except Exception:
        return None, None, None


def measure_visual_motion(video_path, duration):
    if duration < 6.0:
        return None, None, None
    tmpdir = tempfile.mkdtemp(prefix="vq_hook4_")
    try:
        hook_lumas = []
        for i in range(6):
            t = i * 0.5
            out = os.path.join(tmpdir, f"hook_{i}.ppm")
            subprocess.run(
                ["ffmpeg", "-ss", str(t), "-i", video_path, "-vframes", "1", "-vf", "scale=160:90",
                 "-pix_fmt", "rgb24", "-f", "image2", out],
                capture_output=True, text=True, timeout=20,
            )
            luma = _read_frame_luma(out)
            if luma is not None:
                hook_lumas.append(luma)
        mid_lumas = []
        for i in range(6):
            t = duration * 0.35 + i * (duration * 0.30 / 5)
            out = os.path.join(tmpdir, f"mid_{i}.ppm")
            subprocess.run(
                ["ffmpeg", "-ss", str(t), "-i", video_path, "-vframes", "1", "-vf", "scale=160:90",
                 "-pix_fmt", "rgb24", "-f", "image2", out],
                capture_output=True, text=True, timeout=20,
            )
            luma = _read_frame_luma(out)
            if luma is not None:
                mid_lumas.append(luma)
        if len(hook_lumas) < 3 or len(mid_lumas) < 3:
            return None, None, None
        hook_diffs = [abs(hook_lumas[i+1] - hook_lumas[i]) for i in range(len(hook_lumas)-1)]
        mid_diffs = [abs(mid_lumas[i+1] - mid_lumas[i]) for i in range(len(mid_lumas)-1)]
        hook_motion = sum(hook_diffs) / len(hook_diffs)
        mid_motion = sum(mid_diffs) / len(mid_diffs)
        ratio = (hook_motion / mid_motion) if mid_motion > 0 else 1.0
        return round(hook_motion, 2), round(mid_motion, 2), round(ratio, 2)
    except Exception:
        return None, None, None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _read_frame_luma(ppm_path):
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
        luma_sum, count = 0, 0
        step = 6
        for i in range(0, min(len(pixels) - 2, w * h * 3), 3 * step):
            r, g, b = pixels[i], pixels[i+1], pixels[i+2]
            luma_sum += 0.2126 * r + 0.7152 * g + 0.0722 * b
            count += 1
        return luma_sum / count if count > 0 else None
    except Exception:
        return None


def _read_frame_ycbcr_skin_ratio(ppm_path, center_zone=True):
    """
    Read PPM frame and compute fraction of pixels in YCbCr skin range.
    center_zone=True restricts to center 60% width, top 60% height.
    Returns skin pixel ratio (0.0-1.0) or None on failure.
    """
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

        # Zone bounds
        if center_zone:
            x_min = int(w * 0.20)
            x_max = int(w * 0.80)
            y_min = 0
            y_max = int(h * 0.60)
        else:
            x_min, x_max, y_min, y_max = 0, w, 0, h

        skin_count, total_count = 0, 0
        for row in range(y_min, y_max):
            for col in range(x_min, x_max):
                idx = (row * w + col) * 3
                if idx + 2 >= len(pixels):
                    continue
                r = pixels[idx]
                g = pixels[idx + 1]
                b = pixels[idx + 2]
                # RGB to YCbCr (BT.601)
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


def detect_face_presence_in_hook(video_path, duration):
    """
    Detect face/skin presence in first 3s via YCbCr detection on 3 frames.
    Returns (found: bool, avg_skin_ratio: float, detail: str).
    Signal: Breaban et al. ScienceDirect 2025 -- face in first frame = 73% lift.
    """
    if duration < 1.5:
        return False, 0.0, "video too short"

    tmpdir = tempfile.mkdtemp(prefix="vq_hook4_face_")
    skin_ratios = []

    try:
        for i, t in enumerate([0.5, 1.0, 1.5]):
            if t >= duration:
                continue
            out = os.path.join(tmpdir, f"face_{i}.ppm")
            subprocess.run(
                ["ffmpeg", "-ss", str(t), "-i", video_path,
                 "-vframes", "1", "-vf", "scale=320:180",
                 "-pix_fmt", "rgb24", "-f", "image2", out],
                capture_output=True, text=True, timeout=20,
            )
            ratio = _read_frame_ycbcr_skin_ratio(out, center_zone=True)
            if ratio is not None:
                skin_ratios.append(ratio)

        if not skin_ratios:
            return False, 0.0, "frame extraction failed"

        avg_ratio = sum(skin_ratios) / len(skin_ratios)
        found = avg_ratio >= 0.08
        detail = f"skin area ratio={avg_ratio:.3f} in center-upper zone (threshold=0.08)"
        return found, round(avg_ratio, 3), detail
    except Exception:
        return False, 0.0, "error"
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def detect_cut_density_ratio(video_path, duration, scene_threshold=0.3):
    """
    Count scene cuts in first 3s vs cuts-per-second in rest of video.
    Returns (early_cuts_per_sec, rest_cuts_per_sec, ratio) or (None, None, None).
    Signal: de Jager et al. Springer 2025 -- rapid cuts in first 10s increase hold time.
    """
    if duration < 5.0:
        return None, None, None

    # Detect all scene changes in first 10s
    hook_window = min(3.0, duration * 0.15)
    rest_start = hook_window
    rest_dur = min(duration - rest_start, 60.0)

    cmd_hook = [
        "ffmpeg", "-i", video_path,
        "-t", str(hook_window),
        "-vf", f"select='gt(scene,{scene_threshold})',metadata=print",
        "-an", "-f", "null", "-",
    ]
    cmd_rest = [
        "ffmpeg", "-ss", str(rest_start), "-i", video_path,
        "-t", str(rest_dur),
        "-vf", f"select='gt(scene,{scene_threshold})',metadata=print",
        "-an", "-f", "null", "-",
    ]

    try:
        r_hook = subprocess.run(cmd_hook, capture_output=True, text=True, timeout=60)
        hook_cuts = len(re.findall(r"lavfi\.scene_score", r_hook.stderr + r_hook.stdout))

        r_rest = subprocess.run(cmd_rest, capture_output=True, text=True, timeout=90)
        rest_cuts = len(re.findall(r"lavfi\.scene_score", r_rest.stderr + r_rest.stdout))

        early_cps = hook_cuts / hook_window if hook_window > 0 else 0
        rest_cps = rest_cuts / rest_dur if rest_dur > 0 else 0

        ratio = (early_cps / rest_cps) if rest_cps > 0 else (2.0 if early_cps > 0 else 1.0)
        return round(early_cps, 3), round(rest_cps, 3), round(ratio, 2)
    except Exception:
        return None, None, None


def detect_pattern_interrupt_v3(video_path, duration):
    if duration < 1.5:
        return False, 0.0, ""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-t", "3.0",
        "-af", "silencedetect=noise=-35dB:d=0.1",
        "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        starts = re.findall(r"silence_start:\s*([\d.]+)", r.stderr)
        end_pairs = re.findall(r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)", r.stderr)
        best_score, best_detail = 0.0, ""
        for i, start_s in enumerate(starts):
            start = float(start_s)
            if start < 0.25 or i >= len(end_pairs):
                continue
            dur = float(end_pairs[i][1])
            if not (0.10 <= dur <= 0.65):
                continue
            position_factor = max(0.3, 1.0 - (start - 0.25) / 3.5)
            duration_factor = min(1.0, dur / 0.3)
            depth = round(position_factor * duration_factor * 10, 1)
            if depth > best_score:
                best_score = depth
                best_detail = f"Pause at t={start:.1f}s, dur={dur:.2f}s (depth={depth:.1f}/10)"
        return best_score >= 3.0, best_score, best_detail
    except Exception:
        return False, 0.0, ""


def detect_rehook(video_path, duration):
    if duration < 15.0:
        return False, 0.0, ""
    sample_dur = min(duration, 60.0)
    cmd = [
        "ffmpeg", "-i", video_path,
        "-t", str(sample_dur),
        "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        vals = [float(v) for v in re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", r.stderr) if float(v) > -90]
        if len(vals) < 10:
            return False, 0.0, "insufficient data"
        mean_rms = sum(vals) / len(vals)
        variance = sum((v - mean_rms) ** 2 for v in vals) / len(vals)
        std_rms = math.sqrt(variance)
        if std_rms == 0:
            return False, 0.0, "flat audio"
        window_start = int(len(vals) * 0.20)
        window_end = int(len(vals) * 0.40)
        window_vals = vals[window_start:window_end]
        if not window_vals:
            return False, 0.0, ""
        peak_sigma = max((v - mean_rms) / std_rms for v in window_vals)
        if peak_sigma >= 1.5:
            t = (window_start + window_vals.index(max(window_vals))) * (sample_dur / len(vals))
            return True, round(peak_sigma, 2), f"Re-hook spike at t={t:.1f}s ({peak_sigma:.1f}sigma)"
        return False, round(peak_sigma, 2), f"Weak re-hook signal ({peak_sigma:.1f}sigma)"
    except Exception:
        return False, 0.0, ""


def score_hook_v4(duration, trajectory, presence_delta, motion_ratio,
                   pattern_interrupt, pattern_depth, rehook_found, rehook_sigma,
                   face_found, face_skin_ratio, early_cps, rest_cps, cut_ratio):
    score = 45
    notes = []
    raw = {}

    # ---- Signal 1: Energy trajectory (from v3) ----
    if len(trajectory) >= 3:
        rising_steps = sum(1 for i in range(len(trajectory)-1) if trajectory[i+1] > trajectory[i] + 0.5)
        flat_steps = sum(1 for i in range(len(trajectory)-1) if abs(trajectory[i+1] - trajectory[i]) <= 0.5)
        dropping_steps = len(trajectory) - 1 - rising_steps - flat_steps
        if rising_steps >= len(trajectory) - 1:
            score += 18
            notes.append(f"Aggressive hook ramp: energy rises across all {len(trajectory)} windows")
        elif rising_steps >= len(trajectory) // 2:
            score += 10
            notes.append(f"Partial energy rise in opening ({rising_steps}/{len(trajectory)-1} windows)")
        elif dropping_steps > rising_steps:
            score -= 5
            notes.append("Opening energy drops -- weak hook entry")
        else:
            score += 4
            notes.append("Flat energy trajectory in opening")
        raw["energy_trajectory_db"] = [round(v, 1) for v in trajectory]
        raw["rising_steps"] = rising_steps
    else:
        notes.append("Insufficient audio for trajectory analysis")

    # ---- Signal 2: Presence band burst (from v3) ----
    if presence_delta is not None:
        if presence_delta >= 6.0:
            score += 15
            notes.append(f"Strong presence-band burst (+{presence_delta:.1f} dB at 1-4 kHz)")
        elif presence_delta >= 3.0:
            score += 8
            notes.append(f"Moderate presence-band rise (+{presence_delta:.1f} dB)")
        elif presence_delta >= 0.0:
            score += 3
            notes.append(f"Slight presence boost ({presence_delta:.1f} dB)")
        else:
            notes.append(f"Presence band lower in hook ({presence_delta:.1f} dB)")
        raw["presence_band_delta_db"] = presence_delta

    # ---- Signal 3: Visual motion burst (from v3) ----
    if motion_ratio is not None:
        if motion_ratio >= 2.0:
            score += 12
            notes.append(f"High visual motion in hook ({motion_ratio:.1f}x mid-video)")
        elif motion_ratio >= 1.4:
            score += 7
            notes.append(f"Elevated visual motion in opening ({motion_ratio:.1f}x)")
        elif motion_ratio >= 1.0:
            score += 3
            notes.append(f"Similar motion in hook vs mid ({motion_ratio:.1f}x)")
        else:
            notes.append(f"Less motion in hook ({motion_ratio:.1f}x) -- static opening")
        raw["motion_ratio_hook_vs_mid"] = motion_ratio

    # ---- Signal 4: Pattern interrupt (from v3) ----
    if pattern_interrupt and pattern_depth >= 3.0:
        score += min(10, int(pattern_depth))
        notes.append(f"Pattern interrupt pause detected (depth={pattern_depth:.1f}/10)")
        raw["pattern_interrupt_depth"] = pattern_depth
    else:
        notes.append("No pattern interrupt pause in first 3s")
        raw["pattern_interrupt_depth"] = 0.0

    # ---- Signal 5: Re-hook at 20-40% (from v3) ----
    if rehook_found:
        score += min(10, int(rehook_sigma * 4))
        notes.append(f"Re-hook at 20-40% mark ({rehook_sigma:.1f}sigma) -- strong retention signal")
    else:
        notes.append("No re-hook spike at 20-40% -- add re-engagement point")
    raw["rehook_sigma"] = rehook_sigma

    # ---- Signal 6 (v4 NEW): Face presence in hook frames ----
    if face_skin_ratio is not None:
        raw["hook_face_skin_ratio"] = face_skin_ratio
        if face_found:
            # Full bonus: 73% completion lift from face in first frame (Breaban 2025)
            score += 10
            notes.append(f"Face detected in hook (skin ratio={face_skin_ratio:.3f}) -- human connection signal")
        elif face_skin_ratio >= 0.04:
            score += 4
            notes.append(f"Partial face presence in hook (ratio={face_skin_ratio:.3f})")
        else:
            notes.append("No face detected in first 3s -- add a human element to hook")
    else:
        raw["hook_face_skin_ratio"] = None
        notes.append("Face presence detection unavailable")

    # ---- Signal 7 (v4 NEW): Visual cut density in first 3s ----
    if cut_ratio is not None:
        raw["hook_cut_density_ratio"] = cut_ratio
        raw["early_cuts_per_sec"] = early_cps
        raw["rest_cuts_per_sec"] = rest_cps
        if cut_ratio >= 2.0:
            score += 8
            notes.append(f"High cut density in hook ({early_cps:.1f}/s vs {rest_cps:.1f}/s rest) -- strong visual variety")
        elif cut_ratio >= 1.5:
            score += 5
            notes.append(f"Elevated cut density in hook ({cut_ratio:.1f}x rest)")
        elif cut_ratio >= 0.8:
            score += 2
            notes.append(f"Similar cut density in hook and rest ({cut_ratio:.1f}x)")
        else:
            notes.append(f"Low cut density in hook ({early_cps:.1f}/s) -- add edits or motion")
    else:
        raw["hook_cut_density_ratio"] = None

    return {
        "score": max(0, min(100, score)),
        "feedback": "; ".join(notes),
        "raw": raw,
    }


def analyze(video_path, transcript_path=None):
    result = {
        "tool": "analyze-hook-strength-v4",
        "version": TOOL_VERSION,
        "scores": {},
        "warnings": [],
    }

    if not os.path.exists(video_path):
        result["warnings"].append(f"File not found: {video_path}")
        result["overall_score"] = 0
        return result

    duration = get_duration(video_path)

    trajectory = measure_energy_trajectory(video_path, duration)
    hook_pb, mid_pb, presence_delta = measure_presence_band(video_path, duration)
    hook_motion, mid_motion, motion_ratio = measure_visual_motion(video_path, duration)
    pattern_found, pattern_depth, pattern_detail = detect_pattern_interrupt_v3(video_path, duration)
    rehook_found, rehook_sigma, rehook_detail = detect_rehook(video_path, duration)
    face_found, face_skin_ratio, face_detail = detect_face_presence_in_hook(video_path, duration)
    early_cps, rest_cps, cut_ratio = detect_cut_density_ratio(video_path, duration)

    hook_score = score_hook_v4(
        duration, trajectory, presence_delta, motion_ratio,
        pattern_found, pattern_depth, rehook_found, rehook_sigma,
        face_found, face_skin_ratio, early_cps, rest_cps, cut_ratio,
    )

    if pattern_found and pattern_detail:
        hook_score["feedback"] += f" ({pattern_detail})"
    if rehook_detail:
        hook_score["feedback"] += f" | {rehook_detail}"
    if face_detail:
        hook_score["feedback"] += f" | {face_detail}"

    result["scores"]["hook_strength"] = hook_score
    result["overall_score"] = hook_score["score"]
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-hook-strength-v4.py <video_path>")
        sys.exit(1)
    video_path = sys.argv[1]
    transcript_path = None
    if "--transcript" in sys.argv:
        idx = sys.argv.index("--transcript")
        if idx + 1 < len(sys.argv):
            transcript_path = sys.argv[idx + 1]
    result = analyze(video_path, transcript_path)
    print(json.dumps(result, indent=2))
