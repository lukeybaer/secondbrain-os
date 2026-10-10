#!/usr/bin/env bash
set -euo pipefail

# A failed Node child can otherwise spend five minutes serializing a
# multi-hundred-megabyte core on the same volume that holds immutable Otter
# evidence. The healer already has exact receipts and bounded logs for failure
# diagnosis; disable process cores before any child is launched so a crash
# cannot become a second storage-pressure incident.
ulimit -c 0

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
if ! ROOT="$(readlink -f "$ROOT_LINK")" || [[ ! -d "$ROOT" ]]; then
  echo "[otter-call-healer] refused: cannot pin immutable release from $ROOT_LINK" >&2
  exit 75
fi
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${OTTER_CALL_HEALER_LOG_DIR:-/opt/secondbrain/logs}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
ENV_FILE="${SECONDBRAIN_ENV_FILE:-$ROOT/.env}"
if [[ -r "$ENV_FILE" ]]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
LANE="live"
if [[ "${OTTER_CALL_HEALER_INCLUDE_HISTORICAL:-0}" == "1" ]]; then
  LANE="historical"
fi
if [[ "$LANE" == "historical" && "${SB_IDENTITY_CAP_ACTIVE:-0}" != "1" ]]; then
  echo "[otter-call-healer] refused historical identity work without scripts/ec2-global-identity-cap-run.sh (512 MB cap and briefing-window admission)" >&2
  exit 75
fi
HISTORICAL_PAUSE_FILE="${OTTER_HISTORICAL_BACKFILL_PAUSE_FILE:-$DATA_DIR/life-archive/voiceprints/otter-historical-backfill.pause}"
LIVE_PAUSE_FILE="${OTTER_LIVE_HEALER_PAUSE_FILE:-$DATA_DIR/life-archive/voiceprints/otter-live-healer.pause}"
HISTORICAL_PAUSED_OTIDS_FILE="${OTTER_HISTORICAL_PAUSED_OTIDS_FILE:-$DATA_DIR/life-archive/voiceprints/otter-historical-backfill-paused-otids.txt}"
LOCK_FILE="$DATA_DIR/life-archive/voiceprints/otter-call-healer-${LANE}-scheduler.lock"
REFRESH_LOCK_FILE="$DATA_DIR/life-archive/voiceprints/otter-call-healer-ledger-refresh.lock"
PROJECTION_LOCK_FILE="$DATA_DIR/life-archive/voiceprints/otter-exact-briefing-projection.lock"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_FILE")" "$DATA_DIR/agent"
cd "$ROOT"

discovery_output=""
discovery_deferred_marker=""
cleanup_discovery_output() {
  if [[ -n "$discovery_output" ]]; then
    rm -f -- "$discovery_output"
  fi
  if [[ -n "$discovery_deferred_marker" ]]; then
    rm -f -- "$discovery_deferred_marker"
  fi
}
trap cleanup_discovery_output EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[otter-call-healer] pending: another scheduler pass is active"
  exit 0
fi

# Pauses are bounded benches, never permanent off-switches: the runner itself
# enforces the TTL and clears an expired pause, so cron stays installed for
# both lanes and an expired flag can never silently outlive its reason
# (2026-07-31 direct-exact38 bench: no TTL, cron removed, zero overnight
# closures, zero signal). Pause evaluation and expiry deletion happen UNDER
# the lane flock so deploy quiescence, which holds both lane locks, also
# covers pause mutation (Codex review bcd58db8151d).
historical_pause_state="$("$NODE_BIN" "$ROOT/scripts/lib/otter-healer-pause.js" --file "$HISTORICAL_PAUSE_FILE" --clear-expired)"
live_pause_state="$("$NODE_BIN" "$ROOT/scripts/lib/otter-healer-pause.js" --file "$LIVE_PAUSE_FILE" --clear-expired)"

if [[ "$LANE" == "historical" && "$historical_pause_state" == "active" ]]; then
  echo "[otter-call-healer] historical backfill paused by $HISTORICAL_PAUSE_FILE; live exact-call processing is unaffected"
  exit 0
fi

if [[ "$LANE" == "live" && "$live_pause_state" == "active" ]]; then
  echo "[otter-call-healer] live healer paused by $LIVE_PAUSE_FILE"
  exit 0
fi

