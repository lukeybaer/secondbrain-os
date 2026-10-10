#!/usr/bin/env bash
# Cloud-owned Gmail -> S3 durability proof and bounded repair.
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
TZLINE="CRON_TZ=America/Chicago"
CMD="flock -n /tmp/secondbrain-gmail-s3-flow-health.lock timeout --kill-after=30s 20m /usr/bin/python3 $ROOT/scripts/gmail-s3-flow-health.py --days 30 --daily-live --backfill-missing --sync --write --json >> $LOG_DIR/gmail-s3-flow-health-cron.log 2>&1"
LINE="15 21 * * * $CMD"

mkdir -p "$LOG_DIR"
tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -v 'gmail-s3-flow-health.py' > "$tmp" || true
grep -q '^CRON_TZ=America/Chicago$' "$tmp" || echo "$TZLINE" >> "$tmp"
echo "$LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "Installed cloud Gmail-to-S3 durability proof and repair schedule:"
echo "$TZLINE"
echo "$LINE"
