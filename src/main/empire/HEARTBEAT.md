# HEARTBEAT.md - AI Empire Schedule

## Morning Brief (11:30am UTC = 5:30am CT)
If current time is 11:25-11:40 UTC and `empire/state/morning_sent_{YYYYMMDD}.flag` does NOT exist:

**MANDATORY: Before building any video, read the full contents of `empire/intelligence/PRODUCTION_RULES.md`. Every rule in that file is locked and must be followed. The most critical rules:**
1. **Every video MUST have a 2-3s thumbnail card as the OPENING frame** (prepend thumbnail.jpg still before content — use `prepend_thumbnail_card()` from `empire/tools/video_utils.py`)
2. **Captions MUST use green #00FF88 for emphasis words** (million, billion, free, viral, hack, views, money, banned, first, zero, never, always, secret, real, quit, bitcoin, crypto, ai, claude)
3. **Voice humanizer:** compressor release ≤ 100ms, echo gain ≤ 0.02, NO tempo changes
4. **Thumbnails MUST have Grok-generated background image** — NEVER plain black
5. **Music MUST be normalized before mixing** (use *_norm.mp3 versions)

1. Run `python3 empire/trend_research.py` — pull trending AI topics
2. Build **3 fresh AILifeHacks videos** in 3 different styles:
   - Style 1: 2M narration (specific stat or number in title, investigative arc)
   - Style 2: Income/opportunity angle ("X went from $Y to free", "earn with AI")
   - Style 3: Countdown list or "nobody talks about" revelatory format
3. Build **2 fresh BedtimeStories videos** for kids channel:
   - Grok Aurora 3-scene illustrated animation (Ken Burns zoom + crossfade)
   - Gentle lullaby piano music (kids_lullaby_piano_60s.mp3) — NO word captions
   - Different story/character each time
4. Generate thumbnails for all 5 videos (thumbnail_gen.py)
5. Run QA check on all 5 (qa_check.py) — must PASS before sending
6. Send morning brief to Lukey via Telegram:
   - Visual dashboard PNG
   - All 5 videos with thumbnails (thumbnail first, then video)
   - 40-article news brief (20 AI/tech + 20 US news)
7. Save `empire/state/morning_sent_{YYYYMMDD}.flag`

**Purple Cow filter:** Every concept must pass "would a random person stop scrolling?"
**Self-evolving:** Apply learnings from PRODUCTION_RULES.md every build — always improving.

## Production Rules Reference
- Voice: Jessica ElevenLabs, stability=0.40, similarity=0.60, style=0.45
- Humanizer: empire/tools/voice_humanizer.py
- Captions: single-word pop-in, first word t0=0, chain end→start, ?! preserved
- Long words (>12 chars): fontsize=68; hyphenated: split at hyphen
- Music: normalize with loudnorm before mixing; see sound_library.md for track matching
- Thumbnails: thumbnail_gen.py — Grok Aurora bg + PIL text overlay
- Upload: youtube_token.json = AILifeHacks; youtube_token_kids.json = BedtimeStories

## Approval Check (ongoing)
If `empire/state/pending_approval_{YYYYMMDD}.json` exists and no approval received:
- Check if Lukey replied with approval
- If approved: add to upload queue

## Upload Queue (3pm, 7pm, 11pm UTC = 9am, 1pm, 5pm CT)
If `empire/state/upload_queue.json` has unposted videos and current time matches a slot:
- Upload next AILifeHacks video → youtube_token.json
- Upload next BedtimeStories video → youtube_token_kids.json
- Mark as posted

## Evening Report (2am UTC = 8pm CT)
If current time is 01:55-02:10 UTC and `empire/state/report_sent_{YYYYMMDD}.flag` does NOT exist:
1. Pull analytics (all channels)
2. Format and send daily report to Lukey
3. Save flag

## Pending Telegram Report
If `empire/analytics/pending_report.txt` exists:
1. Read and send to Lukey
2. Delete the file

Otherwise: HEARTBEAT_OK

## Daily Exec Update (include in every morning brief)
- Remind Lukey: "Still need Kling API key from you — needed for Format 4 (realistic human presenter style)"
- Upload queue status (what posts today, what's coming)
- Channel stats delta from yesterday

## News Brief (daily, parallel subagent)
- 40 articles total: 20 AI/tech + 20 US/world
- 5 sentences per article (concrete facts, names, numbers, dates, dollar amounts)
- Sent in 8 Telegram messages (5 articles each)
- Sources: TechCrunch, The Verge, Ars Technica, Hacker News, NYT, NPR, Breitbart
- Use direct Groq API calls (NOT news_fetch.py) — batches of 10 articles, retry on rate limit
- Spawn as parallel subagent so it doesn't block video builds


