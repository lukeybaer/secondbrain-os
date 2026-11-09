#!/usr/bin/env bash
# Installs the model-free morning retrospective: 5:40 AM CT daily, after the
# 5:30 AM report/briefing close. Mirrors install-overnight-capacity-measurement-cron.sh.
set -euo pipefail

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
ROOT="$(readlink -f "$ROOT_LINK")"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="/opt/secondbrain/logs"
RUNNER="$ROOT/scripts/morning-retro.js"
LINE="40 5 * * * SECONDBRAIN_DATA_DIR=$DATA_DIR /usr/bin/node $RUNNER >> $LOG_DIR/morning-retro.log 2>&1"

if [[ ! -f "$RUNNER" ]]; then
  echo "[morning-retro] refused: runner missing from pinned release $ROOT" >&2
  exit 75
fi
mkdir -p "$LOG_DIR" "$DATA_DIR/agent/morning-retro"
tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -v 'morning-retro.js' > "$tmp" || true
# Insert below the crontab's CRON_TZ=America/Chicago line when present so the
# hour is CT; otherwise fall back to UTC 10:40 (5:40 CDT).
if grep -q '^CRON_TZ=America/Chicago' "$tmp"; then
  awk -v line="$LINE" '{print} /^CRON_TZ=America\/Chicago/ && !d {print line; d=1}' "$tmp" > "$tmp.2"
else
  awk -v line="${LINE/40 5 /40 10 }" '{print} END {print line}' "$tmp" > "$tmp.2"
fi
crontab "$tmp.2"
rm -f "$tmp" "$tmp.2"

SECONDBRAIN_DATA_DIR="$DATA_DIR" /usr/bin/node "$RUNNER" || true
echo "Installed morning retro: $LINE"
