#!/usr/bin/env python3
"""
Video Virality Prediction Scorer
Combines signals from all quality tools into a virality likelihood score.
Uses a weighted heuristic model based on research into viral video features:
  - Hook strength (first 3s)
  - Pacing and visual variety
  - Audio engagement (energy, dynamics)
  - Technical quality baseline
  - Content structure (CTA, emotional arc proxy)
  - Platform fit

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

analyze_technical = _tech_mod.analyze
analyze_audio = _audio_mod.analyze
analyze_content = _content_mod.analyze
analyze_visual = _visual_mod.analyze


# Virality signal weights (research-backed, v2 with emotional arc + retention)
# Hook strength remains #1, but emotional arc and retention now contribute
VIRALITY_WEIGHTS = {
    "hook_strength": 0.22,        # First 3s = strongest predictor
    "content_pacing": 0.12,       # Visual variety and cuts/min
    "audio_engagement": 0.12,     # Voice dynamics, no dead air
    "emotional_arc": 0.10,        # Emotional progression predicts engagement
    "retention_quality": 0.10,    # Predicted retention curve health
    "voice_clarity": 0.05,        # Clear voice = professional = more trust
    "visual_quality": 0.08,       # Sharpness, lighting, color
    "format_fit": 0.08,           # Right format for platform
    "technical_baseline": 0.03,   # Resolution, codec, bitrate
    "cta_presence": 0.03,         # Has call-to-action
    "pacing_tightness": 0.05,     # Low dead air ratio
    "transition_quality": 0.02,   # Smooth, professional edits
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
                           emotional_results=None, retention_results=None, voice_results=None):
    """
    Compute virality prediction from all tool outputs.
    Returns a score 0-100 with breakdown and recommendations.
    v2: Now incorporates emotional arc, retention prediction, and voice clarity.
    """
    emotional_results = emotional_results or {}
    retention_results = retention_results or {}
    voice_results = voice_results or {}
    platform_factors = PLATFORM_VIRALITY_FACTORS.get(platform, PLATFORM_VIRALITY_FACTORS["youtube"])

    signals = {}
    breakdown = {}
    recommendations = []
    strengths = []

    # === HOOK STRENGTH (25%) ===
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

    # === CONTENT PACING (15%) ===
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

    # === AUDIO ENGAGEMENT (15%) ===
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

    # === VISUAL QUALITY (10%) ===
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

    # === FORMAT FIT (10%) ===
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

    # === TECHNICAL BASELINE (5%) ===
    tech_score = tech_results.get("overall_score", 50) if isinstance(tech_results.get("overall_score"), (int, float)) else 50
    signals["technical_baseline"] = tech_score
    breakdown["technical_baseline"] = {
        "raw_score": round(tech_score),
        "weighted": round(tech_score * VIRALITY_WEIGHTS["technical_baseline"], 1),
    }

    # === CTA PRESENCE (5%) ===
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

    # === PACING TIGHTNESS (10%) ===
    pacing_tight = audio_scores.get("pacing", {}).get("score", 50) if audio_scores else 50
    signals["pacing_tightness"] = pacing_tight
    breakdown["pacing_tightness"] = {
        "raw_score": pacing_tight,
        "weighted": round(pacing_tight * VIRALITY_WEIGHTS["pacing_tightness"], 1),
    }
    if pacing_tight < 60:
        # Get specific dead air info
        pacing_feedback = audio_scores.get("pacing", {}).get("feedback", "")
        recommendations.append(f"Tighten edits -- remove dead air. {pacing_feedback}")

    # === TRANSITION QUALITY (2%) ===
    transition_score = 70  # default
    if "scores" in visual_results and "transitions" in visual_results["scores"]:
        transition_score = visual_results["scores"]["transitions"].get("score", 70)
    signals["transition_quality"] = transition_score
    breakdown["transition_quality"] = {
        "raw_score": transition_score,
        "weighted": round(transition_score * VIRALITY_WEIGHTS["transition_quality"], 1),
    }

    # === EMOTIONAL ARC (10%) ===
    emotional_score = emotional_results.get("overall_score", 50)
    signals["emotional_arc"] = emotional_score
    arc_shape = emotional_results.get("arc_shape", "Unknown")
    breakdown["emotional_arc"] = {
        "raw_score": emotional_score,
        "weighted": round(emotional_score * VIRALITY_WEIGHTS["emotional_arc"], 1),
        "arc_shape": arc_shape,
    }
    if emotional_score >= 75:
        strengths.append(f"Strong emotional arc ({arc_shape})")
    elif emotional_score < 45:
        recommendations.append(f"Emotional arc is weak ({arc_shape}) — build energy toward a climax, vary your delivery intensity.")

    # === RETENTION QUALITY (10%) ===
    retention_score_val = retention_results.get("overall_score", 50)
    signals["retention_quality"] = retention_score_val
    breakdown["retention_quality"] = {
        "raw_score": retention_score_val,
        "weighted": round(retention_score_val * VIRALITY_WEIGHTS["retention_quality"], 1),
    }
    if retention_score_val >= 75:
        strengths.append("Strong predicted retention curve")
    elif retention_score_val < 45:
        # Include specific drop-off info
        retention_scores = retention_results.get("scores", {}).get("retention_curve", {})
        dropoffs = retention_scores.get("raw", {}).get("dropoff_points", [])
        if dropoffs:
            worst = dropoffs[0]
            recommendations.append(f"Predicted viewer drop-off at {worst.get('time_s', '?')}s — add a re-hook or visual change at this point.")
        else:
            recommendations.append("Low predicted retention — tighten pacing and add engagement hooks throughout.")

    # === VOICE CLARITY (5%) ===
    voice_score = voice_results.get("overall_score", 50)
    signals["voice_clarity"] = voice_score
    breakdown["voice_clarity"] = {
        "raw_score": voice_score,
        "weighted": round(voice_score * VIRALITY_WEIGHTS["voice_clarity"], 1),
    }
    if voice_score < 50:
        recommendations.append("Voice clarity issues detected — check mic placement, reduce background noise, normalize audio.")

    # === COMPUTE FINAL VIRALITY SCORE ===
    weighted_sum = sum(
        min(signals[k], 100) * VIRALITY_WEIGHTS[k]
        for k in VIRALITY_WEIGHTS
    )
    # Normalize: weights sum to 1.0, scores are 0-100
    virality_score = min(100, max(0, round(weighted_sum)))

    # Confidence based on how many tools returned valid data
    all_tool_results = [tech_results, audio_results, content_results, visual_results,
                        emotional_results, retention_results, voice_results]
    tools_valid = sum(1 for r in all_tool_results if r and "error" not in r)
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
    """Run all tools and compute virality prediction."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    # Run all analyzers
    tech_results = analyze_technical(video_path, platform)
    audio_results = analyze_audio(video_path)
    content_results = analyze_content(video_path, transcript_path)
    visual_results = analyze_visual(video_path)

    detected_platform = platform or tech_results.get("platform", "youtube")

    virality = compute_virality_score(
        tech_results, audio_results, content_results, visual_results, detected_platform
    )

    return {
        "tool": "predict-virality",
        "version": "1.0.0",
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
