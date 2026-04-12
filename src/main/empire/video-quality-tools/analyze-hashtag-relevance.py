#!/usr/bin/env python3
"""
Hashtag Relevance Analyzer
Evaluates whether a video's content would benefit from relevant, well-targeted
hashtags and provides content-specific hashtag recommendations.

No external API required -- derives hashtag recommendations from:
  - Transcript keyword frequency analysis (most-mentioned concepts)
  - Content type detection (tutorial, motivation, review, vlog, etc.)
  - Platform-specific hashtag strategy (YouTube vs TikTok/Shorts vs LinkedIn)
  - Niche vs broad hashtag mix recommendations
  - Format and count validation against platform best practices

Research basis:
  - YouTube: 3-5 hashtags in description drive 15% more impressions (YouTube Creator Academy)
  - Mixed strategy (1 broad + 2 niche + 1 content-type) outperforms all-broad 2x (HubSpot 2023)
  - Hashtag stuffing (>15 YouTube, >10 LinkedIn) is penalized by platform algorithms
  - Shorts: #Shorts tag is mandatory for algorithm classification; missing it reduces reach ~40%
  - LinkedIn: 3-5 hashtags optimal; >10 suppresses organic reach

Usage:
    python analyze-hashtag-relevance.py <video_path> [--transcript <path>]
        [--platform shorts|youtube|linkedin] [--hashtags "#tag1 #tag2 #tag3"]

Returns JSON with score (0-100), relevance analysis, and suggested hashtags.
"""

import subprocess
import json
import sys
import os
import re
from collections import Counter


# Stop words to exclude from keyword extraction
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
    "think", "make", "take", "come", "look", "need", "get", "back", "come",
    "good", "great", "well", "even", "still", "much", "many", "every",
}

# Content type signatures (ordered by specificity)
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

# Platform-specific hashtag strategy
PLATFORM_HASHTAG_STRATEGY = {
    "youtube": {
        "optimal_count": (3, 5),
        "max_count": 15,
        "notes": "3-5 hashtags in description. YouTube shows first 3 as clickable above title.",
    },
    "shorts": {
        "optimal_count": (3, 8),
        "max_count": 10,
        "mandatory_tag": "#Shorts",
        "notes": "#Shorts tag is mandatory for algorithm classification. Add 2-4 topic tags.",
    },
    "linkedin": {
        "optimal_count": (3, 5),
        "max_count": 10,
        "notes": "Professional tone. 3-5 hashtags optimal; avoid trending/entertainment tags.",
    },
    "tiktok": {
        "optimal_count": (3, 8),
        "max_count": 12,
        "notes": "Mix niche + broad for discovery. Include 1 very broad tag for reach.",
    },
}

# Broad hashtag pools by category
BROAD_HASHTAGS = {
    "ai_tech": ["#AI", "#Tech", "#Technology", "#Innovation", "#MachineLearning", "#ChatGPT", "#Automation"],
    "finance_money": ["#Money", "#Finance", "#PersonalFinance", "#Investment", "#Wealth", "#FinancialFreedom"],
    "health_wellness": ["#Health", "#Fitness", "#Wellness", "#MentalHealth", "#Workout", "#Nutrition"],
    "productivity_growth": ["#Productivity", "#Success", "#Mindset", "#PersonalDevelopment", "#Growth", "#Goals"],
    "relationships_social": ["#Relationships", "#Dating", "#Communication", "#SocialSkills", "#SelfImprovement"],
    "creator_business": ["#YouTube", "#ContentCreator", "#VideoMarketing", "#SocialMedia", "#Business", "#Marketing"],
    "news_culture": ["#News", "#Opinion", "#Culture", "#Trending"],
}

# Topic category detection keywords
TOPIC_KEYWORD_MAP = {
    "ai_tech": ["ai", "artificial intelligence", "chatgpt", "tech", "software", "coding", "algorithm", "robot", "automation", "machine learning", "llm"],
    "finance_money": ["money", "income", "invest", "stock", "crypto", "wealth", "salary", "budget", "finance", "revenue", "business"],
    "health_wellness": ["health", "fitness", "workout", "diet", "nutrition", "mental health", "exercise", "gym", "wellness", "sleep", "weight"],
    "productivity_growth": ["productivity", "routine", "habit", "goal", "success", "mindset", "discipline", "learning", "growth", "skill", "career"],
    "relationships_social": ["relationship", "dating", "marriage", "family", "communication", "love", "social", "confidence", "anxiety", "friend"],
    "creator_business": ["youtube", "content", "creator", "brand", "marketing", "subscriber", "channel", "views", "viral", "audience"],
    "news_culture": ["news", "politics", "trend", "viral", "culture", "controversy", "opinion"],
}

