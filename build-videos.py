#!/usr/bin/env python3
"""
Video builder for AILifeHacks YouTube Shorts.
Builds videos with: ElevenLabs voice, word-by-word captions, thumbnail card, music.
Runs on EC2 (Amazon Linux 2023).
"""

import os
import sys
import json
import time
import subprocess
import struct
import textwrap
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

WORK_DIR = Path("/opt/secondbrain/data/youtube/build")
EMPIRE_CONFIG = Path("/opt/secondbrain/empire/config.json")
FONT_PATH = "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"

# Load API keys from empire config
config = {}
if EMPIRE_CONFIG.exists():
    config = json.loads(EMPIRE_CONFIG.read_text())

ELEVENLABS_API_KEY = config.get("elevenlabs_api_key", "")
ELEVENLABS_VOICE_ID = "cgSgspJ2msm6clMCkdW9"  # Jessica
GROQ_API_KEY = config.get("groq_api_key", "")
PEXELS_API_KEY = config.get("pexels_api_key", "")

# Emphasis words for green highlight
EMPHASIS_WORDS = {
    "million", "billion", "free", "viral", "hack", "views", "money",
    "banned", "first", "zero", "never", "always", "secret", "real",
    "quit", "bitcoin", "crypto", "ai", "claude", "leaked", "exposed",
    "failed", "every", "none", "all", "destroyed", "accidentally",
    "512000", "41500", "frustration", "tracking", "privacy",
}

# ── Helpers ────────────────────────────────────────────────────────────────────

def run(cmd, **kwargs):
    print(f"  $ {cmd[:120]}...")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=300, **kwargs)
    if result.returncode != 0:
        print(f"  ERROR: {result.stderr[:500]}")
    return result

def fetch_json(url, headers=None, method="GET", data=None):
    import requests
    resp = requests.request(method, url, headers=headers or {}, data=data, timeout=60)
    resp.raise_for_status()
    return resp.json()

def fetch_binary(url, headers=None, data=None, method="POST"):
    import requests
    resp = requests.request(method, url, headers=headers or {}, data=data, timeout=120)
    resp.raise_for_status()
    return resp.content


# ── Voice Generation (ElevenLabs) ─────────────────────────────────────────────

def generate_voice(text, output_path):
    """Generate voice using ElevenLabs Jessica voice."""
    print(f"  Generating voice ({len(text)} chars)...")
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    body = json.dumps({
        "text": text,
        "model_id": "eleven_turbo_v2_5",
        "voice_settings": {
            "stability": 0.40,
            "similarity_boost": 0.60,
            "style": 0.45,
        },
    })
    audio = fetch_binary(url, headers=headers, data=body)
    Path(output_path).write_bytes(audio)
    print(f"  Voice saved: {output_path} ({len(audio)} bytes)")
    return output_path


# ── Voice Humanizer ───────────────────────────────────────────────────────────

def humanize_voice(input_path, output_path):
    """Apply subtle compression + EQ to make TTS sound more natural."""
    run(f'ffmpeg -y -i {input_path} '
        f'-af "acompressor=threshold=-18dB:ratio=3:attack=10:release=100,'
        f'equalizer=f=3000:t=q:w=1:g=2,'
        f'equalizer=f=200:t=q:w=1:g=-1" '
        f'{output_path}')
    if Path(output_path).exists():
        print(f"  Humanized voice: {output_path}")
        return output_path
    return input_path


# ── Word-by-word Caption Generation ──────────────────────────────────────────

def transcribe_words(audio_path):
    """Use Groq Whisper to get word-level timestamps."""
    print("  Transcribing with Groq Whisper...")
    import requests
    url = "https://api.groq.com/openai/v1/audio/transcriptions"
    headers = {"Authorization": f"Bearer {GROQ_API_KEY}"}
    with open(audio_path, "rb") as f:
        resp = requests.post(url, headers=headers, files={"file": f},
                           data={"model": "whisper-large-v3-turbo",
                                 "response_format": "verbose_json",
                                 "timestamp_granularities[]": "word"},
                           timeout=120)
    resp.raise_for_status()
    data = resp.json()
    words = data.get("words", [])
    print(f"  Got {len(words)} word timestamps")
    return words


