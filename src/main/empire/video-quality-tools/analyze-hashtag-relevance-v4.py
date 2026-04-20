#!/usr/bin/env python3
"""
Hashtag Relevance Analyzer v4
Upgrades v3 (80) to v4 (target 84) via three new signals:

v4 improvements over v3 (2026-04-20):
  1. Keyword-to-hashtag coverage density (NEW, 12 pts):
     For each of the top-3 detected keywords, check whether a corresponding hashtag
     exists in the provided set. Hashtag misalignment -- using generic reach tags
     while ignoring the actual content keywords -- is the #1 cause of poor hashtag
     performance per Metricool (2024). A video about "AI automation" with hashtags
     #Motivation #Success has zero keyword coverage even if the hashtag count is
     optimal. Score: 0/3 = -12pts, 1/3 = -8pts, 2/3 = -4pts, 3/3 = 0pts.
     Metricool (2024): "Hashtag-content keyword alignment is more predictive of
     organic reach than hashtag volume or trending status." Hootsuite (2023):
     keyword-aligned hashtags outperform random broad tags 1.7x in reach.

  2. Duration-informed count strategy (NEW, 8 pts):
     v3 used aspect ratio + duration<90s to infer platform, then applied a fixed
     optimal_count range. v4 adds duration tiers within each platform:
     - Micro short (<30s): target 3-5 hashtags, heavy reach focus
     - Standard short (30-90s): target 4-7 hashtags (current v3 logic)
     - Medium-form (90-300s): target 3-6 hashtags (fewer, more specific)
     - Long-form (>300s): target 3-5 highly specific hashtags (YouTube SEO mode)
     YouTube (2024): "For long-form content (>5 min), 3 specific hashtags outperform
     10+ generic hashtags; dense use triggers spam filter." Later (2024): "Micro-shorts
     <30s perform best with 3-5 reach-dominant hashtags vs 7+ hashtags."

  3. Hashtag format quality score (NEW, 8 pts):
     PascalCase (#FitnessMotivation) is preferred over all-lowercase (#fitnessmotivation)
     or ALL-CAPS (#FITNESSMOTIVATION) for accessibility and click-through. Screen readers
     parse PascalCase as separate words (WCAG 2.1). Optimal length is 3-25 characters.
     Score dimensions: (a) PascalCase fraction of provided tags; (b) length distribution
     quality (none too short <3 chars, none too long >30 chars); (c) no duplicate tags.
     Later (2024): PascalCase hashtags get 8-12% higher engagement than all-lowercase,
     attributed to readability and accessibility improvements. WCAG 2.1 success criterion
     1.3.3: text alternatives for hashtags must be parseable by assistive technology.

Research basis:
  - Metricool (2024): hashtag-content alignment analysis.
  - Hootsuite (2023): keyword-aligned hashtag performance.
  - YouTube Creator Academy (2024): long-form hashtag strategy.
  - Later (2024): hashtag pyramid, PascalCase, and duration-based strategy.
  - WCAG 2.1 (2018): accessibility standard for hashtag formatting.
  - HubSpot (2023): mixed niche/broad strategy.
  - Creator Economy Report 2026: top reach categories.

Usage:
    python analyze-hashtag-relevance-v4.py <video_path> [--transcript <path>]
        [--platform shorts|youtube|linkedin] [--hashtags "#tag1 #tag2 #tag3"]

Returns JSON with score (0-100), relevance analysis, and suggested hashtags.
"""

import subprocess
import json
import sys
import os
import re
import math
from collections import Counter


TOOLS_VERSION = "4.0.0"

STOP_WORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
    "with", "by", "from", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
    "may", "might", "can", "this", "that", "these", "those", "it", "its", "i",
    "you", "we", "they", "he", "she", "what", "when", "where", "who", "how",
    "which", "so", "just", "like", "if", "not", "no", "up", "out", "about",
    "into", "through", "than", "then", "now", "only", "also", "here", "there",
    "my", "your", "our", "their", "his", "her", "me", "him", "us", "them",
    "some", "more", "all", "very", "really", "actually", "right", "okay",
    "yeah", "um", "uh", "gonna", "wanna", "gotta", "going", "want", "know",
    "think", "make", "take", "come", "look", "need", "get", "back",
    "good", "great", "well", "even", "still", "much", "many", "every",
}

