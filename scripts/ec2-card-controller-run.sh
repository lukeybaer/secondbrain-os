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
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
LOCK="/tmp/secondbrain-card-controller-run.lock"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
# This runner opens TOMORROW's board at 11 PM CT. An explicit BRIEFING_DATE is
# useful for a supervised replay and always wins.
DATE="${BRIEFING_DATE:-$(TZ=America/Chicago date -d tomorrow +%F)}"
MAX_SECONDS="${BRIEFING_CARD_CONTROLLER_MAX_SECONDS:-21000}"

echo "[card-controller-run] $(date -u +%FT%TZ) root=$ROOT data_dir=$DATA_DIR date=$DATE max_seconds=$MAX_SECONDS"

# Controller source adapters are deterministic/local or subscription-neutral.
# Never let a stale process env silently turn an overnight card repair into a
# charged API lane.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

CMD=("$NODE_BIN" scripts/card-controller.js --mode overnight --cards all --date "$DATE" --bootstrap --max-seconds "$MAX_SECONDS")

if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${CARD_CONTROLLER_DRY_RUN:-}" = "1" ]; then
  echo "[card-controller-run] DRY-RUN: would run (cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR ${CMD[*]})"
  exit 0
fi

cd "$ROOT" || { echo "[card-controller-run] cannot cd to $ROOT" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# One controller lease serializes card mutation itself; this outer flock only
# avoids two cron triggers creating noisy duplicate supervisors. The controller
# owns the deadline and each child-owned timeout, so an outer OS kill cannot
# orphan a card writer after the transaction journal was opened.
if flock -n "$LOCK" env SECONDBRAIN_DATA_DIR="$DATA_DIR" "${CMD[@]}"; then
  status=0
else
  status=$?
fi

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
