# Production Rules — AI Life Hacks Empire
_Last updated: 2026-03-07 — consolidated from all sessions_

---

## ⚠️ ARCHITECTURE NOTE FOR ALL SUBAGENTS
All video builds MUST use empire/tools/build_video.py functions.
Never render captions, mix audio, or finalize a video without using these functions.
The functions enforce all production rules at code level — not docs level.

Key enforced rules:
- EMPHASIS_WORDS → green #00FF88 (in build_captions_filter)
- NOPE PILE check → ValueError if banned topic (in _check_nope_pile)
- Music normalization → always *_norm.mp3 at locked ratios (in mix_audio)
- Thumbnail card → 2.5s opening frame MANDATORY (in prepend_thumbnail_card)
- Watermark → @ailifehacks always (in add_watermark_filter)
- Voice humanizer → always applied after TTS (in generate_voice)

---

## Video Requirements (every video)
- ✅ Music (always — never silent)
- ✅ Thumbnail (always — send with video every time)
- ✅ Captions (word-by-word preferred, green highlight on key words)
- ✅ @ailifehacks watermark bottom right
- ✅ 1080x1920 output
- ✅ No CTA in video — newsletter only in description

## 🚨 THUMBNAIL IN VIDEO — MANDATORY (never skip)
- Every video MUST include a 2-3 second thumbnail card baked into the first frames
- Place as OPENING card: thumbnail frame holds for 2-3s, then cuts into content
- This allows Lukey (and YouTube) to select the thumbnail frame from within the video
- Implementation: prepend a 2.5s still of thumbnail.jpg before the main content using ffmpeg concat
- NEVER deliver a video without this — it is a hard build requirement
- Regression rule: if thumbnail is missing from video, rebuild before sending

## Caption Rules (locked)
- Word-by-word display (max_chars=22 chunks is ok, but word-by-word single-word preferred)
- `end = min(word_end, next_start - 0.05)` — hard gap between words
- 80ms fade-out: `alpha = if(lt(t,fade_start),1,max(0,(t1-t)/0.08))`
- **Sanitize timestamps before use**: clamp each word start >= previous word end
- Key words in green `#00FF88`: million, billion, free, viral, hack, views, money, banned, first, zero, never, always, numbers, claude, pentagon, cursor, exodus, secret, real, dying, paid
- Font: DejaVuSans-Bold, size 72, y=1600
- Strip em-dashes `—`, `–`, smart quotes from all scripts before TTS

## Voice (Jessica)
- ElevenLabs ID: `cgSgspJ2msm6clMCkdW9`
- Narration: stability=0.40, similarity_boost=0.60, style=0.45, use_speaker_boost=False
- Calm/kids: stability=0.75, similarity_boost=0.75, style=0.20
- Always run through voice_humanizer.py after generation

## Music Matching
- `deep_thinking.mp3` → personal/story/reflective
- `hans_zimmer_time_inception.mp3` → big reveals, OYU riddles, serious
- `hopeful_piano.mp3` → empowerment, positive, free tools
- `dark_piano_emotional.mp3` → exodus/backlash/conflict
- `tech_futuristic.mp3` → coding/startup/tools
- `jain_alright_*.mp3` → kind spotlight, kids channel, brand north star
- Music volume: ~0.18–0.25 for voice videos, ~0.20–0.25 for silent videos

## Image Generation (Grok Aurora)
- Model: `grok-imagine-image` via xAI API — $0.20/image (NOTE: `grok-2-image` is deprecated as of 2026-03-11 — use `grok-imagine-image` only)
- Always specify: vertical portrait, 9:16, fill the frame edge to edge, no text in image
- Max output: 768x1408 — always use `scale=1080:-1,crop=1080:1920:0:(ih-1920)/2` in ffmpeg
- NEVER use `pad` — use `scale` then `crop` to fill frame
- 3-color rule for thumbnails: max 3 dominant colors, high contrast, must pop at small size

## Video Formats

### Format 1: 2M-Style Narration
- Voice (Jessica) + stock footage b-roll + word-by-word captions
- Hook in first 3 seconds — data point or contradiction
- Stock via Pixabay (1.5s delay, retry 3x) or Pexels
- Builder: `build_2M_style.py`

### Format 2: OYU Riddle
- No voice — cinematic Grok Aurora image + text overlay only
- Hook must be CRYPTIC and COMPLEX — not obvious on first read
- Must make viewer think "wait... what does that mean?" for several seconds
- Multi-line text, text in safe zone y=1100–1450
- Music: hans_zimmer or dark_piano
- Builder: `build_once_you_understand.py`
- Rule: one OYU per brief max, must pass riddle test

