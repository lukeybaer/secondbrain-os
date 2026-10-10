#!/usr/bin/env bash
# Install the deploy-parity proof on an independent hourly cadence. The probe
# intentionally runs from the Git build path so it can compare origin/master
# and repo-owned file content against the active /opt release.
set -euo pipefail

ROOT="${SECONDBRAIN_BUILD_PATH_ROOT:-/home/ec2-user/secondbrain-current}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
LOG_FILE="${DEPLOY_PARITY_LOG_FILE:-/opt/secondbrain/logs/deploy-parity-cron.log}"
CRON_LINE="17 * * * * cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR $NODE_BIN scripts/verify-deploy-parity.js --json >> $LOG_FILE 2>&1"

if [[ "${1:-}" == "--dry-run" ]]; then
  printf '%s\n' "$CRON_LINE"
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
crontab -l 2>/dev/null | grep -v 'verify-deploy-parity.js' > "$tmp" || true
printf '%s\n' "$CRON_LINE" >> "$tmp"
crontab "$tmp"

echo "Installed hourly EC2 deploy-parity proof:"
echo "$CRON_LINE"