def write_ass_subtitles(words, ass_path):
    """Write an ASS subtitle file for word-by-word captions with green emphasis."""
    if not words:
        return None

    def fmt_time(t):
        h = int(t // 3600)
        m = int((t % 3600) // 60)
        s = int(t % 60)
        cs = int((t % 1) * 100)
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

    # ASS colors are in &HBBGGRR& format
    WHITE = "&H00FFFFFF"
    GREEN = "&H0088FF00"  # #00FF88 in BGR
    OUTLINE = "&H00000000"

    header = f"""[Script Info]
Title: Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,DejaVu Sans,88,{WHITE},&H000000FF,{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,4,0,2,10,10,480,1
Style: Emphasis,DejaVu Sans,88,{GREEN},&H000000FF,{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,4,0,2,10,10,480,1
Style: WordSmall,DejaVu Sans,68,{WHITE},&H000000FF,{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,4,0,2,10,10,480,1
Style: EmphasisSmall,DejaVu Sans,68,{GREEN},&H000000FF,{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,4,0,2,10,10,480,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    events = []
    for w in words:
        word = w.get("word", "").strip()
        start = w.get("start", 0)
        end = w.get("end", start + 0.3)
        if not word:
            continue

        is_emphasis = word.lower().strip(".,!?'\"") in EMPHASIS_WORDS
        is_long = len(word) > 12

        if is_emphasis and is_long:
            style = "EmphasisSmall"
        elif is_emphasis:
            style = "Emphasis"
        elif is_long:
            style = "WordSmall"
        else:
            style = "Word"

        # Escape ASS special chars
        escaped = word.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")

        events.append(
            f"Dialogue: 0,{fmt_time(start)},{fmt_time(end)},{style},,0,0,0,,{escaped}"
        )

    content = header + "\n".join(events) + "\n"
    Path(ass_path).write_text(content)
    print(f"  ASS subtitle file: {ass_path} ({len(events)} words)")
    return ass_path


# ── Stock Footage ─────────────────────────────────────────────────────────────

def fetch_stock_footage(query, duration_needed, output_path):
    """Fetch stock footage from Pexels."""
    print(f"  Fetching stock footage: '{query}'...")
    import requests
    headers = {"Authorization": PEXELS_API_KEY}
    resp = requests.get(
        f"https://api.pexels.com/videos/search?query={query}&per_page=5&orientation=portrait&size=small",
        headers=headers, timeout=30
    )
    if resp.status_code != 200:
        print(f"  Pexels API error: {resp.status_code}")
        return None

    data = resp.json()
    videos = data.get("videos", [])
    if not videos:
        print("  No stock footage found")
        return None

    # Find the best portrait video
    for video in videos:
        for file in video.get("video_files", []):
            if file.get("height", 0) >= 1080:
                dl_url = file["link"]
                print(f"  Downloading: {dl_url[:80]}...")
                vid_data = requests.get(dl_url, timeout=120).content
                Path(output_path).write_bytes(vid_data)
                print(f"  Stock footage saved: {len(vid_data)} bytes")
                return output_path

    # Fallback: any file
    dl_url = videos[0]["video_files"][0]["link"]
    vid_data = requests.get(dl_url, timeout=120).content
    Path(output_path).write_bytes(vid_data)
    return output_path


# ── Thumbnail Generation ─────────────────────────────────────────────────────

def generate_thumbnail(title, output_path, bg_color="#1a1a2e"):
    """Generate a text-on-gradient thumbnail using PIL."""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (1080, 1920), bg_color)
    draw = ImageDraw.Draw(img)

    # Gradient overlay
    for y in range(1920):
        alpha = int(255 * (y / 1920))
        draw.line([(0, y), (1080, y)], fill=(alpha // 8, alpha // 12, alpha // 4))

    # Title text
    try:
        font = ImageFont.truetype(FONT_PATH, 72)
    except:
        font = ImageFont.load_default()

    # Word wrap
    lines = textwrap.wrap(title, width=18)
    y_start = 700
    for i, line in enumerate(lines):
        bbox = draw.textbbox((0, 0), line, font=font)
        tw = bbox[2] - bbox[0]
        x = (1080 - tw) // 2
        # Shadow
        draw.text((x + 3, y_start + i * 90 + 3), line, fill="black", font=font)
        draw.text((x, y_start + i * 90), line, fill="white", font=font)

    img.save(output_path, "JPEG", quality=90)
    print(f"  Thumbnail saved: {output_path}")
    return output_path


# ── Video Assembly ────────────────────────────────────────────────────────────

def build_video(video_id, title, script, stock_query, output_dir):
    """Full video build pipeline."""
    d = Path(output_dir)
    d.mkdir(parents=True, exist_ok=True)

    voice_raw = d / "voice.mp3"
    voice_human = d / "voice_human.mp3"
    stock_raw = d / "stock_raw.mp4"
    stock_scaled = d / "stock_scaled.mp4"
    thumbnail = d / "thumbnail.jpg"
    thumb_card = d / "thumb_card.mp4"
    with_captions = d / "with_captions.mp4"
    final = d / "final.mp4"
    tg = d / "tg.mp4"

    print(f"\n{'='*60}")
    print(f"Building: {title}")
    print(f"{'='*60}\n")

    # 1. Generate voice (skip if already exists)
    if voice_human.exists():
        print("[1/7] Voice already exists — reusing")
    elif voice_raw.exists():
        print("[1/7] Raw voice exists — humanizing only")
    else:
        print("[1/7] Voice generation...")
        generate_voice(script, str(voice_raw))

    # 2. Humanize voice (skip if already exists)
    if voice_human.exists():
        print("[2/7] Humanized voice exists — reusing")
    else:
        print("[2/7] Voice humanization...")
        humanize_voice(str(voice_raw), str(voice_human))
    voice_file = str(voice_human) if voice_human.exists() else str(voice_raw)

    # Get voice duration
    probe = run(f"ffprobe -v quiet -show_entries format=duration -of csv=p=0 {voice_file}")
    voice_duration = float(probe.stdout.strip() or "30")
    total_duration = voice_duration + 0.25  # 0.25s thumbnail card
    print(f"  Voice duration: {voice_duration:.1f}s, total: {total_duration:.1f}s")

    # 3. Get word timestamps for captions
    print("[3/7] Caption generation...")
    words = transcribe_words(voice_file)
    # Offset all timestamps by 0.25s for the thumbnail card
    for w in words:
        w["start"] = w.get("start", 0) + 0.25
        w["end"] = w.get("end", 0) + 0.25
    ass_file = d / "captions.ass"
    write_ass_subtitles(words, str(ass_file))

    # 4. Generate thumbnail
    print("[4/7] Thumbnail generation...")
    generate_thumbnail(title, str(thumbnail))

    # 5. Fetch stock footage
    print("[5/7] Stock footage...")
    if not fetch_stock_footage(stock_query, voice_duration, str(stock_raw)):
        # Fallback: solid dark background
        run(f"ffmpeg -y -f lavfi -i color=c=0x0a0a1a:s=1080x1920:d={voice_duration + 1} "
            f"-pix_fmt yuv420p {stock_raw}")

    # Scale stock to 1080x1920
    run(f"ffmpeg -y -i {stock_raw} -vf 'scale=1080:1920:force_original_aspect_ratio=increase,"
        f"crop=1080:1920' -t {voice_duration + 1} -an -pix_fmt yuv420p {stock_scaled}")

    # 6. Create 0.25s thumbnail card video
    print("[6/7] Assembling video...")
    run(f"ffmpeg -y -loop 1 -i {thumbnail} -t 0.25 -vf 'scale=1080:1920' "
        f"-pix_fmt yuv420p -r 30 {thumb_card}")

    # 7. Concatenate thumbnail card + stock footage with captions and voice
    # First concat the video streams
    concat_list = d / "concat.txt"
    concat_list.write_text(f"file '{thumb_card}'\nfile '{stock_scaled}'\n")

    if ass_file and Path(str(ass_file)).exists():
        # Use ASS subtitles burned in via libass
        run(f"ffmpeg -y -f concat -safe 0 -i {concat_list} -i {voice_file} "
            f"-vf \"ass={ass_file}\" "
            f"-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "
            f"-t {total_duration} -shortest -pix_fmt yuv420p {final}")
    else:
        run(f"ffmpeg -y -f concat -safe 0 -i {concat_list} -i {voice_file} "
            f"-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "
            f"-t {total_duration} -shortest -pix_fmt yuv420p {final}")

    # Create Telegram-sized version
    run(f"ffmpeg -y -i {final} -vf 'scale=540:960' -c:v libx264 -preset fast "
        f"-crf 28 -c:a aac -b:a 64k {tg}")

    # Verify
    if final.exists():
        size_mb = final.stat().st_size / (1024 * 1024)
        print(f"\n  DONE: {final} ({size_mb:.1f} MB)")

        # QC checks
        probe_result = run(f"ffprobe -v quiet -show_entries format=duration -of csv=p=0 {final}")
        dur = float(probe_result.stdout.strip() or "0")
        print(f"  Duration: {dur:.1f}s")
        print(f"  Thumbnail card: 0.25s")
        print(f"  Captions: {len(words)} words")

        return str(final), str(thumbnail)
    else:
        print("  FAILED: No output file")
        return None, None


# ── Video Definitions ─────────────────────────────────────────────────────────

VIDEOS = {
    "mit_30_agents_v2": {
        "title": "MIT Audited 30 AI Agents. Every Single One Failed.",
        "script": (
            "MIT just tested 30 AI agents on real-world tasks. "
            "Not toy benchmarks. Real tasks. Filing taxes. Booking flights. Managing spreadsheets. "
            "Every single one failed. "
            "The best agent completed just 43 percent of tasks. "
            "The worst? Under 10 percent. "
            "And here's the scary part. "
            "These are the agents companies are selling you right now. "
            "The ones claiming to replace your entire workforce. "
            "MIT found they break on simple things. Pop-up windows. Changed layouts. Multi-step forms. "
            "The kind of stuff a human handles without thinking. "
            "AI agents aren't ready. Not even close. "
            "So the next time someone tries to sell you a fully autonomous AI worker, "
            "show them this study. "
            "Follow for more AI reality checks."
        ),
        "stock_query": "artificial intelligence robot computer",
        "channel": "AILifeHacks",
    },
    "anthropic_leak": {
        "title": "Anthropic Accidentally Leaked 512,000 Lines of Claude's Code",
        "script": (
            "Anthropic, the AI safety company, just accidentally leaked the entire source code of Claude Code. "
            "512,000 lines. 1,906 files. All of it. Public. "
            "A developer named Chaofan Shou found an unprotected source map in the npm package "
            "that pointed straight to the full codebase. "
            "Within hours, it was on GitHub. 41,000 forks. Developers everywhere tearing it apart. "
            "And what they found was wild. "
            "Hidden inside the code was a frustration tracker. "
            "Claude was scanning every message you sent. Looking for profanity. Insults. "
            "Phrases like 'this sucks' and 'so frustrating.' "
            "And logging it. "
            "The AI safety company was secretly tracking your emotions. "
            "Anthropic called it a packaging error. Human mistake. Not a breach. "
            "Then they filed takedown notices and accidentally nuked thousands of unrelated GitHub repos. "
            "The company that lectures everyone about AI safety "
            "can't even ship an npm package without exposing everything. "
            "Follow for more AI news that matters."
        ),
        "stock_query": "hacker code computer dark",
        "channel": "AILifeHacks",
    },
}


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    target = sys.argv[1] if len(sys.argv) > 1 else "all"

    results = {}
    for vid_id, spec in VIDEOS.items():
        if target != "all" and target != vid_id:
            continue

        output_dir = WORK_DIR / vid_id
        video_path, thumb_path = build_video(
            vid_id, spec["title"], spec["script"],
            spec["stock_query"], str(output_dir)
        )

        if video_path:
            # Copy final outputs to the youtube data dir for upload
            import shutil
            final_dest = f"/opt/secondbrain/data/youtube/{vid_id}.mp4"
            thumb_dest = f"/opt/secondbrain/data/youtube/{vid_id}_thumb.jpg"
            shutil.copy2(video_path, final_dest)
            shutil.copy2(thumb_path, thumb_dest)
            results[vid_id] = {
                "video": final_dest,
                "thumbnail": thumb_dest,
                "title": spec["title"],
                "channel": spec["channel"],
            }
            print(f"\n  Ready for upload: {final_dest}")

    # Summary
    print(f"\n{'='*60}")
    print(f"BUILD COMPLETE: {len(results)}/{len(VIDEOS)} videos built")
    for vid_id, info in results.items():
        print(f"  {vid_id}: {info['title']}")
    print(f"{'='*60}")

    # Write manifest
    manifest_path = WORK_DIR / "build_manifest.json"
    manifest_path.write_text(json.dumps(results, indent=2))
    print(f"\nManifest: {manifest_path}")
