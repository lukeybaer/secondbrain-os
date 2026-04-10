#!/bin/bash
# PreToolUse hook: validate Vapi call parameters before any outbound call
# Guards against: insufficient silence timeout, low max duration, bridge-in language in prompts

COMMAND=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.tool_input?.command||'')}catch{console.log('')}})" 2>/dev/null)

# Only check commands that hit Vapi API
if echo "$COMMAND" | grep -qiE 'vapi\.ai/call|initiateCall|vapi'; then

  # Check silence timeout — must be >= 300
  SILENCE=$(echo "$COMMAND" | grep -oP 'silenceTimeout[Ss]econds["\s:=]+\K[0-9]+' || echo "")
  if [ -n "$SILENCE" ] && [ "$SILENCE" -lt 300 ]; then
    echo "BLOCKED: silenceTimeoutSeconds is $SILENCE — must be >= 300. Amy needs time to think and the caller needs time to respond. Fix and retry." >&2
    exit 2
  fi

  # Check max duration — must be >= 600
  MAXDUR=$(echo "$COMMAND" | grep -oP 'maxDuration[Ss]econds["\s:=]+\K[0-9]+' || echo "")
  if [ -n "$MAXDUR" ] && [ "$MAXDUR" -lt 600 ]; then
    echo "BLOCKED: maxDurationSeconds is $MAXDUR — must be >= 600. Calls can run long, especially with hold times and phone trees. Fix and retry." >&2
    exit 2
  fi

  # Check for bridge-in language in the prompt/instructions — Amy should say "let me check with Luke and call back"
  if echo "$COMMAND" | grep -qiE 'bridge.*luke|transfer.*luke|connect.*to.*luke|patch.*luke'; then
    echo "WARNING: Detected bridge-in language in call instructions. Amy should NEVER offer to bridge Luke in. She should say 'let me check with Luke and call you back.' Review the prompt." >&2
  fi
fi

exit 0
