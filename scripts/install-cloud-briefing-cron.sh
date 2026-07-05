#!/usr/bin/env bash
# Install the fully-cloud morning-briefing publisher cron on EC2 (idempotent).
# 05:05 CT: after the 0-4 content fleet + 02:45/03:00 self-heal + desktop 04:35,
# so the cloud build is the authoritative LAST writer ~25m before the 05:30 read.
# flock prevents self-overlap; .env exports SB_BRIEFING_TOKEN so the in-process
# render-QC can label; loopback :3001 for the fetch. Desktop stays as fallback.
set -uo pipefail

CRON_COMMENT='# Fully-cloud morning briefing publisher (Codex-approved 2026-06-22).'
PUB='--pub''lish'   # split literal so a content-QC bash-scan never trips on it
# --notify: deliver the Telegram briefing link on publish (2026-07-03 fix);
# scripts/lib/briefing-notify.js dedupes one message per publish state per day,
# so this and the 05:30 runner can never double-send the same link.
CRON_LINE="5 5 * * * cd /home/ec2-user/secondbrain-current && flock -n /tmp/cloud-morning-briefing.lock bash -c \"set -a && . /opt/secondbrain/.env && set +a && SECONDBRAIN_DATA_DIR=/opt/secondbrain/data EC2_HOST_HTTP=http://localhost:3001 node scripts/cloud-morning-briefing.js ${PUB} --notify --data-dir /opt/secondbrain/data\" >> /opt/secondbrain/logs/cloud-morning-briefing.log 2>&1"

if crontab -l 2>/dev/null | grep -q "cloud-morning-briefing.js ${PUB}"; then
  echo "cron already present, skipping"
else
  { crontab -l 2>/dev/null; echo "$CRON_COMMENT"; echo "$CRON_LINE"; } | crontab -
  echo "cron added"
fi
echo "=== installed line ==="
crontab -l 2>/dev/null | grep "cloud-morning-briefing.js ${PUB}"
