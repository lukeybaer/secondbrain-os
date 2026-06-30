#!/usr/bin/env bash
#
# install-ec2-otter-resolver-cron.sh -- idempotently install the pre-briefing Otter
# voice-intelligence RESOLVER refresh cron on EC2 (green-tomorrow WAVE 3A).
#
# Schedules scripts/ec2-otter-resolver-run.sh at 4:45 AM CT under
# CRON_TZ=America/Chicago -- AFTER the 2:45/3:00 CT self-heal chain and BEFORE the
# 5:30 CT Daily Executive Briefing, so the leaked resolver lock is force-broken and
# the coverage/pareto/system-health artifacts are fresh when the briefing reads them.
#
# Run ON EC2:  /home/ec2-user/secondbrain-current/scripts/install-ec2-otter-resolver-cron.sh
# It removes any prior resolver cron line (matched by the runner basename) first, so
# re-running is safe (idempotent). It preserves the shared CRON_TZ line and every
# other crontab line (self-heal, audio backfill, etc.) untouched: it only ADDS the
# CRON_TZ line if no CRON_TZ=America/Chicago is already present, so it never stacks a
# duplicate against the self-heal installer that owns the same TZ line. The operator
# installs this on EC2.
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
LOG_DIR="${OTTER_RESOLVER_LOG_DIR:-/opt/secondbrain/logs}"
RUNNER="$ROOT/scripts/ec2-otter-resolver-run.sh"
CRON_TZ_LINE="CRON_TZ=America/Chicago"
# 4:45 CT: after the 2:45/3:00 self-heal, before the 5:30 briefing.
CRON_LINE="45 4 * * * $RUNNER >> $LOG_DIR/otter-resolver-cron.log 2>&1"

mkdir -p "$LOG_DIR"
chmod +x "$RUNNER" 2>/dev/null || true

tmp="$(mktemp)"
# Drop any prior resolver line (match the runner basename) so we never stack
# duplicates. Other crontab lines (self-heal, audio backfill, the shared CRON_TZ)
# are preserved untouched.
crontab -l 2>/dev/null | grep -v 'ec2-otter-resolver-run.sh' > "$tmp" || true

# CRON_TZ must precede the schedule lines it applies to. Add it ONLY if not already
# present (the self-heal installer may already own it); never stack a duplicate.
if ! grep -q '^CRON_TZ=America/Chicago$' "$tmp"; then
  printf '%s\n' "$CRON_TZ_LINE" >> "$tmp"
fi
printf '%s\n' "$CRON_LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "Installed EC2 pre-briefing Otter resolver-refresh cron (4:45 AM CT, CRON_TZ=America/Chicago):"
echo "$CRON_TZ_LINE"
echo "$CRON_LINE"
