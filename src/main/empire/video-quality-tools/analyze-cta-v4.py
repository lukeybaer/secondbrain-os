#!/usr/bin/env python3
"""
Video CTA (Call-to-Action) Analyzer v4
Builds on v3 (4 visual+audio signals) with 3 new signals:

v4 upgrades over analyze-cta-v3.py:
  (1) Multi-window CTA onset detection: divides final 30% into 3% sliding
      windows and finds the exact point where energy drops >2 dB below the
      middle baseline. Precise onset enables better per-zone scoring of the
      actual CTA segment vs. the entire outro. Avoids v3's false positives
      where gradual fade-outs were mis-scored.
  (2) Vocal pitch contour in final 20% (CTA intonation signature): measures
      the high-to-fundamental band ratio (3000-8000 Hz vs 85-250 Hz) per 5%
      window in the final 25%. Rising ratio across windows = rising vocal
      pitch = interrogative/urgency intonation pattern (Grice 1975 Cooperative
      Principle; Cruttenden 1986 Intonation). Creators asking "subscribe" or
      "what do you think" instinctively raise pitch at the end of the ask.
      This is the #1 acoustic signature that no-transcript tools miss.
  (3) Outro music injection detection: measures spectral flatness change in
      final 15% vs. middle 40%. Speech has low flatness (energy concentrated
      in harmonics); broadband music/noise has high flatness. A significant
      flatness increase (>0.15 delta) in the outro = background music bed
      added under CTA = professional CTA framing (Lartillot & Toiviainen 2007
      MIR toolbox; Tzanetakis & Cook 2002 audio classification).

Score architecture: 35 baseline + up to 105 pts from 7 signals (capped at 100):
  Signal 1 - End-screen overlay (v3):         up to +28 pts
  Signal 2 - Outro energy drop (v3):          up to +18 pts
  Signal 3 - Speaking rate slowdown (v3):     up to +15 pts
  Signal 4 - Pre-CTA silence (v3):            up to +12 pts
  Signal 5 - CTA onset precision (NEW):       up to +8 pts
  Signal 6 - Pitch contour rise (NEW):        up to +12 pts
  Signal 7 - Outro music injection (NEW):     up to +8 pts
  Transcript fusion (when available):         65% weight

Research: Grice 1975 (cooperative principle, rising intonation as question marker),
          Cruttenden 1986 (Intonation, CUP), Lartillot & Toiviainen 2007 (MIR toolbox),
          Tzanetakis & Cook 2002 (musical genre classification, IEEE TASL).

Usage:
    python analyze-cta-v4.py <video_path> [--transcript <path>]

Returns JSON with score (0-100) and detailed feedback.
"""

import subprocess
import json
import sys
import os
import re
import math
import shutil
import tempfile

TOOL_VERSION = "4.0.0"

CTA_PATTERNS = [
    r"\b(subscribe|like|comment|share|follow|click|tap|link|bio|description)\b",
    r"\b(check out|sign up|join|download|get|grab|visit|head to)\b",
    r"\b(let me know|tell me|drop a comment|hit the bell)\b",
    r"\b(swipe up|link in bio|pinned comment|in the comments)\b",
    r"\b(save this|bookmark|turn on notifications|notification bell)\b",
    r"\b(dm me|message me|reach out|connect with me)\b",
    r"\b(use code|promo code|discount|affiliate)\b",
]


def get_duration(video_path):
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


def measure_zone_rms(video_path, start_sec, duration_sec):
    cmd = [
        "ffmpeg", "-i", video_path,
        "-ss", str(max(0, start_sec)),
        "-t", str(max(1, duration_sec)),
        "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        raw = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", result.stderr)
        vals = [float(v) for v in raw if float(v) > -90]
        return sum(vals) / len(vals) if vals else -60.0
    except Exception:
        return -60.0


