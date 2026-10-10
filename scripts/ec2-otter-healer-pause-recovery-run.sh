#!/usr/bin/env bash
set -euo pipefail

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
if ! ROOT="$(readlink -f "$ROOT_LINK")" || [[ ! -d "$ROOT" ]]; then
  echo "[otter-pause-recovery] refused: cannot pin immutable release from $ROOT_LINK" >&2
  exit 75
fi
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
ENV_FILE="${SECONDBRAIN_ENV_FILE:-$ROOT/.env}"
if [[ -r "$ENV_FILE" ]]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

LANE="live"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lane)
      LANE="${2:-}"
      shift 2
      ;;
    *)
      echo "usage: ec2-otter-healer-pause-recovery-run.sh --lane live|historical" >&2
      exit 2
      ;;
  esac
done
if [[ "$LANE" != "live" && "$LANE" != "historical" ]]; then
  echo "invalid Otter healer lane: $LANE" >&2
  exit 2
fi

VP_DIR="$DATA_DIR/life-archive/voiceprints"
RECOVERY_LOCK="$VP_DIR/otter-healer-pause-recovery.lock"
HISTORICAL_LOCK="$VP_DIR/otter-call-healer-historical-scheduler.lock"
LIVE_LOCK="$VP_DIR/otter-call-healer-live-scheduler.lock"
WORKER_LOCK="$VP_DIR/otter-exact-worker.lock.flock"
if [[ "$LANE" == "live" ]]; then
  PAUSE_FILE="${OTTER_LIVE_HEALER_PAUSE_FILE:-$VP_DIR/otter-live-healer.pause}"
else
  PAUSE_FILE="${OTTER_HISTORICAL_BACKFILL_PAUSE_FILE:-$VP_DIR/otter-historical-backfill.pause}"
fi
QUARANTINE_DIR="$DATA_DIR/agent/otter-pause-incidents"
REPORT_FILE="$DATA_DIR/agent/otter-healer-pause-recovery-${LANE}-latest.json"
DEPLOY_LOCK_FILE="${SB_DEPLOY_LOCK_FILE:-/tmp/secondbrain-deploy.lock}"

mkdir -p "$VP_DIR" "$QUARANTINE_DIR" "$(dirname "$REPORT_FILE")"
cd "$ROOT"
export SECONDBRAIN_ROOT="$ROOT"
export SB_OTTER_RUNNER_RELEASE_ROOT="$ROOT"

record_blocked_recovery() {
  local blocked_reason="$1"
  "$NODE_BIN" "$ROOT/scripts/lib/otter-healer-pause.js" \
    --file "$PAUSE_FILE" \
    --quarantine-stale-invalid \
    --quarantine-dir "$QUARANTINE_DIR" \
    --report-file "$REPORT_FILE" \
    --tasks-dir "$DATA_DIR/tasks" \
    --deploy-lock-file "$DEPLOY_LOCK_FILE" \
    --blocked-reason "$blocked_reason" >/dev/null || true
}

# One recovery contender, then both scheduler locks in a fixed nonblocking
# order, then the host-global exact worker fence. An ordinary lane runner may
# already hold one scheduler lock; in that case recovery exits without
# mutating the pause and retries on the next cron tick. A deployment holding
# both locks likewise wins. There is no wait cycle and therefore no deadlock.
exec 6>"$RECOVERY_LOCK"
if ! flock -n 6; then
  echo "[otter-pause-recovery] another recovery pass is active"
  exit 0
fi
exec 7>"$HISTORICAL_LOCK"
if ! flock -n 7; then
  echo "[otter-pause-recovery] blocked: historical scheduler lock is active"
  record_blocked_recovery historical_scheduler_lock_active
  exit 0
fi
exec 8>"$LIVE_LOCK"
if ! flock -n 8; then
  echo "[otter-pause-recovery] blocked: live scheduler lock is active"
  record_blocked_recovery live_scheduler_lock_active
  exit 0
fi
exec 9>"$WORKER_LOCK"
if ! flock -n 9; then
  echo "[otter-pause-recovery] blocked: exact worker fence is active"
  record_blocked_recovery exact_worker_fence_active
  exit 0
fi

"$NODE_BIN" "$ROOT/scripts/lib/otter-healer-pause.js" \
  --file "$PAUSE_FILE" \
  --quarantine-stale-invalid \
  --quarantine-dir "$QUARANTINE_DIR" \
  --report-file "$REPORT_FILE" \
  --tasks-dir "$DATA_DIR/tasks" \
  --deploy-lock-file "$DEPLOY_LOCK_FILE" \
  --locks-held
