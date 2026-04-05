#!/usr/bin/env python3
"""
Regenerate thumbnails using Grok Aurora and rebuild both videos.
Fixes: truncated MP4 (moov atom missing), basic PIL-only thumbnails.
"""
import json, requests, subprocess, sys, textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

WORK_DIR = Path("/opt/secondbrain/data/youtube/build")
CONFIG = json.loads(Path("/opt/secondbrain/empire/config.json").read_text())
XAI_KEY = CONFIG.get("xai_api_key", "")
FONT_PATH = "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"
W, H = 1080, 1920

# ── Grok Aurora Background ─────────────────────────────────────────────────

def generate_bg(prompt, out_path):
    """Generate cinematic background via Grok Aurora (xAI)."""
    print(f"  Generating Grok Aurora background...")
    r = requests.post("https://api.x.ai/v1/images/generations",
        headers={"Authorization": f"Bearer {XAI_KEY}", "Content-Type": "application/json"},
        json={"model": "grok-imagine-image", "prompt": prompt, "n": 1}, timeout=60)
    r.raise_for_status()
    data = r.json()
    img_url = data["data"][0]["url"]
    img_data = requests.get(img_url, headers={"Authorization": f"Bearer {XAI_KEY}"}, timeout=30).content
    Path(out_path).write_bytes(img_data)
    print(f"  Background saved: {out_path} ({len(img_data)} bytes)")
    return out_path

def scale_crop(img, w=W, h=H):
    ratio = max(w / img.width, h / img.height)
    new_w, new_h = int(img.width * ratio), int(img.height * ratio)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left, top = (new_w - w) // 2, (new_h - h) // 2
    return img.crop((left, top, left + w, top + h))