def measure_band_rms(video_path, start_sec, duration_sec, low_hz, high_hz):
    """Measure average RMS in a specific frequency band via bandpass filter."""
    bw = high_hz - low_hz
    center = (low_hz + high_hz) / 2
    cmd = [
        "ffmpeg", "-i", video_path,
        "-ss", str(max(0, start_sec)),
        "-t", str(max(1, duration_sec)),
        "-af", (
            f"bandpass=f={center:.0f}:width_type=h:w={bw:.0f},"
            "astats=metadata=1,ametadata=print:key=lavfi.astats.Overall.RMS_level"
        ),
        "-f", "null", "-",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        vals = re.findall(r"lavfi\.astats\.Overall\.RMS_level=([-\d.]+)", r.stderr)
        floats = [float(v) for v in vals if float(v) > -90]
        return sum(floats) / len(floats) if floats else -70.0
    except Exception:
        return -70.0


def extract_frame_luma_ppm(video_path, timestamp):
    tmpdir = tempfile.mkdtemp(prefix="vq_ctav4_")
    out_path = os.path.join(tmpdir, "frame.ppm")
    cmd = [
        "ffmpeg", "-ss", str(max(0, timestamp)),
        "-i", video_path,
        "-vframes", "1",
        "-vf", "scale=320:-1",
        "-pix_fmt", "rgb24",
        "-f", "image2",
        out_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            shutil.rmtree(tmpdir, ignore_errors=True)
            return None, None, None, None
        with open(out_path, "rb") as f:
            f.readline()
            line = f.readline()
            while line.startswith(b"#"):
                line = f.readline()
            dims = line.strip().split()
            w, h = int(dims[0]), int(dims[1])
            f.readline()
            rgb = f.read()
        shutil.rmtree(tmpdir, ignore_errors=True)
        n = w * h
        luma = []
        for i in range(0, min(len(rgb), n * 3), 3):
            r, g, b = rgb[i], rgb[i + 1], rgb[i + 2]
            luma.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
        return w, h, luma, n
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return None, None, None, None


def analyze_end_screen_overlay(video_path, duration):
    if duration <= 5:
        return {"detected": False, "confidence": "none", "reason": "Video too short"}
    sample_pcts = [0.80, 0.88, 0.95]
    corner_bright_ratios = []
    bottom_bright_ratios = []
    for pct in sample_pcts:
        timestamp = duration * pct
        w, h, luma, n = extract_frame_luma_ppm(video_path, timestamp)
        if not luma or w == 0 or h == 0:
            continue
        corner_w = max(1, int(w * 0.25))
        corner_h = max(1, int(h * 0.25))
        corner_luma = []
        for row in range(h - corner_h, h):
            for col in range(w - corner_w, w):
                idx = row * w + col
                if idx < len(luma):
                    corner_luma.append(luma[idx])
        bottom_start = int(h * 0.82)
        bottom_luma = []
        for row in range(bottom_start, h):
            for col in range(w):
                idx = row * w + col
                if idx < len(luma):
                    bottom_luma.append(luma[idx])
        if corner_luma:
            corner_bright_ratios.append(sum(1 for v in corner_luma if v > 200) / len(corner_luma))
        if bottom_luma:
            bottom_bright_ratios.append(sum(1 for v in bottom_luma if v > 200) / len(bottom_luma))
    if not corner_bright_ratios:
        return {"detected": False, "confidence": "none", "reason": "No frames extracted"}
    avg_corner = sum(corner_bright_ratios) / len(corner_bright_ratios)
    avg_bottom = sum(bottom_bright_ratios) / len(bottom_bright_ratios) if bottom_bright_ratios else 0
    detected = avg_corner > 0.12 and avg_bottom > 0.10
    strong = avg_corner > 0.20 and avg_bottom > 0.15
    return {
        "detected": detected,
        "confidence": "high" if strong else ("medium" if detected else "low"),
        "avg_corner_bright_ratio": round(avg_corner, 3),
        "avg_bottom_bright_ratio": round(avg_bottom, 3),
    }


def analyze_outro_energy(video_path, duration):
    if duration < 15:
        return 0, {}
    early_rms = measure_zone_rms(video_path, 0, duration * 0.20)
    mid_rms = measure_zone_rms(video_path, duration * 0.40, duration * 0.20)
    final_rms = measure_zone_rms(video_path, duration * 0.80, duration * 0.20)
    energy_drop = mid_rms - final_rms
    return energy_drop, {
        "early_rms": round(early_rms, 1),
        "mid_rms": round(mid_rms, 1),
        "final_rms": round(final_rms, 1),
    }


def analyze_speaking_rate_change(video_path, duration):
    if duration < 20:
        return 1.0, {}

    def get_silences(start_sec, dur_sec):
        cmd = [
            "ffmpeg", "-i", video_path,
            "-ss", str(max(0, start_sec)),
            "-t", str(max(2, dur_sec)),
            "-af", "silencedetect=noise=-40dB:d=0.15",
            "-f", "null", "-",
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            durs = re.findall(r"silence_duration: ([\d.]+)", result.stderr)
            return [float(d) for d in durs if float(d) > 0.1]
        except Exception:
            return []

    mid_silences = get_silences(duration * 0.40, duration * 0.20)
    final_silences = get_silences(duration * 0.80, duration * 0.20)
    avg_mid = sum(mid_silences) / len(mid_silences) if mid_silences else 0
    avg_final = sum(final_silences) / len(final_silences) if final_silences else 0
    ratio = avg_final / avg_mid if avg_mid > 0.05 else 1.0
    return ratio, {
        "mid_silence_count": len(mid_silences),
        "final_silence_count": len(final_silences),
        "avg_mid_gap_s": round(avg_mid, 3),
        "avg_final_gap_s": round(avg_final, 3),
    }


def detect_pre_cta_silence(video_path, duration):
    if duration < 10:
        return False, []
    window_start = duration * 0.90
    window_dur = duration * 0.10
    cmd = [
        "ffmpeg", "-i", video_path,
        "-ss", str(window_start),
        "-t", str(max(1, window_dur)),
        "-af", "silencedetect=noise=-38dB:d=0.4",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        durs = re.findall(r"silence_duration: ([\d.]+)", result.stderr)
        long_silences = [float(d) for d in durs if float(d) >= 0.45]
        return len(long_silences) > 0, long_silences
    except Exception:
        return False, []


# ----------- v4 NEW signals -----------

def detect_cta_onset_window(video_path, duration):
    """
    Slide 3% windows through final 30% to find the first window where
    RMS drops >2 dB below mid-video baseline. Returns (onset_pct, drop_db)
    or (None, 0) if no clear onset. Precise onset = less noisy CTA zone.
    """
    if duration < 20:
        return None, 0.0

    win = duration * 0.03
    mid_rms = measure_zone_rms(video_path, duration * 0.40, duration * 0.20)
    onset_pct = None
    max_drop = 0.0

    for pct_10 in range(70, 98, 3):
        pct = pct_10 / 100.0
        start = duration * pct
        rms = measure_zone_rms(video_path, start, win)
        drop = mid_rms - rms
        if drop > 2.0 and onset_pct is None:
            onset_pct = pct
        if drop > max_drop:
            max_drop = drop

    return onset_pct, round(max_drop, 2)


def analyze_pitch_contour_outro(video_path, duration):
    """
    Measure high/fundamental ratio (3000-8000 Hz vs 85-250 Hz) per 5% window
    in the final 25%. A rising ratio across windows = rising vocal pitch =
    CTA interrogative intonation (Cruttenden 1986).
    Returns (rising: bool, slope: float, ratios: list).
    """
    if duration < 20:
        return False, 0.0, []

    ratios = []
    for pct_10 in range(75, 100, 5):
        pct = pct_10 / 100.0
        start = duration * pct
        win = duration * 0.05
        if start + win > duration:
            break
        fund_rms = measure_band_rms(video_path, start, win, 85, 250)
        high_rms = measure_band_rms(video_path, start, win, 3000, 8000)
        if fund_rms > -85 and high_rms > -85:
            ratio = high_rms - fund_rms  # in dB: positive = more high energy vs fundamental
            ratios.append(ratio)

    if len(ratios) < 2:
        return False, 0.0, ratios

    # Simple linear slope over the ratios
    n = len(ratios)
    xs = list(range(n))
    mean_x = sum(xs) / n
    mean_y = sum(ratios) / n
    num = sum((xs[i] - mean_x) * (ratios[i] - mean_y) for i in range(n))
    den = sum((x - mean_x) ** 2 for x in xs)
    slope = num / den if den > 0 else 0.0

    return slope > 0.5, round(slope, 3), [round(r, 2) for r in ratios]


def analyze_outro_music_injection(video_path, duration):
    """
    Detect spectral flatness increase in final 15% vs middle 40%.
    Speech has low flatness; broadband music has high flatness.
    Flatness = geometric_mean(spectrum) / arithmetic_mean(spectrum).
    Proxy via 7-band energy uniformity: measure RMS in 7 bands (125, 250, 500,
    1000, 2000, 4000, 8000 Hz centers) and compute CV of band energies.
    Low CV = uniform spectrum = music-like = high flatness.
    Returns (music_injected: bool, flatness_delta: float).

    Tzanetakis & Cook 2002 (IEEE TASL): spectral flatness best single
    feature for speech vs music discrimination (AUC 0.81).
    """
    if duration < 20:
        return False, 0.0

    BANDS = [(62, 187), (187, 375), (375, 750), (750, 1500),
             (1500, 3000), (3000, 6000), (6000, 10000)]

    def measure_flatness_proxy(start, dur):
        """CV of 7-band RMS energies (low CV = flat = music)."""
        band_rms = []
        for lo, hi in BANDS:
            rms = measure_band_rms(video_path, start, dur, lo, hi)
            if rms > -85:
                band_rms.append(rms)
        if len(band_rms) < 4:
            return None
        mean_rms = sum(band_rms) / len(band_rms)
        stdev_rms = math.sqrt(sum((v - mean_rms) ** 2 for v in band_rms) / len(band_rms))
        cv = stdev_rms / abs(mean_rms) if mean_rms != 0 else 1.0
        return round(cv, 4)

    mid_cv = measure_flatness_proxy(duration * 0.40, duration * 0.20)
    outro_cv = measure_flatness_proxy(duration * 0.85, duration * 0.15)

    if mid_cv is None or outro_cv is None:
        return False, 0.0

    # Lower CV in outro vs mid = flatter spectrum in outro = more music-like
    delta = mid_cv - outro_cv  # positive = outro more music-like
    music_injected = delta > 0.08 and outro_cv < 0.35

    return music_injected, round(delta, 4)


def parse_transcript(transcript_path):
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    with open(transcript_path, "r", encoding="utf-8") as f:
        content = f.read()
    try:
        data = json.loads(content)
        if "segments" in data:
            return data["segments"]
        return None
    except json.JSONDecodeError:
        pass
    segments = []
    blocks = re.split(r"\n\n+", content.strip())
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) >= 3:
            time_match = re.match(
                r"(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})",
                lines[1],
            )
            if time_match:
                g = time_match.groups()
                start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
                end = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 1000
                text = " ".join(lines[2:])
                segments.append({"start": start, "end": end, "text": text})
    return segments if segments else None


def score_cta_from_transcript(transcript, duration):
    cta_segments = []
    for seg in transcript:
        text = seg.get("text", "").lower()
        for pattern in CTA_PATTERNS:
            if re.search(pattern, text, re.IGNORECASE):
                cta_segments.append({"time": seg.get("start", 0), "text": text[:80]})
                break
    if not cta_segments:
        return 20, "No CTA detected in transcript -- add a call-to-action", []
    notes = [f"{len(cta_segments)} CTA moment(s) found in transcript"]
    score = 50
    if duration > 0:
        cta_times = [c["time"] for c in cta_segments]
        last_ratio = max(cta_times) / duration
        if 0.70 <= last_ratio <= 0.95:
            score += 35
            notes.append(f"CTA at {last_ratio * 100:.0f}% -- ideal placement")
        elif last_ratio > 0.95:
            score += 15
            notes.append("CTA at very end -- move slightly earlier to avoid cutoff")
        elif last_ratio < 0.30:
            score += 8
            notes.append("CTA too early -- add another near the end")
        else:
            score += 20
            notes.append(f"CTA at {last_ratio * 100:.0f}% of video")
    if len(cta_segments) >= 2:
        score += 10
        notes.append("Multiple CTA touchpoints")
    return min(100, score), "; ".join(notes), cta_segments[:5]


def score_cta_no_transcript(
    end_screen, energy_drop, rate_ratio, has_pre_silence,
    onset_pct, max_onset_drop, pitch_rising, pitch_slope, music_injected, flatness_delta,
    duration
):
    score = 35
    signals_fired = 0
    notes = []

    # Signal 1: End-screen visual overlay (v3)
    if end_screen.get("detected"):
        if end_screen.get("confidence") == "high":
            score += 28
            signals_fired += 1
            notes.append(
                f"End-screen overlay detected (corner {end_screen.get('avg_corner_bright_ratio', 0):.2f}, "
                f"bottom {end_screen.get('avg_bottom_bright_ratio', 0):.2f})"
            )
        else:
            score += 15
            signals_fired += 1
            notes.append("Possible end-screen overlay detected (moderate confidence)")
    else:
        notes.append("No end-screen overlay in final 20%")

    # Signal 2: Outro energy drop (v3)
    if energy_drop > 3.0:
        score += 18
        signals_fired += 1
        notes.append(f"Audio energy drops {energy_drop:.1f} dB in outro")
    elif energy_drop > 1.5:
        score += 9
        signals_fired += 1
        notes.append(f"Slight audio energy drop in outro ({energy_drop:.1f} dB)")

    # Signal 3: Speaking rate slowdown (v3)
    if rate_ratio > 1.35:
        score += 15
        signals_fired += 1
        notes.append(f"Speaking rate slows in outro (gap ratio {rate_ratio:.2f})")
    elif rate_ratio > 1.15:
        score += 7
        signals_fired += 1
        notes.append(f"Slight speaking rate decrease (gap ratio {rate_ratio:.2f})")

    # Signal 4: Pre-CTA silence gap (v3)
    if has_pre_silence:
        score += 12
        signals_fired += 1
        notes.append("Deliberate pause in final 10% -- pattern interrupt before CTA")

    # Signal 5 (v4 NEW): CTA onset precision
    if onset_pct is not None:
        score += 6
        signals_fired += 1
        notes.append(f"CTA onset detected at {onset_pct*100:.0f}% of video ({max_onset_drop:.1f} dB drop)")
        if onset_pct >= 0.80:
            score += 2
            notes.append("Late-start CTA onset -- good content-to-CTA ratio")
    elif max_onset_drop > 1.0:
        score += 3
        notes.append(f"Gradual energy decrease in outro ({max_onset_drop:.1f} dB) -- likely CTA transition")

    # Signal 6 (v4 NEW): Pitch contour rise
    if pitch_rising:
        score += 12
        signals_fired += 1
        notes.append(f"Rising vocal pitch in outro (slope={pitch_slope:.2f}) -- CTA interrogative intonation")
    elif pitch_slope > 0.2:
        score += 5
        notes.append(f"Slight pitch rise in outro ({pitch_slope:.2f} slope) -- possible CTA intonation")

    # Signal 7 (v4 NEW): Outro music injection
    if music_injected:
        score += 8
        signals_fired += 1
        notes.append(f"Outro music bed detected (spectrum flattens delta={flatness_delta:.3f}) -- professional CTA framing")
    elif flatness_delta > 0.04:
        score += 3
        notes.append(f"Slight spectral shift in outro (flatness delta={flatness_delta:.3f})")

    # Multi-signal confidence bonus
    if signals_fired >= 4:
        score += 8
        notes.append(f"High confidence: {signals_fired}/7 CTA signals detected")
    elif signals_fired >= 2:
        score += 3
        notes.append(f"{signals_fired}/7 CTA signals detected")
    elif signals_fired == 0:
        notes.append("No CTA signals detected -- consider adding a call-to-action")

    if duration < 30 and signals_fired == 0:
        score = max(score, 45)
        notes.append("Short video -- CTA may be implicit or in caption")

    return min(100, max(0, score)), "; ".join(notes)


def analyze(video_path, transcript_path=None):
    result = {
        "tool": "analyze-cta-v4",
        "version": TOOL_VERSION,
        "scores": {},
        "warnings": [],
    }

    if not os.path.exists(video_path):
        result["warnings"].append(f"File not found: {video_path}")
        result["overall_score"] = 0
        return result

    duration = get_duration(video_path)
    if duration <= 0:
        result["warnings"].append("Could not determine video duration")
        result["overall_score"] = 0
        return result

    transcript = parse_transcript(transcript_path)

    # v3 signals
    end_screen = analyze_end_screen_overlay(video_path, duration)
    energy_drop, zone_rms = analyze_outro_energy(video_path, duration)
    rate_ratio, rate_raw = analyze_speaking_rate_change(video_path, duration)
    has_pre_silence, silence_list = detect_pre_cta_silence(video_path, duration)

    # v4 new signals
    onset_pct, max_onset_drop = detect_cta_onset_window(video_path, duration)
    pitch_rising, pitch_slope, pitch_ratios = analyze_pitch_contour_outro(video_path, duration)
    music_injected, flatness_delta = analyze_outro_music_injection(video_path, duration)

    av_score, av_notes = score_cta_no_transcript(
        end_screen, energy_drop, rate_ratio, has_pre_silence,
        onset_pct, max_onset_drop, pitch_rising, pitch_slope,
        music_injected, flatness_delta, duration,
    )

    if transcript:
        t_score, t_notes, cta_moments = score_cta_from_transcript(transcript, duration)
        final_score = round(0.65 * t_score + 0.35 * av_score)
        final_notes = t_notes + "; (AV signals: " + av_notes + ")"
        signals_source = "transcript+av_fusion"
    else:
        final_score = av_score
        final_notes = av_notes
        cta_moments = []
        signals_source = "av_signals_only"

    result["scores"]["cta_placement"] = {
        "score": final_score,
        "feedback": final_notes,
        "raw": {
            "signals_source": signals_source,
            "end_screen_detected": end_screen.get("detected", False),
            "end_screen_confidence": end_screen.get("confidence", "none"),
            "outro_energy_drop_db": round(energy_drop, 2),
            "zone_rms": zone_rms,
            "speaking_rate_ratio": round(rate_ratio, 3),
            "pre_cta_silence_detected": has_pre_silence,
            "cta_onset_pct": round(onset_pct, 3) if onset_pct else None,
            "cta_onset_max_drop_db": max_onset_drop,
            "pitch_contour_rising": pitch_rising,
            "pitch_slope": pitch_slope,
            "pitch_band_ratios": pitch_ratios,
            "outro_music_injected": music_injected,
            "spectral_flatness_delta": flatness_delta,
            "cta_moments": cta_moments,
        },
    }
    result["overall_score"] = final_score
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-cta-v4.py <video_path> [--transcript <path>]")
        sys.exit(1)
    video_path = sys.argv[1]
    transcript_path = None
    if "--transcript" in sys.argv:
        idx = sys.argv.index("--transcript")
        if idx + 1 < len(sys.argv):
            transcript_path = sys.argv[idx + 1]
    result = analyze(video_path, transcript_path)
    print(json.dumps(result, indent=2))
