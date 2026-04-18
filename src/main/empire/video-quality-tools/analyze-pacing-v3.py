#!/usr/bin/env python3
"""
Audio Pacing Analyzer v3
Multi-scale temporal rhythm analysis with speaking-rate variability,
pause duration entropy, and pause cluster signals.

v3 upgrades over analyze-pacing-v2.py:
  (1) Speaking rate variability (30s windows): speech-to-silence ratio measured
      per 30s window via repeated silencedetect passes. CoV across windows in
      range 0.10-0.35 = natural variation; < 0.05 = robotic uniformity; > 0.60
      = chaotic/inconsistent delivery. Barbosa 2009 found inter-speaker CV of
      speech rate ~0.20 in natural discourse vs ~0.05 in rehearsed speech.
  (2) Micro-pause duration entropy: Shannon entropy of micro-pause duration
      histogram (4 bins, 0.1-0.5s range). H > 1.2 = varied natural breathing
      rhythm; H < 0.5 = metronomic delivery -- every breath the same duration.
      Extends inter-pause CV from v2 (interval timing) to also capture pause
      *duration* variety as an independent naturalness signal.
  (3) Pause cluster analysis: consecutive pauses where gap < 3s form a
      "cluster" (typical of list enumeration, thinking patterns, or stuttering).
      Cluster rate 0.5-2.0/min = natural emphasis grouping; > 3.0/min =
      fragmented delivery (Tseng 2004, "Prosody, prosodic units, and
      prosodic structures in Mandarin").

Score architecture (100 pts):
  - Inherited from v2: dead air penalty, micro-pause rhythm, mid-gap usage,
    inter-pause interval CV, front-loaded dead air, RMS burst density
  - v3 additions:
    - Speaking rate variability CoV bonus/penalty (max +8 / -8 pts)
    - Pause duration entropy bonus (max +6 pts)
    - Pause cluster rate (max -6 pts penalty for over-clustering)

Research: Barbosa 2009 (speaking rate CV in natural discourse, INTERSPEECH),
          Tseng 2004 (prosodic pause patterns, J. Pragmatics),
          Barbosa 2007 (speech rhythm CoV), Nielsen 2010 (web attention decay).

Usage:
    python analyze-pacing-v3.py <video_path>

Returns JSON with score (0-100) and pacing feedback.
"""

import subprocess
import json
import sys
import os
import re
import math
import statistics

TOOL_VERSION = "3.0.0"


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


def detect_silence_multi(video_path, threshold_db=-35, min_dur=0.1):
    """Detect silence events. Returns list of (start, end, duration) tuples."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", f"silencedetect=noise={threshold_db}dB:d={min_dur}",
        "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        stderr = r.stderr
        events = []
        starts = re.findall(r"silence_start:\s*([\d.]+)", stderr)
        end_pairs = re.findall(r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)", stderr)
        for i, start_s in enumerate(starts):
            start = float(start_s)
            if i < len(end_pairs):
                end = float(end_pairs[i][0])
                dur = float(end_pairs[i][1])
            else:
                end = start + 0.5
                dur = 0.5
            events.append((start, end, dur))
        return events
    except Exception:
        return []


def measure_rms_segments(video_path, window_sec=2):
    """Measure RMS energy per window for burst density analysis."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", (
            f"astats=metadata=1:reset={window_sec},"
            "ametadata=print:key=lavfi.astats.Overall.RMS_level"
        ),
        "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        values = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", r.stderr)
        return [float(v) for v in values if float(v) > -90]
    except Exception:
        return []


