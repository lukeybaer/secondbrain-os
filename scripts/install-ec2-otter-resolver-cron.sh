#!/usr/bin/env bash
#
# RETIRED COMPATIBILITY ENTRYPOINT.
#
# The old 4:45 AM archive-wide "pre-brief resolver" predates the current
# per-call processing ledger and exact-call healer. A briefing-wide resolver
# pass has no owner in the one-process-per-work-unit architecture and can
# overwrite or obscure exact-call failure evidence.
#
# Keep this filename only so an old deployment instruction cannot reinstall
# the obsolete schedule. Running it now removes that one legacy cron line and
# preserves every exact-call, audio, card, and briefing schedule.
set -euo pipefail

tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -v 'ec2-otter-resolver-run.sh' > "$tmp" || true
crontab "$tmp"
rm -f "$tmp"

echo "Removed retired archive-wide Otter pre-brief resolver schedule."
echo "Current owners: exact-call ingest/Fargate graph plus ec2-otter-call-healer-run.sh."
