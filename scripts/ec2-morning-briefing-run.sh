#!/usr/bin/env bash
#
# ec2-morning-briefing-run.sh -- terminal delivery checkpoint.
#
# This process does not generate, refresh, QC, or heal a card. The 11 PM card
# controller owns every card's complete lifecycle:
#   source ready -> staged card -> atomic live publish -> scoped live QC
#   -> that card's asynchronous healer until green or no progress is possible.
#
# On early readiness, or at 5:30 at the latest, this runner reads the canonical
# per-card live-board artifact and the report staged independently
# before the deadline. briefing-notify reuses those staged bytes and owns one
# bounded, fail-loud report render only when every prep tick failed; this runner
# never starts a competing report writer.
# It never starts a second controller, a whole-board verifier, a mechanical
# sweep, an agentic batch, or a special SELF-HEAL HEALTH refresh.
set -uo pipefail

CONTROLLER_ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
DELIVERY_LOCK="${BRIEFING_DELIVERY_LOCK:-/tmp/secondbrain-morning-briefing-delivery.lock}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
HOME="${HOME:-/home/ec2-user}"
DATE="${BRIEFING_DATE:-$(TZ=America/Chicago date +%F)}"

STATUS_CURRENT_CMD=(
  "$NODE_BIN"
  "$CONTROLLER_ROOT/scripts/lib/briefing-notify.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
  --phase current
  --retry-missing-stages
)
if [ "${BRIEFING_WATCHDOG_TRANSPORT_ONLY:-}" = "1" ]; then
  STATUS_CURRENT_CMD+=(--transport-only)
fi
if [ "${BRIEFING_ALLOW_EARLY_FINAL:-}" = "1" ]; then
  EARLY_FINAL_PROOF="${BRIEFING_EARLY_FINAL_PROOF:-}"
  if [ -z "$EARLY_FINAL_PROOF" ] || ! "$NODE_BIN" -e '
    const fs = require("node:fs");
    const [file, date] = process.argv.slice(1);
    let row;
    try { row = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(2); }
    const issued = Date.parse(row.issuedAt || "");
    const expires = Date.parse(row.expiresAt || "");
    const now = Date.now();
    if (row.schema !== "briefing-watcher-early-final-authority@1" ||
        row.issuedBy !== "attended-watcher-checkpoint" || row.date !== date ||
        !Number.isFinite(issued) || !Number.isFinite(expires) ||
        issued > now + 60000 || expires <= now || expires - issued > 12 * 60 * 1000) process.exit(3);
  ' "$EARLY_FINAL_PROOF" "$DATE"; then
    echo "[morning-briefing-run] early final refused: a current attended-checkpoint authority receipt is required." >&2
    exit 2
  fi
  STATUS_CURRENT_CMD+=(--allow-early-final)
fi
REPORT_CLOSURE_CMD=(
  "$NODE_BIN"
  "$CONTROLLER_ROOT/scripts/briefing-report-closure.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
)
LESSONS_CMD=(
  "$NODE_BIN"
  "$CONTROLLER_ROOT/scripts/self-heal/card-blocker-lessons-rollup.js"
  --date "$DATE"
)

TEST_MODE=0
if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${BRIEFING_DRY_RUN:-}" = "1" ]; then
  TEST_MODE=1
fi

echo "[morning-briefing-run] $(date -u +%FT%TZ) delivery-only checkpoint date=$DATE data_dir=$DATA_DIR"

if [ "$TEST_MODE" != "1" ]; then
  exec 8>"$DELIVERY_LOCK"
  if ! flock -n 8; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) delivery-only checkpoint skipped: another delivery process owns the lock."
    exit 0
  fi
fi

notify_current_state() {
  if [ "$TEST_MODE" = "1" ]; then
    echo "[morning-briefing-run] DRY-RUN: would send current live-board status with: ${STATUS_CURRENT_CMD[*]}"
    return 0
  fi
  if timeout --kill-after=5s 90s "${STATUS_CURRENT_CMD[@]}"; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) briefing-current-notify: handled."
  else
    notify_status=$?
    echo "[morning-briefing-run] $(date -u +%FT%TZ) briefing-current-notify: exit $notify_status; recorded internally." >&2
  fi
  return 0
}

