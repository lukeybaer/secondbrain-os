#!/usr/bin/env bash
# Idempotently install the PM2 storm-guard cron on EC2 (every 2 minutes).
# Tracked so cron installation is reproducible, not a one-off manual step
# (Codex review 2026-07-07 #1). Safe to re-run: it only adds the line if the
# guard is not already scheduled.
set -euo pipefail

GUARD="/home/ec2-user/secondbrain-current/scripts/pm2-storm-guard.js"
LOG="/opt/secondbrain/logs/pm2-storm-guard.log"
LINE="*/2 * * * * cd /home/ec2-user/secondbrain-current && /usr/bin/node ${GUARD} >> ${LOG} 2>&1"

mkdir -p /opt/secondbrain/logs

current="$(crontab -l 2>/dev/null || true)"
if printf '%s\n' "$current" | grep -qF 'pm2-storm-guard.js'; then
  echo "[install] pm2-storm-guard cron already present"
else
  printf '%s\n%s\n' "$current" "$LINE" | crontab -
  echo "[install] pm2-storm-guard cron installed (every 2 min)"
fi

crontab -l 2>/dev/null | grep -F 'pm2-storm-guard.js' || {
  echo "[install] ERROR: cron line not found after install"; exit 1;
}
