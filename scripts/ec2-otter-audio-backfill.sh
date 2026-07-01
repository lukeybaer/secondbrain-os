#!/usr/bin/env bash
#
# ec2-otter-audio-backfill.sh -- EC2 ALWAYS-ON Otter full-audio backfill (Phase 4b).
#
# Keeps Otter call audio fresh WITHOUT depending on ExampleCo's laptop being awake. It
# runs scripts/otter-full-audio-backfill.js (already UA-hardened + idempotent: it
# skips any otid whose full audio already exists) from the canonical EC2 deploy
# root, so audio for newly-ingested calls is downloaded within ~30 min of ingest.
#
# Install the cron line (every 30 min) with:
#   */30 * * * * /opt/secondbrain/scripts/ec2-otter-audio-backfill.sh >> /opt/secondbrain/logs/otter-audio-backfill.log 2>&1
# or run scripts/install-ec2-otter-audio-backfill-cron.sh on EC2 to install it
# idempotently. The operator installs this on EC2; nothing here SSHes anywhere.
#
# IDEMPOTENT: the underlying backfill no-ops on otids that already have audio, and
# `flock -n` makes a second invocation a clean no-op while one is mid-run (the
# ingest watcher runs every 2 min; a slow backfill must not stack). LOGGED: every
# run prints a dated header + the backfill status tail.
#
# TEST-GATED: under NODE_ENV=test / VITEST / OTTER_BACKFILL_DRY_RUN=1 it prints the
# command it WOULD run and exits 0 WITHOUT spawning node, so a regression test can
# assert the wiring without a real Otter network call.
set -uo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
LOG_DIR="$ROOT/logs"
LOCK="/tmp/secondbrain-otter-audio-backfill.lock"
CONFIG="${OTTER_CONFIG_PATH:-$ROOT/data/config/otter.json}"
# Pin the data root EXPLICITLY so audio lands where the coverage report counts it,
# regardless of how node resolves the script-relative REPO. On EC2 the live store
# is /opt/secondbrain/data, NOT the hourly-synced checkout root. ExampleCo 2026-07-01
# #gap: the backfill used to ignore this and write into the checkout's empty
# data/otter/audio-full. See dev-plans/core/otter-transcript-pipeline.md section 4.5.
DATA_DIR="${SECONDBRAIN_DATA_DIR:-$ROOT/data}"
# --limit caps a single pass so one run can never monopolize the host; the next
# 30-min run picks up the remainder (still converges, never stacks).
LIMIT="${OTTER_BACKFILL_LIMIT:-200}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

STAMP="$(date -u +%FT%TZ)"
echo "[otter-audio-backfill] $STAMP root=$ROOT dataDir=$DATA_DIR config=$CONFIG limit=$LIMIT"

# Build the exact command once so the dry-run print and the real spawn cannot drift.
CMD=("$NODE_BIN" scripts/otter-full-audio-backfill.js --write --limit "$LIMIT" --config "$CONFIG")

# TEST GATE: never make a real Otter network call under test / dry-run.
if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${OTTER_BACKFILL_DRY_RUN:-}" = "1" ]; then
  echo "[otter-audio-backfill] DRY-RUN (test mode): would run: (cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR OTTER_CONFIG_PATH=$CONFIG ${CMD[*]})"
  exit 0
fi

cd "$ROOT" || { echo "[otter-audio-backfill] cannot cd to $ROOT" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# flock -n: if a backfill is already running, this run is a clean no-op (idempotent
# under overlap). The underlying script also skips otids that already have audio.
flock -n "$LOCK" env SECONDBRAIN_DATA_DIR="$DATA_DIR" OTTER_CONFIG_PATH="$CONFIG" "${CMD[@]}" | tail -20
status=${PIPESTATUS[0]}

if [ "$status" = "0" ]; then
  echo "[otter-audio-backfill] $(date -u +%FT%TZ) done (exit 0)."
elif [ "$status" = "1" ]; then
  # flock returns 1 when the lock is held -> a prior run is still going. Benign.
  echo "[otter-audio-backfill] $(date -u +%FT%TZ) skipped: a backfill is already running (lock held)."
else
  # backfill exits 2 when some otids failed to download; surface it, do not crash cron.
  echo "[otter-audio-backfill] $(date -u +%FT%TZ) finished with partial errors (exit $status); see status artifact data/life-archive/voiceprints/otter-full-audio-backfill-latest.json."
fi
exit 0
