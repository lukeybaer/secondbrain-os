#!/usr/bin/env python3
"""
build-from-plan.py

2026-05-26 ExampleCo: this is the DUMB executor for the new short-form
video pipeline. It reads a build plan JSON (emitted by
scripts/lib/plan-video-build.js) and runs ElevenLabs + Pexels + ffmpeg
mechanically. It has NO opinions, NO fallback heuristics, NO
hardcoded MUSIC_MAP, NO JESSICA_ID default. Every craft decision
comes from the plan; missing required fields fail fast with
MISSING_PLAN_FIELD.

Replaces the opinion-heavy `ec2-build-from-queue.py` for the regen
flow. The legacy path stays during the migration week (see
scripts/auto-regen-rejected-videos.js and the USE_PLANNER_PIPELINE
env flag).

CLI:
    python3 scripts/build-from-plan.py --plan <path-to-plan.json>

Exit codes:
    0  success: mp4 + thumbnail produced; manifest receipt written
    1  MISSING_PLAN_FIELD or MISSING_PLAN_ARG (caller did not provide
       a complete plan)
    2  asset missing: MUSIC_TRACK_MISSING, ELEVENLABS_AUTH, etc.
    3  ffmpeg / pipeline runtime failure

Manifest receipt: writes data/agent/build-receipts/<video_id>.json
with { used_plan_path, exit_status, asset_paths, started_at,
finished_at } so the orchestrator can audit what the executor did.

Contract pinned by tests/build-from-plan-executor.spec.ts.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
# Music library lives under empire/assets/sounds/ (the existing music
# library that ec2-build-from-queue.py's MUSIC_MAP referenced). Env override
# for tests: SECONDBRAIN_MUSIC_DIR.
ASSETS_MUSIC_DIR = Path(os.environ.get("SECONDBRAIN_MUSIC_DIR", str(REPO_ROOT / "empire" / "assets" / "sounds")))
WORK_DIR_ROOT = REPO_ROOT / "data" / "youtube" / "build-from-plan"
RECEIPTS_DIR = REPO_ROOT / "data" / "agent" / "build-receipts"


# ---------------------------------------------------------------------------
# Plan-field access: every required field flows through this helper. It is
# the only way to read a required field. Missing field fails fast.
# ---------------------------------------------------------------------------

def require_field(plan, name):
    """Read a required plan field. Exits non-zero with MISSING_PLAN_FIELD
    when the field is absent or None. There is no default, no fallback,
    no silent recovery; the plan must be complete."""
    if not isinstance(plan, dict):
        print(f"MISSING_PLAN_FIELD: plan is not a dict")
        sys.exit(1)
    if name not in plan or plan[name] is None:
        print(f"MISSING_PLAN_FIELD: {name}")
        sys.exit(1)
    return plan[name]


def optional_field(plan, name):
    """Read an optional plan field. Returns None when absent."""
    if not isinstance(plan, dict):
        return None
    return plan.get(name)


# ---------------------------------------------------------------------------
# Voice (ElevenLabs)
# ---------------------------------------------------------------------------

def generate_voice(voice_id, voice_model, script, out_path):
    """ElevenLabs TTS using EXACTLY the voice id from the plan.
    No JESSICA_ID default, no Polly fallback. If the env is missing
    or ElevenLabs returns non-2xx, exit 2 with the response body
    truncated."""
    try:
        import requests  # local import so the module is importable for tests
    except ImportError:
        print("MISSING_DEP: requests not installed")
        sys.exit(2)
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        # Try config file as a secondary key source.
        cfg_path = REPO_ROOT / "empire" / "config.json"
        if cfg_path.exists():
            try:
                cfg = json.loads(cfg_path.read_text())
                key = cfg.get("elevenlabs_api_key", "") or key
            except Exception:
                pass
    if not key:
        print("ELEVENLABS_AUTH: ELEVENLABS_API_KEY missing (env or empire-config.json)")
        sys.exit(2)
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    body = {
        "text": script,
        "model_id": voice_model,
        "voice_settings": {"stability": 0.40, "similarity_boost": 0.60, "style": 0.0, "use_speaker_boost": True},
    }
    r = requests.post(url, headers={"xi-api-key": key, "Content-Type": "application/json"}, json=body, timeout=120)
    if r.status_code != 200:
        print(f"ELEVENLABS_HTTP_{r.status_code}: {r.text[:300]}")
        sys.exit(2)
    Path(out_path).write_bytes(r.content)
    return out_path


# ---------------------------------------------------------------------------
# Stock (Pexels)
# ---------------------------------------------------------------------------

def fetch_stock(query, out_path):
    try:
        import requests
    except ImportError:
        print("MISSING_DEP: requests not installed")
        sys.exit(2)
    key = os.environ.get("PEXELS_API_KEY", "")
    if not key:
        cfg_path = REPO_ROOT / "empire" / "config.json"
        if cfg_path.exists():
            try:
                cfg = json.loads(cfg_path.read_text())
                key = cfg.get("pexels_api_key", "") or key
            except Exception:
                pass
    if not key:
        print("PEXELS_AUTH: PEXELS_API_KEY missing")
        sys.exit(2)
    r = requests.get(
        f"https://api.pexels.com/videos/search?query={query}&per_page=5&orientation=portrait",
        headers={"Authorization": key},
        timeout=30,
    )
    if r.status_code != 200:
        print(f"PEXELS_HTTP_{r.status_code}: {r.text[:200]}")
        sys.exit(2)
    files = []
    for v in r.json().get("videos", []):
        for f in sorted(v.get("video_files", []), key=lambda x: x.get("height", 0), reverse=True):
            if f.get("height", 0) >= 1080:
                files.append(f.get("link"))
                break
    if not files:
        print(f"STOCK_QUERY_DRY: no Pexels result for query: {query}")
        sys.exit(2)
    data = requests.get(files[0], timeout=120).content
    Path(out_path).write_bytes(data)
    return out_path


# ---------------------------------------------------------------------------
# Music
# ---------------------------------------------------------------------------

def resolve_music_track(track_name):
    """Resolve plan.music.track relative to assets/music/. No fallback,
    no fuzzy match. Missing file is MUSIC_TRACK_MISSING (exit 2)."""
    if not isinstance(track_name, str) or not track_name.strip():
        print("MUSIC_TRACK_MISSING: empty or non-string track name")
        sys.exit(2)
    candidate = ASSETS_MUSIC_DIR / track_name
    if not candidate.exists():
        print(f"MUSIC_TRACK_MISSING: assets/music/{track_name}")
        sys.exit(2)
    return str(candidate)


# ---------------------------------------------------------------------------
# Captions and tags
# ---------------------------------------------------------------------------

def write_tags_ass(tags, voice_duration_s, out_path):
    """Render plan.tags into a fresh ASS file. Each tag fires at its
    declared t_s with a 2.0s visible duration and a small fade. No
    static template; the events come straight from the plan."""
    style = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: TagTitle,Impact,110,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,8,4,5,0,0,0,1\n"
        "Style: TagSub,Impact,60,&H00CCCCCC,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,6,4,5,0,0,0,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    def fmt_t(t):
        t = max(0.0, float(t))
        h = int(t // 3600)
        m = int((t % 3600) // 60)
        s = t - 60 * (m + 60 * h)
        return f"{h:01d}:{m:02d}:{s:05.2f}"

    events = []
    for tag in tags or []:
        if not isinstance(tag, dict):
            continue
        text = str(tag.get("text", "")).strip()
        subtitle = str(tag.get("subtitle", "")).strip()
        t_s = float(tag.get("t_s", 0.0))
        end = min(t_s + 2.0, max(voice_duration_s or t_s + 2.0, t_s + 0.5))
        if not text:
            continue
        title_event = f"Dialogue: 0,{fmt_t(t_s)},{fmt_t(end)},TagTitle,,0,0,0,,{{\\an5\\pos(540,500)\\fad(150,150)}}{text}"
        events.append(title_event)
        if subtitle:
            sub_event = f"Dialogue: 0,{fmt_t(t_s)},{fmt_t(end)},TagSub,,0,0,0,,{{\\an5\\pos(540,600)\\fad(150,150)}}{subtitle}"
            events.append(sub_event)

    Path(out_path).write_text(style + "\n".join(events) + "\n", encoding="utf-8")
    return out_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def voice_duration_s(audio_path):
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path)],
            capture_output=True, text=True, timeout=30,
        )
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def run_ffmpeg(args):
    r = subprocess.run(["ffmpeg", "-y", "-hide_banner", *args], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        print(f"FFMPEG_FAIL: {r.stderr[:400]}")
        sys.exit(3)


def assemble(plan, work_dir, voice_path, tags_ass_path, music_path, stock_files):
    """Concatenate stock clips, overlay tag ASS, mix voice + music. Output
    final.mp4 in work_dir. ffmpeg-only; no fancy fallback paths.

    2026-05-26 ExampleCo #learn: TTS duration cannot be perfectly predicted
    from script word count, so the planner's stock_clips coverage may
    fall short of the actual voice. Loop the stock concat to AT LEAST
    the voice duration so the audio never plays over a black screen.
    The final ffmpeg pass then trims with -t voice_duration so video
    and audio are exactly co-terminal."""
    # Stock concat. RE-ENCODE rather than -c copy: the individual stock
    # clips come from Pexels with varying codec params (fps, profile, color
    # space). -c copy preserves them and produces an mp4 where every clip
    # boundary has stream-state inconsistencies; the final mp4 then plays
    # back as "broken video stream" (video duration much less than audio
    # duration). Re-encode forces a clean single stream throughout.
    # 2026-05-26 ExampleCo #learn: short009 rebuild failed with video=19s but
    # audio=56s when -c copy was used. Re-encoding fixes it.
    concat_list = work_dir / "concat.txt"
    concat_list.write_text("\n".join(f"file '{p}'" for p in stock_files), encoding="utf-8")
    stock_concat = work_dir / "stock_concat.mp4"
    run_ffmpeg([
        "-f", "concat", "-safe", "0", "-i", str(concat_list),
        "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
        "-r", "30", "-an", str(stock_concat),
    ])

    # AV duration matching. If stock_concat is shorter than voice, loop it
    # via -stream_loop and re-encode so the output is a single clean stream.
    voice_dur = voice_duration_s(voice_path)
    stock_dur = voice_duration_s(stock_concat)
    if voice_dur > 0 and stock_dur > 0 and stock_dur < voice_dur - 0.1:
        loops_needed = max(2, int((voice_dur / stock_dur) + 1))
        stock_extended = work_dir / "stock_extended.mp4"
        run_ffmpeg([
            "-stream_loop", str(loops_needed - 1), "-i", str(stock_concat),
            "-t", f"{voice_dur + 0.5:.3f}",
            "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
            "-r", "30", "-an", str(stock_extended),
        ])
        stock_concat = stock_extended
        print(f"  AV-match: looped stock {loops_needed}x to cover voice ({voice_dur:.1f}s)")

    # Mix voice + music (duck music under voice)
    duck_db = float(require_field(plan["music"], "duck_db"))
    mixed_audio = work_dir / "mixed_audio.m4a"
    run_ffmpeg([
        "-i", str(voice_path), "-i", str(music_path),
        "-filter_complex",
        f"[1:a]volume={duck_db}dB[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[a]",
        "-map", "[a]", "-c:a", "aac", "-b:a", "192k", str(mixed_audio),
    ])

    # Overlay tag ASS onto stock concat with mixed audio. Trim to the
    # voice duration so video and audio are exactly co-terminal (no
    # trailing black screen, no audio cut off mid-sentence).
    final = work_dir / "final.mp4"
    trim_t = f"{voice_dur:.3f}" if voice_dur and voice_dur > 0 else None
    base_args = ["-i", str(stock_concat), "-i", str(mixed_audio)]
    if trim_t:
        base_args = ["-i", str(stock_concat), "-i", str(mixed_audio), "-t", trim_t]
    if tags_ass_path and Path(tags_ass_path).exists() and any(plan.get("tags") or []):
        run_ffmpeg([
            *base_args,
            "-vf", f"ass={tags_ass_path}",
            "-c:v", "libx264", "-c:a", "copy",
            "-map", "0:v:0", "-map", "1:a:0",
            str(final),
        ])
    else:
        print("INFO: no tags in plan; skipping tag overlay layer")
        run_ffmpeg([
            *base_args,
            "-c:v", "copy", "-c:a", "copy",
            "-map", "0:v:0", "-map", "1:a:0",
            str(final),
        ])
    return final


def write_receipt(video_id, plan_path, exit_status, assets, started_at, finished_at):
    RECEIPTS_DIR.mkdir(parents=True, exist_ok=True)
    receipt = {
        "video_id": video_id,
        "used_plan_path": str(plan_path),
        "exit_status": exit_status,
        "asset_paths": assets,
        "started_at": started_at,
        "finished_at": finished_at,
    }
    (RECEIPTS_DIR / f"{video_id}.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Build a short-form video from a structured plan JSON")
    parser.add_argument("--plan", required=True, help="Path to the plan JSON file (MISSING_PLAN_ARG when absent)")
    args = parser.parse_args()

    plan_path = Path(args.plan)
    if not plan_path.exists():
        print(f"MISSING_PLAN_ARG: plan file does not exist: {plan_path}")
        sys.exit(1)

    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"PLAN_PARSE_FAIL: {e}")
        sys.exit(1)

    # Required fields. Every read goes through require_field so missing
    # fields fail fast with MISSING_PLAN_FIELD.
    plan_version = require_field(plan, "plan_version")
    if plan_version != "1.0":
        print(f"MISSING_PLAN_FIELD: plan_version must be \"1.0\" (got {plan_version!r})")
        sys.exit(1)
    video_id = require_field(plan, "video_id")
    channel = require_field(plan, "channel")
    voice = require_field(plan, "voice")
    script = require_field(plan, "script")
    captions = require_field(plan, "captions")
    stock_clips = require_field(plan, "stock_clips")
    music = require_field(plan, "music")
    animations = require_field(plan, "animations")
    _reflections_addressed = require_field(plan, "reflections_addressed")
    _plan_confidence = require_field(plan, "plan_confidence")

    voice_id = require_field(voice, "id")
    voice_model = require_field(voice, "model")
    music_track = require_field(music, "track")
    density = require_field(animations, "density")  # used for downstream layers
    emphasis_color = require_field(captions, "emphasis_color")
    _emphasis_indices = require_field(captions, "emphasis_word_indices")

    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    work_dir = WORK_DIR_ROOT / video_id
    work_dir.mkdir(parents=True, exist_ok=True)

    # 1. Voice
    voice_path = work_dir / "voice.mp3"
    print(f"[1] Voice via ElevenLabs {voice_id} ({voice_model})...")
    generate_voice(voice_id, voice_model, script, voice_path)
    vdur = voice_duration_s(voice_path)
    print(f"    duration {vdur:.2f}s")

    # 2. Music
    print(f"[2] Music: assets/music/{music_track}")
    music_path = resolve_music_track(music_track)

    # 3. Stock clips
    print(f"[3] Stock clips: {len(stock_clips)} entries")
    stock_files = []
    for i, clip in enumerate(stock_clips):
        q = require_field(clip, "query")
        t_in = require_field(clip, "t_in_s")
        t_out = require_field(clip, "t_out_s")
        dur = float(t_out) - float(t_in)
        raw = work_dir / f"stock_raw_{i}.mp4"
        trimmed = work_dir / f"stock_clip_{i}.mp4"
        fetch_stock(q, raw)
        run_ffmpeg([
            "-i", str(raw), "-t", f"{dur:.3f}",
            "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
            "-c:v", "libx264", "-an", str(trimmed),
        ])
        stock_files.append(str(trimmed))

    # 4. Tags ASS (optional; skip overlay when absent or empty)
    tags = plan.get("tags") or []
    tags_ass = None
    if tags:
        print(f"[4] Tags ASS: {len(tags)} tag(s) (emphasis color {emphasis_color}, density {density})")
        tags_ass = work_dir / "tags.ass"
        write_tags_ass(tags, vdur, tags_ass)
    else:
        print(f"[4] No tags in plan; skip tag overlay layer (density {density})")

    # 5. Assemble
    print("[5] Assembling final mp4...")
    final = assemble(plan, work_dir, voice_path, tags_ass, music_path, stock_files)

    # 6. Thumbnail (optional layer; skip when plan.thumbnail absent)
    thumb_brief = plan.get("thumbnail")
    thumb_path = None
    if thumb_brief:
        print(f"[6] Thumbnail brief present: {thumb_brief.get('focal_subject', '')[:80]}")
        # Thumbnail rendering is delegated to scripts/thumbnail_aurora.py which
        # consumes plan.thumbnail. For this executor: just record the brief.
        thumb_path = work_dir / "thumbnail.brief.json"
        thumb_path.write_text(json.dumps(thumb_brief, indent=2), encoding="utf-8")
    else:
        print("[6] No thumbnail in plan; skipping thumbnail layer")

    finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_receipt(
        video_id, plan_path, 0,
        {
            "voice": str(voice_path),
            "music": str(music_path),
            "final_mp4": str(final),
            "tags_ass": str(tags_ass) if tags_ass else None,
            "thumbnail_brief": str(thumb_path) if thumb_path else None,
            "stock_clips": stock_files,
        },
        started_at, finished_at,
    )
    print(f"DONE video={video_id} -> {final}")


if __name__ == "__main__":
    main()
