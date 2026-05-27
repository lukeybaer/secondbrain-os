#!/usr/bin/env python3
"""
check-video-content-not-blank.py -- block videos that are visually blank.

The user reported on 2026-04-29 that the regen produced a video that was
"just black the whole time" -- thumbnail card displays for 2.5s, then the
body of the video is a black canvas with audio playing over it. The visual
B-roll never landed. mtime advanced, file size looks normal (~500KB to 1MB),
but the actual rendered frames have no content.

Strategy: extract three frames from the BODY of the video (after the 2.5s
thumbnail card), run each through scripts/check-thumbnail-quality.py, and
fail if all three are blank. We sample at t=4s, mid, and 75% to get a
representative cross-section -- a real video changes scenes; a black-canvas
video is uniformly blank everywhere.

Output: JSON to stdout. Exit 0 = pass, 1 = fail.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

THUMB_GATE = Path(__file__).resolve().parent / "check-thumbnail-quality.py"
THUMBNAIL_CARD_DURATION_S = 2.5
SAMPLE_TIMESTAMPS_FRAC = (0.10, 0.50, 0.80)
MIN_BODY_DURATION_S = 5.0


def get_duration(path: Path) -> float:
    r = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def get_stream_durations(path: Path) -> tuple[float, float]:
    """Return (video_duration_s, audio_duration_s) -- 0 if stream missing."""
    r = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-show_entries", "stream=codec_type,duration",
            "-of", "json",
            str(path),
        ],
        capture_output=True, text=True,
    )
    try:
        data = json.loads(r.stdout)
        video_dur = 0.0
        audio_dur = 0.0
        for s in data.get("streams", []):
            try:
                d = float(s.get("duration", 0) or 0)
            except Exception:
                d = 0.0
            if s.get("codec_type") == "video" and d > video_dur:
                video_dur = d
            if s.get("codec_type") == "audio" and d > audio_dur:
                audio_dur = d
        return video_dur, audio_dur
    except Exception:
        return 0.0, 0.0


def extract_frame(video: Path, timestamp_s: float, out: Path) -> bool:
    r = subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-ss", f"{timestamp_s:.2f}",
            "-i", str(video),
            "-vframes", "1",
            "-q:v", "3",
            str(out),
        ],
        capture_output=True, text=True,
    )
    return r.returncode == 0 and out.exists() and out.stat().st_size > 0


def check_frame(frame: Path) -> dict:
    r = subprocess.run(
        [sys.executable, str(THUMB_GATE), str(frame)],
        capture_output=True, text=True, timeout=15,
    )
    try:
        return json.loads((r.stdout or "").strip())
    except Exception:
        return {"ok": False, "reason": f"frame gate output unparseable: {(r.stdout or r.stderr or '')[:200]}"}


def analyze(path: Path) -> dict:
    if not path.exists():
        return {"ok": False, "reason": f"video file missing: {path}", "metrics": {}}
    if not THUMB_GATE.exists():
        return {"ok": False, "reason": f"thumbnail gate missing at {THUMB_GATE}", "metrics": {}}

    duration = get_duration(path)
    if duration <= 0:
        return {"ok": False, "reason": "could not read video duration", "metrics": {}}

    # Stream-duration sanity check: a real video has a video stream that
    # runs for the full container duration. The 2026-04-29 incident produced
    # an mp4 with audio_dur=28.2s but video_dur=0.23s -- the video stream
    # was effectively empty, so playback showed black after the first frame.
    video_dur, audio_dur = get_stream_durations(path)
    base_metrics = {
        "duration_s": round(duration, 1),
        "video_stream_s": round(video_dur, 2),
        "audio_stream_s": round(audio_dur, 2),
    }
    if video_dur > 0 and audio_dur > 0 and video_dur < audio_dur * 0.5:
        return {
            "ok": False,
            "reason": f"BROKEN VIDEO STREAM: video_dur={video_dur:.2f}s but "
            f"audio_dur={audio_dur:.2f}s. The video stream is missing or "
            f"truncated -- playback will show black after the first frame.",
            "metrics": base_metrics,
        }

    body_start = THUMBNAIL_CARD_DURATION_S
    body_duration = duration - body_start
    if body_duration < MIN_BODY_DURATION_S:
        return {
            "ok": False,
            "reason": f"BROKEN VIDEO STREAM: video body too short to sample ({body_duration:.1f}s). "
            f"A reviewable short must have at least {MIN_BODY_DURATION_S:.1f}s of body after the thumbnail card.",
            "metrics": base_metrics,
        }

    timestamps = [body_start + body_duration * frac for frac in SAMPLE_TIMESTAMPS_FRAC]

    frame_results = []
    blank_count = 0
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        for i, ts in enumerate(timestamps):
            frame = tmp_path / f"frame_{i}.jpg"
            if not extract_frame(path, ts, frame):
                frame_results.append({"t_s": round(ts, 1), "extracted": False})
                continue
            check = check_frame(frame)
            frame_results.append({
                "t_s": round(ts, 1),
                "extracted": True,
                "ok": check.get("ok"),
                "reason": check.get("reason", "")[:120],
                "metrics": check.get("metrics", {}),
            })
            if not check.get("ok"):
                blank_count += 1

    metrics = {
        **base_metrics,
        "body_start_s": body_start,
        "samples_taken": sum(1 for f in frame_results if f.get("extracted")),
        "samples_blank": blank_count,
        "frames": frame_results,
    }

    extracted = metrics["samples_taken"]
    if extracted == 0:
        # ffmpeg refused to extract a single frame from the body -- the
        # video stream is broken. Treat as a hard failure, never as "skip".
        return {
            "ok": False,
            "reason": "BROKEN VIDEO STREAM: could not extract any sample frames "
            "from the video body. ffmpeg is unable to decode frames past the "
            "first second -- the video stream is empty or corrupt.",
            "metrics": metrics,
        }

    if blank_count >= extracted:
        # All extracted frames are blank -- the video body is uniformly empty.
        return {
            "ok": False,
            "reason": f"BLANK VIDEO: all {extracted} sampled frames in the body "
            f"failed the thumbnail quality gate. Likely the B-roll never rendered "
            f"-- only the thumbnail card and audio made it into the file.",
            "metrics": metrics,
        }

    if blank_count > extracted // 2:
        return {
            "ok": False,
            "reason": f"BLANK VIDEO: {blank_count}/{extracted} sampled frames are blank "
            f"-- video body is mostly empty.",
            "metrics": metrics,
        }

    return {
        "ok": True,
        "reason": f"video body has visual content ({extracted - blank_count}/{extracted} "
        f"sampled frames passed quality gate)",
        "metrics": metrics,
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({"ok": False, "reason": "usage: check-video-content-not-blank.py <video.mp4>", "metrics": {}}))
        return 2
    result = analyze(Path(argv[1]))
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
