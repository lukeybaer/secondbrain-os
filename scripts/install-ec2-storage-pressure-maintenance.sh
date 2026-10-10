#!/usr/bin/env bash
set -euo pipefail

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
if ! ROOT="$(readlink -f "$ROOT_LINK")" || [[ ! -d "$ROOT" ]]; then
  echo "[storage-pressure] refused: cannot pin immutable release from $ROOT_LINK" >&2
  exit 75
fi
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
SOURCE_ROOT="${SECONDBRAIN_BUILD_PATH_ROOT:-/home/ec2-user/secondbrain-current}"
LOG_DIR="/opt/secondbrain/logs"
ROTATE_FILE="/etc/logrotate.d/secondbrain-derived-logs"
SERVICE_FILE="/etc/systemd/system/secondbrain-storage-pressure-maintenance.service"
TIMER_FILE="/etc/systemd/system/secondbrain-storage-pressure-maintenance.timer"
RUNNER="$ROOT/scripts/ec2-storage-pressure-maintenance-run.sh"

for required in \
  "$ROOT/scripts/git-janitor.js" \
  "$ROOT/scripts/ec2-storage-pressure-maintenance.js" \
  "$RUNNER" \
  "$SOURCE_ROOT/.git" \
  "$DATA_DIR/tasks"; do
  [[ -e "$required" ]] || { echo "[storage-pressure] refused: required path missing: $required" >&2; exit 75; }
done
mkdir -p "$LOG_DIR" "$DATA_DIR/agent/storage-pressure/daily"

rotate_tmp="$(mktemp)"
cat > "$rotate_tmp" <<'EOF'
/opt/secondbrain/data/agent/voice-efs-reconcile.log {
  daily
  maxsize 100M
  rotate 7
  missingok
  notifempty
  compress
  compressoptions -6
  create 0640 ec2-user ec2-user
  su ec2-user ec2-user
}

/opt/secondbrain/data/agent/otter-exact-call-envelope-reconcile.log {
  daily
  maxsize 100M
  rotate 3
  missingok
  notifempty
  compress
  compressoptions -6
  create 0640 ec2-user ec2-user
  su ec2-user ec2-user
}

/opt/secondbrain/logs/*.log /opt/secondbrain/data/agent/amy-night-runs/*-production.log {
  daily
  maxsize 25M
  rotate 7
  missingok
  notifempty
  compress
  compressoptions -6
  copytruncate
  su ec2-user ec2-user
}
EOF
sudo install -m 0644 "$rotate_tmp" "$ROTATE_FILE"
rm -f "$rotate_tmp"

# The 2 GB target is append-and-close, so normal rename/create rotation avoids
# copytruncate's second full-size copy. Rotate it now; the timer owns all
# worktree deletion and every later maintenance pass.
sudo /usr/sbin/logrotate "$ROTATE_FILE"

service_tmp="$(mktemp)"
cat > "$service_tmp" <<EOF
[Unit]
Description=SecondBrain safe derived-log and terminal-worktree maintenance
After=network-online.target
RequiresMountsFor=/opt/secondbrain /opt/secondbrain/data $SOURCE_ROOT

[Service]
Type=oneshot
ExecStart=/usr/bin/env SECONDBRAIN_ROOT=$ROOT SECONDBRAIN_DATA_DIR=$DATA_DIR SECONDBRAIN_BUILD_PATH_ROOT=$SOURCE_ROOT /usr/bin/bash $RUNNER
Nice=10
CPUQuota=50%
MemoryMax=512M
TasksMax=128
TimeoutStartSec=1800
EOF
sudo install -m 0644 "$service_tmp" "$SERVICE_FILE"
rm -f "$service_tmp"

timer_tmp="$(mktemp)"
cat > "$timer_tmp" <<'EOF'
[Unit]
Description=SecondBrain CT safe storage maintenance schedule

[Timer]
OnCalendar=*-*-* 06:05:00 America/Chicago
Persistent=true
Unit=secondbrain-storage-pressure-maintenance.service

[Install]
WantedBy=timers.target
EOF
sudo install -m 0644 "$timer_tmp" "$TIMER_FILE"
rm -f "$timer_tmp"
sudo systemctl daemon-reload
if [[ -f "$DATA_DIR/agent/amy-night-owner.active" ]]; then
  sudo systemctl disable --now secondbrain-storage-pressure-maintenance.timer
else
  sudo systemctl enable --now secondbrain-storage-pressure-maintenance.timer
fi

# Current post-rotation evidence is useful, but the three-day clock begins only
# after the timer's first strict worktree audit writes the cleanup baseline.
SECONDBRAIN_DATA_DIR="$DATA_DIR" /usr/bin/node "$ROOT/scripts/ec2-storage-pressure-maintenance.js" --sample
echo "Installed derived-log rotation: $ROTATE_FILE"
echo "Installed safe cleanup; the single night owner invokes it after terminal delivery when active"
