#!/usr/bin/env python3
"""seedance-broll.py — generate cinematic B-roll clips for stuck short-form
videos using ByteDance Seedance 2.0. Attacks feature backlog #77 (multi-shot
B-roll composition) and unblocks the "can't just show that one stock footage
the whole time" rejection pattern that has `anthropic_leak` and
`mit_30_agents_v2` stuck for 5 days in the daily diagnostic.

Pipeline:
  1. Read content-review/pending/manifest.json, pick videos where the
     rejection note mentions "stock footage", "on loop", "robot guy", "boring"
     (the stuck-B-roll signature).
  2. For each video, derive 4-6 shot prompts from the title + hook + beats.
  3. POST each prompt to the Seedance 2.0 endpoint (ByteDance Volcengine /
     Volcano Ark API: https://www.volcengine.com/docs/82379). Poll for the
     MP4 URL, download it, write to tmp/seedance-broll/<id>/<shot>.mp4.
  4. Emit a shot list JSON so the next editor pass (manual or automated) can
     splice them into the regen queue.

Env:
  SEEDANCE_API_KEY  — ByteDance Volcano Ark API key (required)
  SEEDANCE_MODEL    — default "seedance-2-0-pro" (override for cheaper runs)
  SEEDANCE_REGION   — default "ap-southeast-1"
  SEEDANCE_DRY_RUN  — if "1", only print the prompts without calling the API
"""

from __future__ import annotations

import json
import os
import sys
import time
import pathlib
import textwrap
import urllib.request
import urllib.error

REPO = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = REPO / "content-review" / "pending" / "manifest.json"
OUT_ROOT = REPO / "tmp" / "seedance-broll"
DEFAULT_MODEL = os.environ.get("SEEDANCE_MODEL", "seedance-2-0-pro")
REGION = os.environ.get("SEEDANCE_REGION", "ap-southeast-1")
API_BASE = f"https://ark.cn-beijing.volces.com/api/v3"  # Volcano Ark default

STUCK_SIGNATURE = ("stock footage", "on loop", "robot guy", "boring", "no music", "no visual")


def die(msg: str) -> None:
    print(f"[seedance-broll] {msg}", file=sys.stderr)
    sys.exit(1)


def load_manifest() -> dict:
    if not MANIFEST.exists():
        die(f"manifest missing: {MANIFEST}")
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def pick_stuck(manifest: dict) -> list[dict]:
    hits = []
    for v in manifest.get("videos", []):
        if not v.get("video_needs_regen"):
            continue
        note = (v.get("video_rejection_note") or "").lower()
        if any(sig in note for sig in STUCK_SIGNATURE):
            hits.append(v)
    return hits


def build_shot_prompts(video: dict) -> list[str]:
    """Derive 4-6 cinematic shot prompts from a stuck video. Designed to
    produce variety — talking-head alternatives, data viz, abstract
    technology shots — so the regen editor never has to reuse one clip."""
    title = video.get("title", "") or video.get("id", "")
    hook = video.get("hook") or video.get("subtitle") or ""
    base = f"{title}. {hook}".strip(". ").strip()
    shots = [
        f"Cinematic close-up of a glowing neural network morphing in ultra slow motion, shallow depth of field, 35mm, teal and orange grade, subject: {base}",
        f"Dolly shot over a futuristic data-center server rack with volumetric light shafts and particulate air, moody atmosphere, subject: {base}",
        f"Overhead macro of a circuit board with ripples of light tracing copper pathways, 120fps slow motion, subject: {base}",
        f"Side-light portrait of a focused engineer at a monitor, reflections in glasses, Roger Deakins style, subject: {base}",
        f"Abstract generative particles forming into a Claude-style waveform, Anthropic orange gradient, subtle motion blur, subject: {base}",
        f"Aerial shot of a neon skyline at dusk with data streams overlaid, Blade Runner palette, subject: {base}",
    ]
    return shots


def seedance_submit(prompt: str, api_key: str, model: str) -> str:
    body = json.dumps(
        {
            "model": model,
            "content": [{"type": "text", "text": prompt}],
            "parameters": {"aspect_ratio": "9:16", "duration": 5, "fps": 30},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}/contents/generations/tasks",
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = json.loads(r.read())
    task_id = payload.get("id") or payload.get("task_id")
    if not task_id:
        raise RuntimeError(f"Seedance API did not return a task id: {payload}")
    return task_id


def seedance_poll(task_id: str, api_key: str, timeout_s: int = 600) -> str:
    deadline = time.time() + timeout_s
    req_url = f"{API_BASE}/contents/generations/tasks/{task_id}"
    while time.time() < deadline:
        req = urllib.request.Request(
            req_url, headers={"Authorization": f"Bearer {api_key}"}
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = json.loads(r.read())
        status = payload.get("status", "").lower()
        if status in ("succeeded", "success", "completed"):
            return payload.get("content", {}).get("video_url") or payload.get("video_url")
        if status in ("failed", "error"):
            raise RuntimeError(f"Seedance task {task_id} failed: {payload}")
        time.sleep(5)
    raise TimeoutError(f"Seedance task {task_id} did not finish in {timeout_s}s")


def download(url: str, dest: pathlib.Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as r, dest.open("wb") as f:
        while chunk := r.read(1 << 16):
            f.write(chunk)


def main(argv: list[str]) -> int:
    dry_run = os.environ.get("SEEDANCE_DRY_RUN") == "1"
    api_key = os.environ.get("SEEDANCE_API_KEY", "")
    if not dry_run and not api_key:
        die("SEEDANCE_API_KEY is unset. Set it or run with SEEDANCE_DRY_RUN=1 to preview prompts.")

    manifest = load_manifest()
    if "--stuck-only" in argv:
        targets = pick_stuck(manifest)
    else:
        ids = [a for a in argv if not a.startswith("--")]
        by_id = {v["id"]: v for v in manifest.get("videos", [])}
        targets = [by_id[i] for i in ids if i in by_id]

    if not targets:
        die("no target videos (use --stuck-only or pass ids)")

    results = []
    for v in targets:
        vid = v["id"]
        out_dir = OUT_ROOT / vid
        out_dir.mkdir(parents=True, exist_ok=True)
        prompts = build_shot_prompts(v)
        (out_dir / "shot-list.json").write_text(
            json.dumps({"id": vid, "rejection": v.get("video_rejection_note"), "prompts": prompts}, indent=2)
        )
        print(f"[seedance-broll] {vid}: {len(prompts)} prompts authored -> {out_dir}")
        if dry_run:
            for i, p in enumerate(prompts):
                print(f"  shot-{i+1}: {textwrap.shorten(p, 140)}")
            results.append({"id": vid, "shots": len(prompts), "dry_run": True})
            continue
        shot_urls = []
        for i, prompt in enumerate(prompts):
            try:
                task_id = seedance_submit(prompt, api_key, DEFAULT_MODEL)
                video_url = seedance_poll(task_id, api_key)
                clip_path = out_dir / f"shot-{i+1:02d}.mp4"
                download(video_url, clip_path)
                shot_urls.append({"shot": i + 1, "path": str(clip_path), "url": video_url})
                print(f"  shot-{i+1:02d}: {clip_path.name} ({clip_path.stat().st_size} bytes)")
            except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError, TimeoutError) as e:
                print(f"  shot-{i+1:02d} FAILED: {e}", file=sys.stderr)
                shot_urls.append({"shot": i + 1, "error": str(e)})
        (out_dir / "render-log.json").write_text(json.dumps(shot_urls, indent=2))
        results.append({"id": vid, "shots": shot_urls, "dry_run": False})

    print(json.dumps({"generated": results}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