### Format 3: Income/Opportunity Angle
- Specific dollar amount + specific AI tool + specific timeframe
- Real story format ("She fired her VA...") — not generic advice
- Voice narration + stock footage
- Green highlight on dollar amounts and tool names

## Brand Rules
- Visual vibe: Hope, life, light, love, goodness, truth — uplifting, NOT dark
- NO: puppet/manipulation, surveillance, AI inequality, fear
- YES: empowering, wonder, "AI is the great equalizer"
- Brand north star: Jain "Alright" — things gonna be alright

## Text Safe Zone
- Safe: y=1100–1450 on 1920px canvas
- NEVER: top 150px (YouTube chrome), bottom 380px (channel info/subscribe button)
- Text captions at y=1600 is correct for lower third narration

## Upload Rules
- 1 video/day max
- Morning brief approval required before any upload
- Queue: `empire/state/upload_queue.json`
- Always show thumbnail + video together when proposing
- Never upload same day as another video (queue only)

## Cost Targets
- Per video: <$0.50
- Grok Aurora image: $0.20 each
- ElevenLabs voice: ~$0.02–0.05 per video
- Groq: free (use ask_small for news/formatting, ask for scripts)
- Claude: final scripts + strategy only

## Morning Brief
- Time: 5:30am CT (11:30am UTC) — cron ID `45b7cdaa-b047-4ede-8a34-19fb1e41534a`
- Must include: 3 new finished videos (different formats), each with thumbnail
- Must include: visual dashboard PNG
- Must include: 40-article news brief (Part 1: AI/tech, Part 2: US news)
- Videos must pass Purple Cow test: "would a random person stop scrolling?"

## Purple Cow Test
Every video must answer YES to: "Would a random person stop scrolling for this?"
- Generic = fail ("AI tools are changing everything")
- Specific + strange = pass ("She fired her $1,400/month VA for one Claude prompt")
- Obvious OYU = fail ("Once you understand AI agents")
- Cryptic OYU = pass (requires 3+ seconds to decode)

## Volume Rules (learned 2026-03-07)
- Voice output from ElevenLabs + humanizer is already loud
- Music at 0.35 relative to voice = too loud (buries voice, feels like music video)
- **Target mix**: voice=1.0, music=0.18-0.22 in amix
- **Final output volume**: -0.6x (60% of rendered) if mix still sounds hot
- Calibration: render → Lukey review → if too loud, apply `volume=0.6` to final output
- Never go above music vol=0.25 relative to voice
- Silent OYU videos: music vol=0.20-0.25 absolute (no voice to compete with)

## QA Checklist (mandatory before every send)
Run `python3 empire/tools/qa_check.py <path>` on every video before sending or queuing.
Must pass ALL:
- ✅ Video stream present, 1080x1920
- ✅ Audio stream present, bitrate >30kbps
- ✅ Duration 15–60s
- ✅ File size >500KB
- ✅ Thumbnail exists alongside video
- ✅ Music audible (not just voice)
- ✅ Captions burned in (visually verify at least one frame)

Never send a video that hasn't passed QA. No exceptions.

## Telegram Preview Compression
- Telegram max: 16MB
- For 54s+ videos: scale to 720x1280, crf=28, audio 160kbps
- For ≤30s videos: scale 1080x1920, crf=26, audio 128kbps
- The _tg.mp4 preview is NOT the upload copy — upload always uses full 1080x1920 master

---

## ✅ Approved Video Formulas (What's Working)

### chatgpt_exodus — 869 views in ~8h (posted Mar 8, 2026)
**Title:** "ChatGPT Uninstalls Are Up 295% — Is the Backlash Real?"
**What worked:**
- Specific number in title (295%) — creates immediate curiosity + credibility
- "Is the backlash real?" = open question viewers want answered = high completion
- 2M narration style — stock footage background, single-word captions
- Tension arc: accusation → evidence → counterpoint → open question
- Not fear-based — genuinely curious, investigative tone
- Short and punchy (under 35s)

### anthropic_vs_pentagon_v13 — APPROVED for queue (Mar 8, 2026)
**Title:** "They Banned Claude Publicly — Then Used It in Secret"
**What worked:**
- Single-word pop-in captions (one word per frame, no overlap)
- Words chain end→start: t0=word.start, t1=next_word.start (zero overlap, zero gap)
- First word t0=0 (catches super-short Whisper timestamps on first word)
- `?` and `!` preserved in captions (removed from BAD chars set)
- Long words (>12 chars) rendered at fontsize=68 instead of 88
- Hyphenated compounds split into two caption words (GOVERNMENT- / CONTROLLED)
- Music normalized to -14 LUFS before mixing (prevents inaudible quiet sections)
- Music at 2.34x relative to voice 1.0 (normalized track needs higher ratio)
- dark_cinematic_inception_norm.mp3 = correct track for this tone
- "THOUSANDS" fix: first word t0 forced to 0.0 regardless of Whisper timestamp
- Contrast arc: public denial → secret government use → moral question
- Hyphen/punctuation in titles reads as conflict/tension

