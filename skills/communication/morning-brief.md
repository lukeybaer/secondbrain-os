# Skill: Morning Brief

## Purpose
5:30 AM CT daily briefing via Telegram. Luke wakes to a complete picture of his day.

## Structure (always in this order)

```
⚠️ SECURITY FLAGS    [PII disclosures + reputation events — ALWAYS FIRST if any]
📋 TODAY             [Scheduled tasks + key dates]
🎯 GOALS             [Progress on active projects]
📞 CALLS             [Inbound summaries + pending callbacks]
🎬 CONTENT           [Videos pending review + upload queue status]
🧠 MEMORY UPDATES    [New contacts, promoted memories]
💬 MESSAGES          [Telegram threads needing response]
📰 NEWS              [Top 5 AI/tech + top 5 US news headlines]
```

## Rules
- Security flags ALWAYS appear first if any exist
- Max 3 bullet points per section (brief = brief)
- Numbers > 1,000 use commas. Dates use natural language ("Wednesday", not "2026-04-01")
- No filler phrases ("Here's your brief" etc.) — jump straight to content
- Sent as single Telegram message unless content > 4096 chars (then split by section)
- Timezone: America/Chicago (CT)

## On Failure
- If news API fails: skip news section, note "News unavailable"
- If video pipeline failed: mention it in CONTENT section with count of pending
- If Telegram fails: retry 3× with 30s backoff, then log and give up

## Usage Count Tracking
- uses: 0
- last_evolved: never
