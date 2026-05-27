#!/usr/bin/env bash
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
LOG_DIR="$ROOT/logs"
LOCK="/tmp/secondbrain-auto-regen.lock"
CRON_LINE="*/15 * * * * cd $ROOT && mkdir -p $LOG_DIR && flock -n $LOCK /usr/bin/node scripts/auto-regen-rejected-videos.js >> $LOG_DIR/auto-regen-rejected-videos.log 2>&1"

mkdir -p "$LOG_DIR"

tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -v 'auto-regen-rejected-videos.js' > "$tmp" || true
printf '%s\n' "$CRON_LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "Installed EC2 auto-regen cron:"
echo "$CRON_LINE"
