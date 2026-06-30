#!/usr/bin/env bash
#
# install-ec2-self-heal-cron.sh -- idempotently install the pre-briefing overnight
# self-heal cron on EC2 (green-tomorrow WAVE 1, BLOCKER B).
#
# Schedules scripts/ec2-self-heal-run.sh at 2:45 AM and 3:00 AM CT under
# CRON_TZ=America/Chicago -- the documented pre-briefing diagnostic -> self-heal
# chain that must finish BEFORE the 5:30 CT Daily Executive Briefing so the nightly
# blockers are cleared and SELF-HEAL HEALTH is fresh.
#
# Run ON EC2:  /home/ec2-user/secondbrain-current/scripts/install-ec2-self-heal-cron.sh
# It removes any prior self-heal cron line (and any stale CRON_TZ it owns) first, so
# re-running is safe (idempotent). The operator installs this on EC2.
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
LOG_DIR="${SELFHEAL_LOG_DIR:-/opt/secondbrain/logs}"
RUNNER="$ROOT/scripts/ec2-self-heal-run.sh"
CRON_TZ_LINE="CRON_TZ=America/Chicago"
# 2:45 and 3:00 CT (the pre-briefing diagnostic -> self-heal chain, before 5:30 CT).
CRON_LINE_1="45 2 * * * $RUNNER >> $LOG_DIR/self-heal-cron.log 2>&1"
CRON_LINE_2="0 3 * * * $RUNNER >> $LOG_DIR/self-heal-cron.log 2>&1"

mkdir -p "$LOG_DIR"
chmod +x "$RUNNER" 2>/dev/null || true

tmp="$(mktemp)"
# Drop any prior self-heal lines (match the runner basename) AND any CRON_TZ line we
# own, so we never stack duplicates or leave a second CRON_TZ behind. Other crontab
# lines (e.g. the otter backfill) are preserved untouched.
crontab -l 2>/dev/null \
  | grep -v 'ec2-self-heal-run.sh' \
  | grep -v '^CRON_TZ=America/Chicago$' \
  > "$tmp" || true
# CRON_TZ must precede the schedule lines it applies to.
printf '%s\n' "$CRON_TZ_LINE" >> "$tmp"
printf '%s\n' "$CRON_LINE_1" >> "$tmp"
printf '%s\n' "$CRON_LINE_2" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "Installed EC2 pre-briefing self-heal cron (2:45 + 3:00 AM CT, CRON_TZ=America/Chicago):"
echo "$CRON_TZ_LINE"
echo "$CRON_LINE_1"
echo "$CRON_LINE_2"
