#!/usr/bin/env python3
"""
Video Technical Specs Analyzer
Evaluates: resolution, codec_quality, bitrate, format_fit
Uses ffprobe to extract video metadata and score against platform standards.

Usage:
    python analyze-technical-specs.py <video_path> [--platform shorts|youtube|linkedin]

Returns JSON with scores (0-100) and feedback for each criterion.
"""

import subprocess
import json
import sys
import os

# Platform-specific thresholds
PLATFORM_SPECS = {
    "shorts": {
        "target_width": 1080,
        "target_height": 1920,
        "aspect_ratio": 9 / 16,
        "max_duration": 60,
        "min_bitrate_kbps": 4000,
        "ideal_bitrate_kbps": 8000,
        "codec": "h264",
    },
    "youtube": {
        "target_width": 1920,
        "target_height": 1080,
        "aspect_ratio": 16 / 9,
        "max_duration": 7200,
        "min_bitrate_kbps": 8000,
        "ideal_bitrate_kbps": 16000,
        "codec": "h264",
    },
    "linkedin": {
        "target_width": 1920,
        "target_height": 1080,
        "aspect_ratio": 16 / 9,
        "max_duration": 600,
        "min_bitrate_kbps": 10000,
        "ideal_bitrate_kbps": 20000,
        "codec": "h264",
    },
}


