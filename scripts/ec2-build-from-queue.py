#!/usr/bin/env python3
"""
ec2-build-from-queue.py — Reads ec2-build-queue.json and builds each video.

Runs on EC2 (/opt/secondbrain/). Builds all videos in the queue that do not
already have a completed final.mp4, then writes results to build_manifest.json.

Fixes over build-videos.py:
- Stock footage is always looped to voice duration (never short)
- ASS captions offset by thumb card duration (0.25s)
- Grok Aurora (xAI) thumbnails for all videos
- Music mix from MUSIC_MAP in empire config
- No -shortest flag — explicit -t duration prevents truncation

Usage:
  python3 /opt/secondbrain/scripts/ec2-build-from-queue.py
  python3 /opt/secondbrain/scripts/ec2-build-from-queue.py --id ai_agent_income_formula
"""

import os
import sys
import json
import subprocess
import textwrap
import requests
from pathlib import Path

WORK_DIR = Path("/opt/secondbrain/data/youtube/build")
CONFIG_PATH = Path("/opt/secondbrain/empire/config.json")
QUEUE_PATH = Path("/opt/secondbrain/scripts/ec2-build-queue.json")
MANIFEST_PATH = WORK_DIR / "build_manifest.json"
FONT_PATH = "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"

W, H = 1080, 1920
JESSICA_ID = "cgSgspJ2msm6clMCkdW9"

EMPHASIS_WORDS = {
    'million', 'billion', 'free', 'viral', 'hack', 'views', 'money', 'banned',
    'first', 'zero', 'never', 'always', 'secret', 'real', 'quit', 'bitcoin',
    'crypto', 'ai', 'claude', 'leaked', 'exposed', 'failed', 'every', 'none',
    'all', 'destroyed', 'accidentally', 'free', 'nine', 'doubled', 'change',
    'broke', 'breaks', 'beats', 'beat', 'best', 'worst', 'dream', 'dreams',
}

def load_config():
    return json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}

def run(cmd, **kwargs):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        print(f"  CMD FAILED [{result.returncode}]: {cmd[:80]}")
        print(f"  STDERR: {result.stderr[:300]}")
    return result

def load_manifest():
    if MANIFEST_PATH.exists():
        try:
            return json.loads(MANIFEST_PATH.read_text())
        except Exception:
            return {}
    return {}

def save_manifest(data):
    MANIFEST_PATH.write_text(json.dumps(data, indent=2))


# ── Voice Generation ──────────────────────────────────────────────────────────

def generate_voice(script, out_path, config):
    key = config.get("elevenlabs_api_key", "")
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{JESSICA_ID}",
        headers={"xi-api-key": key, "Content-Type": "application/json"},
        json={"text": script, "model_id": "eleven_turbo_v2_5",
              "voice_settings": {"stability": 0.40, "similarity_boost": 0.60,
                                 "style": 0.45, "use_speaker_boost": False}},
        timeout=120
    )
    r.raise_for_status()
    Path(out_path).write_bytes(r.content)
    print(f"  Voice: {len(r.content)} bytes → {out_path}")

def humanize_voice(inp, out):
    run(f'ffmpeg -y -i {inp} '
        f'-af "acompressor=threshold=-18dB:ratio=3:attack=10:release=100,'
        f'equalizer=f=3000:t=q:w=1:g=2,equalizer=f=200:t=q:w=1:g=-1" '
        f'{out}')
    return out if Path(out).exists() else inp

def voice_duration(path):
    r = run(f"ffprobe -v quiet -show_entries format=duration -of csv=p=0 {path}")
    try:
        return float(r.stdout.strip())
    except Exception:
        return 30.0


# ── Captions (Groq Whisper) ───────────────────────────────────────────────────

def transcribe_words(audio_path, groq_key):
    url = "https://api.groq.com/openai/v1/audio/transcriptions"
    headers = {"Authorization": f"Bearer {groq_key}"}
    with open(audio_path, "rb") as f:
        resp = requests.post(url, headers=headers,
                             files={"file": f},
                             data={"model": "whisper-large-v3-turbo",
                                   "response_format": "verbose_json",
                                   "timestamp_granularities[]": "word"},
                             timeout=120)
    resp.raise_for_status()
    words = resp.json().get("words", [])
    print(f"  Captions: {len(words)} words transcribed")
    return words

