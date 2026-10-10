#!/usr/bin/env bash
#
# install-ec2-morning-briefing-cron.sh -- idempotent install of independent
# 2:00/2:25 plus 4:00/4:25 report drafting, 5:00/5:10 research refresh,
# and the 5:20/5:26/5:29 AM CT deterministic-coordinator recovery checkpoints on EC2.
set -euo pipefail
if [ -f "${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}/agent/amy-night-owner.active" ]; then
  exec bash "${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}/scripts/install-amy-night-owner.sh" --verify
fi

RUNNER="/opt/secondbrain/scripts/ec2-overnight-watcher-run.sh"
PREP_RUNNER="/opt/secondbrain/scripts/ec2-morning-report-prep-run.sh"
WATCHDOG="/opt/secondbrain/scripts/briefing-delivery-watchdog.js"
LOG="/opt/secondbrain/logs/morning-briefing-cron.log"
PREP_LOG="/opt/secondbrain/logs/morning-report-prep-cron.log"
LINE="20,26,29 5 * * * SB_WATCHER_RECOVERY_ATTEMPT_ID=deadline-fallback $RUNNER >> $LOG 2>&1"
EARLY_PREP_LINE="0,25 2 * * * $PREP_RUNNER >> $PREP_LOG 2>&1"
PREP_LINE="0,25 4 * * * $PREP_RUNNER >> $PREP_LOG 2>&1"
FINAL_LINE="0,10 5 * * * $PREP_RUNNER >> $PREP_LOG 2>&1"
WATCHDOG_LINE="31 5 * * * /usr/bin/node $WATCHDOG --probe --data-dir /opt/secondbrain/data >> $LOG 2>&1"
TZLINE="CRON_TZ=America/Chicago"

tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -v "ec2-morning-briefing-run.sh" | grep -v "SB_WATCHER_RECOVERY_ATTEMPT_ID=deadline-fallback" | grep -v "ec2-morning-report-prep-run.sh" | grep -v "briefing-delivery-watchdog.js" > "$tmp" || true
grep -q "^CRON_TZ=America/Chicago" "$tmp" || echo "$TZLINE" >> "$tmp"
echo "$EARLY_PREP_LINE" >> "$tmp"
echo "$PREP_LINE" >> "$tmp"
echo "$FINAL_LINE" >> "$tmp"
echo "$WATCHDOG_LINE" >> "$tmp"
echo "$LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "Installed EC2 report research (2:00/2:25, 4:00/4:25, 5:00/5:10), coordinator recovery (5:20/5:26/5:29), and read-only proof audit (5:31 AM CT):"
echo "$TZLINE"
echo "$EARLY_PREP_LINE"
echo "$PREP_LINE"
echo "$FINAL_LINE"
echo "$WATCHDOG_LINE"
echo "$LINE"