def build_thumbnail(bg_path, out_path, headline, subline=""):
    """Composite text over Grok Aurora background."""
    img = Image.open(bg_path).convert("RGB")
    img = scale_crop(img)
    draw = ImageDraw.Draw(img)

    # Dark gradient overlay for text readability
    overlay = Image.new("RGBA", (W, 900), (0, 0, 0, 0))
    ov_draw = ImageDraw.Draw(overlay)
    for y in range(900):
        alpha = int(180 * (1 - y / 900))
        ov_draw.line([(0, y), (W, y)], fill=(0, 0, 0, alpha))
    img = img.convert("RGBA")
    img.alpha_composite(overlay, (0, 0))
    img = img.convert("RGB")
    draw = ImageDraw.Draw(img)

    try:
        font_h = ImageFont.truetype(FONT_PATH, 110)
        font_s = ImageFont.truetype(FONT_PATH, 72)
    except:
        font_h = ImageFont.load_default()
        font_s = font_h

    # Split headline into 2 lines
    words = headline.split()
    if len(words) <= 3:
        lines = [headline]
    else:
        mid = len(words) // 2
        lines = [" ".join(words[:mid]), " ".join(words[mid:])]

    y = 320
    for line in lines:
        # Stroke outline
        draw.text((W // 2, y), line, font=font_h, fill="black",
                  stroke_width=8, stroke_fill="black", anchor="mm")
        draw.text((W // 2, y), line, font=font_h, fill="white", anchor="mm")
        bbox = draw.textbbox((0, 0), line, font=font_h)
        y += (bbox[3] - bbox[1]) + 20

    if subline:
        wrapped = textwrap.wrap(subline, width=20)
        sy = y + 25
        for sline in wrapped:
            draw.text((W // 2, sy), sline, font=font_s, fill="black",
                      stroke_width=6, stroke_fill="black", anchor="mm")
            draw.text((W // 2, sy), sline, font=font_s, fill="#FFD700", anchor="mm")
            bbox = draw.textbbox((0, 0), sline, font=font_s)
            sy += (bbox[3] - bbox[1]) + 12

    img.save(str(out_path), "JPEG", quality=95)
    print(f"  Thumbnail: {out_path} ({Path(out_path).stat().st_size // 1024}KB)")

# ── Video definitions ──────────────────────────────────────────────────────

VIDEOS = {
    "mit_30_agents_v2": {
        "headline": "MIT Tested 30 AI Agents",
        "subline": "Every Single One Failed",
        "bg_prompt": "Cinematic dark futuristic AI laboratory with glowing red warning screens and failed test results, dramatic lighting, cyberpunk aesthetic, 9:16 portrait",
    },
    "anthropic_leak": {
        "headline": "512,000 Lines Leaked",
        "subline": "Anthropic's Worst Day",
        "bg_prompt": "Dramatic hacker scene with cascading green code on dark screens, data breach visualization, cinematic lighting, glowing terminals, 9:16 portrait",
    },
}

# ── Rebuild video ──────────────────────────────────────────────────────────

def rebuild_video(vid_id, spec):
    d = WORK_DIR / vid_id
    d.mkdir(parents=True, exist_ok=True)

    thumb = d / "thumbnail.jpg"
    bg = d / "thumb_bg.jpg"
    voice = d / "voice_human.mp3"
    ass_file = d / "captions.ass"
    stock_scaled = d / "stock_scaled.mp4"
    thumb_card = d / "thumb_card.mp4"
    concat_list = d / "concat.txt"
    final = d / "final.mp4"

    print(f"\n{'='*60}")
    print(f"Rebuilding: {vid_id}")
    print(f"{'='*60}")

    # 1. Generate Grok Aurora thumbnail
    print("[1/3] Generating Grok Aurora thumbnail...")
    generate_bg(spec["bg_prompt"], str(bg))
    build_thumbnail(str(bg), str(thumb), spec["headline"], spec["subline"])

    # 2. Verify prerequisites exist
    if not voice.exists():
        print(f"  ERROR: {voice} not found — need voice audio")
        return None, None
    if not ass_file.exists():
        print(f"  ERROR: {ass_file} not found — need captions")
        return None, None
    if not stock_scaled.exists():
        print(f"  ERROR: {stock_scaled} not found — need stock footage")
        return None, None

    # 3. Get duration
    probe = subprocess.run(f"ffprobe -v quiet -show_entries format=duration -of csv=p=0 {voice}",
                          shell=True, capture_output=True, text=True)
    voice_dur = float(probe.stdout.strip() or "30")
    total_dur = voice_dur + 0.25
    print(f"  Voice: {voice_dur:.1f}s, Total: {total_dur:.1f}s")

    # 4. Rebuild 0.25s thumbnail card
    print("[2/3] Creating thumbnail card...")
    subprocess.run(f"ffmpeg -y -loop 1 -i {thumb} -t 0.25 -vf 'scale=1080:1920' "
                   f"-pix_fmt yuv420p -r 30 {thumb_card}",
                   shell=True, capture_output=True, timeout=30)

    # 5. Assemble final video with captions
    print("[3/3] Assembling video (this takes ~5 min)...")
    concat_list.write_text(f"file '{thumb_card}'\nfile '{stock_scaled}'\n")

    result = subprocess.run(
        f"ffmpeg -y -f concat -safe 0 -i {concat_list} -i {voice} "
        f"-vf \"ass={ass_file}\" "
        f"-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "
        f"-t {total_dur} -shortest -pix_fmt yuv420p -movflags +faststart {final}",
        shell=True, capture_output=True, text=True, timeout=600
    )

    if result.returncode != 0:
        print(f"  FFMPEG ERROR: {result.stderr[-500:]}")
        return None, None

    if final.exists():
        size_mb = final.stat().st_size / (1024 * 1024)
        print(f"  DONE: {final} ({size_mb:.1f} MB)")

        # Copy to upload dir
        import shutil
        dest_video = f"/opt/secondbrain/data/youtube/{vid_id}.mp4"
        dest_thumb = f"/opt/secondbrain/data/youtube/{vid_id}_thumb.jpg"
        shutil.copy2(str(final), dest_video)
        shutil.copy2(str(thumb), dest_thumb)
        return dest_video, dest_thumb
    else:
        print("  FAILED: No output")
        return None, None

# ── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    results = {}
    for vid_id, spec in VIDEOS.items():
        video, thumb = rebuild_video(vid_id, spec)
        if video:
            results[vid_id] = {"video": video, "thumbnail": thumb}

    print(f"\n{'='*60}")
    print(f"REBUILD COMPLETE: {len(results)}/{len(VIDEOS)}")
    for vid_id, info in results.items():
        print(f"  {vid_id}: {info['video']}")
    print(f"{'='*60}")
