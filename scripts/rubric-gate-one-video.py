#!/usr/bin/env python3
"""
rubric-gate-one-video.py -- transcribe (if needed) then run video_aurora
through the rubric gate, then update the manifest.

Used by scripts/run-rubric-gate-on-rejected.js to process one video at
a time. Idempotent: if the video already has a transcript and the
manifest is already pending_approval, it's a no-op.

Usage:
    python rubric-gate-one-video.py --id mit_30_agents_v2
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "content-review" / "pending"
MANIFEST = PENDING / "manifest.json"
TRANSCRIBE = ROOT / "src" / "main" / "empire" / "transcribe_word_level.py"
VIDEO_AURORA = ROOT / "src" / "main" / "empire" / "video_aurora.py"


def load_manifest():
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def save_manifest(m):
    MANIFEST.write_text(json.dumps(m, indent=2), encoding="utf-8")


def find_video(m, video_id):
    for v in m.get("videos", []):
        if v.get("id") == video_id:
            return v
    return None


def ensure_transcript(video):
    transcript_file = video.get("transcript_file")
    if not transcript_file:
        transcript_file = f"{video['id']}_transcript.json"
        video["transcript_file"] = transcript_file
    transcript_path = PENDING / transcript_file
    if transcript_path.exists() and transcript_path.stat().st_size > 100:
        return {"ok": True, "path": str(transcript_path), "skipped": True}
    source = PENDING / video["video_file"]
    if not source.exists():
        return {"ok": False, "reason": f"source mp4 missing: {source}"}
    print(f"[transcribe] {source.name} -> {transcript_path.name}", flush=True)
    r = subprocess.run(
        [sys.executable, str(TRANSCRIBE), "--source", str(source), "--out", str(transcript_path)],
        capture_output=True, text=True, timeout=600,
    )
    if r.returncode != 0:
        return {"ok": False, "reason": f"transcribe failed: {(r.stderr or r.stdout or '')[-500:]}"}
    try:
        return {"ok": True, "path": str(transcript_path), "result": json.loads(r.stdout)}
    except Exception:
        return {"ok": True, "path": str(transcript_path), "raw_stdout": r.stdout[:200]}


def run_rubric_gate(video):
    transcript = PENDING / video["transcript_file"]
    thumb = PENDING / video["thumbnail_file"] if video.get("thumbnail_file") else None
    source = PENDING / video["video_file"]
    out = PENDING / video["video_file"]
    cmd = [
        sys.executable, str(VIDEO_AURORA),
        "--id", video["id"],
        "--title", video.get("title", video["id"]),
        "--channel", video.get("channel", "AILifeHacksByExampleCoyExampleCo"),
        "--source", str(source),
        "--transcript", str(transcript),
        "--out", str(out),
        "--rubric-gate",
        "--platform", "shorts",
        "--max-iterations", "2",
    ]
    if thumb and thumb.exists():
        cmd += ["--thumb", str(thumb)]
    print(f"[rubric-gate] {video['id']} ...", flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    out_text = (r.stdout or "").strip()
    if not out_text:
        return {"ok": False, "reason": f"video_aurora empty stdout (exit {r.returncode}): {(r.stderr or '')[-500:]}"}
    try:
        return json.loads(out_text)
    except Exception as e:
        return {"ok": False, "reason": f"video_aurora output unparseable: {e}: {out_text[-500:]}"}


def update_manifest(video, gate_result):
    if gate_result.get("ok") and gate_result.get("rubric_pass"):
        from datetime import datetime, timezone
        video["status"] = "pending_approval"
        video["regen_status"] = "rubric_passed"
        video["video_needs_regen"] = False
        video["rubric_pass_at"] = datetime.now(timezone.utc).isoformat()
        rubric = gate_result.get("rubric", {})
        video["rubric_overall_score"] = rubric.get("overall_score")
        video["rubric_virality_score"] = rubric.get("virality_score")
        video["rubric_scores"] = rubric.get("scores")
    else:
        video["status"] = "video_rejected"
        video["regen_status"] = "pending_higher_bar"
        video["video_needs_regen"] = True
        rubric = gate_result.get("rubric", {})
        video["rubric_failed"] = rubric.get("failed", [])
        video["rubric_scores"] = rubric.get("scores", {})
        video["rubric_error"] = rubric.get("error")


def main(argv):
    p = argparse.ArgumentParser()
    p.add_argument("--id", required=True)
    args = p.parse_args(argv[1:])
    m = load_manifest()
    video = find_video(m, args.id)
    if not video:
        print(json.dumps({"ok": False, "reason": f"video {args.id} not in manifest"}, indent=2))
        return 1

    if video.get("status") == "pending_approval":
        print(json.dumps({"ok": True, "skipped": True, "reason": f"{args.id} already pending_approval"}, indent=2))
        return 0

    t_step = ensure_transcript(video)
    if not t_step.get("ok"):
        print(json.dumps({"ok": False, "stage": "transcribe", **t_step}, indent=2))
        return 1

    gate = run_rubric_gate(video)
    update_manifest(video, gate)
    save_manifest(m)
    summary = {
        "ok": gate.get("ok") and gate.get("rubric_pass"),
        "id": args.id,
        "status_now": video["status"],
        "rubric_overall": gate.get("rubric", {}).get("overall_score"),
        "failed_criteria": [f.get("name") for f in gate.get("rubric", {}).get("failed", [])][:8],
    }
    print(json.dumps(summary, indent=2))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