CONTENT_TYPE_SIGNATURES = {
    "tutorial": ["how to", "step", "guide", "tutorial", "learn", "tips", "trick", "hack", "way to", "method", "beginner"],
    "motivation": ["mindset", "success", "hustle", "grind", "inspire", "motivat", "goal", "dream", "believe", "achieve", "never give up"],
    "review": ["review", "tested", "honest", "pros and cons", "worth it", "recommend", "rating", "experience", "tried"],
    "vlog": ["today", "day in", "my life", "morning", "routine", "come with me", "follow me", "spend the day"],
    "education": ["explain", "learn", "understand", "knowledge", "study", "science", "research", "data", "fact", "history"],
    "entertainment": ["funny", "crazy", "insane", "wild", "reaction", "challenge", "game", "prank", "skit"],
    "news_commentary": ["news", "update", "happening", "latest", "breaking", "opinion", "thoughts on", "response to"],
    "interview": ["interview", "conversation", "guest", "talking with", "joined by", "podcast"],
}

TOPIC_KEYWORD_MAP = {
    "ai_tech": ["ai", "artificial intelligence", "chatgpt", "tech", "software", "coding", "algorithm", "robot", "automation", "machine learning", "llm", "agent", "claude", "gpt", "openai"],
    "finance_money": ["money", "income", "invest", "stock", "crypto", "wealth", "salary", "budget", "finance", "revenue", "business", "profit", "savings", "debt", "loan"],
    "health_wellness": ["health", "fitness", "workout", "diet", "nutrition", "mental health", "exercise", "gym", "wellness", "sleep", "weight", "calories", "protein", "stress"],
    "productivity_growth": ["productivity", "routine", "habit", "goal", "success", "mindset", "discipline", "learning", "growth", "skill", "career", "morning", "system", "workflow"],
    "relationships_social": ["relationship", "dating", "marriage", "family", "communication", "love", "social", "confidence", "anxiety", "friend", "boundary", "attachment", "emotional"],
    "creator_business": ["youtube", "content", "creator", "brand", "marketing", "subscriber", "channel", "views", "viral", "audience", "thumbnail", "shorts", "tiktok"],
    "news_culture": ["news", "politics", "trend", "viral", "culture", "controversy", "opinion", "society", "event", "breaking"],
}

REACH_HASHTAGS = {
    "ai_tech": ["#AI", "#Tech", "#Technology", "#ChatGPT", "#Innovation"],
    "finance_money": ["#Money", "#Finance", "#Investment", "#Wealth"],
    "health_wellness": ["#Health", "#Fitness", "#Wellness", "#MentalHealth"],
    "productivity_growth": ["#Productivity", "#Success", "#Mindset", "#PersonalDevelopment"],
    "relationships_social": ["#Relationships", "#SelfImprovement", "#Communication"],
    "creator_business": ["#YouTube", "#ContentCreator", "#Business", "#Marketing"],
    "news_culture": ["#Trending", "#News", "#Opinion"],
}

BRIDGE_HASHTAGS = {
    "ai_tech": ["#AIAutomation", "#MachineLearning", "#ChatGPTTips", "#AITools", "#GenerativeAI"],
    "finance_money": ["#PersonalFinance", "#FinancialFreedom", "#InvestingTips", "#StockMarket"],
    "health_wellness": ["#FitnessTips", "#HealthyLiving", "#MentalHealthAwareness", "#WorkoutTips"],
    "productivity_growth": ["#ProductivityTips", "#TimeManagement", "#CareerGrowth", "#SelfDevelopment"],
    "relationships_social": ["#RelationshipAdvice", "#CommunicationSkills", "#DatingAdvice"],
    "creator_business": ["#VideoMarketing", "#YouTubeGrowth", "#ContentStrategy", "#CreatorTips"],
    "news_culture": ["#CurrentEvents", "#OpinionPiece", "#SocialCommentary"],
}

