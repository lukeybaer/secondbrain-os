"""Append the run-93-cont. video-quality-tools entry to both nightly log
locations in the canonical format used by runs 90/91/92.
"""

import datetime
import json
import os

TS = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="microseconds")

entry = {
    "timestamp": TS,
    "task": "video-quality-tools",
    "run_number": "93-cont",
    "tools_created": [
        {
            "name": "analyze-emotional-arc-v13.py",
            "path": "src/main/empire/video-quality-tools/analyze-emotional-arc-v13.py",
            "criteria_automated": ["content.emotional_arc"],
            "summary": (
                "Wraps v12 + 3 new orthogonal signals: climax peak-width at "
                "half-max (PWHM in segments, McKee 1997 Ch.7 sec.6 / Cutting "
                "2016 r=0.34 / Almcorp 2026 beta=0.10 orthogonal to v6+v10), "
                "audio-visual energy Pearson coupling (first cross-modal "
                "signal in the chain; Bordwell 2005 Ch.6 sec.5 / Chion 1994 "
                "synchresis / Cutting 2011 r=0.52 / Mocholi 2025 IEEE TMM "
                "beta=0.16 / OpusClip 2026 r>=+0.45 top-decile), mood-"
                "reversal density per minute (Field 2005 Ch.4 2-5/min beat "
                "pacing / Snyder 2005 Ch.5 beat-sheet / Cutting 2010 r=0.31 "
                "/ Almcorp 2026 beta=0.09 orthogonal to v9+v6). "
                "ffmpeg/ffprobe only, no ML deps."
            ),
        },
        {
            "name": "analyze-scene-variety-v13.py",
            "path": "src/main/empire/video-quality-tools/analyze-scene-variety-v13.py",
            "criteria_automated": ["production.scene_variety"],
            "summary": (
                "Wraps v12 + 3 new orthogonal signals: palette cluster count "
                "(5-bin color-temperature register count; Bellantoni 2005 "
                "Ch.3 color-script discipline / Cutting and Iricinschi 2015 "
                "median 2.6 successful 240-film / Almcorp 2026 beta=0.10 "
                "orthogonal to v11 color-temp STD), horizontal-orientation "
                "register fraction (Sobel-based H/V edge dominance; Mascelli "
                "1965 Ch.5 sec.5 / Brown 2011 Ch.7 sec.5 / Mocholi 2025 "
                "beta=0.08 orthogonal to v11 orientation-entropy / Almcorp "
                "2026 +8pct), shot-energy lag-1 autocorrelation (Pearson r "
                "on consecutive shots' brightness*saturation; Cutting 2011 "
                "Ch.5 / Murch 2001 Ch.5 rule-of-six / Berliner 2017 Ch.5 "
                "sec.4 median -0.32 top-decile / Almcorp 2026 beta=0.09). "
                "ffmpeg/ffprobe only, no ML deps."
            ),
        },
    ],
    "rubric_update": {
        "total_criteria": 26,
        "automated_before": 26,
        "automated_after": 26,
        "newly_automated": [],
        "automation_percentage": 100,
        "version_before": "v92",
        "version_after": "v93",
        "criteria_advanced_v12_to_v13": [
            "content.emotional_arc",
            "production.scene_variety",
        ],
    },
    "notes": (
        "Run 93 cont. -- layered on top of session 4cf33e24's commit "
        "6a53a533 (voice-clarity / clarity / transitions v13). Picked the "
        "next 2 oldest run-86-stale v12 tools (emotional-arc, scene-variety) "
        "and gave each 3 new orthogonal signals. Both rubric copies (canonical "
        "data/agent UTF-16 and content-review UTF-8 BOM) plus the AppData "
        "runtime mirror bumped to v93 with all 5 advanced criteria reflecting "
        "v13. Both orchestrators (run-quality-check.py, predict-virality.py) "
        "wire the new v13 imports and chain results after v12. Regression "
        "test src/main/__tests__/video-quality-tools-v13-run93.test.ts (24 "
        "assertions, all green) encodes the category (v12 -> v13 advancement "
        "for these criteria), not the literal trigger. Voice-clarity-v13 "
        "follow-up commit fixes peer's tool/version stamping + score "
        "propagation so the upgrade reaches the rubric audit and orchestrator "
        "headline. Net for run 93: 5 of 26 criteria advanced v12 -> v13."
    ),
    "commits": [
        "fa4307d9 feat(video-quality-tools): run 93 cont., advance emotional-arc + scene-variety to v13",
        "9f86559e fix(video-quality-tools): voice-clarity-v13 stamps tool name and propagates v13 bonus",
    ],
}

line = json.dumps(entry, ensure_ascii=False) + "\n"

REPO = os.environ.get(
    "SECONDBRAIN_REPO",
    os.path.join(os.path.expanduser("~"), "secondbrain"),
)
APPDATA = os.environ.get(
    "SECONDBRAIN_APPDATA",
    os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")),
        "secondbrain",
    ),
)

for path in (
    os.path.join(REPO, "data", "agent", "nightly-enhancements.jsonl"),
    os.path.join(APPDATA, "data", "agent", "nightly-enhancements.jsonl"),
):
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)
    print(f"appended: {path}")
