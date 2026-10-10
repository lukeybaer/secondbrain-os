#!/usr/bin/env bash
set -euo pipefail

# ExampleCo 2026-09-12: attended daytime briefing repair uses the same Sol-medium
# ceiling as the night owner, including any nested routed review.
export SECONDBRAIN_BRIEFING_CODEX_CEILING="gpt-5.6-sol:medium"

ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
HEALER_ROOT="${SECONDBRAIN_HEALER_ROOT:-/home/ec2-user/secondbrain-current}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
DATE="${BRIEFING_DATE:?BRIEFING_DATE is required}"
CARD="${BRIEFING_CONTROLLER_CARD:?BRIEFING_CONTROLLER_CARD is required}"
# One comma-separated set is one exact same-card transaction. The controller
# canonicalizes, deduplicates, and sorts it before consuming attended proof.
WORK_UNIT="${BRIEFING_CONTROLLER_WORK_UNIT:?BRIEFING_CONTROLLER_WORK_UNIT is required}"
BRIEFING_HUMAN_ACTION_TOKEN="${BRIEFING_HUMAN_ACTION_TOKEN:-}"
# S-2 (2026-08-24). One exact same-card transaction gets one honest heal cycle: worker
# session plus integration plus deploy wait plus a scoped live re-verify. The
# old ten-minute default expired mid-cycle and threw the finished work away.
# Keep this in step with CONTROLLER_CYCLE_FLOOR_MS in
# scripts/lib/briefing-card-controller.js; a test pins the two together.
MAX_SECONDS="${BRIEFING_CARD_CONTROLLER_MAX_SECONDS:-5400}"

# Attended SSH launches do not inherit the cron/systemd environment that armed
# conflict-key concurrency. Use the durable operator arming receipt as the one
# allowed default source, and accept it only when its recorded override proof is
# exact. This preserves the acknowledged override semantics without fabricating
# a shadow-passed marker. An explicitly supplied feature flag (including `off`)
# always wins, so the ordinary rollback/kill switch remains immediate.
ARMING_RECEIPT="$DATA_DIR/agent/conflict-lease-arming-2026-08-23.json"
CONFLICT_MODE_REQUESTED="${BRIEFING_CONTROLLER_CONFLICT_LEASES:-}"
CONFLICT_SHADOW_PASSED="${BRIEFING_CONTROLLER_CONFLICT_LEASES_SHADOW_PASSED:-}"
if [ -z "${BRIEFING_CONTROLLER_CONFLICT_LEASES+x}" ] && [ -f "$ARMING_RECEIPT" ]; then
  if "$NODE_BIN" - "$ARMING_RECEIPT" <<'NODE'
const fs = require('node:fs');
try {
  const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const accepted =
    receipt.schema === 'amy.conflict-lease-arming.v1' &&
    receipt.mode === 'enforce' &&
    receipt.shadowProof ===
      'operator env override BRIEFING_CONTROLLER_CONFLICT_LEASES_SHADOW_PASSED=1';
  process.exit(accepted ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
  then
    CONFLICT_MODE_REQUESTED="enforce"
    CONFLICT_SHADOW_PASSED="1"
  fi
fi
case "$CONFLICT_MODE_REQUESTED" in
  off|shadow|enforce) ;;
  *) CONFLICT_MODE_REQUESTED="off" ;;
esac
if [ "$CONFLICT_SHADOW_PASSED" != "1" ]; then
  CONFLICT_SHADOW_PASSED=""
fi

normalize_identity() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

CARD="$(normalize_identity "$CARD")"
WORK_UNIT="$(normalize_identity "$WORK_UNIT")"
EXACT_LOCK_DIR="$DATA_DIR/agent/card-controller/exact-trigger-locks"
# Linux caps a file name at 255 bytes. A comma-separated multi-target work
# unit (e.g. ~10 System Health rows) can sanitize past that limit and fail
# the run with "File name too long". Keep short keys exactly as before (an
# existing lock file for a short identity keeps its name), but once the
# sanitized key exceeds a safe bound, replace it with a readable prefix plus
# a sha256 hash of the FULL identity, so distinct long sets never collide
# and the name never overflows. Test:
# scripts/__tests__/ec2-card-controller-exact-run-lock-key.test.js
EXACT_LOCK_KEY_SAFE_MAX=120
EXACT_LOCK_KEY_RAW="$(printf '%s' "$WORK_UNIT" | tr -c 'A-Za-z0-9._-' '_')"
if [ "${#EXACT_LOCK_KEY_RAW}" -gt "$EXACT_LOCK_KEY_SAFE_MAX" ]; then
  EXACT_LOCK_KEY_HASH="$(printf '%s' "$WORK_UNIT" | sha256sum | cut -d' ' -f1)"
  EXACT_LOCK_KEY="${EXACT_LOCK_KEY_RAW:0:80}_${EXACT_LOCK_KEY_HASH}"