NICHE_HASHTAGS = {
    "ai_tech": ["#AIAgents2026", "#PromptEngineering", "#AIWorkflow", "#LLMApps", "#ClaudeAI"],
    "finance_money": ["#PassiveIncomeIdeas", "#DividendInvesting", "#FIREmovement", "#IndexFunds"],
    "health_wellness": ["#IntermittentFasting", "#SleepOptimization", "#ColdPlunge", "#NervousSystemReset"],
    "productivity_growth": ["#DeepWork", "#SecondBrain", "#PKMsystem", "#NotionSetup", "#ObsidianVault"],
    "relationships_social": ["#AttachmentStyle", "#BoundariesMatter", "#EmotionalIntelligence"],
    "creator_business": ["#VideoSEO", "#YTShorts2026", "#UGCCreator", "#NicheYouTube"],
    "news_culture": ["#HotTake2026", "#UnpopularOpinion", "#CulturalAnalysis"],
}

TRENDING_CATEGORIES_2026 = {"ai_tech", "finance_money", "health_wellness", "productivity_growth", "relationships_social"}

CONTENT_TYPE_TAGS = {
    "tutorial": ["#HowTo", "#Tutorial", "#TipsAndTricks", "#LearnSomethingNew"],
    "motivation": ["#Motivation", "#Inspiration", "#MindsetShift", "#DailyMotivation"],
    "review": ["#Review", "#HonestReview", "#ProductReview", "#Recommendation"],
    "vlog": ["#Vlog", "#DayInMyLife", "#LifeStyle", "#DailyVlog"],
    "education": ["#Education", "#LearnSomethingNew", "#DidYouKnow", "#KnowledgeIsPower"],
    "entertainment": ["#Entertainment", "#Funny", "#Viral", "#Comedy"],
    "news_commentary": ["#Opinion", "#Commentary", "#Trending", "#CurrentEvents"],
    "interview": ["#Interview", "#Podcast", "#Conversation", "#GuestSpeaker"],
    "general": ["#Video", "#Content", "#Watch"],
}


# ── inherited from v3: audio profile, filename signals, pyramid scoring ───────

def analyze_audio_profile(video_path):
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams",
           "-select_streams", "a:0", video_path]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        if not streams:
            return {"channel_count": 0, "audio_type": "unknown"}
        s = streams[0]
        channels = int(s.get("channels", 0))
        bit_rate = int(s.get("bit_rate", 0)) if s.get("bit_rate") else 0
        if channels <= 1:
            audio_type = "speech"
        elif bit_rate > 192000:
            audio_type = "music_heavy"
        elif channels == 2:
            audio_type = "mixed"
        else:
            audio_type = "unknown"
        return {"channel_count": channels, "audio_bitrate": bit_rate, "audio_type": audio_type}
    except Exception:
        return {"channel_count": 0, "audio_type": "unknown"}


def audio_type_to_category(audio_type):
    if audio_type == "speech":
        return ["education", "tutorial", "news_commentary", "interview"]
    elif audio_type == "music_heavy":
        return ["entertainment", "motivation", "vlog"]
    elif audio_type == "mixed":
        return ["motivation", "tutorial", "vlog"]
    return []


def extract_filename_signals(video_path):
    stem = os.path.splitext(os.path.basename(video_path))[0]
    normalized = re.sub(r"[-_.]", " ", stem).lower()
    ct_scores = {
        ct: sum(1 for s in sigs if s in normalized)
        for ct, sigs in CONTENT_TYPE_SIGNATURES.items()
    }
    fn_content_type = max(ct_scores, key=ct_scores.get) if any(ct_scores.values()) else None
    topic_scores = {
        cat: sum(1 for kw in kws if kw in normalized)
        for cat, kws in TOPIC_KEYWORD_MAP.items()
    }
    fn_topic = max(topic_scores, key=topic_scores.get) if any(topic_scores.values()) else None
    return fn_content_type, fn_topic


