#!/usr/bin/env bash
# Activate or roll back the legacy EC2 watcher schedule used during cloud-control shadowing.
set -euo pipefail
if [ -f "${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}/agent/amy-night-owner.active" ]; then
  exec bash "${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}/scripts/install-amy-night-owner.sh" --verify
fi

RUNTIME_ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
CONTROL_MODE_FILE="${AMY_BRIEFING_CONTROL_MODE_FILE:-/opt/amy-control/mode}"
CONTROL_TIMER="${AMY_BRIEFING_CONTROL_TIMER:-amy-briefing-control.timer}"
SYSTEMCTL_BIN="${AMY_BRIEFING_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
FLOCK_BIN="${AMY_CRONTAB_FLOCK_BIN:-/usr/bin/flock}"
CRONTAB_LOCK_FILE="${AMY_CRONTAB_MUTATION_LOCK:-/tmp/amy-crontab-mutation.lock}"
TZLINE="CRON_TZ=America/Chicago"
CMD="flock -n /tmp/secondbrain-overnight-watcher-launch.lock /usr/bin/bash $RUNTIME_ROOT/scripts/ec2-overnight-watcher-run.sh >> $LOG_DIR/overnight-watcher-cron.log 2>&1"
LINE_WARMUP="45,55 22 * * * $CMD"
LINE_LAST_RETRY="5 23 * * * $CMD"
MODE="${1:-}"

case "$MODE" in
  --activate|--rollback) ;;
  *)
    echo "Usage: $0 --activate|--rollback" >&2
    echo "Refusing to change cron without an explicit authority decision." >&2
    exit 2
    ;;
esac

command -v "$FLOCK_BIN" >/dev/null 2>&1 || {
  echo "Refusing to change cron: flock is unavailable at $FLOCK_BIN." >&2
  exit 1
}
exec 9>"$CRONTAB_LOCK_FILE"
"$FLOCK_BIN" -w 10 9 || {
  echo "Refusing to change cron: timed out waiting for $CRONTAB_LOCK_FILE." >&2
  exit 1
}

mkdir -p "$LOG_DIR"
original="$(mktemp)"
filtered="$(mktemp)"
cron_error="$(mktemp)"
trap 'rm -f "$original" "$filtered" "$cron_error"' EXIT

set +e
crontab -l >"$original" 2>"$cron_error"
cron_status=$?
set -e
if [ "$cron_status" -ne 0 ]; then
  if [ "$cron_status" -eq 1 ] && grep -qi 'no crontab for' "$cron_error"; then
    : >"$original"
  else
    echo "Refusing to change cron: crontab -l failed (exit $cron_status): $(tr '\n' ' ' <"$cron_error")" >&2
    exit 1
  fi
fi

grep -v 'ec2-overnight-watcher-run.sh' "$original" >"$filtered" || true
set +e
legacy_row_count="$(grep -c 'ec2-overnight-watcher-run.sh' "$original")"
grep_status=$?
set -e
if [ "$grep_status" -gt 1 ] || [[ ! "$legacy_row_count" =~ ^[0-9]+$ ]]; then
  echo "Refusing to change cron: could not count legacy watcher rows." >&2
  exit 1
fi

cloud_control_is_active() {
  local control_mode=''
  if [ -r "$CONTROL_MODE_FILE" ]; then
    control_mode="$(tr -d '[:space:]' <"$CONTROL_MODE_FILE")"
  fi
  [ "$control_mode" = "active" ] || return 1

  command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1 || return 1
  "$SYSTEMCTL_BIN" is-enabled --quiet "$CONTROL_TIMER" >/dev/null 2>&1 &&
    "$SYSTEMCTL_BIN" is-active --quiet "$CONTROL_TIMER" >/dev/null 2>&1
}

if [ "$MODE" = "--activate" ] && cloud_control_is_active; then
  if [ "$legacy_row_count" -gt 0 ]; then
    crontab "$filtered"
    repair_result="removed $legacy_row_count legacy watcher row(s)"
  else
    repair_result="no legacy watcher rows were present"
  fi
  echo "REFUSED_ACTIVE_CLOUD_CONTROL: cloud control timer is active and owns the watcher schedule; $repair_result."
  exit 0
fi

if [ "$MODE" = "--rollback" ]; then
  if [ "$legacy_row_count" -gt 0 ]; then
    crontab "$filtered"
  fi
  echo "Rolled back: removed $legacy_row_count EC2 overnight watcher cron row(s)."
  exit 0
fi

grep -q '^CRON_TZ=America/Chicago' "$filtered" || echo "$TZLINE" >> "$filtered"
echo "$LINE_WARMUP" >> "$filtered"
echo "$LINE_LAST_RETRY" >> "$filtered"
crontab "$filtered"

echo "Activated the canonical EC2 overnight watcher cron:"
echo "$TZLINE"
echo "$LINE_WARMUP"
echo "$LINE_LAST_RETRY"
echo "Cutover is not complete until the Windows SecondBrain-OvernightWatcher task is verified disabled."
