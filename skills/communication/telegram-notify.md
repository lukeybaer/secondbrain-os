# Skill: Telegram Notifications

## Purpose
Rules for when and how to notify Luke via Telegram. Luke's attention is precious — notify only when necessary.

## Notification Tiers

### Immediate (send now, any time)
- Inbound call from unknown caller with urgent message
- PII shared on a call (even if approved — audit trail)
- Reputation risk flagged during any call
- Video pipeline failure (total, not partial)
- Security event (unknown caller claiming emergency)

### Batched (include in morning brief)
- Call summaries and outcomes
- Content pipeline status
- Memory updates and new contacts
- Routine task completions

### Never notify
- Routine status (pipeline starting, minor errors)
- Duplicate alerts (same event twice)
- Anything after 10pm CT unless the message is "Immediate" tier

## Message Format
- Lead with emoji icon then category label
- One sentence per point — no paragraphs
- Phone numbers in E.164 format (+1XXXXXXXXXX)
- Never include full transcripts in Telegram — link to the call record

## Quiet Hours
10pm–5am CT: Only Immediate-tier messages. Morning brief fires at 5:30 AM CT.

## Usage Count Tracking
- uses: 0
- last_evolved: never