export SECONDBRAIN_ROOT="$ROOT"
export SECONDBRAIN_DATA_DIR="$DATA_DIR"
export SB_OTTER_RUNNER_RELEASE_ROOT="$ROOT"

# Exact ledger refreshes load multi-megabyte per-call evidence. Keep the
# recurring live lane below the host heap/cgroup ceiling by evaluating a small
# deterministic slice at a time; the ledger publisher preserves every
# unselected prior row and writes each slice atomically.
ledger_refresh_batch_size="${OTTER_CALL_LEDGER_REFRESH_BATCH_SIZE:-2}"
ledger_refresh_heap_mb="${OTTER_CALL_LEDGER_REFRESH_HEAP_MB:-1536}"
if [[ "$LANE" == "historical" ]]; then
  ledger_refresh_batch_size="${OTTER_CALL_LEDGER_REFRESH_BATCH_SIZE:-2}"
  ledger_refresh_heap_mb="${OTTER_CALL_LEDGER_REFRESH_HEAP_MB:-384}"
fi
if ! [[ "$ledger_refresh_batch_size" =~ ^[1-9][0-9]*$ ]] || [[ "$ledger_refresh_batch_size" -gt 16 ]]; then
  echo "[otter-call-healer] OTTER_CALL_LEDGER_REFRESH_BATCH_SIZE must be 1..16" >&2
  exit 64
fi
if ! [[ "$ledger_refresh_heap_mb" =~ ^[1-9][0-9]*$ ]] || [[ "$ledger_refresh_heap_mb" -lt 256 ]] || [[ "$ledger_refresh_heap_mb" -gt 2048 ]]; then
  echo "[otter-call-healer] OTTER_CALL_LEDGER_REFRESH_HEAP_MB must be 256..2048" >&2
  exit 64
fi

