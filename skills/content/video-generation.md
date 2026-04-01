# Skill: Video Generation

## Purpose
Build YouTube shorts for AILifeHacks and BedtimeStories channels using the empire tool stack.

## Channel Specs

### AILifeHacks (UCnCUvNwfV9Sivf30xy_MyRg)
- Format: 45-90s vertical short
- Voice: ElevenLabs Jessica (cgSgspJ2msm6clMCkdW9), stability=0.40, similarity=0.60
- Captions: single-word pop-in, green #00FF88 for emphasis words
- Emphasis words: million, billion, free, viral, hack, views, money, banned, first, zero, never, always, secret, real, quit, bitcoin, crypto, ai, claude
- Music: normalized _norm.mp3 versions only, mixed at -18dB
- Thumbnail: Grok Aurora background + PIL text overlay (NEVER plain black)
- Opening: 2-3s thumbnail card prepended (mandatory, enforced in code)

### BedtimeStories (UCw-XcdSwe_kLYNzQ2JT3mDg)
- Format: 2-4min illustrated short
- Voice: ElevenLabs Jessica, same settings
- Music: kids_lullaby_piano_60s.mp3 — NO word captions
- Animation: Grok Aurora 3-scene Ken Burns zoom + crossfade
- Each story: unique character, unique setting

## Build Order (enforced in video-pipeline.ts)
1. `trend_research.py` — trending AI topics
2. `build_video.py --channel --style --output-dir` × 5
3. `qc_agent.py [video_path]` × 5 — all must pass before Luke sees anything
4. Populate manifest.json → Content Pipeline tab

## QC Gate (18 checks, all must pass)
File exists, size > 500KB, duration 45-240s, audio present, thumbnail exists and isn't black,
thumbnail card in first 3s of video, voice files present, correct resolution (1080×1920),
captions present (AILifeHacks), Telegram preview version < 50MB.

## Purple Cow Test
Before any script is finalized: "Would a random person stop scrolling?"
- Specific > generic ("ChatGPT Uninstalls Up 295%" > "AI is Changing Everything")
- Provable claim or shocking stat in title
- Visual hook in first 2s

## Cost Target
< $0.50/video including: voice generation, image generation, LLM script writing.

## Upload Schedule
- 9am CT, 1pm CT, 5pm CT
- AILifeHacks uploads via youtube_token.json
- BedtimeStories uploads via youtube_token_kids.json

## Usage Count Tracking
- uses: 0
- last_evolved: never
