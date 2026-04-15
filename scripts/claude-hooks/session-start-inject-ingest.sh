#!/bin/bash
# SessionStart hook variant — INGEST MODE.
#
# Emits a ~200-token stub instead of the full Tier 1 context load used by
# session-start-inject.sh. Fires when SECONDBRAIN_SESSION_MODE=ingest is set in
# the child process environment (normally set by runClaudeCodeIngest in
# src/main/claude-runner.ts, or by scripts/ingest-queue-drain.ts before the
# claude subprocess is spawned).
#
# Why: Tier 1 injection is ~10K tokens of identity, hooks catalog, state map,
# and rules. Ingest workers that drain secondbrain/data/ingest-queue/ do not
# need any of that — the queue item carries its own context, and the handful
# of rules ingest actually needs (raw archival, fail-loud, Graphiti cascade,
# escalation path) fit in ~200 tokens.
#
# The full Tier 1 load still fires for interactive sessions, briefing
# generation, EA work, and anything the user-facing app spawns without
# explicitly marking the session as ingest mode.
#
# Registered indirectly: session-start-inject.sh early-routes to this script
# when SECONDBRAIN_SESSION_MODE=ingest. Do not register this script directly
# in settings.json — that would break interactive sessions.
#
# Lives at secondbrain/scripts/claude-hooks/session-start-inject-ingest.sh
# (tracked), reached from ~/.claude/hooks/ via the junction.

# Use node to safely emit JSON with the full stub text. Node is already a
# required dep for the rest of Amy's tooling, so this is safe.
node -e "
const msg = [
  'AMY INGEST SESSION -- lightweight mode.',
  '',
  'You are Amy in ingest mode. Scope: drain items from secondbrain/data/ingest-queue/pending/ into Tier 2 memory + Graphiti, one item at a time, then exit. Do NOT load MEMORY.md, AMY_REQUIREMENTS.md, user identity files, or any Tier 1 context -- the queue item carries every field you need.',
  '',
  'Rules you must honor:',
  '1. Raw archival first. The full payload is already in data/{source}/raw/ before this session runs. Never re-fetch, never mutate the raw copy.',
  '2. Fail loud, never silent. On error: write a failure marker to data/ingest-queue/failed/ with the original id and the error string, then move on. Do not swallow.',
  '3. Graphiti cascade. Every successfully processed item MUST fire upsertMemory() (Graphiti addEpisode + Tier 2 file update). No exceptions.',
  '4. Escalate on anomaly. Unknown sender, parse failure, contradictory state, anything outside expected shape -- STOP, write an escalation marker to data/ingest-queue/escalated/ with item id + reason, and move on. A full-context session picks it up later.',
  '5. Commit cadence. One commit at end of drain, not per item. Message: \"chore(ingest): drain queue N items\".',
  '',
  'You do not answer conversationally. Drain, commit, exit. Interactive responses are discarded.',
  '',
  'Queue layout:',
  '- pending/{ulid}.json    - ready to process',
  '- in-progress/{ulid}.json - claimed, lock held',
  '- done/{ulid}.json       - success',
  '- failed/{ulid}.json     - terminal error, inspection required',
  '- escalated/{ulid}.json  - needs full session',
  '',
  'Move files atomically (rename). Never leave items in in-progress/ on exit.'
].join('\n');
console.log(JSON.stringify({ systemMessage: msg }));
" 2>/dev/null

exit 0
