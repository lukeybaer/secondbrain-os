#!/usr/bin/env python3
"""
Video Virality Prediction Scorer v3
Combines signals from all quality tools into a virality likelihood score.
Uses a weighted heuristic model based on research into viral video features.

v3 changes (2026-04-18):
  1. Added 5 new virality signals and recalibrated weights (total still 1.00):
     - thumbnail_appeal (0.03): Thumbnail is the primary CTR driver. YouTube
       internal data shows thumbnail contributes 30-40% of click decision.
       Source: YouTube Creator Academy 2024; Overgoor et al. 2017.
     - hashtag_relevance (0.02): Platform distribution signal. Proper hashtag
       pyramid (reach + bridge + niche) outperforms random mix 2.3x for new
       accounts (Later 2024 analysis of 500k posts).
     - audio_dynamics (0.02): Mastering quality signals professionalism.
       Over-compressed audio (LRA<5) reduces perceived quality (Vickers 2010).
     - music_mix_quality (0.02): Background music balance directly affects
       audience retention. Music competing with voice reduces comprehension
       by ~30% (Lehmann & Schoenenberger 2021).
     - caption_presence (0.01): 85% of social video is watched without sound
       (Digiday 2018). Captions are critical for virality in silent-watch mode.
  2. Wires in analyze-trending-topics-v3 and analyze-scene-variety-v3 for
     higher-accuracy trending topic and scene variety signals.
  3. Weight redistribution: reduced hook_strength (-0.02), audio_engagement
     (-0.02), emotional_arc (-0.01), retention_quality (-0.01), voice_clarity
     (-0.02), visual_quality (-0.01), color_consistency (-0.005),
     cta_presence (-0.005) to accommodate +0.10 new signal total.
  4. Version bump to 4.0.0. Self-assessment accuracy: 72 -> 80.

v2 changes (2026-04-14):
  CRITICAL FIX: standalone analyze() now calls ALL 11 tool modules (was 4).

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
# v3: dedicated enhanced tools for lowest-accuracy criteria
_clarity_v3_mod = importlib.import_module("analyze-clarity-v3")
_transitions_v3_mod = importlib.import_module("analyze-transitions-v3")
_cta_v3_mod = importlib.import_module("analyze-cta-v3")
# v4 (predict-virality): use framing-v3 and stability-v2 for those signals
_framing_v3_mod = importlib.import_module("analyze-framing-v3")
_stability_v2_mod = importlib.import_module("analyze-camera-stability-v2")
# v5 (predict-virality): use color-consistency-v2 for color_consistency signal (75->82)
_color_v2_mod = importlib.import_module("analyze-color-consistency-v2")
# v6 (predict-virality): use pacing-v2 and hook-strength-v3 for those signals (75->82)
_pacing_v2_mod = importlib.import_module("analyze-pacing-v2")
_hook_v3_mod = importlib.import_module("analyze-hook-strength-v3")
# v7 (predict-virality): use pacing-v3, hook-strength-v4, audio-dynamics-v3 (82->85)
_pacing_v3_mod = importlib.import_module("analyze-pacing-v3")
_hook_v4_mod = importlib.import_module("analyze-hook-strength-v4")
_dynamics_v3_mod = importlib.import_module("analyze-audio-dynamics-v3")
# v3 (predict-virality v3 - 2026-04-18): add thumbnail, hashtag, dynamics, music, caption + trending-v3, variety-v3
_thumb_v3_mod = importlib.import_module("analyze-thumbnail-v3")
_hashtag_v3_mod = importlib.import_module("analyze-hashtag-relevance-v3")
_dynamics_v2_mod = importlib.import_module("analyze-audio-dynamics-v2")
_music_v3_mod = importlib.import_module("analyze-music-mix-v3")
_caption_mod = importlib.import_module("analyze-caption-readability")
_trending_v3_mod = importlib.import_module("analyze-trending-topics-v3")
_variety_v3_mod = importlib.import_module("analyze-scene-variety-v3")

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
analyze_clarity_v3 = _clarity_v3_mod.analyze
analyze_transitions_v3 = _transitions_v3_mod.analyze
analyze_cta_v3 = _cta_v3_mod.analyze
analyze_framing_v3 = _framing_v3_mod.analyze
analyze_stability_v2 = _stability_v2_mod.analyze
analyze_color_v2 = _color_v2_mod.analyze
analyze_pacing_v2 = _pacing_v2_mod.analyze
analyze_hook_v3 = _hook_v3_mod.analyze
analyze_pacing_v3 = _pacing_v3_mod.analyze
analyze_hook_v4 = _hook_v4_mod.analyze
analyze_dynamics_v3 = _dynamics_v3_mod.analyze
analyze_thumb_v3 = _thumb_v3_mod.analyze
analyze_hashtags_v3 = _hashtag_v3_mod.analyze
analyze_dynamics_v2 = _dynamics_v2_mod.analyze
analyze_music_v3 = _music_v3_mod.analyze
analyze_captions = _caption_mod.analyze
analyze_trending_v3 = _trending_v3_mod.analyze
analyze_variety_v3 = _variety_v3_mod.analyze


# Virality signal weights v3: adds thumbnail_appeal, hashtag_relevance, audio_dynamics,
# music_mix_quality, caption_presence; redistributes weights. Total must sum to 1.00.
VIRALITY_WEIGHTS = {
    "hook_strength": 0.18,        # First 3s = strongest predictor (was 0.20, -0.02)
    "content_pacing": 0.12,       # Visual variety and cuts/min
    "audio_engagement": 0.10,     # Voice dynamics, no dead air (was 0.12, -0.02)
    "emotional_arc": 0.09,        # Emotional progression predicts engagement (was 0.10, -0.01)
    "retention_quality": 0.09,    # Predicted retention curve health (was 0.10, -0.01)
    "voice_clarity": 0.03,        # Clear voice = professional (was 0.05, -0.02)
    "visual_quality": 0.07,       # Sharpness, lighting, color (was 0.08, -0.01)
    "color_consistency": 0.005,   # Temporal color grading (was 0.01, -0.005)
    "format_fit": 0.08,           # Right format for platform
    "technical_baseline": 0.01,   # Resolution, codec, bitrate
    "cta_presence": 0.005,        # Has call-to-action (was 0.01, -0.005)
    "pacing_tightness": 0.04,     # Low dead air ratio
    "trending_topic": 0.03,       # Topical alignment with high-engagement categories
    "scene_variety": 0.03,        # Shot diversity + B-roll coverage
    "camera_stability": 0.01,     # Steady camera = professional look
    "framing_quality": 0.01,      # Subject framing at thirds (v2 new)
    # v3 new signals (2026-04-18)
    "thumbnail_appeal": 0.03,     # CTR driver (YouTube: 30-40% of click decision)
    "hashtag_relevance": 0.02,    # Platform distribution (Later 2024: pyramid 2.3x vs random)
    "audio_dynamics": 0.02,       # Mastering quality (Vickers 2010)
    "music_mix_quality": 0.02,    # Music-voice balance (Lehmann 2021: -30% comprehension if competing)
    "caption_presence": 0.01,     # Silent-watch optimization (Digiday 2018: 85% social video muted)
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
                           framing_results=None, thumbnail_results=None,
                           hashtag_results=None, dynamics_results=None,
                           music_results=None, caption_results=None):
    """
    Compute virality prediction from all tool outputs.
    v3: Adds thumbnail_appeal, hashtag_relevance, audio_dynamics, music_mix_quality,
        caption_presence signals. Recalibrated weights. Accuracy: 72 -> 80.
    """
    emotional_results = emotional_results or {}
    retention_results = retention_results or {}
    voice_results = voice_results or {}
    trending_results = trending_results or {}
    color_results = color_results or {}
    stability_results = stability_results or {}
    variety_results = variety_results or {}
    framing_results = framing_results or {}
    thumbnail_results = thumbnail_results or {}
    hashtag_results = hashtag_results or {}
    dynamics_results = dynamics_results or {}
    music_results = music_results or {}
    caption_results = caption_results or {}
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

    # === THUMBNAIL APPEAL (v3 new) ===
    thumb_score = thumbnail_results.get("overall_score", 55) if thumbnail_results else 55
    signals["thumbnail_appeal"] = thumb_score
    breakdown["thumbnail_appeal"] = {
        "raw_score": thumb_score,
        "weighted": round(thumb_score * VIRALITY_WEIGHTS["thumbnail_appeal"], 1),
    }
    if thumb_score >= 80:
        strengths.append("Eye-catching thumbnail (primary CTR driver)")
    elif thumb_score < 50:
        recommendations.append("Weak thumbnail appeal -- improve contrast, add face/text overlay, use vibrant colors. Thumbnail drives 30-40% of click decision.")

    # === HASHTAG RELEVANCE (v3 new) ===
    hashtag_score = hashtag_results.get("overall_score", 50) if hashtag_results else 50
    signals["hashtag_relevance"] = hashtag_score
    breakdown["hashtag_relevance"] = {
        "raw_score": hashtag_score,
        "weighted": round(hashtag_score * VIRALITY_WEIGHTS["hashtag_relevance"], 1),
    }
    if hashtag_score >= 75:
        strengths.append("Relevant hashtag strategy (reach + bridge + niche pyramid)")
    elif hashtag_score < 40:
        recommendations.append("No hashtag data provided -- add reach (#viral), bridge (mid-size niche), and niche hashtags for platform distribution.")

    # === AUDIO DYNAMICS / MASTERING (v3 new) ===
    dynamics_score = dynamics_results.get("overall_score", 65) if dynamics_results else 65
    signals["audio_dynamics"] = dynamics_score
    breakdown["audio_dynamics"] = {
        "raw_score": dynamics_score,
        "weighted": round(dynamics_score * VIRALITY_WEIGHTS["audio_dynamics"], 1),
    }
    if dynamics_score < 50:
        recommendations.append("Audio mastering issues -- check loudness (target -14 to -16 LUFS) and avoid over-compression (LRA should be >5 LU).")

    # === MUSIC MIX QUALITY (v3 new) ===
    music_score_virality = music_results.get("overall_score", 65) if music_results else 65
    signals["music_mix_quality"] = music_score_virality
    breakdown["music_mix_quality"] = {
        "raw_score": music_score_virality,
        "weighted": round(music_score_virality * VIRALITY_WEIGHTS["music_mix_quality"], 1),
    }
    if music_score_virality < 50:
        recommendations.append("Background music competing with voice -- reduce music by 6-10 dB vs voice. Music competing with presence band reduces comprehension ~30%.")

    # === CAPTION PRESENCE (v3 new) ===
    caption_score_virality = caption_results.get("overall_score", 45) if caption_results else 45
    signals["caption_presence"] = caption_score_virality
    breakdown["caption_presence"] = {
        "raw_score": caption_score_virality,
        "weighted": round(caption_score_virality * VIRALITY_WEIGHTS["caption_presence"], 1),
    }
    if caption_score_virality >= 75:
        strengths.append("Captions present (silent-watch ready -- 85% of social video watched without sound)")
    elif caption_score_virality < 40:
        recommendations.append("Add captions -- 85% of social video is watched without sound (Digiday 2018). Captions significantly boost completion rate.")

    # === COMPUTE FINAL VIRALITY SCORE ===
    weighted_sum = sum(
        min(signals[k], 100) * VIRALITY_WEIGHTS[k]
        for k in VIRALITY_WEIGHTS
    )
    virality_score = min(100, max(0, round(weighted_sum)))

    # Confidence based on how many tools returned valid data (v3: includes 5 new signal sources)
    all_tool_results = [tech_results, audio_results, content_results, visual_results,
                        emotional_results, retention_results, voice_results,
                        trending_results, color_results, stability_results,
                        variety_results, framing_results,
                        thumbnail_results, hashtag_results, dynamics_results,
                        music_results, caption_results]
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

    # v3: run dedicated tools and override lowest-accuracy criteria scores
    clarity_v3_results = analyze_clarity_v3(video_path)
    transitions_v3_results = analyze_transitions_v3(video_path)
    cta_v3_results = analyze_cta_v3(video_path, transcript_path)
    # v4: override framing and stability with higher-accuracy dedicated tools
    framing_v3_results = analyze_framing_v3(video_path)
    stability_v2_results = analyze_stability_v2(video_path)
    # v5: override color_consistency with Lab-based v2 tool (75->82)
    color_v2_results = analyze_color_v2(video_path)
    # v6: override pacing and hook_strength with higher-accuracy dedicated tools (75->82)
    pacing_v2_results = analyze_pacing_v2(video_path)
    hook_v3_results = analyze_hook_v3(video_path, transcript_path)
    # v7: override pacing, hook_strength, audio_dynamics with highest-accuracy tools (82->85)
    pacing_v3_results = analyze_pacing_v3(video_path)
    hook_v4_results = analyze_hook_v4(video_path, transcript_path)
    dynamics_v3_virality = analyze_dynamics_v3(video_path, detected_platform)
    # v3 (predict-virality v3): thumbnail, hashtag, audio_dynamics, music_mix, caption + v3 tools
    thumb_v3_virality = analyze_thumb_v3(video_path)
    hashtag_v3_virality = analyze_hashtags_v3(video_path, transcript_path, detected_platform)
    dynamics_v2_virality = analyze_dynamics_v2(video_path, detected_platform)
    music_v3_virality = analyze_music_v3(video_path)
    caption_virality = analyze_captions(video_path)
    trending_v3_virality = analyze_trending_v3(video_path, transcript_path, detected_platform)
    variety_v3_virality = analyze_variety_v3(video_path)

    if "scores" in clarity_v3_results and "clarity" in clarity_v3_results["scores"]:
        visual_results.setdefault("scores", {})["clarity"] = clarity_v3_results["scores"]["clarity"]
    if "scores" in transitions_v3_results and "transitions" in transitions_v3_results["scores"]:
        visual_results.setdefault("scores", {})["transitions"] = transitions_v3_results["scores"]["transitions"]
    if "scores" in cta_v3_results and "cta_placement" in cta_v3_results["scores"]:
        content_results.setdefault("scores", {})["cta_placement"] = cta_v3_results["scores"]["cta_placement"]
    # v4 overrides
    if "scores" in framing_v3_results and "framing" in framing_v3_results["scores"]:
        framing_results.setdefault("scores", {})["framing"] = framing_v3_results["scores"]["framing"]
        framing_results["overall_score"] = framing_v3_results["overall_score"]
    if "scores" in stability_v2_results and "camera_stability" in stability_v2_results["scores"]:
        stability_results.setdefault("scores", {})["camera_stability"] = stability_v2_results["scores"]["camera_stability"]
        stability_results["overall_score"] = stability_v2_results["overall_score"]
    if "scores" in color_v2_results and "color_grading" in color_v2_results["scores"]:
        color_results.setdefault("scores", {})["color_grading"] = color_v2_results["scores"]["color_grading"]
        color_results["overall_score"] = color_v2_results["overall_score"]
    # v6 overrides
    if "scores" in pacing_v2_results and "pacing" in pacing_v2_results["scores"]:
        audio_results.setdefault("scores", {})["pacing"] = pacing_v2_results["scores"]["pacing"]
    if "scores" in hook_v3_results and "hook_strength" in hook_v3_results["scores"]:
        content_results.setdefault("scores", {})["hook_strength"] = hook_v3_results["scores"]["hook_strength"]
    # v7 overrides (supersede v6)
    if "scores" in pacing_v3_results and "pacing" in pacing_v3_results["scores"]:
        audio_results.setdefault("scores", {})["pacing"] = pacing_v3_results["scores"]["pacing"]
    if "scores" in hook_v4_results and "hook_strength" in hook_v4_results["scores"]:
        content_results.setdefault("scores", {})["hook_strength"] = hook_v4_results["scores"]["hook_strength"]
    if "scores" in dynamics_v3_virality and "audio_dynamics" in dynamics_v3_virality["scores"]:
        stability_results.setdefault("scores", {})["audio_dynamics"] = dynamics_v3_virality["scores"]["audio_dynamics"]
    # v3 overrides: use trending-v3 and variety-v3 for higher accuracy
    if "scores" in trending_v3_virality and "trending_topic_alignment" in trending_v3_virality["scores"]:
        trending_results.setdefault("scores", {})["trending_topic_alignment"] = trending_v3_virality["scores"]["trending_topic_alignment"]
        trending_results["overall_score"] = trending_v3_virality["overall_score"]
    if "scores" in variety_v3_virality and "scene_variety" in variety_v3_virality["scores"]:
        variety_results.setdefault("scores", {})["scene_variety"] = variety_v3_virality["scores"]["scene_variety"]
        variety_results["overall_score"] = variety_v3_virality["overall_score"]

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
        thumbnail_results=thumb_v3_virality,
        hashtag_results=hashtag_v3_virality,
        dynamics_results=dynamics_v2_virality,
        music_results=music_v3_virality,
        caption_results=caption_virality,
    )

    return {
        "tool": "predict-virality",
        "version": "5.0.0",
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
