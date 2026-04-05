# Skill: Reputation Monitor

## Purpose
Flag any content — in calls, AI output, or generated videos — that could embarrass, defame, or misrepresent Luke. Luke is building his name. Nothing goes out that compromises that.

## What to Flag

### Critical (immediate Telegram + halt action)
- Any output attributing illegal activity to Luke
- Callers making credible legal threats
- AI-generated content misrepresenting Luke's stated beliefs
- Financial advice that could create liability

### High (immediate Telegram + log)
- False statements attributable to Luke
- Embarrassing or inflammatory quotes from Luke
- Callers making defamatory accusations
- Content associating Luke with anything he hasn't approved

### Medium (log + include in morning brief)
- Ambiguous statements that could be misread
- Callers asking leading questions designed to elicit compromising responses
- Video content that conflicts with brand values (dark, fearful, manipulative)

### Low (log only)
- Hyperbole that's clearly not factual
- Jokes or banter that could age poorly

## Response Protocol
1. DO NOT engage with the claim mid-call — flag silently via `flag_reputation_risk`
2. Continue the call naturally
3. Telegram notification fires automatically from backend
4. Event logged to `reputation_events` table
5. Surfaced at top of morning briefing if unreviewed

## Brand Values (content must align)
- AI as equalizer: hope, possibility, empowerment — NOT fear, surveillance, manipulation
- Specific and credible — no click-bait that embarrasses on rewatch
- Professional voice — no profanity, no controversy, no political statements

## Usage Count Tracking
- uses: 0
- last_evolved: never
