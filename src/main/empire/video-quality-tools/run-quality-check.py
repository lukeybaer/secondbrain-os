#!/usr/bin/env python3
"""
Video Quality Check Runner v3
Runs all quality analysis tools on a video and produces a combined report
including visual quality, thumbnail analysis, virality prediction,
emotional arc analysis, retention curve prediction, and voice clarity.

Usage:
    python run-quality-check.py <video_path> [--platform shorts|youtube|linkedin] [--transcript <path>] [--thumbnail <path>]

Returns a combined JSON report with all scores, virality prediction, and publish recommendation.
"""

import importlib
import json
import sys
import os

# Add tool dir to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import modules with hyphenated filenames via importlib
_tech_mod = importlib.import_module("analyze-technical-specs")
_audio_mod = importlib.import_module("analyze-audio-quality")
_content_mod = importlib.import_module("analyze-content-hooks")
_visual_mod = importlib.import_module("analyze-visual-quality")
_thumb_mod = importlib.import_module("analyze-thumbnail")
_virality_mod = importlib.import_module("predict-virality")
_emotional_mod = importlib.import_module("analyze-emotional-arc")
_retention_mod = importlib.import_module("analyze-retention-curve")
_voice_mod = importlib.import_module("analyze-voice-clarity")

analyze_technical = _tech_mod.analyze
analyze_audio = _audio_mod.analyze
analyze_content = _content_mod.analyze
analyze_visual = _visual_mod.analyze
analyze_thumb = _thumb_mod.analyze
compute_virality_score = _virality_mod.compute_virality_score
analyze_emotional_arc = _emotional_mod.analyze
analyze_retention = _retention_mod.analyze
analyze_voice = _voice_mod.analyze


def run_all(video_path, platform=None, transcript_path=None, thumbnail_path=None):
    """Run all quality tools and combine results."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    # Core analyzers
    tech_results = analyze_technical(video_path, platform)
    audio_results = analyze_audio(video_path)
    content_results = analyze_content(video_path, transcript_path)
    visual_results = analyze_visual(video_path)
    thumb_results = analyze_thumb(video_path, thumbnail_path)

    detected_platform = platform or tech_results.get("platform", "youtube")

    # New v3 analyzers
    emotional_results = analyze_emotional_arc(video_path, transcript_path)
    retention_results = analyze_retention(video_path, detected_platform)
    voice_results = analyze_voice(video_path)

    # Virality prediction (now includes emotional arc and retention signals)
    virality = compute_virality_score(
        tech_results, audio_results, content_results, visual_results, detected_platform,
        emotional_results=emotional_results, retention_results=retention_results,
        voice_results=voice_results,
    )

    # Combine all scores
    all_scores = {}
    for result_set in [tech_results, audio_results, content_results, visual_results, thumb_results, emotional_results, retention_results, voice_results]:
        if "scores" in result_set:
            all_scores.update(result_set["scores"])

    # Category averages (audio now includes voice clarity)
    audio_overall = audio_results.get("overall_score", 0)
    voice_score = voice_results.get("overall_score", 0)
    audio_combined = round((audio_overall * 0.6 + voice_score * 0.4), 1) if voice_score > 0 else audio_overall

    # Content now includes emotional arc and retention
    content_overall = content_results.get("overall_score", 0)
    emotional_score = emotional_results.get("overall_score", 0)
    retention_score = retention_results.get("overall_score", 0)
    content_combined = round((content_overall * 0.4 + emotional_score * 0.3 + retention_score * 0.3), 1)

    category_scores = {
        "technical": round(tech_results.get("overall_score", 0), 1),
        "audio": audio_combined,
        "content": content_combined,
        "visual": round(visual_results.get("overall_score", 0), 1),
        "thumbnail": round(thumb_results.get("overall_score", 0), 1),
        "emotional_arc": round(emotional_score, 1),
        "retention": round(retention_score, 1),
        "voice_clarity": round(voice_score, 1),
    }

    # Weighted overall (matching rubric weights)
    weights = {"technical": 0.15, "audio": 0.25, "content": 0.20, "visual": 0.25, "thumbnail": 0.15}
    weighted_total = sum(category_scores[k] * weights[k] for k in weights)
    max_weight = sum(weights.values())
    overall = round(weighted_total / max_weight, 1)

    report = {
        "video_path": video_path,
        "platform": detected_platform,
        "overall_score": overall,
        "virality_score": virality["virality_score"],
        "virality_prediction": virality["prediction"],
        "publish_recommendation": virality["publish_recommendation"],
        "category_scores": category_scores,
        "detailed_scores": all_scores,
        "virality_breakdown": virality["breakdown"],
        "virality_strengths": virality.get("strengths", []),
        "tools_run": [
            tech_results.get("tool", "unknown"),
            audio_results.get("tool", "unknown"),
            content_results.get("tool", "unknown"),
            visual_results.get("tool", "unknown"),
            thumb_results.get("tool", "unknown"),
            emotional_results.get("tool", "unknown"),
            retention_results.get("tool", "unknown"),
            voice_results.get("tool", "unknown"),
            "predict-virality",
        ],
        "warnings": [],
    }

    for result_set in [tech_results, audio_results, content_results, visual_results, thumb_results, emotional_results, retention_results, voice_results]:
        report["warnings"].extend(result_set.get("warnings", []))

    # Thumbnail best candidate info
    if "best_candidate" in thumb_results:
        report["thumbnail_recommendation"] = thumb_results["best_candidate"]

    # Generate top 5 improvement suggestions (sorted by lowest score)
    scored_items = [(k, v["score"], v.get("feedback", "")) for k, v in all_scores.items()]
    scored_items.sort(key=lambda x: x[1])
    report["top_improvements"] = [
        {"criterion": item[0], "score": item[1], "suggestion": item[2]}
        for item in scored_items[:5]
    ]

    # Add virality-specific recommendations
    report["virality_recommendations"] = virality.get("top_recommendations", [])

    # Add new v3 analysis details
    report["emotional_arc"] = {
        "shape": emotional_results.get("arc_shape", "unknown"),
        "score": emotional_results.get("overall_score", 0),
    }
    report["retention_prediction"] = {
        "initial_retention": retention_results.get("initial_retention_pct", 0),
        "score": retention_results.get("overall_score", 0),
        "curve_summary": retention_results.get("predicted_curve", [])[-1:],
    }
    report["voice_clarity"] = {
        "score": voice_results.get("overall_score", 0),
        "frequency_bands": voice_results.get("frequency_bands", {}),
    }

    return report


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python run-quality-check.py <video_path> [--platform shorts|youtube|linkedin] [--transcript <path>]")
        sys.exit(1)

    video_path = sys.argv[1]
    platform = None
    transcript_path = None

    if "--platform" in sys.argv:
        idx = sys.argv.index("--platform")
        if idx + 1 < len(sys.argv):
            platform = sys.argv[idx + 1]

    if "--transcript" in sys.argv:
        idx = sys.argv.index("--transcript")
        if idx + 1 < len(sys.argv):
            transcript_path = sys.argv[idx + 1]

    thumbnail_path = None
    if "--thumbnail" in sys.argv:
        idx = sys.argv.index("--thumbnail")
        if idx + 1 < len(sys.argv):
            thumbnail_path = sys.argv[idx + 1]

    result = run_all(video_path, platform, transcript_path, thumbnail_path)
    print(json.dumps(result, indent=2))