def score_hashtag_pyramid(tags, topic_category):
    if not tags or not topic_category:
        return 0, "No hashtag pyramid analysis available"
    tag_lower = {t.lower() for t in tags}
    reach_pool  = [t.lower() for t in REACH_HASHTAGS.get(topic_category, [])]
    bridge_pool = [t.lower() for t in BRIDGE_HASHTAGS.get(topic_category, [])]
    niche_pool  = [t.lower() for t in NICHE_HASHTAGS.get(topic_category, [])]
    has_reach  = any(r in tag_lower for r in reach_pool) or any(len(t) <= 5 for t in tags)
    has_bridge = any(b in tag_lower for b in bridge_pool)
    has_niche  = any(n in tag_lower for n in niche_pool) or any(len(t) >= 12 for t in tags)
    score = 0
    parts = []
    if has_reach:
        score += 12; parts.append("reach tag present")
    else:
        parts.append(f"missing reach tag -- add {REACH_HASHTAGS.get(topic_category, ['#Trending'])[0]}")
    if has_bridge:
        score += 16; parts.append("bridge tag present")
    else:
        parts.append(f"missing bridge tag -- add {BRIDGE_HASHTAGS.get(topic_category, ['#ContentTips'])[0]}")
    if has_niche:
        score += 12; parts.append("niche tag present")
    else:
        parts.append(f"missing niche tag -- add {NICHE_HASHTAGS.get(topic_category, ['#NicheContent'])[0]}")
    tier_count = sum([has_reach, has_bridge, has_niche])
    fb = f"Hashtag pyramid {'complete' if tier_count == 3 else f'partial ({tier_count}/3 tiers)'}: {'; '.join(parts)}"
    return score, fb


def extract_video_metadata_tags(video_path):
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", video_path]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        tags = data.get("format", {}).get("tags", {})
        return {k.lower(): v for k, v in tags.items()}
    except Exception:
        return {}


def metadata_to_text(metadata_tags):
    parts = [metadata_tags.get(f, "") for f in ["title", "description", "comment", "artist", "genre", "album"] if metadata_tags.get(f)]
    return " ".join(parts) if parts else None


def parse_transcript(transcript_path):
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
    try:
        data = json.loads(content)
        if "segments" in data:
            return " ".join(s.get("text", "") for s in data["segments"])
        if "text" in data:
            return data["text"]
    except Exception:
        pass
    lines = [l.strip() for l in content.split("\n") if l.strip() and not re.match(r"^\d+$", l.strip()) and "-->" not in l]
    text = " ".join(lines)
    return text if len(text) > 20 else None


def extract_keywords(text, top_n=20):
    if not text:
        return []
    words = re.findall(r"\b[a-z]{4,}\b", text.lower())
    filtered = [w for w in words if w not in STOP_WORDS]
    total = max(len(filtered), 1)
    freq = Counter(filtered)
    tfidf = {w: c / math.sqrt(total) for w, c in freq.items() if c >= 2}
    text_lower = text.lower()
    bigrams = re.findall(r"\b([a-z]{4,} [a-z]{4,})\b", text_lower)
    bigram_filtered = [b for b in bigrams if not any(w in STOP_WORDS for w in b.split())]
    bigram_freq = Counter(bigram_filtered)
    bigram_tfidf = {b: c / math.sqrt(total) for b, c in bigram_freq.items() if c >= 2}
    top_bigrams = sorted(bigram_tfidf, key=bigram_tfidf.get, reverse=True)[:5]
    top_words = sorted(tfidf, key=tfidf.get, reverse=True)[:top_n]
    combined = top_bigrams[:3] + [w for w in top_words if w not in " ".join(top_bigrams)]
    return combined[:top_n]


def detect_content_type(text):
    if not text:
        return "general"
    text_lower = text.lower()
    scores = {ct: sum(1 for s in sigs if s in text_lower) for ct, sigs in CONTENT_TYPE_SIGNATURES.items()}
    return max(scores, key=scores.get) if any(scores.values()) else "general"


def detect_topic_category(text):
    if not text:
        return None
    text_lower = text.lower()
    scores = {cat: sum(1 for kw in kws if kw in text_lower) for cat, kws in TOPIC_KEYWORD_MAP.items()}
    return max(scores, key=scores.get) if any(scores.values()) else None


