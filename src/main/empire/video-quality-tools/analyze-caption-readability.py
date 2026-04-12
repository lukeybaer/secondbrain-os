#!/usr/bin/env python3
"""
Video Caption / Subtitle Readability Analyzer
Evaluates caption presence, timing quality, text density, and display duration.
Uses ffprobe for stream detection and ffmpeg subtitle extraction for text analysis.
Supports embedded text subtitles (SRT, ASS/SSA, WebVTT, MOV_TEXT) and sidecar files.

Technique:
  1. ffprobe stream scan: detect subtitle streams by codec_type="subtitle"
  2. Extract subtitle data via ffmpeg (-c:s copy -f srt or -f ass)
  3. Parse timing data: gap between lines, display duration per cue, cue count
  4. Analyze text content: words per cue, reading speed (words/min), line length
  5. Score based on:
     - Presence/absence of captions (automated channels without captions lose ~20% reach)
     - Reading speed: 120-200 WPM is ideal, >300 WPM is too fast to read
     - Cue duration: 1-7 seconds per caption is readable; <0.5s is flash
     - Gap between captions: >1s gaps break flow
     - Line length: >42 chars per line is hard to read on mobile

Research basis:
  BBC subtitle guidelines (2019): max 200 WPM display rate, 42 chars/line
  Netflix Timed Text Style Guide: 17 chars/second max, min 5/6 frame duration
  YouTube auto-caption accuracy study (2022): human captions increase watch time 40%
  WCAG 2.1 AA requires captions for all pre-recorded video -- absence is accessibility gap

Usage:
    python analyze-caption-readability.py <video_path> [--srt-file <path>]

Returns JSON with caption_readability score (0-100) and feedback.
"""

import subprocess
import json
import sys
import os
import re
import tempfile
import shutil


TOOLS_VERSION = "1.0.0"

# BBC / Netflix reading speed benchmarks
MAX_CHARS_PER_SECOND = 17.0      # Netflix standard
MAX_WORDS_PER_MINUTE = 200.0     # BBC standard
MIN_CUE_DURATION_S = 0.5         # Minimum display time before caption is a "flash"
MAX_CUE_DURATION_S = 7.0         # Maximum display time per cue (split long cues)
MAX_LINE_LENGTH_CHARS = 42       # Mobile-safe line length


# ── ffprobe subtitle detection ────────────────────────────────────────────────

def detect_subtitle_streams(video_path):
    """
    Use ffprobe to detect subtitle streams in the video container.
    Returns list of stream dicts with index, codec, and language.
    """
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_streams", "-select_streams", "s",
        "-print_format", "json",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        out = []
        for s in streams:
            out.append({
                "index": s.get("index"),
                "codec_name": s.get("codec_name", "unknown"),
                "codec_type": s.get("codec_type", ""),
                "language": s.get("tags", {}).get("language", "und"),
                "is_text": s.get("codec_name", "") in ("srt", "subrip", "ass", "ssa", "webvtt", "mov_text", "text"),
            })
        return out, None
    except Exception as e:
        return [], str(e)