# The coordinator's evidence-final report pass already collects and embeds the
# honest elapsed 11 PM-through-settlement token window. Delivery must never
# wait on telemetry collection: at the deadline, frozen report bytes win.
TOKEN_CUT_WINDOW_END_EPOCH="$(TZ=America/Chicago date -d "$DATE 05:30:00" +%s 2>/dev/null || echo 0)"
TOKEN_CUT_MAX_DEFER_SECONDS="${BRIEFING_TOKEN_CUT_MAX_DEFER_SECONDS:-900}"

token_cut_window_closed() {
  local now
  now="$(date +%s)"
  [ "$TOKEN_CUT_WINDOW_END_EPOCH" -gt 0 ] && [ "$now" -ge "$TOKEN_CUT_WINDOW_END_EPOCH" ]
}

# The scheduled fallback starts at 5:20 so it is already resident if cron is
# slow. It waits before freezing or sending. The coordinator's proven early
# readiness path skips this wait and ships an honestly elapsed token cut.
wait_for_terminal_delivery_boundary() {
  if [ "$TEST_MODE" = "1" ]; then
    echo "[morning-briefing-run] DRY-RUN: would wait for 5:30 CT unless the coordinator proved early readiness."
    return 0
  fi
  if [ "${BRIEFING_COORDINATOR_EARLY_FINAL:-0}" = "1" ]; then
    return 0
  fi
  if token_cut_window_closed; then
    return 0
  fi
  local now wait_seconds
  now="$(date +%s)"
  wait_seconds=$((TOKEN_CUT_WINDOW_END_EPOCH - now))
  if [ "$wait_seconds" -gt "$TOKEN_CUT_MAX_DEFER_SECONDS" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) terminal delivery refused: boundary is ${wait_seconds}s away, beyond the ${TOKEN_CUT_MAX_DEFER_SECONDS}s wait bound." >&2
    return 1
  fi
  echo "[morning-briefing-run] $(date -u +%FT%TZ) waiting ${wait_seconds}s before the atomic 5:30 settlement."
  sleep "$wait_seconds"
  return 0
}

settle_report_closure() {
  if [ "$TEST_MODE" = "1" ]; then
    echo "[morning-briefing-run] DRY-RUN: would bind the delivered report bytes with: ${REPORT_CLOSURE_CMD[*]} --write --phase handoff"
    echo "[morning-briefing-run] DRY-RUN: would verify the same-date closure with: ${REPORT_CLOSURE_CMD[*]} --verify"
    return 0
  fi
  if "${REPORT_CLOSURE_CMD[@]}" --write --phase handoff && "${REPORT_CLOSURE_CMD[@]}" --verify; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) dated report closure and exact token window are verified."
  else
    closure_status=$?
    echo "[morning-briefing-run] $(date -u +%FT%TZ) BLOCKER: dated report closure or exact token window is invalid (exit $closure_status); delivery continues with the honest staged status because the 5:30 deadline wins." >&2
  fi
  return 0
}

run_weekly_lessons_rollup() {
  if [ "${BRIEFING_SKIP_LESSONS_ROLLUP:-}" = "1" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-rollup: skipped (BRIEFING_SKIP_LESSONS_ROLLUP=1)."
    return 0
  fi
  day_of_week="$(date -d "$DATE" +%u 2>/dev/null || echo 0)"
  if [ "$day_of_week" != "5" ]; then
    return 0
  fi
  if [ ! -f "$CONTROLLER_ROOT/scripts/self-heal/card-blocker-lessons-rollup.js" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-rollup: deployed helper missing; skipped (non-fatal)." >&2
    return 0
  fi
  if [ "$TEST_MODE" = "1" ]; then
    echo "[morning-briefing-run] DRY-RUN: lessons-rollup would run (Friday, $DATE): ${LESSONS_CMD[*]}"
    return 0
  fi
  if "${LESSONS_CMD[@]}"; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-rollup: appended."
  else
    echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-rollup: finished non-zero (non-fatal)." >&2
  fi
  return 0
}

mkdir -p "$LOG_DIR" 2>/dev/null || true
export HOME SECONDBRAIN_DATA_DIR="$DATA_DIR"

# Strategic report prose and its elapsed token evidence were staged before this
# checkpoint. Transport is deliberately independent of later telemetry work.
wait_for_terminal_delivery_boundary || exit 2
settle_report_closure
notify_current_state
run_weekly_lessons_rollup

echo "[morning-briefing-run] $(date -u +%FT%TZ) delivery-only checkpoint complete; card-owned loops were not touched."
exit 0
