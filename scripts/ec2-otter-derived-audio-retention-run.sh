#!/usr/bin/env bash
set -euo pipefail

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
if ! ROOT="$(readlink -f "$ROOT_LINK")" || [[ ! -d "$ROOT" ]]; then
  echo "[otter-derived-audio-retention] refused: cannot pin immutable release from $ROOT_LINK" >&2
  exit 75
fi
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${OTTER_RETENTION_LOG_DIR:-/opt/secondbrain/logs}"
LOCK_FILE="$DATA_DIR/life-archive/voiceprints/otter-derived-audio-retention.lock"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_FILE")"
cd "$ROOT"
export SECONDBRAIN_ROOT="$ROOT"
export SB_OTTER_RUNNER_RELEASE_ROOT="$ROOT"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[otter-derived-audio-retention] pending: another bounded retention pass is active"
  exit 0
fi

reconcile_on_exit() {
  if ! "$NODE_BIN" "$ROOT/scripts/otter-derived-audio-retention.js" \
    --reconcile-stale-active \
    --reason runner_exit_without_final_status >/dev/null; then
    echo "[otter-derived-audio-retention] warning: could not reconcile latest run status on exit" >&2
  fi
}
trap reconcile_on_exit EXIT

"$NODE_BIN" "$ROOT/scripts/otter-derived-audio-retention.js" \
  --reconcile-stale-active \
  --reason exclusive_runner_lock_reacquired >/dev/null

retention_priority="normal"
available_kb="$(df -Pk "$DATA_DIR" | awk 'NR == 2 { print $4 }')"
critical_free_kb="$(
  awk -v gib="${OTTER_STORAGE_CRITICAL_FREE_GB:-8}" \
    'BEGIN { printf "%.0f", gib * 1024 * 1024 }'
)"
if [[ "$available_kb" =~ ^[0-9]+$ ]] &&
  [[ "$critical_free_kb" =~ ^[0-9]+$ ]] &&
  (( available_kb < critical_free_kb )); then
  retention_priority="critical"
fi

ct_hour="$(TZ=America/Chicago date +%H)"
if [[ "$retention_priority" != "critical" ]] && {
  [[ "$ct_hour" -ge 22 ]] || [[ "$ct_hour" -lt 6 ]];
}; then
  echo "[otter-derived-audio-retention] priority-deferred: overnight briefing owns 22:00-06:00 CT"
  exit 0
fi

set +e
"$NODE_BIN" "$ROOT/scripts/host-work-admission.js" run \
  --kind otter-derived-audio-retention \
  --priority "$retention_priority" \
  --wait-ms 0 \
  --lease-ms "${OTTER_DERIVED_AUDIO_LEASE_MS:-28800000}" \
  -- \
  "$NODE_BIN" "$ROOT/scripts/otter-derived-audio-retention.js" \
    --write \
    --min-age-days "${OTTER_DERIVED_AUDIO_MIN_AGE_DAYS:-3}" \
    --max-files "${OTTER_DERIVED_AUDIO_MAX_FILES:-5000}" \
    --concurrency "${OTTER_DERIVED_AUDIO_CONCURRENCY:-6}" \
    --target-free-gb "${OTTER_STORAGE_TARGET_FREE_GB:-15}"
status=$?
set -e

if [[ "$status" -eq 75 ]]; then
  echo "[otter-derived-audio-retention] pending: critical host work owns the safe lane"
  exit 0
fi
exit "$status"
