#!/usr/bin/env bash
# Graphiti realtime maintenance, cron */15.
#
# IMPORTANT: no `set -e`. The tail steps (lifetime/coverage health) exit nonzero
# by design when coverage is RED -- that is a health REPORT, not a reason to
# abort the run. Under the old `set -euo pipefail` a red coverage signal killed
# the very pipeline (drain + health-card refresh + "finished" marker) that would
# improve and observe coverage, so every run since coverage went red logged a
# "starting" with no "finished". Each step is now individually fault-isolated:
# the load-bearing ingest steps (backfill, drain) flag the run's status, the
# diagnostic steps are non-fatal, and the run ALWAYS reaches "finished".
# (feedback_health_report_must_not_kill_the_healer.md)
set -uo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
LOG_DIR="$ROOT/data/agent"
LOG_FILE="$LOG_DIR/graphiti-realtime-maintenance.log"
LOCK_FILE="/tmp/secondbrain-graphiti-realtime-maintenance.lock"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

# The disabled policy is a whole-runtime stop, not only an ingestion stop.
# Check it before host-work admission, flock, or any diagnostic process so a
# retained cron row is harmless while Graphiti is owner-disabled. Missing or
# invalid policy also fails closed through the same helper.
if ! "$NODE_BIN" "$ROOT/scripts/lib/graphiti-ingestion-policy.js" >/dev/null 2>&1; then
  mkdir -p "$LOG_DIR"
  echo "$(date -Is) Graphiti maintenance skipped: owner runtime policy is disabled or unavailable" >> "$LOG_FILE"
  exit 0
fi

mkdir -p "$LOG_DIR"

# The full pass is background work. Admit it as one normal-priority unit so a
# high-load host defers the pass and the briefing controller always retains the
# critical lane. The child marker prevents recursive re-admission.
if [[ "${GRAPHITI_MAINTENANCE_ADMITTED:-0}" != "1" ]]; then
  cd "$ROOT" || exit 1
  export GRAPHITI_MAINTENANCE_ADMITTED=1
  nice -n 10 ionice -c2 -n7 \
    "$NODE_BIN" scripts/host-work-admission.js run \
      --kind graphiti-realtime-maintenance \
      --priority normal \
      --wait-ms 0 \
      --lease-ms "${GRAPHITI_MAINTENANCE_LEASE_MS:-1200000}" \
      -- \
      "$0"
  status=$?
  if [[ "$status" -eq 75 ]]; then
    echo "$(date -Is) deferred Graphiti realtime maintenance: host admission kept the safe lane" >> "$LOG_FILE"
    exit 0
  fi
  exit "$status"
fi

(
  flock -n 9 || {
    echo "$(date -Is) previous Graphiti realtime maintenance still running" >> "$LOG_FILE"
    exit 0
  }
  cd "$ROOT" || exit 1
  {
    echo
    echo "=============================="
    echo "$(date -Is) starting Graphiti realtime maintenance"

    ingest_failed=0

    # Diagnostic step: log failure, never abort the run.
    run_soft() {
      if ! "$NODE_BIN" "$@"; then
        echo "$(date -Is) NON-FATAL: node $* exited nonzero"
      fi
    }
    # Load-bearing ingest step: log failure AND flag the run, but still continue
    # so the remaining steps (and the finished marker) run.
    run_ingest() {
      if ! "$NODE_BIN" scripts/lib/graphiti-ingestion-policy.js >/dev/null; then
        echo "$(date -Is) ingestion disabled by owner; skipped $*"
        return 0
      fi
      if ! "$NODE_BIN" "$@"; then
        echo "$(date -Is) INGEST-FAILED: node $* exited nonzero"
        ingest_failed=1
      fi
    }

    run_soft scripts/graphiti-provider-health.js
    run_soft scripts/graphiti-live-health.js
    run_ingest scripts/graphiti-backfill-last-30-days.js --days 30
    run_ingest scripts/graphiti-event-drain.js --max 250 --concurrency 4
    run_soft scripts/graphiti-lifetime-coverage-health.js
    run_soft scripts/graphiti-coverage-health.js --days 30
    run_soft scripts/refresh-graphiti-health-card.js

    echo "$(date -Is) finished Graphiti realtime maintenance (ingest_failed=${ingest_failed})"
  } >> "$LOG_FILE" 2>&1
) 9>"$LOCK_FILE"
