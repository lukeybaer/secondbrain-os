#!/usr/bin/env bash
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${OTTER_CALL_HEALER_LOG_DIR:-/opt/secondbrain/logs}"
RUNNER="$ROOT/scripts/ec2-otter-call-healer-run.sh"
PAUSE_RECOVERY_RUNNER="$ROOT/scripts/ec2-otter-healer-pause-recovery-run.sh"
RETENTION_RUNNER="$ROOT/scripts/ec2-otter-derived-audio-retention-run.sh"
IDENTITY_CAP_RUNNER="$ROOT/scripts/ec2-global-identity-cap-run.sh"
LANE_SCOPE_RUNNER="$ROOT/scripts/ec2-otter-lane-scope-run.sh"
BASH_BIN="${OTTER_CALL_HEALER_BASH:-/usr/bin/bash}"
HISTORICAL_PAUSE_FILE="${OTTER_HISTORICAL_BACKFILL_PAUSE_FILE:-$DATA_DIR/life-archive/voiceprints/otter-historical-backfill.pause}"
LIVE_PAUSE_FILE="${OTTER_LIVE_HEALER_PAUSE_FILE:-$DATA_DIR/life-archive/voiceprints/otter-live-healer.pause}"
# Historical replay is attended work, not a standing maintenance job.  It is
# installed only when an operator explicitly enables it for that installation;
# ordinary releases remove any old historical cron line while preserving the
# live exact-call lane and retention task.
HISTORICAL_BACKFILL_ENABLED="${OTTER_HISTORICAL_BACKFILL_ENABLED:-0}"
LIVE_CRON_LINE="*/5 * * * * $BASH_BIN $PAUSE_RECOVERY_RUNNER --lane live >> $LOG_DIR/otter-call-healer.log 2>&1; $BASH_BIN $LANE_SCOPE_RUNNER live $RUNNER >> $LOG_DIR/otter-call-healer.log 2>&1"
HISTORICAL_CRON_LINE="17 * * * * $BASH_BIN $PAUSE_RECOVERY_RUNNER --lane historical >> $LOG_DIR/otter-call-healer-historical.log 2>&1; OTTER_CALL_HEALER_INCLUDE_HISTORICAL=1 SB_IDENTITY_WORK_KIND=historical $BASH_BIN $IDENTITY_CAP_RUNNER $BASH_BIN $RUNNER >> $LOG_DIR/otter-call-healer-historical.log 2>&1"
# One-minute fast path: promotes a finished Fargate envelope for just that call
# and starts the live lane at once, and re-queues a job whose task stopped
# without an envelope. The five-minute lane and ten-minute reconcile remain.
FASTPATH_RUNNER="$ROOT/scripts/otter-envelope-fastpath.js"
FASTPATH_CRON_LINE="* * * * * cd $ROOT && flock -n /tmp/secondbrain-otter-fastpath.lock timeout --kill-after=15s 170s env VOICE_EFS_MOUNT=/mnt/sbvoice SECONDBRAIN_ROOT=$ROOT SECONDBRAIN_DATA_DIR=$DATA_DIR OTTER_CALL_HEALER_LOG_DIR=$LOG_DIR /usr/bin/node $FASTPATH_RUNNER >> $LOG_DIR/otter-envelope-fastpath.log 2>&1"
RETENTION_CRON_LINE="23 * * * * $BASH_BIN $LANE_SCOPE_RUNNER retention $RETENTION_RUNNER >> $LOG_DIR/otter-derived-audio-retention.log 2>&1"

mkdir -p "$LOG_DIR"
chmod +x "$RUNNER" "$PAUSE_RECOVERY_RUNNER" "$RETENTION_RUNNER" "$IDENTITY_CAP_RUNNER" "$LANE_SCOPE_RUNNER"

# Cron has no login session. Keep one user manager alive and prove the exact
# systemd scope properties on this host before putting the scope in front of
# the five-minute production lane.
RUNTIME_USER="$(id -un)"
RUNTIME_UID="$(id -u)"
sudo loginctl enable-linger "$RUNTIME_USER"
sudo systemctl start "user@${RUNTIME_UID}.service"
export XDG_RUNTIME_DIR="/run/user/$RUNTIME_UID"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
[[ -S "$XDG_RUNTIME_DIR/bus" ]] || { echo "Otter scope install refused: user systemd bus missing" >&2; exit 75; }
systemctl --user show-environment >/dev/null
"$BASH_BIN" "$LANE_SCOPE_RUNNER" live /usr/bin/bash -c '
  set -euo pipefail
  cgroup="$(awk -F: '\''$1 == "0" { print $3 }'\'' /proc/self/cgroup)"
  root="/sys/fs/cgroup${cgroup}"
  [[ -n "$cgroup" && -d "$root" ]]
  [[ "$(cat "$root/memory.high")" != "max" ]]
  [[ "$(cat "$root/memory.max")" != "max" ]]
  [[ "$(cat "$root/memory.swap.max")" != "max" ]]
  [[ "$(awk '\''{ print $1 }'\'' "$root/cpu.max")" != "max" ]]
  [[ "$(cat "$root/pids.max")" != "max" ]]
'

tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -Ev 'ec2-otter-call-healer-run.sh|ec2-otter-healer-pause-recovery-run.sh|ec2-otter-derived-audio-retention-run.sh|otter-envelope-fastpath.js' > "$tmp" || true
# The live lane remains scheduled so its bounded pause is observed. Historical
# replay is intentionally different: it needs an explicit attended enablement
# and otherwise has no standing scheduler to resume it after a pause expires.
printf '%s\n' "$LIVE_CRON_LINE" >> "$tmp"
printf '%s\n' "$RETENTION_CRON_LINE" >> "$tmp"
if [[ -f "$FASTPATH_RUNNER" ]]; then
  printf '%s\n' "$FASTPATH_CRON_LINE" >> "$tmp"
fi
if [[ "$HISTORICAL_BACKFILL_ENABLED" == "1" ]]; then
  printf '%s\n' "$HISTORICAL_CRON_LINE" >> "$tmp"
fi
crontab "$tmp"
rm -f "$tmp"

echo "Installed exact-call Otter healer scheduler:"
echo "$LIVE_CRON_LINE"
if [[ -e "$LIVE_PAUSE_FILE" ]]; then
  echo "Live healer currently paused by $LIVE_PAUSE_FILE (runner enforces the pause TTL)"
fi
echo "$RETENTION_CRON_LINE"
echo "$FASTPATH_CRON_LINE"
if [[ "$HISTORICAL_BACKFILL_ENABLED" == "1" ]]; then
  echo "$HISTORICAL_CRON_LINE"
  if [[ -e "$HISTORICAL_PAUSE_FILE" ]]; then
    echo "Historical backfill currently paused by $HISTORICAL_PAUSE_FILE (runner enforces the pause TTL)"
  fi
else
  echo "Historical backfill schedule omitted: OTTER_HISTORICAL_BACKFILL_ENABLED is not explicitly 1"
fi
