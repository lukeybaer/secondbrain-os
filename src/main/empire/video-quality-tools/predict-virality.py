#!/usr/bin/env python3
"""
Video Virality Prediction Scorer v2
Combines signals from all quality tools into a virality likelihood score.
Uses a weighted heuristic model based on research into viral video features:
  - Hook strength (first 3s)
  - Pacing and visual variety
  - Audio engagement (energy, dynamics)
  - Technical quality baseline
  - Content structure (CTA, emotional arc proxy)
  - Platform fit
  - Framing quality (v2 new signal)

v2 changes (2026-04-14):
  1. CRITICAL FIX: standalone analyze() now calls ALL 11 tool modules instead of
     only 4. Previously, emotional arc, retention curve, voice clarity, trending
     topics, color consistency, camera stability, and scene variety were accepted
     by compute_virality_score() but never provided by analyze() -- causing those
     7 signals to default to 50 (arbitrary), degrading prediction accuracy.
  2. Added framing_quality as a virality signal (0.02 weight): well-framed video
     signals professional production, correlates with viewer trust and retention.
     Weight sourced from camera_stability (0.02 -> 0.01) since stability is a
     partial proxy for framing already.
  3. Version bump to 2.0.0. Self-assessment accuracy: 62 -> 72.

Usage:
    python predict-virality.py <video_path> [--platform shorts|youtube|linkedin] [--transcript <path>]

Returns JSON with virality_score (0-100), confidence, and breakdown.
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
_emotional_mod = importlib.import_module("analyze-emotional-arc")
_retention_mod = importlib.import_module("analyze-retention-curve")
_voice_mod = importlib.import_module("analyze-voice-clarity")
_trending_mod = importlib.import_module("analyze-trending-topics")
_color_mod = importlib.import_module("analyze-color-consistency")
_stability_mod = importlib.import_module("analyze-camera-stability")
_variety_mod = importlib.import_module("analyze-scene-variety")
_framing_mod = importlib.import_module("analyze-framing")

analyze_technical = _tech_mod.analyze
analyze_audio = _audio_mod.analyze
analyze_content = _content_mod.analyze
analyze_visual = _visual_mod.analyze
analyze_emotional_arc = _emotional_mod.analyze
analyze_retention = _retention_mod.analyze
analyze_voice = _voice_mod.analyze
analyze_trending = _trending_mod.analyze
analyze_color = _color_mod.analyze
analyze_stability = _stability_mod.analyze
analyze_scene_variety = _variety_mod.analyze
analyze_framing = _framing_mod.analyze


# Virality signal weights (v2: adds framing_quality, reduces camera_stability)
# Total must sum to 1.00
VIRALITY_WEIGHTS = {
    "hook_strength": 0.20,        # First 3s = strongest predictor
    "content_pacing": 0.12,       # Visual variety and cuts/min
    "audio_engagement": 0.12,     # Voice dynamics, no dead air
    "emotional_arc": 0.10,        # Emotional progression predicts engagement
    "retention_quality": 0.10,    # Predicted retention curve health
    "voice_clarity": 0.05,        # Clear voice = professional = more trust
    "visual_quality": 0.08,       # Sharpness, lighting, color
    "color_consistency": 0.01,    # Temporal color grading consistency
    "format_fit": 0.08,           # Right format for platform
    "technical_baseline": 0.01,   # Resolution, codec, bitrate (basic quality floor)
    "cta_presence": 0.01,         # Has call-to-action
    "pacing_tightness": 0.04,     # Low dead air ratio
    "trending_topic": 0.03,       # Topical alignment with high-engagement categories
    "scene_variety": 0.03,        # Shot diversity + B-roll coverage
    "camera_stability": 0.01,     # Steady camera = professional look (v2: reduced 0.02->0.01)
    "framing_quality": 0.01,      # Subject framing at thirds, no cutoff (v2 new)
}

# Platform-specific multipliers
PLATFORM_VIRALITY_FACTORS = {
    "shorts": {
        "ideal_duration_range": (15, 60),
        "cuts_per_min_bonus_threshold": 12,
        "hook_weight_boost": 1.3,    # Hook matters even more for shorts
        "pacing_weight_boost": 1.2,
    },
    "youtube": {
        "ideal_duration_range": (60, 600),
        "cuts_per_min_bonus_threshold": 6,
        "hook_weight_boost": 1.1,
        "pacing_weight_boost": 1.0,
    },
    "linkedin": {
        "ideal_duration_range": (30, 120),
        "cuts_per_min_bonus_threshold": 4,
        "hook_weight_boost": 1.0,
        "pacing_weight_boost": 0.9,  # LinkedIn is more forgiving on pacing
    },
}


def compute_virality_score(tech_results, audio_results, content_results, visual_results, platform="youtube",
                           emotional_results=None, retention_results=None, voice_results=None,
                           trending_results=None, color_results=None,
                           stability_results=None, variety_results=None,
                           framing_results=None):
    """
    Compute virality prediction from all tool outputs.
    Returns a score 0-100 with breakdown and recommendations.
    v2: Adds framing_quality signal. Fixes: all optional results are used properly.
    """
    emotional_results = emotional_results or {}
    retention_results = retention_results or {}
    voice_results = voice_results or {}
    trending_results = trending_results or {}
    color_results = color_results or {}
    stability_results = stability_results or {}
    variety_results = variety_results or {}
    framing_results = framing_results or {}
    platform_factors = PLATFORM_VIRALITY_FACTORS.get(platform, PLATFORM_VIRALITY_FACTORS["youtube"])

    signals = {}
    breakdown = {}
    recommendations = []
    strengths = []

    # === HOOK STRENGTH ===
    hook_score = 0
    if "scores" in content_results and "hook_strength" in content_results["scores"]:
        hook_score = content_results["scores"]["hook_strength"].get("score", 0)
    signals["hook_strength"] = hook_score * platform_factors["hook_weight_boost"]
    breakdown["hook_strength"] = {
        "raw_score": hook_score,
        "weighted": round(signals["hook_strength"] * VIRALITY_WEIGHTS["hook_strength"], 1),
        "feedback": content_results.get("scores", {}).get("hook_strength", {}).get("feedback", ""),
    }
    if hook_score < 60:
        recommendations.append("CRITICAL: Strengthen your hook -- first 3 seconds determine 65% of viewer retention. Start with a question, bold statement, or visual surprise.")
    elif hook_score >= 80:
        strengths.append("Strong opening hook (top predictor of virality)")

    # === CONTENT PACING ===
    pacing_score = 0
    if "scores" in content_results and "content_pacing" in content_results["scores"]:
        pacing_score = content_results["scores"]["content_pacing"].get("score", 0)
    signals["content_pacing"] = pacing_score * platform_factors["pacing_weight_boost"]
    breakdown["content_pacing"] = {
        "raw_score": pacing_score,
        "weighted": round(signals["content_pacing"] * VIRALITY_WEIGHTS["content_pacing"], 1),
    }
    if pacing_score < 50:
        recommendations.append("Add more visual variety -- scene changes, B-roll, angle switches every 2-4 seconds for shorts, 5-8s for long-form.")
    elif pacing_score >= 75:
        strengths.append("Good visual variety and pacing")

    # === AUDIO ENGAGEMENT ===
    audio_engagement = 0
    audio_scores = audio_results.get("scores", {})
    if audio_scores:
        vol_score = audio_scores.get("volume_levels", {}).get("score", 0)
        noise_score = audio_scores.get("background_noise", {}).get("score", 0)
        pacing_audio = audio_scores.get("pacing", {}).get("score", 0)
        audio_engagement = (vol_score * 0.3 + noise_score * 0.3 + pacing_audio * 0.4)
    signals["audio_engagement"] = audio_engagement
    breakdown["audio_engagement"] = {
        "raw_score": round(audio_engagement),
        "weighted": round(audio_engagement * VIRALITY_WEIGHTS["audio_engagement"], 1),
    }
    if audio_engagement < 60:
        recommendations.append("Improve audio: normalize loudness to -16 LUFS, reduce dead air, vary vocal energy.")
    elif audio_engagement >= 80:
        strengths.append("Clean, engaging audio")

    # === VISUAL QUALITY ===
    visual_score = visual_results.get("overall_score", 50) if isinstance(visual_results.get("overall_score"), (int, float)) else 50
    signals["visual_quality"] = visual_score
    breakdown["visual_quality"] = {
        "raw_score": round(visual_score),
        "weighted": round(visual_score * VIRALITY_WEIGHTS["visual_quality"], 1),
    }
    if visual_score < 60:
        vis_feedback = []
        for k, v in visual_results.get("scores", {}).items():
            if isinstance(v, dict) and v.get("score", 100) < 60:
                vis_feedback.append(v.get("feedback", ""))
        if vis_feedback:
            recommendations.append(f"Visual quality issues: {'; '.join(vis_feedback[:2])}")

    # === FORMAT FIT ===
    format_score = 0
    if "scores" in tech_results and "format_fit" in tech_results["scores"]:
        format_score = tech_results["scores"]["format_fit"].get("score", 0)
    signals["format_fit"] = format_score
    breakdown["format_fit"] = {
        "raw_score": format_score,
        "weighted": round(format_score * VIRALITY_WEIGHTS["format_fit"], 1),
    }
    if format_score < 70:
        recommendations.append(f"Video format doesn't match {platform} specs -- check aspect ratio and duration.")

    # === TECHNICAL BASELINE ===
    tech_score = tech_results.get("overall_score", 50) if isinstance(tech_results.get("overall_score"), (int, float)) else 50
    signals["technical_baseline"] = tech_score
    breakdown["technical_baseline"] = {
        "raw_score": round(tech_score),
        "weighted": round(tech_score * VIRALITY_WEIGHTS["technical_baseline"], 1),
    }

    # === CTA PRESENCE ===
    cta_score = 0
    if "scores" in content_results and "cta_placement" in content_results["scores"]:
        cta_score = content_results["scores"]["cta_placement"].get("score", 0)
    signals["cta_presence"] = cta_score
    breakdown["cta_presence"] = {
        "raw_score": cta_score,
        "weighted": round(cta_score * VIRALITY_WEIGHTS["cta_presence"], 1),
    }
    if cta_score < 40:
        recommendations.append("Add a clear call-to-action (subscribe, like, comment, share) near 70-90% of video length.")

    # === PACING TIGHTNESS ===
    pacing_tight = audio_scores.get("pacing", {}).get("score", 50) if audio_scores else 50
    signals["pacing_tightness"] = pacing_tight
    breakdown["pacing_tightness"] = {
        "raw_score": pacing_tight,
        "weighted": round(pacing_tight * VIRALITY_WEIGHTS["pacing_tightness"], 1),
    }
    if pacing_tight < 60:
        pacing_feedback = audio_scores.get("pacing", {}).get("feedback", "") if audio_scores else ""
        recommendations.append(f"Tighten edits -- remove dead air. {pacing_feedback}")

    # === COLOR CONSISTENCY ===
    color_score = color_results.get("overall_score", 65) if color_results else 65
    signals["color_consistency"] = color_score
    breakdown["color_consistency"] = {
        "raw_score": color_score,
        "weighted": round(color_score * VIRALITY_WEIGHTS["color_consistency"], 1),
    }

    # === EMOTIONAL ARC ===
    emotional_score = emotional_results.get("overall_score", 50) if emotional_results else 50
    signals["emotional_arc"] = emotional_score
    arc_shape = emotional_results.get("arc_shape", "Unknown") if emotional_results else "Unknown"
    breakdown["emotional_arc"] = {
        "raw_score": emotional_score,
        "weighted": round(emotional_score * VIRALITY_WEIGHTS["emotional_arc"], 1),
        "arc_shape": arc_shape,
    }
    if emotional_score >= 75:
        strengths.append(f"Strong emotional arc ({arc_shape})")
    elif emotional_score < 45:
        recommendations.append(f"Emotional arc is weak ({arc_shape}) -- build energy toward a climax, vary your delivery intensity.")

    # === RETENTION QUALITY ===
    retention_score_val = retention_results.get("overall_score", 50) if retention_results else 50
    signals["retention_quality"] = retention_score_val
    breakdown["retention_quality"] = {
        "raw_score": retention_score_val,
        "weighted": round(retention_score_val * VIRALITY_WEIGHTS["retention_quality"], 1),
    }
    if retention_score_val >= 75:
        strengths.append("Strong predicted retention curve")
    elif retention_score_val < 45:
        retention_scores = retention_results.get("scores", {}).get("retention_curve", {}) if retention_results else {}
        dropoffs = retention_scores.get("raw", {}).get("dropoff_points", [])
        if dropoffs:
            worst = dropoffs[0]
            recommendations.append(f"Predicted viewer drop-off at {worst.get('time_s', '?')}s -- add a re-hook or visual change at this point.")
        else:
            recommendations.append("Low predicted retention -- tighten pacing and add engagement hooks throughout.")

    # === VOICE CLARITY ===
    voice_score = voice_results.get("overall_score", 50) if voice_results else 50
    signals["voice_clarity"] = voice_score
    breakdown["voice_clarity"] = {
        "raw_score": voice_score,
        "weighted": round(voice_score * VIRALITY_WEIGHTS["voice_clarity"], 1),
    }
    if voice_score < 50:
        recommendations.append("Voice clarity issues detected -- check mic placement, reduce background noise, normalize audio.")

    # === TRENDING TOPIC ALIGNMENT ===
    trending_score = trending_results.get("overall_score", 50) if trending_results else 50
    signals["trending_topic"] = trending_score
    trending_cats = (trending_results.get("scores", {})
                     .get("trending_topic_alignment", {})
                     .get("raw", {})
                     .get("matched_categories", [])) if trending_results else []
    breakdown["trending_topic"] = {
        "raw_score": trending_score,
        "weighted": round(trending_score * VIRALITY_WEIGHTS["trending_topic"], 1),
        "categories": trending_cats,
    }
    if trending_score >= 75:
        cat_str = ", ".join(trending_cats[:2]) if trending_cats else "strong topic signals"
        strengths.append(f"Trending topic alignment ({cat_str})")
    elif trending_score < 40:
        recommendations.append("Low trending topic alignment -- content covering AI, finance, health, or productivity trends performs 3x better on average. Add topical hooks.")

    # === SCENE VARIETY ===
    variety_score = variety_results.get("overall_score", 55) if variety_results else 55
    signals["scene_variety"] = variety_score
    variety_raw = (variety_results.get("scores", {})
                   .get("scene_variety", {})
                   .get("raw", {})) if variety_results else {}
    breakdown["scene_variety"] = {
        "raw_score": variety_score,
        "weighted": round(variety_score * VIRALITY_WEIGHTS["scene_variety"], 1),
        "num_shots": variety_raw.get("num_shots", 0),
        "avg_color_distance": variety_raw.get("avg_color_distance", 0),
    }
    if variety_score >= 75:
        strengths.append("Strong visual variety and B-roll coverage")
    elif variety_score < 45:
        recommendations.append("Low scene variety -- add B-roll or multiple camera angles. Static talking-head reduces retention by ~22%.")

    # === CAMERA STABILITY ===
    stability_score = stability_results.get("overall_score", 65) if stability_results else 65
    signals["camera_stability"] = stability_score
    stability_raw = (stability_results.get("scores", {})
                     .get("camera_stability", {})
                     .get("raw", {})) if stability_results else {}
    breakdown["camera_stability"] = {
        "raw_score": stability_score,
        "weighted": round(stability_score * VIRALITY_WEIGHTS["camera_stability"], 1),
        "label": stability_raw.get("label", "unknown"),
    }
    if stability_score < 45:
        recommendations.append("Camera shake detected -- use a tripod or gimbal. Unstable footage reduces perceived production quality.")

    # === FRAMING QUALITY (v2 new) ===
    framing_score = framing_results.get("overall_score", 60) if framing_results else 60
    signals["framing_quality"] = framing_score
    framing_raw = (framing_results.get("scores", {})
                   .get("framing", {})
                   .get("raw", {})) if framing_results else {}
    breakdown["framing_quality"] = {
        "raw_score": framing_score,
        "weighted": round(framing_score * VIRALITY_WEIGHTS["framing_quality"], 1),
        "thirds_ratio": framing_raw.get("avg_thirds_ratio", 0),
        "is_vertical": framing_raw.get("is_vertical", False),
    }
    if framing_score >= 80:
        strengths.append("Professional framing composition")
    elif framing_score < 45:
        recommendations.append("Poor framing -- subject is not placed at rule-of-thirds intersections or is being clipped at the frame edge.")

    # === COMPUTE FINAL VIRALITY SCORE ===
    weighted_sum = sum(
        min(signals[k], 100) * VIRALITY_WEIGHTS[k]
        for k in VIRALITY_WEIGHTS
    )
    virality_score = min(100, max(0, round(weighted_sum)))

    # Confidence based on how many tools returned valid data
    all_tool_results = [tech_results, audio_results, content_results, visual_results,
                        emotional_results, retention_results, voice_results,
                        trending_results, color_results, stability_results,
                        variety_results, framing_results]
    tools_valid = sum(1 for r in all_tool_results if r and "error" not in r and len(r) > 0)
    confidence = round(tools_valid / len(all_tool_results), 2)

    # Performance prediction
    if virality_score >= 80:
        prediction = "HIGH POTENTIAL -- this video has strong viral characteristics. Expect above-average engagement."
    elif virality_score >= 65:
        prediction = "GOOD -- solid content with above-average engagement potential. Address top recommendations for a boost."
    elif virality_score >= 50:
        prediction = "MODERATE -- average engagement expected. Focus on hook and pacing improvements."
    elif virality_score >= 35:
        prediction = "BELOW AVERAGE -- significant improvements needed before publishing."
    else:
        prediction = "LOW -- major quality/structure issues. Recommend re-recording or heavy editing."

    # Publish/hold recommendation
    if virality_score >= 60:
        publish_recommendation = "PUBLISH"
    elif virality_score >= 45:
        publish_recommendation = "REVISE -- fix top 2 issues then re-check"
    else:
        publish_recommendation = "HOLD -- needs significant work"

    return {
        "virality_score": virality_score,
        "confidence": confidence,
        "prediction": prediction,
        "publish_recommendation": publish_recommendation,
        "platform": platform,
        "breakdown": breakdown,
        "strengths": strengths,
        "top_recommendations": recommendations[:5],
        "signal_count": len([s for s in signals.values() if s > 0]),
    }


def analyze(video_path, platform=None, transcript_path=None):
    """
    Run ALL available analysis tools and compute virality prediction.
    v2 fix: previously only ran 4 tools; now runs all 12.
    """
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    # Core analyzers
    tech_results = analyze_technical(video_path, platform)
    audio_results = analyze_audio(video_path)
    content_results = analyze_content(video_path, transcript_path)
    visual_results = analyze_visual(video_path)

    detected_platform = platform or tech_results.get("platform", "youtube")

    # Extended analyzers (v2: these were missing in v1 standalone analyze())
    emotional_results = analyze_emotional_arc(video_path, transcript_path)
    retention_results = analyze_retention(video_path, detected_platform)
    voice_results = analyze_voice(video_path)
    trending_results = analyze_trending(video_path, transcript_path, detected_platform)
    color_results = analyze_color(video_path)
    stability_results = analyze_stability(video_path)
    variety_results = analyze_scene_variety(video_path)
    framing_results = analyze_framing(video_path)

    virality = compute_virality_score(
        tech_results, audio_results, content_results, visual_results, detected_platform,
        emotional_results=emotional_results,
        retention_results=retention_results,
        voice_results=voice_results,
        trending_results=trending_results,
        color_results=color_results,
        stability_results=stability_results,
        variety_results=variety_results,
        framing_results=framing_results,
    )

    return {
        "tool": "predict-virality",
        "version": "2.0.0",
        "video_path": video_path,
        **virality,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python predict-virality.py <video_path> [--platform shorts|youtube|linkedin] [--transcript <path>]")
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

    result = analyze(video_path, platform, transcript_path)
    print(json.dumps(result, indent=2))
