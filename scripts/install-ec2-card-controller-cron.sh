#!/usr/bin/env bash
# Activate or roll back the cloud-only 11 PM CT card-controller run. Activation
# is forbidden until a supervised proof run is clean; rollback makes the legacy
# pre-briefing self-heal schedule authoritative again.
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
CONTROLLER_ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
RUNNER="$CONTROLLER_ROOT/scripts/ec2-card-controller-run.sh"
MORNING_RUNNER="$CONTROLLER_ROOT/scripts/ec2-morning-briefing-run.sh"
LEGACY_INSTALLER="$ROOT/scripts/install-ec2-self-heal-cron.sh"
AUTHORITY_FILE="${BRIEFING_CARD_CONTROLLER_AUTHORITY_FILE:-$DATA_DIR/agent/briefing-card-controller-authority}"
TZLINE="CRON_TZ=America/Chicago"
LINE="0 23 * * * $RUNNER >> $LOG_DIR/card-controller-cron.log 2>&1"
MORNING_LINE="30 5 * * * $MORNING_RUNNER >> $LOG_DIR/morning-briefing-cron.log 2>&1"
# The old cloud scheduled-skill fleet runs generic Claude/Codex jobs serially
# from 7-11 PM CT. Controller authority replaces that briefing work with direct
# source contracts, so keeping this cron would recreate competing token-heavy
# producers alongside the new lanes.
LEGACY_FLEET_LINE="*/30 0-4 * * * cd $ROOT && mkdir -p $LOG_DIR && SECONDBRAIN_DATA_DIR=$DATA_DIR /usr/bin/node scripts/run-cloud-scheduled-tasks.js --trigger cloud-cron >> $LOG_DIR/cloud-scheduled-fleet.log 2>&1"
MODE="${1:-}"

case "$MODE" in
  --activate|--rollback) ;;
  *)
    echo "Usage: $0 --activate|--rollback" >&2
    echo "Refusing to change cron without an explicit authority decision." >&2
    exit 2
    ;;
esac

mkdir -p "$LOG_DIR"
chmod +x "$RUNNER" 2>/dev/null || true
mkdir -p "$(dirname "$AUTHORITY_FILE")"

if [ "$MODE" = "--rollback" ]; then
  printf '0\n' > "$AUTHORITY_FILE"
  tmp="$(mktemp)"
  crontab -l 2>/dev/null | grep -v 'ec2-card-controller-run.sh' > "$tmp" || true
  grep -q 'run-cloud-scheduled-tasks.js --trigger cloud-cron' "$tmp" || echo "$LEGACY_FLEET_LINE" >> "$tmp"
  crontab "$tmp"
  rm -f "$tmp"
  "$LEGACY_INSTALLER"
  echo "Rolled back to legacy self-heal authority; controller authority marker is 0."
  exit 0
fi

tmp="$(mktemp)"
crontab -l 2>/dev/null \
  | grep -v 'ec2-card-controller-run.sh' \
  | grep -v 'ec2-morning-briefing-run.sh' \
  | grep -v 'ec2-self-heal-run.sh' \
  | grep -v 'run-cloud-scheduled-tasks.js --trigger cloud-cron' \
  > "$tmp" || true
grep -q "^CRON_TZ=America/Chicago" "$tmp" || echo "$TZLINE" >> "$tmp"
echo "$LINE" >> "$tmp"
echo "$MORNING_LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"
printf '1\n' > "$AUTHORITY_FILE"

echo "Activated cloud card-controller authority and installed its 11 PM CT cron:"
echo "$TZLINE"
echo "$LINE"
echo "$MORNING_LINE"
echo "authority marker: $AUTHORITY_FILE = 1"
echo "retired generic cloud scheduled-skill fleet during controller authority"