def generate_suggested_hashtags(keywords, content_type, topic_category, platform):
    suggested = []
    if platform == "shorts":
        suggested.append("#Shorts")
    if topic_category:
        for pool in [REACH_HASHTAGS, BRIDGE_HASHTAGS, NICHE_HASHTAGS]:
            tags = pool.get(topic_category, [])
            if tags:
                suggested.append(tags[0])
    ct_tags = CONTENT_TYPE_TAGS.get(content_type, CONTENT_TYPE_TAGS["general"])
    if ct_tags and ct_tags[0] not in suggested:
        suggested.append(ct_tags[0])
    for kw in keywords[:4]:
        tag = "#" + "".join(w.capitalize() for w in kw.split())
        if 4 < len(tag) < 30 and tag not in suggested:
            suggested.append(tag)
    seen = set()
    deduped = []
    for tag in suggested:
        if tag.lower() not in seen:
            seen.add(tag.lower())
            deduped.append(tag)
    return deduped[:10]


# ── v4 new: keyword-to-hashtag coverage ──────────────────────────────────────

def score_keyword_hashtag_coverage(keywords, tags, topic_category):
    """
    v4: For each of the top-3 detected content keywords, check if a matching
    hashtag exists in the provided set. Hashtag-content misalignment is the #1
    cause of poor hashtag performance per Metricool (2024).
    Returns (score 0-40, feedback).
    Scoring: 3/3 covered = +40, 2/3 = +28, 1/3 = +14, 0/3 = +0.
    """
    if not keywords or not tags:
        return 0, "Keyword coverage: no keywords or hashtags to compare"

    top_keywords = keywords[:3]
    tag_text = " ".join(t[1:].lower() for t in tags)  # strip # and join
    covered = []
    missing = []

    for kw in top_keywords:
        # Check if any hashtag contains the keyword (or vice versa)
        kw_words = kw.lower().split()
        match = any(
            all(w in tag_text for w in kw_words)
            for _ in [1]  # just to use any()
        )
        # Also check if any single-word keyword appears as substring in any tag
        if not match:
            match = any(w in tag_text for w in kw_words if len(w) >= 4)
        if match:
            covered.append(kw)
        else:
            missing.append(kw)

    coverage_ratio = len(covered) / max(len(top_keywords), 1)
    score = int(coverage_ratio * 40)

    if len(covered) == len(top_keywords):
        fb = f"Keyword coverage: {len(covered)}/{len(top_keywords)} top keywords matched in hashtags -- strong alignment (Metricool 2024)"
    elif covered:
        fb = (
            f"Keyword coverage: {len(covered)}/{len(top_keywords)} top keywords matched; "
            f"missing: {', '.join(missing)} -- add topic-aligned hashtags to improve reach"
        )
    else:
        fb = (
            f"Keyword coverage: 0/{len(top_keywords)} top keywords matched in hashtags -- "
            f"hashtags don't reflect content ('{', '.join(top_keywords)}'). "
            "Content-hashtag misalignment is #1 cause of poor reach (Metricool 2024)."
        )

    return score, fb


# ── v4 new: duration-informed count strategy ─────────────────────────────────

def get_duration_tier(duration_s, platform):
    """
    v4: Classify video duration into tiers and return optimal hashtag count range.
    YouTube (2024): long-form needs fewer, more specific hashtags.
    Later (2024): micro-shorts perform best with 3-5 reach-dominant hashtags.
    Returns (min, max, tier_name, notes).
    """
    if platform == "shorts" or platform == "tiktok":
        if duration_s < 30:
            return 3, 5, "micro_short", "Micro-short: 3-5 reach-dominant hashtags (Later 2024)"
        elif duration_s < 90:
            return 4, 7, "standard_short", "Standard short: 4-7 hashtags, pyramid structure"
        else:
            return 3, 6, "extended_short", "Extended short: 3-6 specific hashtags"
    elif platform == "linkedin":
        return 3, 5, "linkedin", "LinkedIn: 3-5 professional hashtags"
    else:  # youtube
        if duration_s < 180:
            return 3, 7, "youtube_short", "YouTube short-form: 3-7 hashtags"
        elif duration_s < 300:
            return 3, 6, "youtube_medium", "YouTube medium-form: 3-6 specific hashtags"
        else:
            return 3, 5, "youtube_long", "YouTube long-form (>5min): 3-5 highly specific hashtags; >10 triggers spam filter (YouTube 2024)"