# Content-type hashtag suggestions
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


def parse_transcript(transcript_path):
    """Parse transcript to raw text."""
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
    except json.JSONDecodeError:
        pass

    lines = []
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped and not re.match(r"^\d+$", stripped) and "-->" not in stripped:
            lines.append(stripped)
    text = " ".join(lines)
    return text if len(text) > 20 else None


def extract_keywords(text, top_n=20):
    """Extract top keywords from transcript via frequency analysis."""
    if not text:
        return []

    # Single words
    words = re.findall(r"\b[a-z]{4,}\b", text.lower())
    filtered = [w for w in words if w not in STOP_WORDS]
    freq = Counter(filtered)

    # Bigrams for multi-word concepts
    text_lower = text.lower()
    bigrams = re.findall(r"\b([a-z]{4,} [a-z]{4,})\b", text_lower)
    bigram_filtered = [b for b in bigrams if not any(w in STOP_WORDS for w in b.split())]
    bigram_freq = Counter(bigram_filtered)

    top_words = [w for w, c in freq.most_common(top_n) if c >= 2]
    top_bigrams = [b for b, c in bigram_freq.most_common(5) if c >= 2]

    # Bigrams first (more specific), then single words
    return top_bigrams[:3] + top_words[:top_n - 3]


def detect_content_type(text):
    """Detect content type from transcript."""
    if not text:
        return "general"

    text_lower = text.lower()
    scores = {}
    for ctype, signals in CONTENT_TYPE_SIGNATURES.items():
        score = sum(1 for s in signals if s in text_lower)
        if score > 0:
            scores[ctype] = score

    return max(scores, key=scores.get) if scores else "general"


def detect_topic_category(text):
    """Detect primary topic category."""
    if not text:
        return None

    text_lower = text.lower()
    category_scores = {}
    for cat, keywords in TOPIC_KEYWORD_MAP.items():
        hits = sum(1 for kw in keywords if kw in text_lower)
        if hits > 0:
            category_scores[cat] = hits

    return max(category_scores, key=category_scores.get) if category_scores else None


def generate_suggested_hashtags(keywords, content_type, topic_category, platform):
    """Generate suggested hashtags from extracted signals."""
    suggested = []

    # Mandatory platform tag
    if platform == "shorts":
        suggested.append("#Shorts")

    # Broad topic category tags (2 max)
    if topic_category and topic_category in BROAD_HASHTAGS:
        suggested.extend(BROAD_HASHTAGS[topic_category][:2])

    # Content type tags (2 max)
    ct_tags = CONTENT_TYPE_TAGS.get(content_type, CONTENT_TYPE_TAGS["general"])
    suggested.extend(ct_tags[:2])

    # Niche tags from top keywords (capitalize words, hashtag prefix)
    for kw in keywords[:5]:
        tag = "#" + "".join(w.capitalize() for w in kw.split())
        if 4 < len(tag) < 30 and tag not in suggested:
            suggested.append(tag)

    # Deduplicate preserving order
    seen = set()
    deduped = []
    for tag in suggested:
        if tag.lower() not in seen:
            seen.add(tag.lower())
            deduped.append(tag)

    return deduped[:10]


