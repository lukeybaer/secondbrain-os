#!/usr/bin/env python3
"""
Video Quality Check Runner v6
Runs all quality analysis tools on a video and produces a combined report
including visual quality, thumbnail analysis, virality prediction,
emotional arc analysis, retention curve prediction, voice clarity,
framing/composition, music mix balance, caption readability,
trending topic alignment, hashtag relevance, color consistency,
camera stability, audio dynamics/mastering quality, and scene variety.

Usage:
    python run-quality-check.py <video_path> [--platform shorts|youtube|linkedin]
        [--transcript <path>] [--thumbnail <path>] [--srt-file <path>]
        [--hashtags "#tag1 #tag2"] [--no-platform-analysis]

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
_framing_mod = importlib.import_module("analyze-framing")
_music_mod = importlib.import_module("analyze-music-mix")
_caption_mod = importlib.import_module("analyze-caption-readability")
_trending_mod = importlib.import_module("analyze-trending-topics")
_hashtag_mod = importlib.import_module("analyze-hashtag-relevance")
_color_mod = importlib.import_module("analyze-color-consistency")
_stability_mod = importlib.import_module("analyze-camera-stability")
_dynamics_mod = importlib.import_module("analyze-audio-dynamics")
_variety_mod = importlib.import_module("analyze-scene-variety")

analyze_technical = _tech_mod.analyze
analyze_audio = _audio_mod.analyze
analyze_content = _content_mod.analyze
analyze_visual = _visual_mod.analyze
analyze_thumb = _thumb_mod.analyze
compute_virality_score = _virality_mod.compute_virality_score
analyze_emotional_arc = _emotional_mod.analyze
analyze_retention = _retention_mod.analyze
analyze_voice = _voice_mod.analyze
analyze_framing = _framing_mod.analyze
analyze_music_mix = _music_mod.analyze
analyze_captions = _caption_mod.analyze
analyze_trending = _trending_mod.analyze
analyze_hashtags = _hashtag_mod.analyze
analyze_color = _color_mod.analyze
analyze_stability = _stability_mod.analyze
analyze_audio_dynamics = _dynamics_mod.analyze
analyze_scene_variety = _variety_mod.analyze


def run_all(video_path, platform=None, transcript_path=None, thumbnail_path=None, srt_file=None, hashtags_str=None):
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

    # v3 analyzers
    emotional_results = analyze_emotional_arc(video_path, transcript_path)
    retention_results = analyze_retention(video_path, detected_platform)
    voice_results = analyze_voice(video_path)

    # v4 analyzers: framing, music mix, caption readability
    framing_results = analyze_framing(video_path)
    music_results = analyze_music_mix(video_path)
    caption_results = analyze_captions(video_path, srt_file)

    # v5 analyzers: trending topics, hashtag relevance, color consistency
    trending_results = analyze_trending(video_path, transcript_path, detected_platform)
    hashtag_results = analyze_hashtags(video_path, transcript_path, detected_platform, hashtags_str)
    color_results = analyze_color(video_path)

    # v6 analyzers: camera stability, audio dynamics, scene variety
    stability_results = analyze_stability(video_path)
    dynamics_results = analyze_audio_dynamics(video_path)
    variety_results = analyze_scene_variety(video_path)

    # Virality prediction (v2: now passes all tool results including framing)
    virality = compute_virality_score(
        tech_results, audio_results, content_results, visual_results, detected_platform,
        emotional_results=emotional_results, retention_results=retention_results,
        voice_results=voice_results, trending_results=trending_results,
        color_results=color_results,
        stability_results=stability_results, variety_results=variety_results,
        framing_results=framing_results,
    )

    # Combine all scores
    all_result_sets = [
        tech_results, audio_results, content_results, visual_results, thumb_results,
        emotional_results, retention_results, voice_results,
        framing_results, music_results, caption_results,
        trending_results, hashtag_results, color_results,
        stability_results, dynamics_results, variety_results,
    ]
    all_scores = {}
    for result_set in all_result_sets:
        if "scores" in result_set:
            all_scores.update(result_set["scores"])

    # Category averages -- audio includes voice clarity + music mix
    audio_overall = audio_results.get("overall_score", 0)
    voice_score = voice_results.get("overall_score", 0)
    music_score = music_results.get("overall_score", 0)
    audio_combined = round(
        (audio_overall * 0.5 + voice_score * 0.3 + music_score * 0.2), 1
    ) if voice_score > 0 or music_score > 0 else audio_overall

    # Content includes emotional arc, retention, and scene variety
    content_overall = content_results.get("overall_score", 0)
    emotional_score = emotional_results.get("overall_score", 0)
    retention_score = retention_results.get("overall_score", 0)
    variety_score = variety_results.get("overall_score", 0)
    content_combined = round((content_overall * 0.35 + emotional_score * 0.25 + retention_score * 0.25 + variety_score * 0.15), 1)

    # Visual includes framing + color consistency + camera stability
    visual_overall = visual_results.get("overall_score", 0)
    framing_score = framing_results.get("overall_score", 0)
    color_score = color_results.get("overall_score", 0)
    stability_score = stability_results.get("overall_score", 0)
    visual_combined = round((visual_overall * 0.55 + framing_score * 0.18 + color_score * 0.12 + stability_score * 0.15), 1)

    # Technical includes caption readability + audio dynamics
    technical_overall = tech_results.get("overall_score", 0)
    caption_score = caption_results.get("overall_score", 0)
    dynamics_score = dynamics_results.get("overall_score", 0)
    technical_combined = round((technical_overall * 0.55 + caption_score * 0.25 + dynamics_score * 0.20), 1)

    # Platform includes trending topic + hashtag relevance
    trending_score = trending_results.get("overall_score", 0)
    hashtag_score = hashtag_results.get("overall_score", 0)
    platform_combined = round((trending_score * 0.6 + hashtag_score * 0.4), 1) if trending_score or hashtag_score else 50

    category_scores = {
        "technical": round(technical_combined, 1),
        "audio": audio_combined,
        "content": content_combined,
        "visual": round(visual_combined, 1),
        "thumbnail": round(thumb_results.get("overall_score", 0), 1),
        "emotional_arc": round(emotional_score, 1),
        "retention": round(retention_score, 1),
        "voice_clarity": round(voice_score, 1),
        "framing": round(framing_score, 1),
        "music_mix": round(music_score, 1),
        "caption_readability": round(caption_score, 1),
        "trending_topic_alignment": round(trending_score, 1),
        "hashtag_relevance": round(hashtag_score, 1),
        "color_consistency": round(color_score, 1),
        "platform": round(platform_combined, 1),
        "camera_stability": round(stability_score, 1),
        "audio_dynamics": round(dynamics_score, 1),
        "scene_variety": round(variety_score, 1),
    }

    # Weighted overall (matching rubric weights: platform 0.15 now computed, not assumed 50)
    weights = {"technical": 0.15, "audio": 0.25, "content": 0.20, "visual": 0.25, "platform": 0.15}
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
            framing_results.get("tool", "unknown"),
            music_results.get("tool", "unknown"),
            caption_results.get("tool", "unknown"),
            trending_results.get("tool", "unknown"),
            hashtag_results.get("tool", "unknown"),
            color_results.get("tool", "unknown"),
            "predict-virality",
        stability_results.get("tool", "unknown"),
        dynamics_results.get("tool", "unknown"),
        variety_results.get("tool", "unknown"),
        ],
        "warnings": [],
    }

    for result_set in all_result_sets:
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

    # Add v3 analysis details
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

    # Add v4 analysis details
    report["framing"] = {
        "score": framing_score,
        "raw": framing_results.get("scores", {}).get("framing", {}).get("raw", {}),
    }
    report["music_mix"] = {
        "score": music_score,
        "raw": music_results.get("scores", {}).get("music_mix", {}).get("raw", {}),
    }
    report["captions"] = {
        "score": caption_score,
        "subtitle_streams": caption_results.get("subtitle_streams_found", 0),
        "cues_parsed": caption_results.get("cues_parsed", 0),
    }

    # v6 analysis details
    report["camera_stability"] = {
        "score": stability_score,
        "raw": stability_results.get("scores", {}).get("camera_stability", {}).get("raw", {}),
    }
    report["audio_dynamics"] = {
        "score": dynamics_score,
        "raw": dynamics_results.get("scores", {}).get("audio_dynamics", {}).get("raw", {}),
    }
    report["scene_variety"] = {
        "score": variety_score,
        "raw": variety_results.get("scores", {}).get("scene_variety", {}).get("raw", {}),
    }

    # v5 analysis details
    report["trending_topics"] = {
        "score": trending_score,
        "matched_categories": trending_results.get("scores", {}).get("trending_topic_alignment", {}).get("raw", {}).get("matched_categories", []),
        "engagement_signals": trending_results.get("scores", {}).get("trending_topic_alignment", {}).get("raw", {}).get("engagement_signals", []),
    }
    report["hashtags"] = {
        "score": hashtag_score,
        "suggested": hashtag_results.get("suggested_hashtags", []),
        "strategy": hashtag_results.get("hashtag_strategy", {}),
    }
    report["color_consistency"] = {
        "score": color_score,
        "raw": color_results.get("scores", {}).get("color_grading", {}).get("raw", {}),
    }

    return report


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python run-quality-check.py <video_path> [--platform shorts|youtube|linkedin] [--transcript <path>] [--thumbnail <path>] [--srt-file <path>]")
        sys.exit(1)

    video_path = sys.argv[1]
    platform = None
    transcript_path = None
    thumbnail_path = None
    srt_file = None
    hashtags_str = None

    if "--platform" in sys.argv:
        idx = sys.argv.index("--platform")
        if idx + 1 < len(sys.argv):
            platform = sys.argv[idx + 1]

    if "--transcript" in sys.argv:
        idx = sys.argv.index("--transcript")
        if idx + 1 < len(sys.argv):
            transcript_path = sys.argv[idx + 1]

    if "--thumbnail" in sys.argv:
        idx = sys.argv.index("--thumbnail")
        if idx + 1 < len(sys.argv):
            thumbnail_path = sys.argv[idx + 1]

    if "--srt-file" in sys.argv:
        idx = sys.argv.index("--srt-file")
        if idx + 1 < len(sys.argv):
            srt_file = sys.argv[idx + 1]

    if "--hashtags" in sys.argv:
        idx = sys.argv.index("--hashtags")
        if idx + 1 < len(sys.argv):
            hashtags_str = sys.argv[idx + 1]

    result = run_all(video_path, platform, transcript_path, thumbnail_path, srt_file, hashtags_str)
    print(json.dumps(result, indent=2))
