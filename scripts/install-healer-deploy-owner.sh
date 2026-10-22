#!/usr/bin/env bash
# Install the standing healer deploy coordinator owner (GAP 5, 2026-08-24).
#
# The coordinator's durable inbox previously had no standing owner: batching,
# deploy, and proof were driven only by the requesting process, so a blocked
# deploy died with its requester. This unit gives the inbox a timer-fired
# owner that adopts orphaned requests and drives them to proved completion.
set -euo pipefail

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
if ! ROOT="$(readlink -f "$ROOT_LINK")" || [[ ! -d "$ROOT" ]]; then
  echo "[healer-deploy-owner] refused: cannot pin immutable release from $ROOT_LINK" >&2
  exit 75
fi
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="/opt/secondbrain/logs"
SERVICE_FILE="/etc/systemd/system/secondbrain-healer-deploy-owner.service"
TIMER_FILE="/etc/systemd/system/secondbrain-healer-deploy-owner.timer"
RUNNER="$ROOT/scripts/healer-deploy-coordinator-owner.js"

if [[ ! -f "$RUNNER" ]]; then
  echo "[healer-deploy-owner] refused: runner missing at $RUNNER" >&2
  exit 75
fi
mkdir -p "$LOG_DIR" "$DATA_DIR/agent/healer-deploy-coordinator"

service_tmp="$(mktemp)"
cat > "$service_tmp" <<EOF
[Unit]
Description=SecondBrain standing owner for orphaned healer deploy requests
After=network-online.target
RequiresMountsFor=/opt/secondbrain /opt/secondbrain/data

[Service]
Type=oneshot
User=ec2-user
WorkingDirectory=$ROOT
ExecStart=/usr/bin/env SECONDBRAIN_DATA_DIR=$DATA_DIR SECONDBRAIN_CONTROLLER_ROOT=$ROOT_LINK /usr/bin/node $RUNNER --max-runtime-ms 240000
TimeoutStartSec=300
StandardOutput=append:$LOG_DIR/healer-deploy-owner.log
StandardError=append:$LOG_DIR/healer-deploy-owner.log
EOF
sudo install -m 0644 "$service_tmp" "$SERVICE_FILE"
rm -f "$service_tmp"

timer_tmp="$(mktemp)"
cat > "$timer_tmp" <<'EOF'
[Unit]
Description=SecondBrain healer deploy owner sweep schedule

[Timer]
OnBootSec=2min
OnUnitInactiveSec=5min
Persistent=true
Unit=secondbrain-healer-deploy-owner.service

[Install]
WantedBy=timers.target
EOF
sudo install -m 0644 "$timer_tmp" "$TIMER_FILE"
rm -f "$timer_tmp"

sudo systemctl daemon-reload
sudo systemctl enable --now secondbrain-healer-deploy-owner.timer

echo "Installed standing deploy owner: secondbrain-healer-deploy-owner.service"
echo "Installed sweep timer: secondbrain-healer-deploy-owner.timer"
