# Skill: Meeting Summary

## Purpose
Synthesize Otter.ai transcripts into actionable meeting notes Luke can act on in 2 minutes.

## Output Format
```
## [Meeting Title] — [Date]
**Who**: [Names and roles]
**Duration**: [X min]

### Key Decisions
- [Decision 1]
- [Decision 2]

### Action Items
- [ ] [Luke's action] — due [date if mentioned]
- [ ] [Others' actions]

### Context (brief)
[1-2 sentences on what this meeting was about]

### Follow-up needed?
[Yes/No — and why if yes]
```

## Rules
- No filler summaries ("Great meeting, everyone discussed...")
- Decisions first, context last
- Flag any commitments Luke made that require calendar time
- If the meeting was Luke talking to himself (voice memos): just bullet the key thoughts
- Never invent action items — only include what was explicitly said

## Tagging
Auto-tag with: people mentioned, companies, project names, dates, dollar amounts

## Usage Count Tracking
- uses: 0
- last_evolved: never