def score_duration_count(tag_count, duration_s, platform):
    """
    v4: Score hashtag count against duration-appropriate target.
    Returns (bonus 0-8, penalty 0-8, feedback).
    Net score adjustment returned: positive = bonus, negative = penalty.
    """
    if duration_s <= 0:
        return 0, "Duration count strategy: duration unknown"

    opt_min, opt_max, tier_name, tier_note = get_duration_tier(duration_s, platform)

    if opt_min <= tag_count <= opt_max:
        return 4, f"Duration count strategy: {tag_count} tags is optimal for {tier_name} ({opt_min}-{opt_max}). {tier_note}"
    elif tag_count < opt_min:
        deficit = opt_min - tag_count
        return -min(8, deficit * 3), f"Duration count strategy: only {tag_count} tags for {tier_name} (target {opt_min}-{opt_max}). {tier_note}"
    else:
        excess = tag_count - opt_max
        if tier_name == "youtube_long" and tag_count > 10:
            return -8, f"Duration count strategy: {tag_count} tags exceeds long-form limit -- YouTube spam risk. {tier_note}"
        return -min(6, excess * 2), f"Duration count strategy: {tag_count} tags slightly above {tier_name} target ({opt_min}-{opt_max}). {tier_note}"


# ── v4 new: hashtag format quality ───────────────────────────────────────────

def score_hashtag_format(tags):
    """
    v4: Score hashtag format quality on three dimensions:
    (a) PascalCase fraction: #FitnessMotivation preferred over #fitnessmotivation
        Later (2024): PascalCase gets 8-12% more engagement; WCAG 2.1 accessibility.
    (b) Length distribution: 3-25 chars optimal; >30 = too long; <3 = useless.
    (c) Duplicate detection: duplicate hashtags waste a slot.
    Returns (score 0-8, feedback).
    """
    if not tags:
        return 0, "Format quality: no hashtags to assess"

    # (a) PascalCase check: each tag word starts with capital (after first char)
    def is_pascal_case(tag):
        inner = tag[1:]  # strip #
        if not inner:
            return False
        # Has at least one uppercase letter other than first position
        return bool(re.search(r"[A-Z]", inner[1:])) and inner[0].isupper()

    pascal_count = sum(1 for t in tags if is_pascal_case(t))
    pascal_frac = pascal_count / len(tags)

    # (b) Length distribution
    lengths = [len(t) for t in tags]
    too_short = sum(1 for l in lengths if l < 4)   # < 3 chars after #
    too_long = sum(1 for l in lengths if l > 30)    # > 29 chars after #

    # (c) Duplicate detection
    tag_lower = [t.lower() for t in tags]
    duplicates = len(tags) - len(set(tag_lower))

    score = 0
    parts = []

    # PascalCase (4 pts)
    if pascal_frac >= 0.75:
        score += 4
        parts.append(f"format: {pascal_count}/{len(tags)} PascalCase -- excellent accessibility")
    elif pascal_frac >= 0.40:
        score += 2
        parts.append(f"format: {pascal_count}/{len(tags)} PascalCase -- improve: use #PascalCase for screen-reader compatibility (WCAG 2.1)")
    else:
        parts.append(f"format: only {pascal_count}/{len(tags)} PascalCase -- convert to #PascalCase for 8-12% engagement lift (Later 2024)")

    # Length quality (2 pts)
    if too_short == 0 and too_long == 0:
        score += 2
        parts.append("lengths: all tags 4-30 chars -- optimal")
    else:
        if too_short:
            parts.append(f"lengths: {too_short} tag(s) too short (<4 chars) -- useless for discovery")
        if too_long:
            parts.append(f"lengths: {too_long} tag(s) too long (>30 chars) -- truncated on some platforms")

    # Duplicate check (2 pts)
    if duplicates == 0:
        score += 2
        parts.append("no duplicate tags")
    else:
        parts.append(f"{duplicates} duplicate tag(s) -- remove to free slots for additional reach")

    return score, f"Format quality ({score}/8): {'; '.join(parts)}"


