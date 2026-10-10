#!/usr/bin/env bash
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
LOG_DIR="${OTTER_FULL_AUDIO_ARCHIVE_LOG_DIR:-/opt/secondbrain/logs}"
RUNNER="$ROOT/scripts/ec2-otter-full-audio-archive-run.sh"
BASH_BIN="${OTTER_FULL_AUDIO_ARCHIVE_BASH:-/usr/bin/bash}"
CRON_LINE="41 * * * * $BASH_BIN $RUNNER >> $LOG_DIR/otter-full-audio-archive.log 2>&1"

mkdir -p "$LOG_DIR"
chmod +x "$RUNNER"

tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -v 'ec2-otter-full-audio-archive-run.sh' > "$tmp" || true
printf '%s\n' "$CRON_LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "Installed bounded Otter full-audio archive scheduler:"
echo "$CRON_LINE"