refresh_exact_ledger() {
  local csv="$1"
  local -a ids=()
  local offset end batch rc
  IFS=',' read -r -a ids <<<"$csv"
  for ((offset = 0; offset < ${#ids[@]}; offset += ledger_refresh_batch_size)); do
    end=$((offset + ledger_refresh_batch_size))
    if [[ "$end" -gt "${#ids[@]}" ]]; then end="${#ids[@]}"; fi
    batch="$(IFS=,; echo "${ids[*]:offset:end-offset}")"
    rc=0
    NODE_OPTIONS="--max-old-space-size=$ledger_refresh_heap_mb" \
      "$NODE_BIN" "$ROOT/scripts/otter-call-processing-ledger.js" --write --otids "$batch" \
      >/dev/null || rc=$?
    if [[ "$rc" -ne 0 && "$rc" -ne 2 ]]; then return "$rc"; fi
  done
}

# Historical Otter is lowest priority on the shared host. The newer approved
# four-lane contract keeps a fresh exact current call enabled and bounded, but
# automatic historical work does not start in the briefing window.
ct_hour="$(TZ=America/Chicago date +%H)"
if [[ "$LANE" == "historical" && "${OTTER_CALL_HEALER_ATTENDED_EXACT:-0}" != "1" ]] && {
  [[ "$ct_hour" -ge 22 ]] || [[ "$ct_hour" -lt 6 ]];
}; then
  echo "[otter-call-healer] priority-deferred: overnight briefing owns 22:00-06:00 CT"
  exit 0
fi

live_concurrency="${OTTER_CALL_HEALER_CONCURRENCY:-1}"
live_limit="${OTTER_CALL_HEALER_LIMIT:-$live_concurrency}"
exact_otids="${OTTER_CALL_HEALER_EXACT_OTIDS:-}"
excluded_otids=""
if [[ "$LANE" == "live" && "$historical_pause_state" == "active" && -s "$HISTORICAL_PAUSED_OTIDS_FILE" ]]; then
  excluded_otids="$(
    tr '\r\n' ',,' <"$HISTORICAL_PAUSED_OTIDS_FILE" |
      sed -E 's/,+/,/g; s/^,//; s/,$//'
  )"
fi
if [[ "$LANE" == "live" && -z "$exact_otids" ]]; then
  # Restart recovery is event-driven from durable state too. A promoted exact
  # handoff may predate this process or deploy, so discover it from the current
  # ledger before deciding whether to perform the expensive global refresh.
  # Discovery also materializes the durable handoffs for the complete live
  # set. This is bounded coordination paperwork and must run before host
  # admission so capacity pressure defers execution without hiding exact work.
  discover_args=(--discover-fresh-exact-otids)
  if [[ -n "$excluded_otids" ]]; then
    discover_args+=(--exclude-otids "$excluded_otids")
  fi
  if [[ ! -f "$ROOT/scripts/host-work-admission.js" ]]; then
    echo "[otter-call-healer] live discovery blocked: host admission runner missing from pinned release $ROOT" >&2
    exit 69
  fi
  discovery_output="$(mktemp "$DATA_DIR/agent/otter-live-handoff-discovery.XXXXXX")"
  discovery_rc=0
  "$NODE_BIN" "$ROOT/scripts/otter-call-processing-healer-dispatch.js" "${discover_args[@]}" \
    >"$discovery_output" || discovery_rc=$?
  if [[ "$discovery_rc" -ne 0 ]]; then
    exit "$discovery_rc"
  fi
  exact_otids="$(tr -d '[:space:]' <"$discovery_output")"
  if [[ -n "$exact_otids" && ! "$exact_otids" =~ ^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$ ]]; then
    echo "[otter-call-healer] live discovery returned invalid exact OTID output" >&2
    exit 65
  fi
  rm -f "$discovery_output"
  discovery_output=""
fi
# An automatic live pass owns only newly landed exact calls. An empty discovery
# result is terminal for this pass; falling through to the global ledger would
# turn the five-minute current-call lane back into historical identity work.
if [[ "$LANE" == "live" && -z "$exact_otids" && "${OTTER_CALL_HEALER_ATTENDED_EXACT:-0}" != "1" ]]; then
  noop_file="$DATA_DIR/life-archive/voiceprints/otter-call-healer-dispatch-live-latest.json"
  "$NODE_BIN" - "$noop_file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const report = {
  schema: 'life_archive_otter_call_processing_healer_dispatch.v2',
  generated_at: new Date().toISOString(),
  lane: 'live',
  attended_exact: false,
  exact_otids: [],
  concurrency: 1,
  candidate_count: 0,
  candidates_scanned: 0,
  admitted_count: 0,
  deferred_count: 0,
  target_count: 0,
  targets: [],
  results: [],
  handoffless_targets: [],
  handoff_creation_failures: [],
  noop: true,
  noop_reason: 'no_fresh_exact_calls_global_ledger_excluded',
  ok: true,
};
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
fs.renameSync(tmp, file);
NODE
  # Rolling SLA freshness (2026-10-02): with no fresh calls this lane used to
  # exit without touching the ledger, so on a quiet night the Past 24h SLA row
  # went red on a 20-minute staleness gate while showing 0 breaches. Keep the
  # ledger current with the same audit-only rolling producer the SLA source
  # refresh uses: 48h discovery, older rows preserved, no identity, naming, or
  # projection mutation. It runs only when the ledger is older than the
  # threshold, yields to a deploy, and never fails the pass.
  sla_ledger="$DATA_DIR/life-archive/voiceprints/otter-call-processing-ledger-latest.json"
  sla_max_age_sec="${OTTER_SLA_LEDGER_REFRESH_AGE_SEC:-900}"
  sla_ledger_age_sec=999999
  if [[ -f "$sla_ledger" ]]; then
    sla_ledger_age_sec=$(( $(date +%s) - $(stat -c %Y "$sla_ledger") ))
  fi
  if [[ "$sla_ledger_age_sec" -ge "$sla_max_age_sec" && ! -e "${SB_DEPLOY_LOCK_FILE:-/tmp/secondbrain-deploy.lock}" ]]; then
    exec 8>"$REFRESH_LOCK_FILE"
    if flock -w 60 8; then
      NODE_OPTIONS="--max-old-space-size=1024" ionice -c 3 nice -n 15 "$NODE_BIN" \
        "$ROOT/scripts/otter-call-processing-ledger.js" --write --quiet --audit-only --recent-hours 48 \
        >/dev/null || echo "[otter-call-healer] rolling SLA ledger audit refresh failed (rc=$?)" >&2
      flock -u 8
    else
      echo "[otter-call-healer] rolling SLA ledger audit refresh skipped: refresh lock busy" >&2
    fi
  fi
  echo "[otter-call-healer] no fresh exact calls; global ledger refresh excluded"
  exit 0
fi
if [[ -n "$exact_otids" && -z "${OTTER_CALL_HEALER_LIMIT:-}" ]]; then
  # One pass admits every discovered exact call, one at a time, instead of one
  # call per five-minute tick.
  exact_count="$(tr ',' '\n' <<<"$exact_otids" | grep -c .)"
  live_limit="$(( exact_count < 6 ? exact_count : 6 ))"
fi
base_healer_args=(--limit "$live_limit" --concurrency "$live_concurrency")
if [[ "${OTTER_CALL_HEALER_INCLUDE_HISTORICAL:-0}" == "1" ]]; then
  # Fargate owns historical per-call parallelism. laneBounds() in the dispatcher
  # keeps the EC2 shared tail one-wide unless this is an attended exact batch.
  historical_limit="${OTTER_CALL_HEALER_HISTORICAL_LIMIT:-8}"
  # The dispatcher honors a wider historical concurrency only for an attended
  # exact batch; the unattended historical lane stays one-wide.
  base_healer_args=(--include-historical --limit "$historical_limit" --concurrency "${OTTER_CALL_HEALER_HISTORICAL_CONCURRENCY:-1}")
fi
if [[ "${OTTER_CALL_HEALER_ATTENDED_EXACT:-0}" == "1" && -z "$exact_otids" ]]; then
  echo "[otter-call-healer] OTTER_CALL_HEALER_ATTENDED_EXACT requires OTTER_CALL_HEALER_EXACT_OTIDS" >&2
  exit 64
fi
if [[ "$LANE" == "live" && -n "$excluded_otids" ]]; then
  base_healer_args+=(--exclude-otids "$excluded_otids")
fi

# An attended capability is single use and bound to its exact scope, so every
# chained dispatch mints its own.
mint_attended_capability() {
  local scope="$1"
  attended_action_token="$($NODE_BIN -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  attended_scope_hash="$(printf '%s' "$scope" | sha256sum | awk '{print substr($1,1,16)}')"
  attended_date="$(TZ=America/Chicago date +%F)"
  if ! BRIEFING_HUMAN_ACTION_TOKEN="$attended_action_token" \
    "$NODE_BIN" "$ROOT/scripts/mint-briefing-attended-action.js" \
      --data-dir "$DATA_DIR" \
      --date "$attended_date" \
      --card system_health \
      --work-unit "system_health:otter_call_healer_${attended_scope_hash}" \
      >/dev/null; then
    echo "[otter-call-healer] attended exact requires a fresh signed SSH action receipt" >&2
    exit 64
  fi
  export BRIEFING_HUMAN_ACTION_TOKEN="$attended_action_token"
}

run_dispatcher() {
  local scope="$1"
  local -a args=("${base_healer_args[@]}")
  if [[ -n "$scope" ]]; then
    args+=(--exact-otids "$scope")
  fi
  if [[ "${OTTER_CALL_HEALER_ATTENDED_EXACT:-0}" == "1" ]]; then
    mint_attended_capability "$scope"
    args+=(--attended-exact)
  fi
  if command -v ionice >/dev/null 2>&1; then
    ionice -c 3 nice -n 15 "$NODE_BIN" "$ROOT/scripts/otter-call-processing-healer-dispatch.js" "${args[@]}" || test "$?" -eq 2
  else
    nice -n 15 "$NODE_BIN" "$ROOT/scripts/otter-call-processing-healer-dispatch.js" "${args[@]}" || test "$?" -eq 2
  fi
}

# Prints "<open otids csv>|<stage signature>" for the exact scope from the
# published ledger. The signature changes whenever any call advances a stage.
exact_scope_state() {
  "$NODE_BIN" "$ROOT/scripts/lib/otter-exact-scope-state.js" \
    "$DATA_DIR/life-archive/voiceprints/otter-call-processing-ledger-latest.json" "$1"
}

deploy_waiting() {
  [[ -e "${SB_DEPLOY_LOCK_FILE:-/tmp/secondbrain-deploy.lock}" ]]
}

# Both producers persist their canonical artifacts. Their stdout contains the
# full conflict evidence / call ledger and must not be duplicated into a
# five-minute cron log.
exec 8>"$REFRESH_LOCK_FILE"
flock -w 60 8
if [[ -n "$exact_otids" ]]; then
  refresh_exact_ledger "$exact_otids"
else
  "$NODE_BIN" "$ROOT/scripts/voice-name-conflict-audit.js" --write >/dev/null || test "$?" -eq 2
  "$NODE_BIN" "$ROOT/scripts/otter-call-processing-ledger.js" --write >/dev/null || test "$?" -eq 2
fi
flock -u 8
chain_state=""
if [[ -n "$exact_otids" ]]; then
  chain_state="$(exact_scope_state "$exact_otids")"
fi
run_dispatcher "$exact_otids"

# Stage chaining (2026-09-24): a call used to advance one stage per five-minute
# tick. While an exact call is still open and the last dispatch moved some
# stage, refresh just those rows and dispatch again at once. The chain stops at
# a stage boundary when a deploy is waiting, when nothing advanced, or at the
# step and time caps, so the lane lock is never held past one stage for a
# release.
if [[ -n "$exact_otids" ]]; then
  chain_max="${OTTER_CALL_HEALER_CHAIN_MAX:-8}"
  chain_deadline="$(( $(date +%s) + ${OTTER_CALL_HEALER_CHAIN_SECONDS:-1200} ))"
  for ((chain_step = 2; chain_step <= chain_max; chain_step++)); do
    if deploy_waiting || [[ "$(date +%s)" -ge "$chain_deadline" ]]; then
      break
    fi
    exec 8>"$REFRESH_LOCK_FILE"
    flock -w 60 8
    refresh_exact_ledger "$exact_otids"
    flock -u 8
    next_state="$(exact_scope_state "$exact_otids")"
    open_otids="${next_state%%|*}"
    if [[ -z "$open_otids" || "${next_state#*|}" == "${chain_state#*|}" ]]; then
      break
    fi
    chain_state="$next_state"
    echo "[otter-call-healer] chain step $chain_step: $open_otids"
    run_dispatcher "$open_otids"
  done
fi

# Exact call closure updates the aggregate roster and Pareto source projection,
# but it must not republish a briefing card. This runner is a standing five-minute
# pipeline recovery poller, not an overnight or attended midday card refresh.
# The next explicitly admitted briefing refresh consumes these projected source
# artifacts. Keeping that boundary prevents newly arriving call data from
# turning an already accepted green card red in the background.
projection_failed=0
if [[ -n "$exact_otids" ]]; then
  projection_date="$(TZ=America/Chicago date +%F)"
  projection_scope_hash="$(printf '%s' "$exact_otids" | sha256sum | awk '{print substr($1,1,16)}')"
  exec 7>"$PROJECTION_LOCK_FILE"
  if flock -w 60 7; then
    "$NODE_BIN" "$ROOT/scripts/otter-call-speaker-rosters.js" \
      --write --otids "$exact_otids" --scope-hash "$projection_scope_hash" \
      >/dev/null || projection_failed=1
    "$NODE_BIN" "$ROOT/scripts/otter-call-exec-summaries.js" \
      --date "$projection_date" --otids "$exact_otids" --scope-hash "$projection_scope_hash" \
      >/dev/null || projection_failed=1
    "$NODE_BIN" "$ROOT/scripts/otter-speaker-pareto-report.js" \
      >/dev/null || projection_failed=1
    flock -u 7
  else
    echo "[otter-call-healer] exact briefing projection lock timed out" >&2
    projection_failed=1
  fi
  if [[ "$projection_failed" -ne 0 ]]; then
    echo "[otter-call-healer] exact call closed but Otter Pareto source projection failed" >&2
  fi
fi

if [[ "$LANE" == "historical" ]]; then
  # Durable drain verification: the read-only cohort report names paperwork
  # cohort size and any ledger-closed call lacking a committed settlement;
  # System Health reads the artifact (Codex review eb16d6c7cf6b). A report
  # failure is loud in the lane log and visible via report staleness in
  # health; it never fails the lane pass itself.
  report_rc=0
  "$NODE_BIN" "$ROOT/scripts/otter-exact-closure-paperwork-sweep.js" --write || report_rc=$?
  if [[ "$report_rc" -ne 0 ]]; then
    echo "[otter-call-healer] paperwork cohort report FAILED (exit $report_rc)"
  fi
fi

if [[ "$projection_failed" -ne 0 ]]; then
  exit 2
fi
