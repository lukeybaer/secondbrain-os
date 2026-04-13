#!/bin/bash
# Usage tracker hook for UserPromptSubmit
# Calls the Node.js usage tracker and outputs its JSON result
node "${USERPROFILE:-~}/secondbrain/scripts/claude-hooks/usage-tracker.js" --hook --project-dir "${USERPROFILE:-~}/.claude/projects/C--Users-USER-secondbrain" 2>/dev/null
