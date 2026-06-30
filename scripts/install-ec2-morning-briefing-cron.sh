#!/usr/bin/env bash
#
# install-ec2-morning-briefing-cron.sh -- idempotent install of the 5:30 AM CT daily
# briefing generate + publish cron on EC2. CRON_TZ=America/Chicago so 5:30 means Central.
# Runs AFTER the overnight self-heal (2:45/3:00) and the otter resolver (4:45). Strips a
# prior briefing line before re-adding (never stacks), and only adds CRON_TZ if absent so
# it never duplicates the TZ line the other installers may have added.
set -euo pipefail

RUNNER="/home/ec2-user/secondbrain-current/scripts/ec2-morning-briefing-run.sh"
LOG="/opt/secondbrain/logs/morning-briefing-cron.log"
LINE="30 5 * * * $RUNNER >> $LOG 2>&1"
TZLINE="CRON_TZ=America/Chicago"

tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -v "ec2-morning-briefing-run.sh" > "$tmp" || true
grep -q "^CRON_TZ=America/Chicago" "$tmp" || echo "$TZLINE" >> "$tmp"
echo "$LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "Installed EC2 daily briefing generate+publish cron (5:30 AM CT, CRON_TZ=America/Chicago):"
echo "$TZLINE"
echo "$LINE"
