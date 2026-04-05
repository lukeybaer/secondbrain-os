"""video_utils.py — Shared video utilities"""
import subprocess
from pathlib import Path


def shift_word_timestamps(words: list, offset_seconds: float) -> list:
    """
    Shift all word timestamps by offset_seconds.
    Use this to account for thumbnail card prepended at start.

    Args:
        words: list of dicts with 'word', 'start', 'end' keys
        offset_seconds: seconds to add to all timestamps (e.g. 2.5 for thumbnail card)

    Returns:
        New list with shifted timestamps
    """
    shifted = []
    for w in words:
        shifted.append({
            **w,
            'start': float(w.get('start', 0)) + offset_seconds,
            'end': float(w.get('end', 0)) + offset_seconds,
        })
    return shifted


def prepend_thumbnail_card(video_path: Path, thumbnail_path: Path, out_path: Path, hold_seconds: float = 2.5) -> Path:
    """
    Prepend a still thumbnail card to the beginning of a video.
    This is MANDATORY for all builds per PRODUCTION_RULES.md.

    IMPORTANT: If your video has burned-in captions, generate them AFTER calling this
    function, using shift_word_timestamps(words, hold_seconds) to offset timestamps.
    Captions must NOT be burned in before prepending the thumbnail card, as the original
    timestamps (starting at 0) will be misaligned by hold_seconds throughout the video.

    Args:
        video_path: Path to the main video
        thumbnail_path: Path to thumbnail.jpg
        out_path: Output path for final video with thumbnail card
        hold_seconds: How long to show thumbnail (default 2.5s)

    Returns:
        Path to output video
    """
    import json
    probe = subprocess.run([
        'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_streams', str(video_path)
    ], capture_output=True, text=True)
    info = json.loads(probe.stdout)
    vs = next((s for s in info['streams'] if s['codec_type'] == 'video'), {})
    w = vs.get('width', 1080)
    h = vs.get('height', 1920)
    fps_str = vs.get('r_frame_rate', '30/1')

    # Create thumbnail still clip
    thumb_clip = out_path.parent / '_thumb_card.mp4'
    subprocess.run([
        'ffmpeg', '-y', '-loop', '1', '-i', str(thumbnail_path),
        '-t', str(hold_seconds),
        '-vf', f'scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', fps_str,
        '-an', str(thumb_clip)
    ], check=True, capture_output=True)

    # Concat thumbnail card + main video
    concat_file = out_path.parent / '_concat_thumb.txt'
    concat_file.write_text(f"file '{thumb_clip.resolve()}'\nfile '{video_path.resolve()}'\n")

    subprocess.run([
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
        '-i', str(concat_file),
        '-c', 'copy', str(out_path)
    ], check=True, capture_output=True)

    # Cleanup
    thumb_clip.unlink(missing_ok=True)
    concat_file.unlink(missing_ok=True)

    print(f"✅ Thumbnail card prepended: {out_path}")
    return out_path


def make_tg_version(video_path: Path, out_path: Path, max_mb: int = 48) -> Path:
    """Compress video for Telegram (target < 50MB)."""
    size_mb = video_path.stat().st_size / 1024 / 1024
    if size_mb <= max_mb:
        import shutil
        shutil.copy2(video_path, out_path)
        return out_path

    # Compress with lower bitrate
    subprocess.run([
        'ffmpeg', '-y', '-i', str(video_path),
        '-c:v', 'libx264', '-crf', '28', '-preset', 'fast',
        '-c:a', 'aac', '-b:a', '128k',
        str(out_path)
    ], check=True, capture_output=True)
    return out_path