---

## 🎬 Complete Production Spec: anthropic_vs_pentagon_v13 (APPROVED)

### Source Files
- **Voice:** `voice_human.mp3` — Jessica (ElevenLabs `cgSgspJ2msm6clMCkdW9`), stability=0.40, similarity=0.60, style=0.45, speaker_boost=False → humanizer applied
- **Background:** `bg_v3.mp4` — Pixabay stock clips looped with `-stream_loop -1`
- **Music:** `dark_cinematic_inception_norm.mp3` — dark_cinematic_inception.mp3 normalized with `loudnorm=I=-14:TP=-1:LRA=7` before mixing

### Stock Clip Queries (Pixabay via clips.py)
1. `"pentagon building aerial government"` — 7s
2. particle background — 6s
3. `"government document meeting professional"` — 8s
4. particle background — 6s
5. `"technology AI screen data digital"` — 8s
6. `"news leak secret document reveal"` — 7s
7. particle background — 8s

### Audio Mix
```
[voice]volume=1.0[va]
[music]volume=2.34[m]
amix=inputs=2:duration=first
```
- Music MUST be loudnorm-normalized first (`dark_cinematic_inception_norm.mp3`)
- Raw track is too dynamic (LRA=21dB) — quiet sections go inaudible at any volume
- 2.34x = the correct ratio for this normalized track + voice balance

### Caption System (locked spec for all future builds)
- One word per caption (single-word pop-in)
- `t0 = 0.0` for first word (forces visibility regardless of Whisper start time)
- `t0 = word.start` for all other words
- `t1 = next_word.start` (clean end-to-start chain, zero overlap, zero gap)
- `t1 = min(t1, dur)` — never exceed video duration
- Minimum t1-t0 = 0.12s (fade time floor)
- Fade: `fade_start = max(t0, t1 - 0.08)` → alpha fades over 80ms
- Font: DejaVuSans-Bold, fontsize=88 default, fontsize=68 for words >12 chars
- Color: `#00FF88` green for emphasis words, white for rest
- `?` and `!` preserved (NOT in BAD chars set)
- Hyphenated words (e.g. `government-controlled`): split at hyphen → two captions at midpoint timestamp
- `@ailifehacks` watermark: bottom-right, fontsize=32, white@0.5, always on

### Output
- Resolution: 1080x1920
- Codec: libx264, crf=18, preset=fast
- Audio: aac, 192kbps
- TG preview: scale=720:1280, crf=28, audio=256kbps

### Tone/Format
- Title format: `[They Did X] — [Then Did Opposite]` → conflict + contradiction hook
- Arc: public claim → secret reality → moral question
- Music: dark_cinematic_inception for government/military/banned/secret topics

---

## ✅ LOCKED: Kids Channel Format (approved 2026-03-08)
Notes: Both cloud + lighthouse stories approved. Keep coming daily.
- channel: BedtimeStoriesWithLukeyBaer (UCw-XcdSwe_kLYNzQ2JT3mDg)
- token: empire/youtube_token_kids.json (NEVER use main token)
- queue: empire/state/kids_upload_queue.json (SEPARATE from main)
- scenes: 3x Grok Aurora watercolor illustrations ($0.20 each)
- animation: Ken Burns zoompan z=1.0→1.08, xfade crossfade 0.5s between scenes
- voice: Jessica ElevenLabs + humanizer, volume=1.2
- music: kids_lullaby_piano_60s.mp3, volume=0.18
- captions: NONE (storybook narration — no word-by-word captions)
- title overlay: first 4s only, fontsize=60, white with shadow
- watermark: @BedtimeStoriesWithLukeyBaer, bottom center, fontsize=22, white@0.4
- extend video: tpad=stop_mode=clone to match voice duration exactly
- output: 1080x1920, crf=18, aac 192kbps
- daily cadence: 2 new stories per morning brief

---

## 🎚️ Music/Voice Calibration (measured 2026-03-08)

Voice humanized baseline: ~-17dB mean
Target: music sits 8-12dB below voice in final mix

