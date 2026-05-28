#!/usr/bin/env python3
"""
check-thumbnail-quality.py -- block blank/text-only thumbnails.

The 2026-04-26 mtime guard caught regen paths that lied about producing a new
file. The 2026-04-29 follow-up: regen paths that DID produce a new file but the
new file is still 96% black-with-text. Same defect, fourth occurrence.

Real Grok Aurora backgrounds have gradients, mid-tones, and bright highlights.
Black-with-text thumbnails have ~13/12/22 mean RGB and >60% near-black pixels
no matter how large the JPEG ends up (text rendering pads the file size past
the prior 200KB heuristic).

Pixel-statistic gate (no model, no API call, runs in <100ms):
  FAIL if pct_near_black > 50%  (true Grok backgrounds: <30%)
  FAIL if mean_luminance < 40   (mostly dark; real bg averages 60-200)
  FAIL if pct_bright < 4% AND mean_luminance < 60  (no real highlights)

Output: JSON to stdout. Exit 0 = pass, 1 = fail.
"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageStat, ImageChops  # type: ignore
except ImportError:
    print(json.dumps({"ok": False, "reason": "Pillow not installed", "metrics": {}}))
    sys.exit(2)


PCT_NEAR_BLACK_MAX = 50.0
MEAN_LUMINANCE_MIN = 40.0
PCT_BRIGHT_MIN_FALLBACK = 4.0
MEAN_LUMINANCE_FALLBACK = 60.0
NEAR_BLACK_THRESHOLD = 30
BRIGHT_THRESHOLD = 200
# Procedural template thumbnails (gold_money / navy_bold / etc. from
# src/main/empire/thumbnail_styles.py) draw symmetric backgrounds with
# centered text. Real photos and Grok Aurora cinematic backgrounds are NOT
# mirror-symmetric. Threshold calibrated against the 4 yellow-gradient
# thumbnails Luke rejected on 2026-04-29 (all 8.4-11.9) vs. the 3 known-
# good thumbnails (claude4_benchmark 33, kids_little_whale 33, kids_tiny_
# elephant 19). Cutoff at 14 puts a comfortable margin under the worst
# good case.
LR_MIRROR_MAE_MIN = 14.0


def analyze(path: Path) -> dict:
    if not path.exists():
        return {"ok": False, "reason": f"file missing: {path}", "metrics": {}}

    try:
        im = Image.open(path).convert("RGB")
    except Exception as e:
        return {"ok": False, "reason": f"cannot decode: {e}", "metrics": {}}

    gray = im.convert("L")
    hist = gray.histogram()
    total = sum(hist)
    if total == 0:
        return {"ok": False, "reason": "empty image", "metrics": {}}

    near_black = sum(hist[:NEAR_BLACK_THRESHOLD])
    bright = sum(hist[BRIGHT_THRESHOLD:])
    pct_near_black = 100.0 * near_black / total
    pct_bright = 100.0 * bright / total

    stat = ImageStat.Stat(gray)
    mean_lum = stat.mean[0]
    std_lum = stat.stddev[0]

    # Left/right mirror MAE: low when the image is procedurally generated
    # with a symmetric background and centered text (e.g. the gold_money
    # template), high when the image contains a real off-center subject.
    small = gray.resize((180, 320))
    w, h = small.size
    left = small.crop((0, 0, w // 2, h))
    right = small.crop((w // 2, 0, w, h)).transpose(Image.FLIP_LEFT_RIGHT)
    lr_mae = ImageStat.Stat(ImageChops.difference(left, right)).mean[0]

    metrics = {
        "size_kb": round(path.stat().st_size / 1024, 1),
        "width": im.width,
        "height": im.height,
        "mean_luminance": round(mean_lum, 1),
        "stddev_luminance": round(std_lum, 1),
        "pct_near_black": round(pct_near_black, 1),
        "pct_bright": round(pct_bright, 1),
        "lr_mirror_mae": round(lr_mae, 2),
    }

    if pct_near_black > PCT_NEAR_BLACK_MAX:
        return {
            "ok": False,
            "reason": f"blank thumbnail: {pct_near_black:.1f}% of pixels near-black "
            f"(threshold {PCT_NEAR_BLACK_MAX}%) -- background is missing",
            "metrics": metrics,
        }
    if mean_lum < MEAN_LUMINANCE_MIN:
        return {
            "ok": False,
            "reason": f"blank thumbnail: mean luminance {mean_lum:.1f} < {MEAN_LUMINANCE_MIN} "
            f"-- image is dominantly dark, no visible background",
            "metrics": metrics,
        }
    if pct_bright < PCT_BRIGHT_MIN_FALLBACK and mean_lum < MEAN_LUMINANCE_FALLBACK:
        return {
            "ok": False,
            "reason": f"blank thumbnail: only {pct_bright:.1f}% bright pixels with mean "
            f"luminance {mean_lum:.1f} -- no real highlights, likely text-on-black",
            "metrics": metrics,
        }
    if lr_mae < LR_MIRROR_MAE_MIN:
        return {
            "ok": False,
            "reason": f"procedural thumbnail: left/right mirror MAE {lr_mae:.1f} < "
            f"{LR_MIRROR_MAE_MIN} -- background is symmetric, this is a flat "
            f"template (gold_money / navy_bold / etc.) with centered title text, "
            f"not a Grok Aurora cinematic background. The EC2 generator "
            f"(make_thumbnail_v2 in src/main/empire/thumbnail_styles.py) is "
            f"using a procedural template, not a real image-gen pipeline.",
            "metrics": metrics,
        }

    return {
        "ok": True,
        "reason": f"thumbnail has real visual content (mean lum {mean_lum:.1f}, "
        f"near-black {pct_near_black:.1f}%, bright {pct_bright:.1f}%, "
        f"lr-mae {lr_mae:.1f})",
        "metrics": metrics,
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({"ok": False, "reason": "usage: check-thumbnail-quality.py <thumb.jpg>", "metrics": {}}))
        return 2
    path = Path(argv[1])
    result = analyze(path)
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