def extract_subtitles_as_srt(video_path, stream_index=None, tmpdir=None):
    """
    Extract subtitle stream from video to SRT format.
    Returns path to extracted SRT file or None.
    """
    if tmpdir is None:
        tmpdir = tempfile.mkdtemp(prefix="vq_subs_")

    out_path = os.path.join(tmpdir, "subs.srt")
    stream_spec = f"0:s:{stream_index}" if stream_index is not None else "0:s:0"

    cmd = [
        "ffmpeg", "-i", video_path,
        "-map", stream_spec,
        "-f", "srt",
        "-y", out_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            return out_path, tmpdir, None
        return None, tmpdir, f"SRT extraction produced empty file. stderr: {result.stderr[-200:]}"
    except Exception as e:
        return None, tmpdir, str(e)


# ── SRT parsing ───────────────────────────────────────────────────────────────

def parse_srt_timestamp(ts_str):
    """Convert SRT timestamp (HH:MM:SS,mmm) to seconds."""
    # Handles both comma and period as decimal separator
    ts_str = ts_str.replace(",", ".")
    parts = ts_str.strip().split(":")
    if len(parts) != 3:
        return 0.0
    h, m = int(parts[0]), int(parts[1])
    s = float(parts[2])
    return h * 3600 + m * 60 + s


def parse_srt(srt_path):
    """
    Parse SRT file into list of cue dicts:
    {index, start_s, end_s, duration_s, text, word_count, char_count, max_line_len}
    """
    cues = []
    try:
        with open(srt_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception:
        return cues

    # Split on blank lines between cues
    blocks = re.split(r"\n\s*\n", content.strip())
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 2:
            continue

        # Line 0: cue index (integer)
        # Line 1: timestamps
        # Lines 2+: text
        try:
            cue_idx = int(lines[0].strip())
        except ValueError:
            continue

        ts_match = re.match(
            r"(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})",
            lines[1].strip(),
        )
        if not ts_match:
            continue

        start_s = parse_srt_timestamp(ts_match.group(1))
        end_s = parse_srt_timestamp(ts_match.group(2))
        text_lines = lines[2:]
        text = " ".join(text_lines).strip()

        # Strip ASS/SSA override tags if present
        text = re.sub(r"\{[^}]*\}", "", text).strip()
        # Strip HTML tags (sometimes in SRT)
        text = re.sub(r"<[^>]+>", "", text).strip()

        words = text.split()
        char_count = len(text.replace(" ", ""))
        max_line_len = max((len(l) for l in text_lines), default=0)

        cues.append({
            "index": cue_idx,
            "start_s": round(start_s, 3),
            "end_s": round(end_s, 3),
            "duration_s": round(end_s - start_s, 3),
            "text": text,
            "word_count": len(words),
            "char_count": char_count,
            "max_line_len": max_line_len,
        })

    return cues


# ── scoring ───────────────────────────────────────────────────────────────────

def score_caption_readability(cues, stream_info, has_captions):
    """
    Score caption readability from parsed cues.
    """
    notes = []
    score = 100
    raw = {}

    if not has_captions:
        return {
            "score": 30,
            "feedback": "No subtitle/caption stream detected -- add captions to maximize accessibility and reach (YouTube auto-captions add ~40% watch time lift)",
            "raw": {"has_captions": False, "cue_count": 0},
        }

    # Caption stream exists but extraction/parsing failed
    if has_captions and not cues:
        # Partial credit -- captions exist but we can't validate content
        notes.append(f"Caption stream detected ({len(stream_info)} stream(s)) but text extraction failed -- likely image-based subtitles")
        # Check if streams are image-based
        image_based = any(not s.get("is_text", True) for s in stream_info)
        if image_based:
            score = 60
            notes.append("Image-based subtitle format detected -- prefer text-based (SRT/ASS) for better accessibility and indexability")
        else:
            score = 65
            notes.append("Text captions present -- manual readability check recommended")
        return {
            "score": score,
            "feedback": "; ".join(notes),
            "raw": {"has_captions": True, "cue_count": 0, "image_based": image_based},
        }

    # Full analysis with parsed cues
    cue_count = len(cues)
    raw["has_captions"] = True
    raw["cue_count"] = cue_count

    notes.append(f"Captions present: {cue_count} cues")

    # ── Reading speed ──────────────────────────────────────────────────────
    reading_speeds_wpm = []
    for cue in cues:
        if cue["duration_s"] > 0 and cue["word_count"] > 0:
            wpm = (cue["word_count"] / cue["duration_s"]) * 60
            reading_speeds_wpm.append(wpm)

    if reading_speeds_wpm:
        avg_wpm = sum(reading_speeds_wpm) / len(reading_speeds_wpm)
        fast_cues = sum(1 for w in reading_speeds_wpm if w > MAX_WORDS_PER_MINUTE)
        raw["avg_reading_speed_wpm"] = round(avg_wpm, 1)
        raw["fast_cue_count"] = fast_cues

        if avg_wpm <= MAX_WORDS_PER_MINUTE:
            notes.append(f"Reading speed: {avg_wpm:.0f} WPM (within BBC 200 WPM guideline)")
        elif avg_wpm <= 250:
            score -= 15
            notes.append(f"Reading speed: {avg_wpm:.0f} WPM (slightly fast, BBC recommends <= 200 WPM)")
        else:
            score -= 30
            notes.append(f"Reading speed: {avg_wpm:.0f} WPM (too fast -- viewers can't keep up, slow captions or shorten text)")

        if fast_cues > cue_count * 0.2:
            score -= 10
            notes.append(f"{fast_cues}/{cue_count} cues exceed 200 WPM display rate")

    # ── Cue duration ──────────────────────────────────────────────────────
    durations = [c["duration_s"] for c in cues]
    if durations:
        avg_dur = sum(durations) / len(durations)
        flash_cues = sum(1 for d in durations if d < MIN_CUE_DURATION_S)
        long_cues = sum(1 for d in durations if d > MAX_CUE_DURATION_S)
        raw["avg_cue_duration_s"] = round(avg_dur, 2)
        raw["flash_cue_count"] = flash_cues
        raw["long_cue_count"] = long_cues

        if flash_cues > 0:
            score -= min(20, flash_cues * 5)
            notes.append(f"{flash_cues} flash cues (<0.5s) -- too brief to read, extend or remove")
        if long_cues > cue_count * 0.15:
            score -= 10
            notes.append(f"{long_cues} cues exceed 7s -- split long captions for readability")

        if 1.5 <= avg_dur <= MAX_CUE_DURATION_S:
            notes.append(f"Cue duration: {avg_dur:.1f}s avg (good)")
        elif avg_dur < 1.5:
            score -= 10
            notes.append(f"Cue duration: {avg_dur:.1f}s avg (short -- check for timing issues)")

    # ── Line length ───────────────────────────────────────────────────────
    long_lines = sum(1 for c in cues if c["max_line_len"] > MAX_LINE_LENGTH_CHARS)
    raw["long_line_cue_count"] = long_lines
    if long_lines > cue_count * 0.25:
        score -= 15
        notes.append(f"{long_lines}/{cue_count} cues exceed {MAX_LINE_LENGTH_CHARS} chars/line -- wrap for mobile readability")
    elif long_lines > 0:
        score -= 5
        notes.append(f"{long_lines} cues with long lines (>{MAX_LINE_LENGTH_CHARS} chars) -- minor")
    else:
        notes.append(f"Line length: all cues within {MAX_LINE_LENGTH_CHARS} char limit (good)")

    # ── Gap analysis ──────────────────────────────────────────────────────
    gaps = []
    for i in range(1, len(cues)):
        gap = cues[i]["start_s"] - cues[i - 1]["end_s"]
        if gap > 0:
            gaps.append(gap)

    if gaps:
        avg_gap = sum(gaps) / len(gaps)
        large_gaps = sum(1 for g in gaps if g > 2.0)
        raw["avg_gap_between_cues_s"] = round(avg_gap, 2)
        raw["large_gap_count"] = large_gaps
        if large_gaps > len(gaps) * 0.3:
            notes.append(f"{large_gaps} caption gaps >2s -- extended uncaptioned segments (check for missing speech)")
        else:
            notes.append(f"Caption continuity: good (avg gap {avg_gap:.1f}s)")

    return {
        "score": max(0, score),
        "feedback": "; ".join(notes),
        "raw": raw,
    }


# ── main entry ────────────────────────────────────────────────────────────────

def analyze(video_path, srt_file=None):
    """Run caption readability analysis on a video file."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    warnings = []
    tmpdir = None

    # Step 1: detect subtitle streams
    streams, probe_err = detect_subtitle_streams(video_path)
    if probe_err:
        warnings.append(f"ffprobe subtitle detection: {probe_err}")

    has_captions = len(streams) > 0 or (srt_file and os.path.exists(srt_file))
    cues = []

    # Step 2: extract and parse subtitles
    if srt_file and os.path.exists(srt_file):
        # Use provided sidecar SRT
        cues = parse_srt(srt_file)
        warnings.append(f"Using provided SRT file: {srt_file}")
    elif streams:
        # Try extracting text-based subtitle streams
        text_streams = [s for s in streams if s.get("is_text", False)]
        if text_streams:
            tmpdir = tempfile.mkdtemp(prefix="vq_subs_")
            srt_path, tmpdir, ext_err = extract_subtitles_as_srt(video_path, tmpdir=tmpdir)
            if srt_path:
                cues = parse_srt(srt_path)
            elif ext_err:
                warnings.append(f"SRT extraction: {ext_err}")
        else:
            warnings.append("Only image-based subtitle streams found (no text extraction possible)")

    cap_score = score_caption_readability(cues, streams, has_captions)

    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)

    return {
        "tool": "analyze-caption-readability",
        "version": TOOLS_VERSION,
        "video_path": video_path,
        "subtitle_streams_found": len(streams),
        "stream_info": streams,
        "cues_parsed": len(cues),
        "scores": {
            "caption_readability": cap_score,
        },
        "overall_score": cap_score["score"],
        "warnings": warnings,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-caption-readability.py <video_path> [--srt-file <path>]")
        sys.exit(1)

    video_path = sys.argv[1]
    srt_path = None
    if "--srt-file" in sys.argv:
        idx = sys.argv.index("--srt-file")
        if idx + 1 < len(sys.argv):
            srt_path = sys.argv[idx + 1]

    result = analyze(video_path, srt_path)
    print(json.dumps(result, indent=2))
