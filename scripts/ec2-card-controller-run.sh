#!/usr/bin/env bash
#
# ec2-card-controller-run.sh -- cloud-only start of tomorrow's Daily Briefing.
#
# This is intentionally a card fabric, not another whole-briefing builder.
# At 11 PM CT it creates an honest unverified shell for tomorrow, runs the
# data-only source families, and then serializes scoped refresh-card publishes.
# Each card earns clean independently through its own live QC. The controller
# active-transaction journal restores a partial target transaction before the next run. The
# controller itself observes the run budget rather than this wrapper killing it.
# Deadline-path repair admission stops at the repair cutoff exported by
# scripts/lib/briefing-run-window.js (4:30 AM CT since 2026-09-07). Early
# readiness closes it sooner through the shared terminal state receipt. The
# 4:30 to 5:30 hour belongs to the peer-reviewed report; 5:30 delivers.
set -euo pipefail

# The controller is a deployed cloud runtime, not a Git checkout job. Never
# inherit the legacy SECONDBRAIN_ROOT default here: it can point at a stale
# build path after a successful /opt deploy.
ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
HEALER_ROOT="${SECONDBRAIN_HEALER_ROOT:-/home/ec2-user/secondbrain-current}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
LOCK="/tmp/secondbrain-card-controller-run.lock"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
# This runner opens TOMORROW's board at 11 PM CT. An explicit BRIEFING_DATE is
# useful for a supervised replay and always wins.
DATE="${BRIEFING_DATE:-$(TZ=America/Chicago date -d tomorrow +%F)}"
export SECONDBRAIN_BRIEFING_CODEX_CEILING="gpt-5.6-sol:medium"
# One clock source: the canonical 04:30 CT cutoff, or the date's owner-invoked
# catch-up schedule when one exists.
REPAIR_CUTOFF_EPOCH="$("$NODE_BIN" -p "const w=require('$ROOT/scripts/lib/briefing-run-window.js');const ms=w.repairAdmissionCutoffMs(process.argv[1],{dataDir:process.argv[2]});if(!Number.isFinite(ms))throw new Error('no cutoff');Math.floor(ms/1000)" "$DATE" "$DATA_DIR")" || { echo "[card-controller] cannot resolve the repair cutoff from scripts/lib/briefing-run-window.js" >&2; exit 1; }
NOW_EPOCH="$(date +%s)"
REPAIR_SECONDS_LEFT="$((REPAIR_CUTOFF_EPOCH - NOW_EPOCH))"
if [ "$REPAIR_SECONDS_LEFT" -le 0 ]; then
  echo "[card-controller-run] $(date -u +%FT%TZ) repair cutoff reached for $DATE; no refresh, QC, or healing started."
  exit 0
fi
REQUESTED_MAX_SECONDS="${BRIEFING_CARD_CONTROLLER_MAX_SECONDS:-$REPAIR_SECONDS_LEFT}"
if [ "$REQUESTED_MAX_SECONDS" -lt "$REPAIR_SECONDS_LEFT" ]; then
  MAX_SECONDS="$REQUESTED_MAX_SECONDS"
else
  MAX_SECONDS="$REPAIR_SECONDS_LEFT"
fi
echo "[card-controller-run] $(date -u +%FT%TZ) root=$ROOT data_dir=$DATA_DIR date=$DATE max_seconds=$MAX_SECONDS"

# Controller source adapters are deterministic/local or subscription-neutral.
# Never let a stale process env silently turn an overnight card repair into a
# charged API lane.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

CMD=("$NODE_BIN" scripts/card-controller.js --mode overnight --cards all --date "$DATE" --bootstrap --straight-line-news --max-seconds "$MAX_SECONDS")

if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${CARD_CONTROLLER_DRY_RUN:-}" = "1" ]; then
  echo "[card-controller-run] DRY-RUN: would run (cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR ${CMD[*]})"
  exit 0
fi

cd "$ROOT" || { echo "[card-controller-run] cannot cd to $ROOT" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# Off and shadow retain the rollback flock, so effective root concurrency is
# one while conflict decisions and lifecycle telemetry are proven. Enforce is
# reachable only after the shadow-pass marker or explicit shadow-pass env is
# present; conflict-key leases then become the sole controller exclusion
# authority. One flag flip back to off restores this flock immediately.
CONFLICT_MODE="$($NODE_BIN -e 'const {rolloutMode}=require("./scripts/lib/controller-conflict-leases"); process.stdout.write(rolloutMode({dataDir:process.argv[1]}).effective)' "$DATA_DIR")"
owns_run=0
if [ "$CONFLICT_MODE" = "enforce" ]; then
  owns_run=1
  if env SECONDBRAIN_DATA_DIR="$DATA_DIR" SECONDBRAIN_HEALER_ROOT="$HEALER_ROOT" SECONDBRAIN_CONTROLLER_ROOT="$ROOT" EC2_HOST_HTTP="${EC2_HOST_HTTP:-http://localhost:3001}" "${CMD[@]}"; then
    status=0
  else
    status=$?
  fi
else
  exec 9>"$LOCK"
  if flock -n 9; then
  owns_run=1
  SUPERVISOR_TOKEN="$("$NODE_BIN" -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
  printf '%s\n' "$SUPERVISOR_TOKEN" >"$LOCK.owner-token"
  if env SECONDBRAIN_DATA_DIR="$DATA_DIR" SECONDBRAIN_HEALER_ROOT="$HEALER_ROOT" SECONDBRAIN_CONTROLLER_ROOT="$ROOT" EC2_HOST_HTTP="${EC2_HOST_HTTP:-http://localhost:3001}" CARD_CONTROLLER_SUPERVISOR_LOCK_PATH="$LOCK" CARD_CONTROLLER_SUPERVISOR_LOCK_TOKEN="$SUPERVISOR_TOKEN" CARD_CONTROLLER_SUPERVISOR_PID="$$" "${CMD[@]}"; then
    status=0
  else
    status=$?
  fi
  if [ "$(cat "$LOCK.owner-token" 2>/dev/null || true)" = "$SUPERVISOR_TOKEN" ]; then
    rm -f "$LOCK.owner-token"
  fi
  flock -u 9 || true
  else
    status=1
  fi
fi

# The deterministic night coordinator observes the terminal run receipt,
# completes report research, and owns the only delivery invocation. The card
# controller never races it by calling the notifier directly.

if [ "$status" = "0" ]; then
  echo "[card-controller-run] $(date -u +%FT%TZ) completed."
elif [ "$status" = "1" ]; then
  echo "[card-controller-run] $(date -u +%FT%TZ) skipped: controller already active or has remaining honest defects."
elif [ "$status" = "124" ] || [ "$status" = "137" ]; then
  echo "[card-controller-run] $(date -u +%FT%TZ) child timeout or external interruption; the controller receipt records the stopped card and transaction recovery state."
else
  echo "[card-controller-run] $(date -u +%FT%TZ) finished exit=$status; inspect the controller receipt."
fi
exit 0
