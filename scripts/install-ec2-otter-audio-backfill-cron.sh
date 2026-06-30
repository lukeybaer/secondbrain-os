#!/usr/bin/env bash
#
# install-ec2-otter-audio-backfill-cron.sh -- idempotently install the every-30-min
# Otter full-audio backfill cron on EC2 (Phase 4b, EC2-always-on Otter).
#
# Run ON EC2:  /opt/secondbrain/scripts/install-ec2-otter-audio-backfill-cron.sh
# It removes any prior backfill cron line first, so re-running is safe (idempotent).
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
LOG_DIR="$ROOT/logs"
RUNNER="$ROOT/scripts/ec2-otter-audio-backfill.sh"
CRON_LINE="*/30 * * * * $RUNNER >> $LOG_DIR/otter-audio-backfill.log 2>&1"

mkdir -p "$LOG_DIR"
chmod +x "$RUNNER" 2>/dev/null || true

tmp="$(mktemp)"
# Drop any prior backfill line (match the runner basename) so we never stack duplicates.
crontab -l 2>/dev/null | grep -v 'ec2-otter-audio-backfill.sh' > "$tmp" || true
printf '%s\n' "$CRON_LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "Installed EC2 Otter audio backfill cron (every 30 min):"
echo "$CRON_LINE"