def measure_silence_in_segment(video_path, start_sec, dur_sec, threshold_db=-35):
    """
    Run silencedetect on one segment. Returns total silence duration in that segment.
    """
    cmd = [
        "ffmpeg",
        "-ss", str(start_sec), "-i", video_path,
        "-t", str(dur_sec),
        "-af", f"silencedetect=noise={threshold_db}dB:d=0.1",
        "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        dur_vals = re.findall(r"silence_duration:\s*([\d.]+)", r.stderr)
        return sum(float(v) for v in dur_vals)
    except Exception:
        return 0.0


def compute_speech_rate_variability(video_path, total_duration, window_sec=30):
    """
    Compute silence ratio per window_sec chunk. Returns CoV of silence ratios
    across windows, or None if video is too short.
    """
    if total_duration < window_sec * 2:
        return None

    n_windows = int(total_duration / window_sec)
    silence_ratios = []
    for i in range(n_windows):
        start = i * window_sec
        sil = measure_silence_in_segment(video_path, start, window_sec)
        ratio = sil / window_sec
        silence_ratios.append(ratio)

    if len(silence_ratios) < 2:
        return None
    try:
        mean_r = statistics.mean(silence_ratios)
        if mean_r == 0:
            return 0.0
        return statistics.stdev(silence_ratios) / mean_r
    except Exception:
        return None


def compute_pause_duration_entropy(micro_pauses):
    """
    Shannon entropy of micro-pause duration histogram (4 bins, 0.1-0.5s).
    Returns entropy H (0 = uniform single bin, log2(4)=2.0 = maximum spread).
    """
    if len(micro_pauses) < 4:
        return None

    bins = [0.0, 0.0, 0.0, 0.0]
    for _, _, dur in micro_pauses:
        if 0.10 <= dur < 0.20:
            bins[0] += 1
        elif 0.20 <= dur < 0.30:
            bins[1] += 1
        elif 0.30 <= dur < 0.40:
            bins[2] += 1
        elif 0.40 <= dur <= 0.50:
            bins[3] += 1

    total = sum(bins)
    if total == 0:
        return None

    entropy = 0.0
    for count in bins:
        if count > 0:
            p = count / total
            entropy -= p * math.log2(p)
    return entropy


def compute_pause_cluster_rate(silence_events, total_duration, gap_threshold=3.0):
    """
    Group consecutive pauses where inter-pause gap < gap_threshold seconds.
    Returns pause clusters per minute.
    """
    if len(silence_events) < 2:
        return 0.0

    sorted_events = sorted(silence_events, key=lambda e: e[0])
    clusters = 0
    in_cluster = False
    cluster_started = False

    for i in range(len(sorted_events) - 1):
        gap = sorted_events[i + 1][0] - sorted_events[i][1]
        if gap < gap_threshold:
            if not in_cluster:
                clusters += 1
                in_cluster = True
                cluster_started = True
        else:
            in_cluster = False

    duration_min = max(total_duration / 60, 0.1)
    return clusters / duration_min


def classify_pauses(silence_events):
    micro = [e for e in silence_events if 0.10 <= e[2] < 0.50]
    mid   = [e for e in silence_events if 0.50 <= e[2] < 3.00]
    dead  = [e for e in silence_events if e[2] >= 3.00]
    return micro, mid, dead


def inter_pause_cv(silence_events):
    if len(silence_events) < 3:
        return None
    midpoints = [(e[0] + e[1]) / 2 for e in silence_events]
    intervals = [midpoints[i+1] - midpoints[i] for i in range(len(midpoints)-1)]
    if not intervals or statistics.mean(intervals) == 0:
        return None
    try:
        return statistics.stdev(intervals) / statistics.mean(intervals)
    except Exception:
        return None


def segment_dead_air_ratio(dead_pauses, total_duration, n_thirds=3):
    if total_duration <= 0:
        return [0.0, 0.0, 0.0]
    third = total_duration / n_thirds
    ratios = []
    for i in range(n_thirds):
        seg_start = i * third
        seg_end = (i + 1) * third
        seg_dead = sum(
            min(e[1], seg_end) - max(e[0], seg_start)
            for e in dead_pauses
            if e[0] < seg_end and e[1] > seg_start
        )
        ratios.append(seg_dead / third)
    return ratios


def score_pacing_v3(silence_events, rms_segments, total_duration, speech_rate_cov, pause_entropy, cluster_rate):
    if total_duration <= 0:
        return {"score": 50, "feedback": "Could not determine duration", "raw": {}}

    micro, mid, dead = classify_pauses(silence_events)
    total_dead = sum(e[2] for e in dead)
    total_silence = sum(e[2] for e in silence_events)
    dead_ratio = total_dead / total_duration
    silence_ratio = total_silence / total_duration

    score = 100
    notes = []
    raw = {}

    # ---- Signal 1: Dead air penalty (from v2) ----
    if dead_ratio == 0:
        notes.append("No dead air -- tight editing")
    elif dead_ratio < 0.03:
        score -= 5
        notes.append(f"Minimal dead air ({dead_ratio*100:.1f}%)")
    elif dead_ratio < 0.08:
        score -= 15
        notes.append(f"Some dead air ({dead_ratio*100:.1f}%, {len(dead)} gap(s))")
    elif dead_ratio < 0.15:
        score -= 28
        notes.append(f"Significant dead air ({dead_ratio*100:.1f}%) -- tighten edits")
    else:
        score -= 40
        notes.append(f"Excessive dead air ({dead_ratio*100:.1f}%) -- major editing issue")
    raw["dead_air_ratio"] = round(dead_ratio, 4)
    raw["dead_gap_count"] = len(dead)

    # ---- Signal 2: Micro-pause rhythm (from v2) ----
    pauses_per_min = len(micro) / (total_duration / 60) if total_duration > 0 else 0
    if 3.0 <= pauses_per_min <= 10.0:
        notes.append(f"Natural breath rhythm ({pauses_per_min:.1f} micro-pauses/min)")
    elif pauses_per_min > 15:
        score -= 12
        notes.append(f"Choppy delivery ({pauses_per_min:.1f} micro-pauses/min)")
    elif pauses_per_min < 1.5 and total_duration > 30:
        score -= 8
        notes.append(f"Very few micro-pauses ({pauses_per_min:.1f}/min) -- may sound rushed")
    raw["micro_pauses_per_min"] = round(pauses_per_min, 2)

    # ---- Signal 3: Mid-gap (emphasis pause) usage (from v2) ----
    mid_per_min = len(mid) / (total_duration / 60) if total_duration > 0 else 0
    if 1.0 <= mid_per_min <= 4.0:
        notes.append(f"Good emphasis pauses ({mid_per_min:.1f}/min)")
    elif mid_per_min > 6.0:
        score -= 8
        notes.append(f"Too many long pauses ({mid_per_min:.1f}/min)")
    raw["mid_pauses_per_min"] = round(mid_per_min, 2)

    # ---- Signal 4: Inter-pause interval CV (from v2) ----
    cv = inter_pause_cv(silence_events)
    if cv is not None:
        if 0.25 <= cv <= 0.75:
            notes.append(f"Natural pacing rhythm (inter-pause CV={cv:.2f})")
        elif cv < 0.15:
            score -= 8
            notes.append(f"Metronomic delivery (CV={cv:.2f}) -- sounds robotic")
        elif cv > 1.2:
            score -= 10
            notes.append(f"Erratic pacing (CV={cv:.2f})")
        raw["inter_pause_cv"] = round(cv, 3)
    else:
        raw["inter_pause_cv"] = None

    # ---- Signal 5: Front-loaded dead air penalty (from v2) ----
    if dead and total_duration > 30:
        seg_ratios = segment_dead_air_ratio(dead, total_duration)
        if seg_ratios[0] > 0.05:
            extra = min(10, int(seg_ratios[0] * 100))
            score -= extra
            notes.append(f"Dead air front-loaded (first third: {seg_ratios[0]*100:.1f}%)")
        raw["dead_air_by_third"] = [round(r, 4) for r in seg_ratios]

    # ---- Signal 6: RMS burst density (from v2) ----
    if len(rms_segments) >= 5:
        try:
            cv_rms = statistics.stdev(rms_segments) / abs(statistics.mean(rms_segments)) if statistics.mean(rms_segments) != 0 else 0
            if cv_rms < 0.05:
                score -= 5
                notes.append(f"Flat energy profile (RMS CV={cv_rms:.2f}) -- ambient/no-speech audio")
            raw["rms_cv"] = round(cv_rms, 3)
        except Exception:
            pass

    # ---- Signal 7: Early dead air gaps (from v2) ----
    early_dead = [e for e in dead if e[0] < total_duration * 0.30]
    if early_dead:
        score -= min(8, len(early_dead) * 4)
        notes.append(f"{len(early_dead)} dead-air gap(s) in first 30%")
        raw["early_dead_gaps"] = len(early_dead)

    # ---- Signal 8 (v3 NEW): Speaking rate variability (30s window CoV) ----
    if speech_rate_cov is not None:
        raw["speech_rate_cov"] = round(speech_rate_cov, 3)
        if 0.10 <= speech_rate_cov <= 0.40:
            score = min(100, score + 8)
            notes.append(f"Natural speaking rate variation (window CoV={speech_rate_cov:.2f}) -- delivery has good variety")
        elif speech_rate_cov < 0.05:
            score -= 8
            notes.append(f"Uniform speaking rate (window CoV={speech_rate_cov:.2f}) -- delivery sounds robotic")
        elif speech_rate_cov > 0.60:
            score -= 5
            notes.append(f"Highly variable speaking rate (window CoV={speech_rate_cov:.2f}) -- inconsistent pacing")
        else:
            notes.append(f"Speech rate CoV: {speech_rate_cov:.2f}")
    else:
        raw["speech_rate_cov"] = None

    # ---- Signal 9 (v3 NEW): Micro-pause duration entropy ----
    if pause_entropy is not None:
        raw["pause_duration_entropy"] = round(pause_entropy, 3)
        if pause_entropy >= 1.2:
            score = min(100, score + 6)
            notes.append(f"Natural breath variety (pause entropy={pause_entropy:.2f}/2.0) -- diverse pause durations")
        elif pause_entropy < 0.5:
            score -= 4
            notes.append(f"Metronomic breathing (pause entropy={pause_entropy:.2f}/2.0) -- all pauses same duration")
        else:
            notes.append(f"Pause duration entropy: {pause_entropy:.2f}/2.0")
    else:
        raw["pause_duration_entropy"] = None

    # ---- Signal 10 (v3 NEW): Pause cluster rate ----
    if cluster_rate is not None:
        raw["pause_cluster_rate_per_min"] = round(cluster_rate, 2)
        if 0.5 <= cluster_rate <= 2.0:
            notes.append(f"Good pause clustering ({cluster_rate:.1f}/min) -- natural emphasis grouping")
        elif cluster_rate > 3.0:
            score -= 6
            notes.append(f"High pause cluster rate ({cluster_rate:.1f}/min) -- delivery is fragmented")

    raw["total_silence_ratio"] = round(silence_ratio, 4)
    raw["silence_event_count"] = len(silence_events)
    raw["total_duration_s"] = round(total_duration, 1)

    return {
        "score": max(0, min(100, score)),
        "feedback": "; ".join(notes) if notes else "Pacing analysis complete",
        "raw": raw,
    }


def analyze(video_path):
    result = {
        "tool": "analyze-pacing-v3",
        "version": TOOL_VERSION,
        "scores": {},
        "warnings": [],
    }

    if not os.path.exists(video_path):
        result["warnings"].append(f"File not found: {video_path}")
        result["overall_score"] = 0
        return result

    total_duration = get_duration(video_path)
    silence_events = detect_silence_multi(video_path)
    rms_segments = measure_rms_segments(video_path)
    speech_rate_cov = compute_speech_rate_variability(video_path, total_duration)

    micro, _, _ = classify_pauses(silence_events)
    pause_entropy = compute_pause_duration_entropy(micro)
    cluster_rate = compute_pause_cluster_rate(silence_events, total_duration)

    pacing_score = score_pacing_v3(
        silence_events, rms_segments, total_duration,
        speech_rate_cov, pause_entropy, cluster_rate,
    )

    result["scores"]["pacing"] = pacing_score
    result["overall_score"] = pacing_score["score"]
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-pacing-v3.py <video_path>")
        sys.exit(1)
    result = analyze(sys.argv[1])
    print(json.dumps(result, indent=2))
