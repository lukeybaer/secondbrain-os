#!/usr/bin/env bash
#
# install-ec2-voice-recluster-cron.sh -- idempotently install the NIGHTLY global
# voice re-clustering cron on EC2 (Phase B3 of the 2026-07-11 voiceprint audit).
#
# Run ON EC2:  /opt/secondbrain/scripts/install-ec2-voice-recluster-cron.sh
# It removes any prior recluster cron line first, so re-running is safe (idempotent).
#
# 07:10 UTC is roughly 2:10am CT (1:10am in winter): after the day's ingest has
# quieted and BEFORE the 2:45/3:00am CT pre-briefing diagnostic reads voice
# artifacts. flock -n makes an overlapping run a clean no-op, and the job itself
# is idempotent: the run id derives from the input set hash, so identical inputs
# rewrite the same artifact. SECONDBRAIN_DATA_DIR is pinned explicitly so the
# clustering reads/writes the live data store, never the synced checkout's empty
# data dir (the 2026-07-01 audio-backfill #gap; see
# dev-plans/core/otter-transcript-pipeline.md section 4.5).
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
LOG_DIR="$ROOT/logs"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-$ROOT/data}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
LOCK="/tmp/secondbrain-voice-global-recluster.lock"
CRON_LINE="10 7 * * * cd $ROOT && flock -n $LOCK env SECONDBRAIN_DATA_DIR=$DATA_DIR $NODE_BIN scripts/voice-global-recluster.js --write >> $LOG_DIR/voice-global-recluster.log 2>&1"

mkdir -p "$LOG_DIR"

tmp="$(mktemp)"
# Drop any prior recluster line (match the script basename) so we never stack duplicates.
crontab -l 2>/dev/null | grep -v 'voice-global-recluster.js' > "$tmp" || true
printf '%s\n' "$CRON_LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "Installed EC2 nightly voice global recluster cron:"
echo "$CRON_LINE"
