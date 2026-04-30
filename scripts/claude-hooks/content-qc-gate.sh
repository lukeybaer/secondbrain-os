#!/bin/bash
# PreToolUse hook: block content publishing without QC pass
# Lesson from OpenClaw: QC gate is non-negotiable

COMMAND=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.tool_input?.command||'')}catch{console.log('')}})" 2>/dev/null)

# Detect publish/upload commands for content pipeline
if echo "$COMMAND" | grep -qiE '(youtube.*upload|publish.*video|upload.*content|content.*publish)'; then
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo '.')
  QUEUE="$ROOT/content-review/upload-queue.json"

  if [ -f "$QUEUE" ]; then
    # Check if any items in the queue have qc_passed: false or missing
    UNREVIEWED=$(node -e "
      const q = JSON.parse(require('fs').readFileSync('$QUEUE','utf8'));
      const bad = (Array.isArray(q) ? q : q.items || []).filter(i => !i.qc_passed);
      if (bad.length > 0) { console.log(bad.length + ' items have not passed QC'); process.exit(1); }
    " 2>&1)
    if [ $? -ne 0 ]; then
      echo "BLOCKED: $UNREVIEWED. All content must pass QC before publishing. Run QC agent first." >&2
      exit 2
    fi
  fi
fi

exit 0