def score_provided_hashtags(hashtags_str, transcript_text, topic_category, platform):
    """Score user-provided hashtags for relevance and strategy quality."""
    tags = re.findall(r"#\w+", hashtags_str or "")
    if not tags:
        return {"score": 20, "feedback": "No hashtags provided", "tag_count": 0, "tags": []}

    strategy = PLATFORM_HASHTAG_STRATEGY.get(platform, PLATFORM_HASHTAG_STRATEGY["youtube"])
    opt_min, opt_max = strategy["optimal_count"]
    score = 50
    notes = []

    # Count check
    if opt_min <= len(tags) <= opt_max:
        score += 20
        notes.append(f"{len(tags)} hashtags (optimal for {platform}: {opt_min}-{opt_max})")
    elif len(tags) > strategy["max_count"]:
        score -= 15
        notes.append(f"{len(tags)} hashtags exceeds limit ({strategy['max_count']}) -- algorithm may suppress")
    else:
        score -= 10
        notes.append(f"Only {len(tags)} hashtags -- add more for better discoverability (target {opt_min}-{opt_max})")

    # Shorts mandatory tag check
    if platform == "shorts":
        has_shorts_tag = any(t.lower() in ["#shorts", "#short", "#reels"] for t in tags)
        if has_shorts_tag:
            score += 15
            notes.append("#Shorts tag present (required for Shorts algorithm classification)")
        else:
            score -= 20
            notes.append("Missing #Shorts tag -- critical for Shorts algorithm discoverability")

    # Topic relevance check
    if transcript_text and topic_category:
        topic_keywords = TOPIC_KEYWORD_MAP.get(topic_category, [])
        tag_text = " ".join(t[1:].lower() for t in tags)
        keyword_matches = sum(1 for kw in topic_keywords if kw.split()[0] in tag_text)
        if keyword_matches >= 2:
            score += 15
            notes.append(f"Hashtags align with detected topic ({topic_category.replace('_', ' ')})")
        elif keyword_matches == 1:
            score += 8
            notes.append("Some hashtag-to-topic alignment")
        else:
            notes.append("Hashtags don't match transcript topic -- may miss target audience")

    # Specificity diversity (mix of long/short = broad + niche)
    tag_lengths = [len(t) for t in tags]
    avg_len = sum(tag_lengths) / len(tag_lengths) if tag_lengths else 0
    if avg_len > 9:
        score += 10
        notes.append("Good specificity (niche-leaning hashtag mix)")
    elif avg_len < 5:
        score -= 5
        notes.append("Hashtags are very short/generic -- add niche-specific tags for better targeting")

    return {
        "score": min(100, max(0, score)),
        "feedback": "; ".join(notes),
        "tag_count": len(tags),
        "tags": tags,
    }


def get_video_metadata(video_path):
    """Get basic metadata."""
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json",
           "-show_format", "-show_streams", video_path]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout)
    except Exception:
        return {}


def analyze(video_path, transcript_path=None, platform=None, hashtags_str=None):
    """Run hashtag relevance analysis."""
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    metadata = get_video_metadata(video_path)
    duration = float(metadata.get("format", {}).get("duration", 0))

    if not platform:
        for s in metadata.get("streams", []):
            if s.get("codec_type") == "video":
                w = int(s.get("width", 0))
                h = int(s.get("height", 0))
                platform = "shorts" if (h > w and duration < 62) else "youtube"
                break
        platform = platform or "youtube"

    transcript_text = parse_transcript(transcript_path)
    keywords = extract_keywords(transcript_text) if transcript_text else []
    content_type = detect_content_type(transcript_text)
    topic_category = detect_topic_category(transcript_text)
    suggested_hashtags = generate_suggested_hashtags(keywords, content_type, topic_category, platform)
    strategy = PLATFORM_HASHTAG_STRATEGY.get(platform, PLATFORM_HASHTAG_STRATEGY["youtube"])

    if hashtags_str:
        hashtag_result = score_provided_hashtags(hashtags_str, transcript_text, topic_category, platform)
        final_score = hashtag_result["score"]
        notes = [hashtag_result["feedback"]]
    else:
        # No hashtags provided: score the opportunity gap
        final_score = 35
        notes = ["No hashtags provided for evaluation. Use --hashtags to score existing hashtags."]
        if transcript_text:
            opt_min, opt_max = strategy["optimal_count"]
            notes.append(f"Content type: {content_type}. Topic: {(topic_category or 'general').replace('_', ' ')}.")
            notes.append(f"Recommend {opt_min}-{opt_max} hashtags for {platform}. See suggested_hashtags field.")
        else:
            notes.append("Provide --transcript for content-specific hashtag suggestions.")

    return {
        "tool": "analyze-hashtag-relevance",
        "version": "1.0.0",
        "video_path": video_path,
        "platform": platform,
        "has_transcript": transcript_text is not None,
        "scores": {
            "hashtag_relevance": {
                "score": final_score,
                "feedback": "; ".join(notes),
                "raw": {
                    "content_type": content_type,
                    "topic_category": topic_category,
                    "top_keywords": keywords[:10],
                    "platform_strategy": strategy["notes"],
                },
            }
        },
        "overall_score": final_score,
        "suggested_hashtags": suggested_hashtags,
        "hashtag_strategy": {
            "platform": platform,
            "optimal_count": f"{strategy['optimal_count'][0]}-{strategy['optimal_count'][1]}",
            "notes": strategy["notes"],
        },
        "warnings": (
            ["No transcript provided -- hashtag suggestions are generic. Use --transcript for content-specific recommendations."]
            if not transcript_text
            else []
        ),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze-hashtag-relevance.py <video_path> [--transcript <path>] [--platform shorts|youtube|linkedin] [--hashtags '#tag1 #tag2']")
        sys.exit(1)

    video_path = sys.argv[1]
    transcript_path = None
    platform = None
    hashtags_str = None

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
