#!/usr/bin/env bash
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
RUNNER="$ROOT/scripts/voice-efs-reconcile.js"
LOG="$DATA_DIR/agent/voice-efs-reconcile.log"
LOCK="/tmp/secondbrain-voice-efs-reconcile.lock"

[[ -f "$RUNNER" ]] || { echo "voice EFS reconcile installer refused: missing $RUNNER" >&2; exit 75; }
mkdir -p "$(dirname "$LOG")"

# Ten minutes is deliberately longer than the eight-minute hard timeout. A
# delayed pass cannot overlap the next one, and the same bounded pass owns both
# EFS projection and exact-completion-envelope reconciliation.
CRON_LINE="*/10 * * * * cd $ROOT && flock -n $LOCK timeout --kill-after=30s 8m env VOICE_EFS_MOUNT=/mnt/sbvoice SECONDBRAIN_DATA_DIR=$DATA_DIR /usr/bin/node $RUNNER --summary >> $LOG 2>&1"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
crontab -l 2>/dev/null | grep -v 'scripts/voice-efs-reconcile.js' > "$tmp" || true
printf '%s\n' "$CRON_LINE" >> "$tmp"
crontab "$tmp"

echo "Installed locked, timeout-bounded voice EFS reconciliation:"
echo "$CRON_LINE"
