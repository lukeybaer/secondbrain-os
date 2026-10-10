#!/usr/bin/env python3
"""
run-rubric-gate-on-rejected.py -- sequential pipeline runner for every
video_rejected entry in content-review/pending/manifest.json.

For each rejected video: transcribe if needed, run video_aurora through
the rubric gate, update manifest based on result. Sequential because
ffmpeg/Pexels/disk all bottleneck on shared resources -- running 6 in
parallel actually slows the whole batch.

Usage:
    python scripts/run-rubric-gate-on-rejected.py
        [--ids id1,id2]           # only these IDs
        [--dry-run]               # report what would run, no work
        [--limit N]               # stop after N successful promotions
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "content-review" / "pending"
MANIFEST = PENDING / "manifest.json"
ONE_VIDEO = ROOT / "scripts" / "rubric-gate-one-video.py"


def main(argv):
    p = argparse.ArgumentParser()
    p.add_argument("--ids", default="", help="Comma-separated whitelist of IDs")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--limit", type=int, default=0, help="Stop after N successful promotions")
    args = p.parse_args(argv[1:])

    m = json.loads(MANIFEST.read_text(encoding="utf-8"))
    rejected = [v for v in m.get("videos", []) if v.get("status") == "video_rejected"]
    if args.ids:
        whitelist = {x.strip() for x in args.ids.split(",") if x.strip()}
        rejected = [v for v in rejected if v.get("id") in whitelist]

    print(f"Found {len(rejected)} rejected videos", flush=True)
    for v in rejected:
        print(f"  - {v['id']}: {v.get('title', '?')[:60]}", flush=True)

    if args.dry_run:
        return 0

    promoted = 0
    failed = 0
    started = time.time()
    for v in rejected:
        if args.limit and promoted >= args.limit:
            print(f"--- limit hit ({args.limit} promoted) ---", flush=True)
            break
        vid = v["id"]
        print(f"\n=== {vid} ===", flush=True)
        t0 = time.time()
        r = subprocess.run(
            [sys.executable, str(ONE_VIDEO), "--id", vid],
            capture_output=True, text=True, timeout=4500,
        )
        elapsed = round(time.time() - t0, 1)
        out = (r.stdout or "").strip()
        try:
            summary = json.loads(out)
        except Exception:
            summary = {"ok": False, "raw": out[-300:], "stderr": (r.stderr or '')[-300:]}
        summary["elapsed_s"] = elapsed
        if summary.get("ok"):
            promoted += 1
            print(f"  PROMOTED in {elapsed}s -- overall {summary.get('rubric_overall')}", flush=True)
        else:
            failed += 1
            print(f"  FAILED in {elapsed}s -- failed criteria: {summary.get('failed_criteria')}", flush=True)
        print(json.dumps(summary, indent=2)[:1200], flush=True)

    total = round(time.time() - started, 1)
    print(f"\n=== Done. {promoted} promoted, {failed} failed, {total}s total ===")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