| Track | Native dB | amix volume |
|-------|-----------|-------------|
| kids_lullaby_piano_60s.mp3 | -26.1 dB | **0.55** |
| dark_cinematic_inception_norm.mp3 | -13.7 dB | **2.34** |
| hopeful_piano_norm.mp3 | -15.9 dB | **0.35** |
| tech_futuristic_norm.mp3 | -13.4 dB | **0.22** |

Rule: when adding a new track, measure mean_volume with ffmpeg volumedetect.
Target music mean = voice_mean + 8 to 12dB (music should feel supportive, not competing).
Apply loudnorm=I=-16:TP=-1.5:LRA=11 on the final amix output.

---

## ✅ LOCKED: Thumbnail Style (approved 2026-03-08)
The canonical thumbnail design — dark navy bg, bold white title, blue accent, gray subtitle, watermark.

```python
# Canonical thumbnail generator
W, H = 1080, 1920
bg_color = (10, 10, 26)          # dark navy
accent_color = (70, 130, 230)    # blue line
title_color = (255, 255, 255)    # white
subtitle_color = (200, 200, 200) # light gray
watermark_color = (150, 150, 180)

# Blue accent line: centered, ~80px wide, at ~y=380
# Title: DejaVuSans-Bold 108pt, centered, starting y=440, line height 130
# Subtitle: DejaVuSans 58pt, centered, ~30px below last title line
# Watermark: DejaVuSans 36pt, centered, y = H-80
```

Reference file: empire/videos/anthropic_vs_pentagon/thumbnail_FINAL.jpg

---

## ✅ LOCKED: Thumbnail Styles (approved 2026-03-08)
- **split_red** ✅ APPROVED — red diagonal slash, dark bg, bold white text — use for conflict/drama topics
- navy_bold — baseline fallback only, not a stopper
- classified — not yet rated
- glow_neon — not yet rated
- gold_money — not yet rated
- minimal_bold — not yet rated

## Thumbnail Rotation Rule
Rotate styles by topic:
- Government/banned/conspiracy → classified or split_red
- AI tools/tech → glow_neon
- Money/income → gold_money
- General → split_red or navy_bold

## Media Sending Protocol (locked)
When sending multiple images for feedback, caption each with style name:
  "[1/N] style_name — description"
So reply context identifies the exact asset approved.

## ✅ LOCKED: brand_bar thumbnail style (approved 2026-03-08)
- Dark navy bg (8,8,20), bold white headline above center bar
- Blue horizontal bar at H//2 with "AI LIFE HACKS" in white bold
- Gray subline below bar
- Auto-fit font via _fit_font_lines() — no clipping ever
- Use for: general/authoritative topics
- File: empire/analytics/thumb_previews/thumb_brand_bar_v2.jpg

## ✅ LOCKED: classified thumbnail style (approved 2026-03-08)
- Dark navy bg with grid lines, red diagonal CLASSIFIED stamp
- Red border frame, bold white headline top, gray subline bottom
- Use for: secret/government/leaked/pentagon topics
- Auto-fit font required — _fit_font_lines() before all text draws

## ✅ Approved thumbnail rotation (as of 2026-03-08)
| Style | Use for |
|-------|---------|
| split_red | ban/conflict/controversy |
| brand_bar | general/authoritative |
| classified | secret/government/leaked |
| glow_neon | pending rating |
| gold_money | pending rating |

## RULE: Multi-media sends — always number + name captions
When sending multiple images/videos for feedback, ALWAYS caption each:
  "[1/N] style_name — brief description"
This allows reply context to identify exactly which asset is being approved/rejected.
BREAKING THIS RULE = I know immediately, I say so, I re-send correctly numbered.

## RULE: Rules are a living knowledge base
When I break a rule or learn something new:
1. Say what rule I broke
2. Say what I'm doing to fix it
3. Update PRODUCTION_RULES.md or the relevant file immediately
No silent failures. No "I'll remember next time." Write it down.

---

## ❌ NOPE PILE — Topics That Get Suppressed (2026-03-08)
- **anthropic_vs_pentagon / Claude banned by government** — 0 views across 3 thumbnail variants
- Problem: metadata (government/military/banned/Claude keywords) likely triggers algorithm suppression
- Not a thumbnail problem — content itself is flagged
- Rule: avoid topics involving AI + government + weapons/military contracts
- Stick to: tools, income, data, predictions, company drama (not national security angle)
- **"Switch to Claude / use Claude instead" framing** — rejected by Lukey (2026-03-14): makes channel look like Claude advertiser. Neutral AI comparisons are OK but never brand advocacy for a specific AI.

---

