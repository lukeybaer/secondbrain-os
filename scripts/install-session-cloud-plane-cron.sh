#!/usr/bin/env bash
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${ROOT}/logs"
mkdir -p "$LOG_DIR"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
crontab -l 2>/dev/null | grep -v 'session-cloud-plane.js reconcile' > "$tmp" || true
# One reconcile at a time, bounded under its two-minute cadence. On 2026-09-03
# at 10:26 AM CT the unlocked line piled up 18 reconcile and 23 ingest node
# processes (140 to 330 MB each) on a zero-credit t3.medium, drove the load
# average to 77, and the OOM killer took the backend, the clip build, and
# sshd's session with it. A run that cannot finish inside its own interval
# must be skipped by the lock and killed by the timeout, never stacked.
printf '%s\n' "*/2 * * * * flock -n /tmp/secondbrain-session-cloud-plane.lock timeout --kill-after=15s 110s env SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data nice -n 10 node /opt/secondbrain/scripts/session-cloud-plane.js reconcile >> /opt/secondbrain/logs/session-cloud-plane.log 2>&1" >> "$tmp"
crontab "$tmp"

echo "installed session cloud reconciliation every 2 minutes"
