#!/bin/bash
# SessionStart hook — runs once at the start of every new Claude Code session,
# regardless of repo or cwd. Injects Tier 1 memory + state locations + the
# first 80 lines of AMY_REQUIREMENTS so the session starts with the full
# architectural map loaded, not a blank slate.
#
# This is the architectural fix for the 2026-04-10 regression where every
# new session rediscovered the filesystem from scratch and missed half of
# Amy's state. After this hook fires, "does the overnight loop exist?"
# is answered from the injected map, not from grep-and-hope.
#
# Registered in ~/.claude/settings.json under hooks.SessionStart.
# Lives at secondbrain/scripts/claude-hooks/session-start-inject.sh (tracked),
# junctioned to ~/.claude/hooks/session-start-inject.sh (or direct ref).

SECONDBRAIN="C:/Users/luked/secondbrain"
MEMORY="$SECONDBRAIN/memory/MEMORY.md"
STATE_LOCATIONS="$SECONDBRAIN/memory/reference_amy_state_locations.md"
REQUIREMENTS="$SECONDBRAIN/memory/AMY_REQUIREMENTS.md"

# Bail if any canonical file is missing (should never happen but fail loud)
if [ ! -f "$MEMORY" ] || [ ! -f "$STATE_LOCATIONS" ] || [ ! -f "$REQUIREMENTS" ]; then
  echo '{"systemMessage": "SESSION START WARNING: one or more canonical Amy memory files is missing. Check secondbrain/memory/MEMORY.md, reference_amy_state_locations.md, and AMY_REQUIREMENTS.md."}' 2>/dev/null
  exit 0
fi

# Read the three files and emit as a single systemMessage
node -e "
const fs = require('fs');
const memory = fs.readFileSync('$MEMORY', 'utf8');
const stateLocations = fs.readFileSync('$STATE_LOCATIONS', 'utf8');
const requirements = fs.readFileSync('$REQUIREMENTS', 'utf8').split('\n').slice(0, 80).join('\n');

const msg = [
  'AMY SESSION START — canonical context auto-injected.',
  'You are in a new Claude Code session. Before your first action, read the following.',
  'These files are loaded from secondbrain/memory/ via the junction, tracked in git, and survive reclone.',
  '',
  '=== MEMORY.md (Tier 1, master entry point) ===',
  memory,
  '',
  '=== reference_amy_state_locations.md (exhaustive state map) ===',
  stateLocations,
  '',
  '=== AMY_REQUIREMENTS.md (first 80 lines) ===',
  requirements,
  '',
  '=== END SESSION START ===',
  '',
  'You now know: who Luke is, where Amy state lives, the 3 non-negotiable needs,',
  'the hooks that will fire, the active schedules, the key rules, and the canonical',
  'file pointers. Before any action, open AMY_REQUIREMENTS.md and the relevant topic',
  'file. Do not grep as a substitute for reading these files.'
].join('\n');

console.log(JSON.stringify({ systemMessage: msg }));
" 2>/dev/null

exit 0