def run_ffprobe(video_path):
    """Extract video metadata using ffprobe."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return None, f"ffprobe error: {result.stderr}"
        return json.loads(result.stdout), None
    except FileNotFoundError:
        return None, "ffprobe not found. Install ffmpeg."
    except subprocess.TimeoutExpired:
        return None, "ffprobe timed out after 30s"
    except json.JSONDecodeError:
        return None, "Failed to parse ffprobe output"


def get_video_stream(probe_data):
    """Extract the video stream from probe data."""
    for stream in probe_data.get("streams", []):
        if stream.get("codec_type") == "video":
            return stream
    return None


def score_resolution(video_stream, specs):
    """Score resolution against platform target."""
    width = int(video_stream.get("width", 0))
    height = int(video_stream.get("height", 0))
    target_w = specs["target_width"]
    target_h = specs["target_height"]

    if width >= target_w and height >= target_h:
        score = 100
    elif width >= target_w * 0.9 and height >= target_h * 0.9:
        score = 85
    elif width >= target_w * 0.67 and height >= target_h * 0.67:
        score = 60  # 720p equivalent
    else:
        ratio = min(width / target_w, height / target_h)
        score = max(0, int(ratio * 60))

    feedback = f"{width}x{height} (target: {target_w}x{target_h})"
    if score < 80:
        feedback += " — consider upscaling or re-recording at higher resolution"

    return {"score": score, "feedback": feedback, "raw": {"width": width, "height": height}}


def score_codec_quality(video_stream, format_data, specs):
    """Score codec and encoding settings."""
    codec = video_stream.get("codec_name", "unknown")
    profile = video_stream.get("profile", "unknown")
    pix_fmt = video_stream.get("pix_fmt", "unknown")

    score = 50  # baseline
    notes = []

    # Codec check
    if codec == specs["codec"]:
        score += 20
        notes.append(f"Codec: {codec} (correct)")
    elif codec in ("hevc", "h265", "vp9", "av1"):
        score += 15
        notes.append(f"Codec: {codec} (acceptable but {specs['codec']} preferred)")
    else:
        notes.append(f"Codec: {codec} (non-standard, use {specs['codec']})")

    # Profile check
    if profile and "High" in profile:
        score += 15
        notes.append(f"Profile: {profile} (good)")
    elif profile and "Main" in profile:
        score += 10
        notes.append(f"Profile: {profile} (acceptable)")
    else:
        notes.append(f"Profile: {profile}")

    # Pixel format
    if pix_fmt == "yuv420p":
        score += 15
        notes.append("Pixel format: yuv420p (optimal compatibility)")
    elif pix_fmt == "yuv444p":
        score += 10
        notes.append("Pixel format: yuv444p (good quality, may have compat issues)")
    else:
        notes.append(f"Pixel format: {pix_fmt}")

    return {"score": min(100, score), "feedback": "; ".join(notes), "raw": {"codec": codec, "profile": profile, "pix_fmt": pix_fmt}}


def score_bitrate(format_data, specs):
    """Score bitrate against platform standards."""
    bit_rate_str = format_data.get("bit_rate", "0")
    bitrate_kbps = int(bit_rate_str) / 1000 if bit_rate_str else 0

    min_br = specs["min_bitrate_kbps"]
    ideal_br = specs["ideal_bitrate_kbps"]

    if bitrate_kbps >= ideal_br:
        score = 100
    elif bitrate_kbps >= min_br:
        ratio = (bitrate_kbps - min_br) / (ideal_br - min_br)
        score = 70 + int(ratio * 30)
    elif bitrate_kbps >= min_br * 0.5:
        score = 40 + int((bitrate_kbps / min_br) * 30)
    else:
        score = max(0, int((bitrate_kbps / min_br) * 40))

    feedback = f"{bitrate_kbps:.0f} kbps (min: {min_br}, ideal: {ideal_br})"
    if score < 70:
        feedback += " — bitrate too low, re-encode at higher quality (lower CRF)"

    return {"score": score, "feedback": feedback, "raw": {"bitrate_kbps": round(bitrate_kbps)}}


def score_format_fit(video_stream, format_data, specs):
    """Score aspect ratio and duration fit for platform."""
    width = int(video_stream.get("width", 0))
    height = int(video_stream.get("height", 0))
    duration = float(format_data.get("duration", 0))
    actual_ratio = width / height if height > 0 else 0
    target_ratio = specs["aspect_ratio"]

    score = 0
    notes = []

    # Aspect ratio scoring
    ratio_diff = abs(actual_ratio - target_ratio)
    if ratio_diff < 0.02:
        score += 50
        notes.append(f"Aspect ratio: {actual_ratio:.2f} (matches target {target_ratio:.2f})")
    elif ratio_diff < 0.1:
        score += 35
        notes.append(f"Aspect ratio: {actual_ratio:.2f} (close to target {target_ratio:.2f})")
    else:
        score += max(0, 30 - int(ratio_diff * 50))
        notes.append(f"Aspect ratio: {actual_ratio:.2f} (target: {target_ratio:.2f}) — wrong format")

    # Duration scoring
    max_dur = specs["max_duration"]
    if 0 < duration <= max_dur:
        score += 50
        notes.append(f"Duration: {duration:.1f}s (within {max_dur}s limit)")
    elif duration > max_dur:
        overage = (duration - max_dur) / max_dur
        dur_score = max(0, 50 - int(overage * 100))
        score += dur_score
        notes.append(f"Duration: {duration:.1f}s (exceeds {max_dur}s limit)")
    else:
        notes.append("Duration: unknown")

    return {"score": min(100, score), "feedback": "; ".join(notes), "raw": {"aspect_ratio": round(actual_ratio, 3), "duration_s": round(duration, 1)}}


def detect_platform(video_stream, format_data):
    """Auto-detect likely target platform from video properties."""
    width = int(video_stream.get("width", 0))
    height = int(video_stream.get("height", 0))
    duration = float(format_data.get("duration", 0))

    if width < height and duration <= 60:
        return "shorts"
    elif duration <= 600:
        return "linkedin"
    else:
        return "youtube"


def analyze(video_path, platform=None):
    """Run full technical analysis on a video file."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    probe_data, err = run_ffprobe(video_path)
    if err:
        return {"error": err}

    video_stream = get_video_stream(probe_data)
    if not video_stream:
        return {"error": "No video stream found in file"}

    format_data = probe_data.get("format", {})

    # Auto-detect platform if not specified
    if not platform:
        platform = detect_platform(video_stream, format_data)

    specs = PLATFORM_SPECS.get(platform, PLATFORM_SPECS["youtube"])

    results = {
        "tool": "analyze-technical-specs",
        "version": "1.0.0",
        "video_path": video_path,
        "platform": platform,
        "scores": {
            "resolution": score_resolution(video_stream, specs),
            "codec_quality": score_codec_quality(video_stream, format_data, specs),
            "bitrate": score_bitrate(format_data, specs),
            "format_fit": score_format_fit(video_stream, format_data, specs),
        },
    }

    # Compute overall technical score
    scores = [v["score"] for v in results["scores"].values()]
    results["overall_score"] = round(sum(scores) / len(scores), 1)

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-technical-specs.py <video_path> [--platform shorts|youtube|linkedin]")
        sys.exit(1)

    video_path = sys.argv[1]
    platform = None
    if "--platform" in sys.argv:
        idx = sys.argv.index("--platform")
        if idx + 1 < len(sys.argv):
            platform = sys.argv[idx + 1]

    result = analyze(video_path, platform)
    print(json.dumps(result, indent=2))