## Thumbnail Research Findings
_Compiled 2026-03-09 — Full research in THUMBNAIL_RESEARCH.md_

### The 5 Laws (Distilled)
1. **3-Second Glance Rule** — must communicate promise in <3s at any size; one focal point
2. **Contrast = Visibility** — high contrast outperforms by 2-3x CTR; dark bg + bright accents
3. **Emotion Before Information** — extreme emotion (shock, joy) drives 30-40% higher CTR
4. **The Unexpected Interrupts the Pattern** — boring descriptive = scroll-past; unexpected = double-take = click
5. **Mobile-First** — design for 120x68px tiny phone view; max 3-5 bold words, max 3 colors

### Lure Text vs Unexpected Pop
- ❌ LURE TEXT (boring/generic): "Top 5 AI Tools", "Make Money with AI", "AI Will Change Everything"
- ✅ UNEXPECTED POP (specific/tense): "Cursor wrote 847 lines. I wrote 0.", "YouTube just banned this AI tool", "$847 in 3 hours. Claude did the work."
- Formula: `[Specific outcome or violation] + [Named tool] + [Implied stakes]`

### BedtimeStories Rules (Kids Thumbnails — Different Playbook)
- Audience is DUAL: child (visual wonder) + parent (safety/quality signal)
- **Under 6**: NO text. Zero. None.
- **6-10**: max 3 words, large rounded font only
- Best triggers: unexpected creature in human situation, big warm eyes, round shapes
- Color: warm gold + purple, teal + orange — saturated but harmonious (Disney palette)
- NO dark/scary/sharp — parent swipes away immediately
- The wonder test: "Does this make a 5-year-old say 'what's THAT?'"

### Grok Prompt Rules for Thumbnails
- Always: `vertical portrait 9:16, fill frame edge to edge, NO text in image`
- AILifeHacks: cinematic photorealistic, dramatic lighting, glowing tech elements
- BedtimeStories: soft dreamy painterly, warm magical lighting, whimsical/enchanting
- Unexpected creature formula: `[creature] doing [human activity] in [cozy setting], soft warm lighting`
- See THUMBNAIL_RESEARCH.md for full prompt templates per content type

### The Unexpected Principle
Descriptive = tells viewer what they'll see = no reason to click
Unexpected = creates curiosity gap = brain must resolve = forces click
Thumbnail = question. Video = answer.

---

## 🚨 Regression Fixes (2026-03-10)

### Caption Green Highlights — REQUIRED
- `EMPHASIS_WORDS` set MUST be present in `captions.py`
- Emphasis words get `fontcolor=#00FF88` (green), all others get `fontcolor=white`
- Words covered: million, billion, free, viral, hack, views, money, banned, first, zero, never, always, secret, real, quit, ethics, paid, lost, wrong, nine, bitcoin, crypto, ai, gpt, claude, cursor, exodus, dying, numbers, pentagon, leaked, fired, exposed, hidden, truth, fake, illegal, stolen, richest, fastest, biggest, largest, worst, best, only, last, dead, broke
- If captions look all-white — the emphasis logic is missing. Restore it.

### Voice Humanizer — NO Pauses
- `voice_humanizer.py` must NOT introduce timing changes that create pauses
- `atempo`, `asetrate`, or any tempo-altering filter is PROHIBITED (or must stay 0.97–1.02)
- `acompressor release` must stay ≤ 100ms (was 200ms — caused pumping artifacts = perceived pauses)
- `aecho` delays must stay subtle: max 50ms delay, gain ≤ 0.02 (was 0.04 — audible echo gap)
- If voices sound choppy or have weird pauses — check compressor release and echo gain first

### News Brief Deduplication — REQUIRED
- `empire/tools/news_dedup.py` exists and must be called before sending morning brief
- `deduplicate_articles(articles, threshold=0.5)` removes same-story duplicates by Jaccard overlap
- Run dedup on BOTH parts of the 40-article news brief (AI/tech + US news)
- No sending a brief where the same story appears from multiple sources

### Thumbnails — Legibility at Small Size
- Text and icons must be 30–40% larger than base design — must be legible at 120×68px
- Test every thumbnail at thumbnail preview size before approving
- Thumbnail placement: first frame hold (2s opening card) OR natural ending beat
- NEVER tack thumbnail awkwardly at the end of the video as an afterthought

### Morning Brief Format — Executive Style
- Results only, no hedging
- ❌ "I think this might work..." → ✅ "Posted. 869 views in 8h."
- ❌ "We could potentially..." → ✅ "Queue has 3 videos ready."
- Lead with numbers, outcomes, and decisions needed — not process or uncertainty