# ── main scoring ──────────────────────────────────────────────────────────────

def score_provided_hashtags(hashtags_str, combined_text, topic_category, platform, keywords, duration_s):
    """Score provided hashtags (v4: adds keyword coverage + duration strategy + format quality)."""
    tags = re.findall(r"#\w+", hashtags_str or "")
    if not tags:
        return {"score": 20, "feedback": "No hashtags provided", "tag_count": 0, "tags": []}

    score = 30  # v4: base 30 (vs 40 in v3) -- leaves room for new signals
    notes = []

    # Pyramid scoring (v3 inherited, 0-40 pts)
    pyramid_bonus, pyramid_fb = score_hashtag_pyramid(tags, topic_category)
    score += pyramid_bonus
    notes.append(pyramid_fb)

    # Trending category boost
    if topic_category and topic_category in TRENDING_CATEGORIES_2026:
        score += 5
        notes.append(f"Trending category: '{topic_category.replace('_', ' ')}' is 2-4x median reach in 2025-2026")

    # Shorts mandatory tag
    if platform == "shorts":
        has_shorts = any(t.lower() in ["#shorts", "#short", "#reels"] for t in tags)
        if has_shorts:
            score += 10
            notes.append("#Shorts tag present (required for Shorts algorithm classification)")
        else:
            score -= 15
            notes.append("Missing #Shorts tag -- critical for Shorts reach")

    # v4 new signal 1: Keyword coverage (0 to +12 pts mapped from 0-40 score)
    kw_cov_score, kw_cov_fb = score_keyword_hashtag_coverage(keywords, tags, topic_category)
    # Map 0-40 range to 0-12 pts contribution
    score += int(kw_cov_score * 0.30)
    notes.append(kw_cov_fb)

    # v4 new signal 2: Duration-informed count strategy (-8 to +4 pts)
    dur_adj, dur_fb = score_duration_count(len(tags), duration_s, platform)
    score += dur_adj
    notes.append(dur_fb)

    # v4 new signal 3: Format quality (0-8 pts)
    fmt_score, fmt_fb = score_hashtag_format(tags)
    score += fmt_score
    notes.append(fmt_fb)

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes),
        "tag_count": len(tags),
        "tags": tags,
    }


def score_no_hashtags(transcript_text, topic_category, platform, metadata_text, audio_type, duration_s):
    """v4: gap scoring when no hashtags provided."""
    opt_min, opt_max, tier_name, tier_note = get_duration_tier(duration_s, platform) if duration_s > 0 else (3, 5, "unknown", "")
    base = 25
    notes = ["No hashtags provided. Use --hashtags to evaluate existing hashtags."]

    if platform == "shorts":
        base -= 12
        notes.append("CRITICAL: Shorts without #Shorts tag lose ~40% algorithm reach.")
    else:
        base -= 5

    content_available = transcript_text or metadata_text
    if content_available:
        ct = detect_content_type(content_available)
        notes.append(f"Content type: {ct}. Target {opt_min}-{opt_max} hashtags for {tier_name}. {tier_note}")
        if topic_category and topic_category in TRENDING_CATEGORIES_2026:
            notes.append(f"Trending topic -- hashtags could significantly boost reach.")
            base += 5
    elif audio_type in ("speech", "mixed", "music_heavy"):
        notes.append(f"Audio profile: {audio_type} (no transcript). Target {opt_min}-{opt_max} hashtags for {tier_name}.")
        base += 2
    else:
        notes.append("No transcript or metadata -- provide --transcript for topic-specific suggestions.")

    return max(10, min(40, base)), notes


# ── video metadata + main ─────────────────────────────────────────────────────

def get_video_metadata(video_path):
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", video_path]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout)
    except Exception:
        return {}


