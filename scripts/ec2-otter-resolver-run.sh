#!/usr/bin/env bash
#
# ec2-otter-resolver-run.sh -- EC2 ALWAYS-ON pre-briefing Otter voice-intelligence
# RESOLVER refresh (green-tomorrow WAVE 3A).
#
# THE PROBLEM: the Otter "speaker enrichment" briefing card goes RED because the
# voice-intelligence resolver (scripts/otter-post-ingest-voice-intelligence.js)
# runs once near 00:38 UTC as a fargate-cron-repair pass and then NOTHING re-runs
# it before the 5:30 CT briefing. If that run left a lock at
# /mnt/sbvoice/life-archive/voiceprints/otter-post-ingest-voice-intelligence.lock
# (a crash, or a rmSync that could not delete a root-owned dir), the lock sits
# there and cloud-morning-briefing.js marks the card RED ("held >90m -- likely
# orphaned, blocks all processing"), and the coverage/pareto/system-health
# artifacts go stale. There was no cloud trigger to clear it -- only the laptop.
#
# THE FIX (this runner): re-run the resolver ON EC2 at ~4:45 AM CT, AFTER the
# 2:45/3:00 self-heal and BEFORE the 5:30 briefing. The resolver's acquireLock()
# now FORCE-BREAKS a lock older than its stale threshold (rename-aside on the
# 0777 parent, no sudo) before doing any work, so the leaked lock is cleared, and
# its tail regenerates the coverage / speaker-intelligence / pareto / briefing
# artifacts from the LIVE /opt/secondbrain data store.
#
# BOUNDED (Codex review): an empty --otids run scans all local transcripts and
# could do unbounded ECAPA/download work on a backlog. In steady state the */30
# audio backfill + the 2-min ingest watcher keep the backlog near zero and the
# diarize/probe/resolve steps skip already-processed otids, so this is a near
# no-op on heavy work; we ALSO cap the acoustic resolve step via
# OTTER_POST_INGEST_RESOLVER_LIMIT and rely on the resolver's own per-step
# timeouts + flock so one run can never monopolize the host or stack.
#
# MUST run from the EC2 build path (/home/ec2-user/secondbrain-current) with
# SECONDBRAIN_DATA_DIR=/opt/secondbrain/data, OTTER_CONFIG_PATH=.../config/otter.json
# (the full-audio backfill step reads it), and OTTER_VOICE_EFS_LOCK_DIR pointed at
# the EFS lock dir so the force-break targets the SAME lock the briefing reads.
#
# CLAUDE AUTH: the resolver itself needs no LLM, but we export the Max-plan OAuth
# token (mirroring ec2-self-heal-run.sh) as a harmless belt-and-suspenders in case
# a tail step ever grows an LLM call; cron has a minimal env so we pin HOME too.
#
# Install the cron (4:45 AM CT) with scripts/install-ec2-otter-resolver-cron.sh on
# EC2. The operator installs this on EC2; nothing here SSHes anywhere.
#
# IDEMPOTENT: flock -n makes a second invocation a clean no-op while one run is
# mid-flight (the resolver also holds its own internal lock). LOGGED: dated header.
#
# TEST-GATED: under NODE_ENV=test / VITEST / OTTER_RESOLVER_DRY_RUN=1 it prints the
# command it WOULD run and exits 0 WITHOUT spawning node, so a regression test can
# assert the wiring without a real resolver run (no Otter network / ECAPA).
set -uo pipefail

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${OTTER_RESOLVER_LOG_DIR:-/opt/secondbrain/logs}"
LOCK="/tmp/secondbrain-otter-resolver-run.lock"
CONFIG="${OTTER_CONFIG_PATH:-$DATA_DIR/config/otter.json}"
EFS_LOCK_DIR="${OTTER_VOICE_EFS_LOCK_DIR:-/mnt/sbvoice/life-archive/voiceprints}"
# Cap the acoustic resolve step so one run can never monopolize the host on a
# backlog; the next run picks up the remainder (still converges, never stacks).
RESOLVER_LIMIT="${OTTER_POST_INGEST_RESOLVER_LIMIT:-200}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
# Cron has a minimal env: pin HOME so buildClaudeCliEnv's default token path resolves.
HOME="${HOME:-/home/ec2-user}"
TOKEN_PATH="${CLAUDE_OAUTH_TOKEN_PATH:-$HOME/.claude-oauth-token}"

STAMP="$(date -u +%FT%TZ)"
echo "[otter-resolver-run] $STAMP root=$ROOT data_dir=$DATA_DIR config=$CONFIG efs_lock_dir=$EFS_LOCK_DIR resolver_limit=$RESOLVER_LIMIT token_path=$TOKEN_PATH"

# Export the Max-plan OAuth token (belt-and-suspenders; never echo the value).
if [ -r "$TOKEN_PATH" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_PATH")"
  export CLAUDE_CODE_OAUTH_TOKEN
  echo "[otter-resolver-run] Claude OAuth token loaded from $TOKEN_PATH"
else
  echo "[otter-resolver-run] note: no readable token at $TOKEN_PATH (resolver needs no LLM; continuing)."
fi
export HOME

# Build the exact command once so the dry-run print and the real spawn cannot drift.
# Empty --otids = refresh-all pass; the resolver force-breaks the stale lock and
# regenerates coverage/pareto/system-health in its tail.
CMD=("$NODE_BIN" scripts/otter-post-ingest-voice-intelligence.js --reason ec2-pre-briefing-resolver-refresh)

# TEST GATE: never spawn the real resolver under test / dry-run.
if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${OTTER_RESOLVER_DRY_RUN:-}" = "1" ]; then
  echo "[otter-resolver-run] DRY-RUN (test mode): would run: (cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR OTTER_CONFIG_PATH=$CONFIG OTTER_VOICE_EFS_LOCK_DIR=$EFS_LOCK_DIR OTTER_POST_INGEST_RESOLVER_LIMIT=$RESOLVER_LIMIT HOME=$HOME ${CMD[*]})"
  exit 0
fi

cd "$ROOT" || { echo "[otter-resolver-run] cannot cd to $ROOT" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# flock -n: if a resolver run is already going, this run is a clean no-op.
flock -n "$LOCK" env \
  SECONDBRAIN_DATA_DIR="$DATA_DIR" \
  OTTER_CONFIG_PATH="$CONFIG" \
  OTTER_VOICE_EFS_LOCK_DIR="$EFS_LOCK_DIR" \
  OTTER_POST_INGEST_RESOLVER_LIMIT="$RESOLVER_LIMIT" \
  HOME="$HOME" \
  "${CMD[@]}"
status=$?

if [ "$status" = "0" ]; then
  echo "[otter-resolver-run] $(date -u +%FT%TZ) done (exit 0)."
elif [ "$status" = "1" ]; then
  # flock returns 1 when the lock is held -> a prior run is still going. Benign.
  echo "[otter-resolver-run] $(date -u +%FT%TZ) skipped: a resolver run is already going (lock held) OR the resolver reported a fatal; see the run log."
else
  echo "[otter-resolver-run] $(date -u +%FT%TZ) finished with exit $status; see $LOG_DIR/otter-resolver-cron.log and data/life-archive/voiceprints/otter-post-ingest-voice-intelligence-latest.json."
fi
exit 0
