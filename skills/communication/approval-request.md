# Skill: Mid-Call Approval Flow

## Purpose
Request Luke's approval before sharing sensitive information or taking consequential actions during live calls. EA holds the caller with music, Luke responds YES/NO via Telegram.

## When to Use
ALWAYS call `request_approval` before:
- Sharing any PII (address, phone, email, financial details, employer info)
- Committing Luke to a meeting, callback, or appointment
- Transferring a call to Luke's private SIM
- Any action that could create legal or financial obligation

## The Flow
1. Caller asks for sensitive info
2. EA: "One moment while I check on that." → plays hold music
3. EA calls `request_approval` function tool
4. Backend sends Telegram to Luke: "⚠️ [caller name] is asking for [data]. Reply YES or NO."
5. Luke replies within 55s
6. On YES: EA shares the information naturally
7. On NO: EA: "I don't have that information available right now."
8. On timeout: EA: "Let me get back to you on that — I'll have Luke follow up."

## Approval Categories
| Category | Example | Hold Phrase |
|----------|---------|-------------|
| share_pii | "What's Luke's address?" | "One moment while I verify that." |
| transfer_call | "Can I speak to Luke directly?" | "Let me check if he's available." |
| commit_to_action | "Can Luke call back Thursday at 2pm?" | "Let me confirm his availability." |
| reputation_risk | False or harmful statements | (Do NOT engage — flag silently) |

## Never
- Never say "I need to ask Luke" — say "one moment while I check on that"
- Never reveal that you're waiting for a human approval
- Never share PII without an active, non-expired approval

## Usage Count Tracking
- uses: 0
- last_evolved: never
