#!/usr/bin/env bash
#
# install-ec2-voice-recluster-cron.sh -- idempotently install the NIGHTLY global
# voice re-clustering cron on EC2 (Phase B3 of the 2026-07-11 voiceprint audit).
#
# Run ON EC2:  /opt/secondbrain/scripts/install-ec2-voice-recluster-cron.sh
# It removes any prior recluster cron line first, so re-running is safe (idempotent).
#
# 07:10 CT is outside the 22:15-05:35 briefing reserve. flock -n makes an
# overlapping run a clean no-op. The write tail (full recluster, resolution
# backprop, pareto, name resolver, queue build, controlled-incremental
# certification, terminal receipt) runs through the SAME verified wrapper as
# the attended one-off (ec2-otter-recluster-rebuild-run.sh, reentrant under
# this line's flock and cap scope), and the job itself
# is idempotent: the run id derives from the input set hash, so identical inputs
# rewrite the same artifact. The durable probe ledger is published into the
# whole-corpus probe index before reclustering, so a targeted post-ingest index
# can never make the archive look like it contains only that tiny batch.
# SECONDBRAIN_DATA_DIR is pinned explicitly so the
# clustering reads/writes the live data store, never the synced checkout's empty
# data dir (the 2026-07-01 audio-backfill #gap; see
# dev-plans/core/otter-transcript-pipeline.md section 4.5).
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
LOG_DIR="$ROOT/logs"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-$ROOT/data}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
VOICE_PYTHON="${VOICE_ECAPA_PYTHON:-/opt/secondbrain-durable/voice-venv/bin/python}"
VOICE_MODEL_CACHE="${VOICE_ECAPA_MODEL_CACHE:-/mnt/sbvoice/life-archive/voiceprints/model-cache/speechbrain-ecapa-voxceleb}"
LOCK="/tmp/secondbrain-voice-global-recluster.lock"
CAP_RUNNER="$ROOT/scripts/ec2-global-identity-cap-run.sh"
TZLINE="CRON_TZ=America/Chicago"
# 2048M/1024M-swap sizes this chain to its measured working set (the resolver
# alone needs ~1GB RSS plus a torch python child; the probe builder needs more
# than the 256MB heap node derives from a 512M cgroup). The wrapper's 512M
# default still applies to any identity work that does not declare a budget.
# Under 512M the whole chain OOM-died at its first step from 2026-08-12 to
# 2026-08-14 and no full recluster ran after 2026-08-04.
CRON_LINE="10 7 * * * cd $ROOT && flock -n $LOCK env SB_IDENTITY_WORK_KIND=global SB_GLOBAL_IDENTITY_MEMORY_MAX=2048M SB_GLOBAL_IDENTITY_MEMORY_SWAP_MAX=1024M SECONDBRAIN_DATA_DIR=$DATA_DIR $CAP_RUNNER /bin/bash -lc 'env VOICE_SPEAKER_BACKEND=ecapa VOICE_ECAPA_PYTHON=$VOICE_PYTHON VOICE_ECAPA_MODEL_CACHE=$VOICE_MODEL_CACHE SB_REBUILD_RUN_ACOUSTIC_PREREQS=1 bash scripts/ec2-otter-recluster-rebuild-run.sh --write' >> $LOG_DIR/voice-global-recluster.log 2>&1"

mkdir -p "$LOG_DIR"
chmod +x "$CAP_RUNNER"

tmp="$(mktemp)"
# Drop any prior recluster line (match the script basename) so we never stack duplicates.
crontab -l 2>/dev/null | grep -v -e 'voice-global-recluster.js' -e 'ec2-otter-recluster-rebuild-run.sh' > "$tmp" || true
grep -q '^CRON_TZ=America/Chicago$' "$tmp" || printf '%s\n' "$TZLINE" >> "$tmp"
printf '%s\n' "$CRON_LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "Installed EC2 voice global recluster cron (daily 07:10 CT, outside briefing reserve, 2048M/1024M-swap chain budget under the cap wrapper; dry-run acceptance receipt appended each night):"
echo "$CRON_LINE"
