#!/usr/bin/env bash
set -euo pipefail

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
ROOT="$(readlink -f "$ROOT_LINK")"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="/opt/secondbrain/logs"
RUNNER="$ROOT/scripts/overnight-capacity-measurement.js"
LINE="*/5 * * * * SECONDBRAIN_DATA_DIR=$DATA_DIR /usr/bin/node $RUNNER >> $LOG_DIR/overnight-capacity-measurement.log 2>&1"

if [[ ! -f "$RUNNER" ]]; then
  echo "[overnight-capacity] refused: runner missing from pinned release $ROOT" >&2
  exit 75
fi
mkdir -p "$LOG_DIR" "$DATA_DIR/agent/overnight-capacity"
tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -v 'overnight-capacity-measurement.js' > "$tmp" || true
printf '%s\n' "$LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

SECONDBRAIN_DATA_DIR="$DATA_DIR" /usr/bin/node "$RUNNER" || true
echo "Installed overnight capacity measurement: $LINE"