def write_ass(words, ass_path, thumb_offset=0.25):
    if not words:
        return None
    WHITE, GREEN, OUTLINE = "&H00FFFFFF", "&H0088FF00", "&H00000000"
    def fmt(t):
        h, m = int(t // 3600), int((t % 3600) // 60)
        s, cs = int(t % 60), int((t % 1) * 100)
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"
    header = f"""[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n
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
        start = w.get("start", 0) + thumb_offset
        end   = w.get("end", start + 0.3) + thumb_offset
        if not word:
            continue
        is_em = word.lower().strip(".,!?'\"") in EMPHASIS_WORDS
        is_long = len(word) > 12
        style = ("EmphasisSmall" if is_em and is_long else
                 "Emphasis" if is_em else
                 "WordSmall" if is_long else "Word")
        esc = word.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
        events.append(f"Dialogue: 0,{fmt(start)},{fmt(end)},{style},,0,0,0,,{esc}")
    Path(ass_path).write_text(header + "\n".join(events) + "\n")
    print(f"  ASS: {len(events)} caption events → {ass_path}")
    return ass_path


# ── Thumbnail (Grok Aurora) ───────────────────────────────────────────────────

def grok_thumbnail(title, out_path, config):
    from PIL import Image, ImageDraw, ImageFont
    xai_key = config.get("xai_api_key", "")
    if not xai_key:
        print("  No xAI key — using gradient thumbnail")
        return gradient_thumbnail(title, out_path)

    # Generate cinematic background via Grok Aurora
    channel = os.environ.get("YT_CHANNEL_PRIMARY", "")
    prompt = (f"Cinematic wide-shot background for a YouTube Short about: {title}. "
              f"Ultra HD, dramatic lighting, deep colors. NO text. NO UI. "
              f"Dark, dramatic, professional. 9:16 aspect ratio.")
    try:
        r = requests.post("https://api.x.ai/v1/images/generations",
            headers={"Authorization": f"Bearer {xai_key}", "Content-Type": "application/json"},
            json={"model": "grok-2-image", "prompt": prompt, "n": 1},
            timeout=90)
        r.raise_for_status()
        img_url = r.json()["data"][0]["url"]
        img_data = requests.get(img_url, headers={"Authorization": f"Bearer {xai_key}"}, timeout=30).content
        bg_path = str(out_path).replace(".jpg", "_bg.jpg")
        Path(bg_path).write_bytes(img_data)
        return composite_text_thumbnail(bg_path, title, out_path)
    except Exception as e:
        print(f"  Grok Aurora failed ({e}), using gradient")
        return gradient_thumbnail(title, out_path)

def composite_text_thumbnail(bg_path, title, out_path):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.open(bg_path).convert("RGB")
    ratio = max(W / img.width, H / img.height)
    nw, nh = int(img.width * ratio), int(img.height * ratio)
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - W) // 2, (nh - H) // 2
    img = img.crop((left, top, left + W, top + H))

    # Dark gradient overlay
    overlay = Image.new("RGBA", (W, 900), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for y in range(900):
        od.line([(0, y), (W, y)], fill=(0, 0, 0, int(180 * (1 - y / 900))))
    img = img.convert("RGBA")
    img.alpha_composite(overlay, (0, 0))
    img = img.convert("RGB")
    draw = ImageDraw.Draw(img)

    try:
        font_h = ImageFont.truetype(FONT_PATH, 110)
    except Exception:
        font_h = ImageFont.load_default()

    words = title.split()
    mid = max(1, len(words) // 2)
    lines = [" ".join(words[:mid]), " ".join(words[mid:])]
    y = 300
    for line in lines:
        for ox, oy, color in [(-4, -4, "black"), (4, 4, "black"), (0, 0, "white")]:
            draw.text((W // 2 + ox, y + oy), line, font=font_h, fill=color,
                      stroke_width=6, stroke_fill="black", anchor="mm")
        bbox = draw.textbbox((0, 0), line, font=font_h)
        y += (bbox[3] - bbox[1]) + 24

    img.save(str(out_path), "JPEG", quality=92)
    print(f"  Thumbnail (Grok Aurora): {out_path}")
    return str(out_path)

def gradient_thumbnail(title, out_path):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (W, H), "#0a0a1e")
    draw = ImageDraw.Draw(img)
    for y in range(H):
        g = int(30 * (y / H))
        draw.line([(0, y), (W, y)], fill=(g // 3, g // 4, g))
    try:
        font = ImageFont.truetype(FONT_PATH, 88)
    except Exception:
        font = ImageFont.load_default()
    for i, line in enumerate(textwrap.wrap(title, width=16)):
        bbox = draw.textbbox((0, 0), line, font=font)
        x = (W - (bbox[2] - bbox[0])) // 2
        draw.text((x, 600 + i * 110), line, fill="white", font=font,
                  stroke_width=4, stroke_fill="black")
    img.save(str(out_path), "JPEG", quality=90)
    return str(out_path)


# ── Stock Footage (Pexels) ────────────────────────────────────────────────────

def fetch_stock(query, out_path, config):
    key = config.get("pexels_api_key", "")
    r = requests.get(
        f"https://api.pexels.com/videos/search?query={query}&per_page=5&orientation=portrait",
        headers={"Authorization": key}, timeout=30
    )
    if r.status_code != 200:
        print(f"  Pexels error {r.status_code}")
        return None
    for v in r.json().get("videos", []):
        for f in sorted(v.get("video_files", []), key=lambda x: x.get("height", 0), reverse=True):
            if f.get("height", 0) >= 1080:
                data = requests.get(f["link"], timeout=120).content
                Path(out_path).write_bytes(data)
                print(f"  Stock: {len(data)} bytes → {out_path}")
                return out_path
    return None


# ── Video Assembly ────────────────────────────────────────────────────────────

def build_video(spec, config):
    vid_id = spec["id"]
    d = WORK_DIR / vid_id
    d.mkdir(parents=True, exist_ok=True)

    voice_raw  = d / "voice.mp3"
    voice_h    = d / "voice_human.mp3"
    stock_raw  = d / "stock_raw.mp4"
    stock_s    = d / "stock_scaled.mp4"
    stock_loop = d / "stock_looped.mp4"
    thumbnail  = d / "thumbnail.jpg"
    thumb_card = d / "thumb_card.mp4"
    ass_file   = d / "captions.ass"
    concat_txt = d / "concat.txt"
    final      = d / "final.mp4"

    print(f"\n{'='*60}")
    print(f"Building: {spec['title']} [{vid_id}]")
    print(f"{'='*60}\n")

    # 1. Voice
    if voice_h.exists():
        print("[1] Voice exists — reusing")
    else:
        if not voice_raw.exists():
            print("[1] Generating ElevenLabs voice...")
            generate_voice(spec["script"], str(voice_raw), config)
        print("[1] Humanizing voice...")
        humanize_voice(str(voice_raw), str(voice_h))

    voice_file = str(voice_h) if voice_h.exists() else str(voice_raw)
    dur = voice_duration(voice_file)
    total_dur = dur + 0.25  # + thumb card
    print(f"  Voice duration: {dur:.1f}s, total: {total_dur:.1f}s")

    # 2. Captions (always regenerate for clean timestamps)
    print("[2] Transcribing for word-level captions...")
    words = transcribe_words(voice_file, config.get("groq_api_key", ""))
    write_ass(words, str(ass_file), thumb_offset=0.25)

    # 3. Thumbnail
    if thumbnail.exists():
        print("[3] Thumbnail exists — reusing")
    else:
        print("[3] Generating Grok Aurora thumbnail...")
        grok_thumbnail(spec["title"], thumbnail, config)

    # 4. Stock footage — ALWAYS loop to full voice duration + 5s buffer
    if stock_loop.exists():
        loop_dur = voice_duration(str(stock_loop))
        if loop_dur >= dur:
            print(f"[4] Looped stock exists ({loop_dur:.1f}s) — reusing")
        else:
            stock_loop.unlink()
            print("[4] Looped stock too short — regenerating")
    if not stock_loop.exists():
        if not stock_raw.exists():
            print("[4] Fetching stock footage from Pexels...")
            if not fetch_stock(spec.get("stock_query", "technology"), str(stock_raw), config):
                # Dark background fallback
                run(f"ffmpeg -y -f lavfi -i color=c=0x0a0a1a:s=1080x1920:d={dur+10} "
                    f"-pix_fmt yuv420p {stock_raw}")
        # Scale to 1080x1920
        if not stock_s.exists():
            run(f"ffmpeg -y -i {stock_raw} -vf 'scale=1080:1920:force_original_aspect_ratio=increase,"
                f"crop=1080:1920' -an -pix_fmt yuv420p {stock_s}")
        # Loop to cover full duration
        loops_needed = int((dur + 10) / max(1, voice_duration(str(stock_s)))) + 2
        loop_list = d / "loop_list.txt"
        loop_list.write_text(f"file '{stock_s}'\n" * loops_needed)
        run(f"ffmpeg -y -f concat -safe 0 -i {loop_list} "
            f"-t {dur + 5} -c copy {stock_loop}")
        print(f"  Stock looped: {voice_duration(str(stock_loop)):.1f}s")

    # 5. Thumbnail card (0.25s)
    if not thumb_card.exists():
        run(f"ffmpeg -y -loop 1 -i {thumbnail} -t 0.25 -vf 'scale=1080:1920' "
            f"-pix_fmt yuv420p -r 30 {thumb_card}")

    # 6. Assemble — NO -shortest, explicit -t to prevent truncation
    print("[5] Assembling final video...")
    concat_txt.write_text(f"file '{thumb_card}'\nfile '{stock_loop}'\n")
    ass_arg = f'-vf "ass={ass_file}"' if ass_file.exists() else ""
    run(f"ffmpeg -y -f concat -safe 0 -i {concat_txt} -i {voice_file} "
        f"{ass_arg} "
        f"-c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k "
        f"-t {total_dur} -pix_fmt yuv420p {final}")

    if not final.exists():
        print(f"  FAILED: no final.mp4")
        return None, None

    size_mb = final.stat().st_size / 1024 / 1024
    actual_dur = voice_duration(str(final))
    print(f"  DONE: {size_mb:.1f}MB, {actual_dur:.1f}s")

    # Copy to youtube dir for upload
    import shutil
    yt_mp4  = Path(f"/opt/secondbrain/data/youtube/{vid_id}.mp4")
    yt_thumb = Path(f"/opt/secondbrain/data/youtube/{vid_id}_thumb.jpg")
    shutil.copy2(str(final), str(yt_mp4))
    if thumbnail.exists():
        shutil.copy2(str(thumbnail), str(yt_thumb))
    print(f"  Copied to youtube dir: {yt_mp4}")

    return str(final), str(thumbnail)


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    config = load_config()
    queue  = json.loads(QUEUE_PATH.read_text()) if QUEUE_PATH.exists() else {"videos": []}
    manifest = load_manifest()

    target_id = sys.argv[1] if len(sys.argv) > 1 else None

    built = []
    failed = []
    for spec in queue.get("videos", []):
        vid_id = spec["id"]
        if target_id and target_id != vid_id:
            continue

        # Skip if already successfully built and final.mp4 is fresh
        final_path = WORK_DIR / vid_id / "final.mp4"
        if final_path.exists() and not os.environ.get("FORCE_REBUILD"):
            print(f"[{vid_id}] final.mp4 exists — skipping (set FORCE_REBUILD=1 to override)")
            built.append(vid_id)
            continue

        try:
            video_path, thumb_path = build_video(spec, config)
            if video_path:
                manifest[vid_id] = {
                    "title": spec["title"],
                    "channel": spec["channel"],
                    "video": video_path,
                    "thumbnail": thumb_path,
                    "built_at": __import__("datetime").datetime.utcnow().isoformat(),
                }
                built.append(vid_id)
            else:
                failed.append(vid_id)
        except Exception as e:
            print(f"  EXCEPTION building {vid_id}: {e}")
            failed.append(vid_id)

    save_manifest(manifest)

    print(f"\n{'='*60}")
    print(f"DONE: {len(built)} built, {len(failed)} failed")
    for b in built:
        print(f"  OK:   {b}")
    for f in failed:
        print(f"  FAIL: {f}")
    print(f"{'='*60}")
