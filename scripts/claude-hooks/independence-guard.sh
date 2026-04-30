#!/usr/bin/env bash
# independence-guard.sh
#
# Hook: PostToolUse scan of assistant text for permission-asking phrases.
# Injects a systemMessage reminder when drift is detected, so the next
# model turn sees the flag and can self-correct.
#
# Triggers on: "want me to", "should i proceed", "would you like",
# "let me know if", "do you want me to", "or do you want", "want to
# hold off". Case-insensitive.
#
# See memory/feedback_independence_regression_pattern.md for the full
# rule. The rule: proactive, not instructional. Never stall for
# permission. Permission-asking is reserved for truly irreversible
# actions (payment, PII disclosure, public post, account creation).

set -euo pipefail

# Hook receives the tool call + result as JSON on stdin. For our purposes
# we scan the most recent assistant turn from the session transcript.
INPUT=$(cat)

# Extract the assistant response text if present in the input. The exact
# shape depends on Claude Code's hook input format.
TEXT=$(printf '%s' "$INPUT" | tr '\n' ' ' | sed 's/[^[:print:][:space:]]//g')

# Patterns that indicate consultant-mode drift
PATTERNS=(
  '[Ww]ant me to'
  '[Ss]hould [Ii] proceed'
  '[Ww]ould you like'
  '[Ll]et me know if you want'
  '[Dd]o you want me to'
  '[Oo]r do you want'
  '[Ss]hould [Ii] start'
  '[Ss]hould [Ii] go ahead'
  '[Ww]ant to hold off'
  '[Rr]eady to proceed'
)

HITS=""
for pat in "${PATTERNS[@]}"; do
  if printf '%s' "$TEXT" | grep -Eq "$pat"; then
    HITS="$HITS  - matched: $pat\n"
  fi
done

if [ -n "$HITS" ]; then
  printf '{"systemMessage": "INDEPENDENCE GUARD: your last turn contained permission-asking language. Owner rule: proactive, not instructional. Decide and execute. Reserve permission for irreversible actions (payment, PII, public post, account creation). Drift triggers:\n%s\nSee memory/feedback_independence_regression_pattern.md"}' "$HITS"
else
  printf '{}'
fi
