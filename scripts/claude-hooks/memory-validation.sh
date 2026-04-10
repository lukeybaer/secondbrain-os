#!/bin/bash
# PostToolUse hook: validate memory file writes — check frontmatter, check MEMORY.md index

FILE=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.tool_input?.file_path||'')}catch{console.log('')}})" 2>/dev/null)

MEMORY_DIR="C:/Users/luked/.claude/projects/C--Users-luked-secondbrain/memory"

# Only fire on writes to the memory directory
if echo "$FILE" | grep -qi "memory"; then
  # Skip MEMORY.md itself and contact files (different format)
  if echo "$FILE" | grep -qiE '(MEMORY\.md|contacts/)'; then
    exit 0
  fi

  # Check frontmatter exists
  if [ -f "$FILE" ]; then
    HEAD=$(head -1 "$FILE" 2>/dev/null)
    if [ "$HEAD" != "---" ]; then
      echo "WARNING: Memory file $FILE is missing frontmatter (---). Required fields: name, description, type." >&2
    else
      # Check required fields
      FRONTMATTER=$(sed -n '/^---$/,/^---$/p' "$FILE" 2>/dev/null)
      for FIELD in "name:" "description:" "type:"; do
        if ! echo "$FRONTMATTER" | grep -q "$FIELD"; then
          echo "WARNING: Memory file $FILE missing required frontmatter field: $FIELD" >&2
        fi
      done
    fi
  fi

  # Check if MEMORY.md index references this file
  BASENAME=$(basename "$FILE")
  if [ -f "$MEMORY_DIR/MEMORY.md" ] && [ "$BASENAME" != "MEMORY.md" ]; then
    if ! grep -q "$BASENAME" "$MEMORY_DIR/MEMORY.md" 2>/dev/null; then
      echo "WARNING: $BASENAME is not indexed in MEMORY.md — add it or future sessions won't know it exists." >&2
    fi
  fi
fi

exit 0
