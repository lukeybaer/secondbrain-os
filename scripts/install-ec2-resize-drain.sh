#!/usr/bin/env bash
set -euo pipefail

# The OnCalendar times below (05:30:00 / 22:10:00 America/Chicago) are the
# scale-down/scale-up scheduler crons in scripts/infra/apply-nightly-ec2-resize.js
# minus the 5-minute prepare lead, both derived from the single source of
# truth in scripts/lib/nightly-resize-schedule.js. If that schedule ever
# moves, update the OnCalendar lines here to match and re-run
# scripts/__tests__/nightly-resize-schedule-drift.test.js.

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
if ! ROOT="$(readlink -f "$ROOT_LINK")" || [[ ! -d "$ROOT" ]]; then
  echo "[resize-drain] refused: cannot pin immutable release from $ROOT_LINK" >&2
  exit 75
fi
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="/opt/secondbrain/logs"
SERVICE_FILE="/etc/systemd/system/secondbrain-resize-drain.service"
PREPARE_SERVICE_FILE="/etc/systemd/system/secondbrain-resize-predrain.service"
PREPARE_TIMER_FILE="/etc/systemd/system/secondbrain-resize-predrain.timer"
RUNNER="$ROOT/scripts/ec2-resize-drain.js"

if [[ ! -f "$RUNNER" ]]; then
  echo "[resize-drain] refused: runner missing at $RUNNER" >&2
  exit 75
fi
mkdir -p "$LOG_DIR" "$DATA_DIR/agent/host-work-admission"

service_tmp="$(mktemp)"
cat > "$service_tmp" <<EOF
[Unit]
Description=SecondBrain bounded process-tree drain before EC2 stop/resize
DefaultDependencies=no
Conflicts=shutdown.target
After=network-online.target pm2-ec2-user.service
Before=shutdown.target reboot.target halt.target
RequiresMountsFor=/opt/secondbrain /opt/secondbrain/data

[Service]
Type=oneshot
User=ec2-user
ExecStart=/usr/bin/env SECONDBRAIN_DATA_DIR=$DATA_DIR /usr/bin/node $RUNNER --clear-stale
RemainAfterExit=yes
ExecStop=/usr/bin/env SECONDBRAIN_DATA_DIR=$DATA_DIR /usr/bin/node $RUNNER --shutdown --max-wait-ms 120000
TimeoutStopSec=150

[Install]
WantedBy=multi-user.target
EOF
sudo install -m 0644 "$service_tmp" "$SERVICE_FILE"
rm -f "$service_tmp"

prepare_service_tmp="$(mktemp)"
cat > "$prepare_service_tmp" <<EOF
[Unit]
Description=SecondBrain admission pre-drain before scheduled EC2 resize
After=network-online.target pm2-ec2-user.service
RequiresMountsFor=/opt/secondbrain /opt/secondbrain/data

[Service]
Type=oneshot
User=ec2-user
ExecStart=/usr/bin/env SECONDBRAIN_DATA_DIR=$DATA_DIR /usr/bin/node $RUNNER --prepare --max-wait-ms 240000
TimeoutStartSec=270
EOF
sudo install -m 0644 "$prepare_service_tmp" "$PREPARE_SERVICE_FILE"
rm -f "$prepare_service_tmp"

# An owner-disabled pre-drain timer stays disabled across deploys. ExampleCo
# disabled it on 2026-09-22 to hold the box at m7i.xlarge, and every deploy
# silently re-armed it. Only a first install or an enabled timer is (re)armed.
prior_timer_state="$(systemctl is-enabled secondbrain-resize-predrain.timer 2>/dev/null || true)"
keep_timer_disabled=0
if [[ -f "$PREPARE_TIMER_FILE" && "$prior_timer_state" == "disabled" ]]; then
  keep_timer_disabled=1
fi

prepare_timer_tmp="$(mktemp)"
cat > "$prepare_timer_tmp" <<'EOF'
[Unit]
Description=SecondBrain CT resize pre-drain schedule

[Timer]
OnCalendar=*-*-* 05:30:00 America/Chicago
OnCalendar=*-*-* 22:10:00 America/Chicago
Persistent=true
Unit=secondbrain-resize-predrain.service

[Install]
WantedBy=timers.target
EOF
sudo install -m 0644 "$prepare_timer_tmp" "$PREPARE_TIMER_FILE"
rm -f "$prepare_timer_tmp"
sudo systemctl daemon-reload
sudo systemctl enable --now secondbrain-resize-drain.service
if [[ "$keep_timer_disabled" == "1" ]]; then
  echo "Kept owner-disabled CT resize pre-drain timer disabled: secondbrain-resize-predrain.timer"
else
  sudo systemctl enable --now secondbrain-resize-predrain.timer
  echo "Installed CT resize pre-drain timer: secondbrain-resize-predrain.timer"
fi
echo "Installed shutdown-owned drain: secondbrain-resize-drain.service"
