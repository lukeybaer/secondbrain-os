#!/bin/bash
# flush-session.sh
#
# Force a full Stop-hook archive run by setting SECONDBRAIN_FINAL_FLUSH=1
# before invoking archive-session-to-s3.sh. Bypasses the per-session
# throttle so the final transcript, meta, and Graphiti episode all land
# even if the throttle windows have not elapsed.
#
# Wire as a SessionEnd hook when Claude Code supports SessionEnd:
#   "SessionEnd": [{
#     "hooks": [{ "type": "command",
#       "command": "bash $HOME/secondbrain/scripts/claude-hooks/flush-session.sh"
#     }]
#   }]
#
# When SessionEnd is not available in the current Claude Code build, this
# script is still callable manually to force a final flush of an active
# session before shutting down a long-running run.

set -e
HOOK_DIR="$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")"
export SECONDBRAIN_FINAL_FLUSH=1
exec bash "$HOOK_DIR/archive-session-to-s3.sh"