else
  EXACT_LOCK_KEY="$EXACT_LOCK_KEY_RAW"
fi
EXACT_LOCK="$EXACT_LOCK_DIR/$EXACT_LOCK_KEY.lock"

if ! [[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "[card-controller-exact-run] invalid BRIEFING_DATE=$DATE" >&2
  exit 2
fi
if [[ "$CARD" = "all" || -z "$CARD" || -z "$WORK_UNIT" ]]; then
  echo "[card-controller-exact-run] exact card and work-unit identities are required" >&2
  exit 2
fi
# WORK_UNIT == CARD is the explicit card-wide exact-trigger encoding. A real
# sub-unit must remain namespaced to that card so a typo cannot reach the
# controller as a different or unknown target.
if [[ "$WORK_UNIT" != "$CARD" && "$WORK_UNIT" != "$CARD:"* ]]; then
  echo "[card-controller-exact-run] invalid work-unit identity=$WORK_UNIT for card=$CARD" >&2
  exit 2
fi
if ! [[ "$MAX_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[card-controller-exact-run] invalid max seconds=$MAX_SECONDS" >&2
  exit 2
fi

# The repair-cutoff (4:30 AM CT) bounds the scheduled night. An exact attended
# invocation uses the existing explicit supervision declaration or a human
# token verified by the controller. Its live result never rewrites the report.
ATTENDED_REQUEST=0
if [ "${SB_SUPERVISED_REFRESH:-0}" = "1" ] || [ -n "$BRIEFING_HUMAN_ACTION_TOKEN" ]; then
  ATTENDED_REQUEST=1
fi
# One clock source: the canonical 04:30 CT cutoff, or the date's owner-invoked
# catch-up schedule when one exists.
REPAIR_CUTOFF_EPOCH="$("$NODE_BIN" -p "const w=require('$ROOT/scripts/lib/briefing-run-window.js');const ms=w.repairAdmissionCutoffMs(process.argv[1],{dataDir:process.argv[2]});if(!Number.isFinite(ms))throw new Error('no cutoff');Math.floor(ms/1000)" "$DATE" "$DATA_DIR")" || { echo "[card-controller] cannot resolve the repair cutoff from scripts/lib/briefing-run-window.js" >&2; exit 1; }
REPAIR_SECONDS_LEFT="$((REPAIR_CUTOFF_EPOCH - $(date +%s)))"
if [ "$REPAIR_SECONDS_LEFT" -le 0 ] && [ "$ATTENDED_REQUEST" = "0" ]; then
  echo "[card-controller-exact-run] scheduled same-date repair refused: the repair-cutoff (4:30 AM CT) has passed."
  exit 3
fi
# CUTOFF_ENFORCED marks the pre-cutoff overnight lane. This wrapper runs the
# controller as --mode midday --supervised, which makes the controller deadline
# ADMISSION-only: it refuses to start new work at the deadline but does not stop
# work already running. That is correct for an attended daytime repair and wrong
# in the scheduled night, where a 90-minute budget could otherwise let in-flight work
# cross the cutoff and crowd the 5:30 delivery. Adversarial review 2026-08-24.
CUTOFF_ENFORCED=0
if [ "$REPAIR_SECONDS_LEFT" -gt 0 ] && [ "$ATTENDED_REQUEST" = "0" ]; then
  CUTOFF_ENFORCED=1
  if [ "$MAX_SECONDS" -gt "$REPAIR_SECONDS_LEFT" ]; then
    echo "[card-controller-exact-run] budget truncated to the repair-cutoff (4:30 AM CT) settlement cutoff: ${MAX_SECONDS}s -> ${REPAIR_SECONDS_LEFT}s"
    MAX_SECONDS="$REPAIR_SECONDS_LEFT"
  fi
fi

# MAX_SECONDS is the controller's WORKING budget: time parked in the host
# capacity governor with nothing admitted is credited back rather than charged
# to repair. The outer hard stop must therefore be the absolute wall-clock
# ceiling, not the working budget, or this timeout would re-impose exactly the
# starvation the working-time budget removes: a lane parked for an hour would be
# killed after working thirty minutes. The ceiling is the working budget plus the
# governor's own maximum wait, and the repair-cutoff (4:30 AM CT) cutoff still truncates it, so
# scheduled work cannot cross the cutoff or crowd the 5:30 delivery.
# CAPACITY_STALL_CREDIT_SECONDS is pinned to DEFAULT_CAPACITY_REQUEUE_MAX_MS in
# scripts/lib/briefing-card-controller.js by test.
CAPACITY_STALL_CREDIT_SECONDS=3600
HARD_SECONDS="$((MAX_SECONDS + CAPACITY_STALL_CREDIT_SECONDS))"
if [ "$CUTOFF_ENFORCED" = "1" ] && [ "$HARD_SECONDS" -gt "$REPAIR_SECONDS_LEFT" ]; then
  HARD_SECONDS="$REPAIR_SECONDS_LEFT"
fi
CMD=(
  "$NODE_BIN"
  scripts/card-controller.js
  --mode midday
  --date "$DATE"
  --data-dir "$DATA_DIR"
  --cards "$CARD"
)
# A top-level card is still an exact trigger for the wrapper lock, but it is
# not a controller work-unit identity. Passing the same value through both
# fields makes resolvePlan reject news cards before any cached summaries run.
if [ "$WORK_UNIT" != "$CARD" ]; then
  CMD+=(--work-unit "$WORK_UNIT")
fi
CMD+=(--max-seconds "$MAX_SECONDS")
# An exact OTTER SPEAKER PARETO refresh must name its exact calls (the
# controller refuses broad discovery outside --cards all).
if [ -n "${BRIEFING_CONTROLLER_OTTER_OTIDS:-}" ]; then
  CMD+=(--otter-otids "$BRIEFING_CONTROLLER_OTTER_OTIDS")
fi
# A token must prove itself; do not silently turn an invalid token into the
# supervision bypass. Scheduled wrappers keep their bounded working budget.
if [ "${SB_SUPERVISED_REFRESH:-0}" = "1" ] || [ "$ATTENDED_REQUEST" = "0" ]; then
  CMD+=(--supervised)
fi
if [ "${BRIEFING_REUSE_NEWS_CACHE:-0}" = "1" ]; then
  CMD+=(--reuse-news-cache)
fi

cd "$ROOT"
mkdir -p "$LOG_DIR" "$EXACT_LOCK_DIR"
exec 8>"$EXACT_LOCK"
if ! flock -n 8; then
  echo "[card-controller-exact-run] $(date -u +%FT%TZ) duplicate exact trigger already active date=$DATE work_unit=$WORK_UNIT"
  exit 0
fi
if [ -n "$BRIEFING_HUMAN_ACTION_TOKEN" ]; then
  if ! BRIEFING_HUMAN_ACTION_TOKEN="$BRIEFING_HUMAN_ACTION_TOKEN" \
    "$NODE_BIN" "$ROOT/scripts/mint-briefing-attended-action.js" \
    --data-dir "$DATA_DIR" \
    --date "$DATE" \
    --card "$CARD" \
    --work-unit "$WORK_UNIT"; then
    echo "[card-controller-exact-run] attended capacity proof refused; continuing with the operator retry token but no credit-floor override; use a fresh token for a new invocation" >&2
  fi
fi
status=0
# For scheduled work, the capacity-credit ceiling is truncated at 04:30. After
# the cutoff has already passed for this board date, the exact card's requested
# deadline is still a hard stop; attended work may not ping forever while a
# card-local/source call ignores the cooperative abort signal.
env SECONDBRAIN_DATA_DIR="$DATA_DIR" SECONDBRAIN_HEALER_ROOT="$HEALER_ROOT" SECONDBRAIN_CONTROLLER_ROOT="$ROOT" EC2_HOST_HTTP="${EC2_HOST_HTTP:-http://localhost:3001}" BRIEFING_HUMAN_ACTION_TOKEN="$BRIEFING_HUMAN_ACTION_TOKEN" BRIEFING_CONTROLLER_CONFLICT_LEASES="$CONFLICT_MODE_REQUESTED" BRIEFING_CONTROLLER_CONFLICT_LEASES_SHADOW_PASSED="$CONFLICT_SHADOW_PASSED" /usr/bin/timeout --kill-after=30s "${HARD_SECONDS}s" "${CMD[@]}" || status=$?
flock -u 8 || true
echo "[card-controller-exact-run] $(date -u +%FT%TZ) finished status=$status date=$DATE work_unit=$WORK_UNIT"
exit 0