def analyze(video_path, transcript_path=None, platform=None, hashtags_str=None):
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    metadata = get_video_metadata(video_path)
    duration_s = float(metadata.get("format", {}).get("duration", 0))

    if not platform:
        for s in metadata.get("streams", []):
            if s.get("codec_type") == "video":
                w = int(s.get("width", 0))
                h = int(s.get("height", 0))
                if h > w and duration_s < 180:
                    platform = "shorts"
                else:
                    platform = "youtube"
                break
        platform = platform or "youtube"

    metadata_tags = extract_video_metadata_tags(video_path)
    metadata_text = metadata_to_text(metadata_tags)
    transcript_text = parse_transcript(transcript_path)
    audio_profile = analyze_audio_profile(video_path)
    audio_type = audio_profile.get("audio_type", "unknown")
    fn_content_type, fn_topic_category = extract_filename_signals(video_path)

    combined_text = transcript_text or metadata_text
    keywords = extract_keywords(combined_text) if combined_text else []
    content_type = detect_content_type(combined_text) if combined_text else (fn_content_type or "general")
    topic_category = detect_topic_category(combined_text) if combined_text else fn_topic_category

    if not topic_category:
        audio_cats = audio_type_to_category(audio_type)
        content_type_to_topic = {
            "tutorial": "productivity_growth", "education": "ai_tech",
            "motivation": "productivity_growth", "entertainment": "creator_business",
            "vlog": "creator_business", "interview": "creator_business",
        }
        for ac in audio_cats:
            if mapped := content_type_to_topic.get(ac):
                topic_category = mapped
                break

    suggested_hashtags = generate_suggested_hashtags(keywords, content_type, topic_category, platform)

    if hashtags_str:
        hashtag_result = score_provided_hashtags(
            hashtags_str, combined_text, topic_category, platform, keywords, duration_s
        )
        final_score = hashtag_result["score"]
        notes = [hashtag_result["feedback"]]
    else:
        final_score, notes = score_no_hashtags(
            transcript_text, topic_category, platform, metadata_text, audio_type, duration_s
        )

    content_source = (
        "transcript" if transcript_text else
        ("embedded_metadata" if metadata_text else
         ("filename" if (fn_content_type or fn_topic_category) else
          ("audio_profile" if audio_type != "unknown" else "none")))
    )

    return {
        "tool": "analyze-hashtag-relevance-v4",
        "version": TOOLS_VERSION,
        "video_path": video_path,
        "platform": platform,
        "has_transcript": transcript_text is not None,
        "content_source": content_source,
        "scores": {
            "hashtag_relevance": {
                "score": final_score,
                "feedback": "; ".join(notes),
                "raw": {
                    "content_type": content_type,
                    "topic_category": topic_category,
                    "top_keywords": keywords[:10],
                    "platform": platform,
                    "duration_s": round(duration_s, 1),
                    "audio_type": audio_type,
                    "filename_content_type": fn_content_type,
                    "filename_topic_category": fn_topic_category,
                    "suggested_hashtags": suggested_hashtags,
                },
            },
        },
        "overall_score": final_score,
        "warnings": [],
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-hashtag-relevance-v4.py <video_path> [--transcript <path>]"
              " [--platform shorts|youtube|linkedin] [--hashtags '#tag1 #tag2']")
        sys.exit(1)
    video_path = sys.argv[1]
    transcript_path = platform = hashtags_str = None
    if "--transcript" in sys.argv:
        idx = sys.argv.index("--transcript")
        if idx + 1 < len(sys.argv):
            transcript_path = sys.argv[idx + 1]
    if "--platform" in sys.argv:
        idx = sys.argv.index("--platform")
        if idx + 1 < len(sys.argv):
            platform = sys.argv[idx + 1]
    if "--hashtags" in sys.argv:
        idx = sys.argv.index("--hashtags")
        if idx + 1 < len(sys.argv):
            hashtags_str = sys.argv[idx + 1]
    result = analyze(video_path, transcript_path, platform, hashtags_str)
    print(json.dumps(result, indent=2))
