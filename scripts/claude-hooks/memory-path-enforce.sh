#!/bin/bash
# PreToolUse hook — blocks any Write/Edit/NotebookEdit that targets
# ~/.claude/memory/ or .claude/memory/ absolute paths. Rewrites would
# trigger Claude Code's permission gate (path-string-based, not
# inode-based) and force Luke to click Allow.
#
# Rule: always use the project-relative secondbrain/memory/ path. The
# junction from ~/.claude/memory/ → secondbrain/memory/ means both
# resolve to the same file, but only the project-relative path passes
# the permission gate without a prompt.
#
# Same applies to ~/.claude/hooks/, ~/.claude/CLAUDE.md, and
# ~/.claude/settings.json — use the tracked secondbrain/... paths.
#
# On violation: exits 2 (blocking error) and tells Claude Code which
# path to use instead.

FILE=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.tool_input?.file_path||'')}catch{console.log('')}})" 2>/dev/null)

# Normalize path separators for matching
NORMALIZED=$(echo "$FILE" | tr '\\' '/')

# Check if the path targets ~/.claude or C:/Users/luked/.claude
if echo "$NORMALIZED" | grep -qiE '(C:/Users/luked|~)/\.claude/(memory|hooks|scheduled-tasks)/'; then
  # Rewrite to project-relative path
  SUGGESTION=$(echo "$NORMALIZED" | sed -E 's|(C:/Users/luked\|~)/\.claude/memory/|C:/Users/luked/secondbrain/memory/|; s|(C:/Users/luked\|~)/\.claude/hooks/|C:/Users/luked/secondbrain/scripts/claude-hooks/|; s|(C:/Users/luked\|~)/\.claude/scheduled-tasks/|C:/Users/luked/secondbrain/claude-config/scheduled-skills/|')

  echo "BLOCKED: write targets ~/.claude path which triggers Claude Code's permission gate." >&2
  echo "Use the project-relative path instead:" >&2
  echo "  $SUGGESTION" >&2
  echo "Both paths resolve to the same file via junction, but only the project-relative path avoids the permission prompt." >&2
  exit 2
fi

# Also block ~/.claude/CLAUDE.md and ~/.claude/settings.json (file-level)
if echo "$NORMALIZED" | grep -qiE '(C:/Users/luked|~)/\.claude/(CLAUDE\.md|settings\.json)$'; then
  BASENAME=$(basename "$NORMALIZED")
  case "$BASENAME" in
    CLAUDE.md)
      SUGGESTION="C:/Users/luked/secondbrain/claude-config/CLAUDE.global.md"
      ;;
    settings.json)
      SUGGESTION="C:/Users/luked/secondbrain/claude-config/settings.json"
      ;;
  esac
  echo "BLOCKED: write targets ~/.claude/$BASENAME which is permission-gated by Claude Code." >&2
  echo "Edit the tracked canonical version instead:" >&2
  echo "  $SUGGESTION" >&2
  echo "The local file should be hardlinked to this tracked path via the Phase 1b setup." >&2
  exit 2
fi

exit 0
