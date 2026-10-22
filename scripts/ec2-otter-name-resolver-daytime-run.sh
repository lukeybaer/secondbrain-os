#!/usr/bin/env bash
#
# ec2-otter-name-resolver-daytime-run.sh -- EC2 freshness trigger for the
# canonical recorder name resolver singleton (every 3 hours, around the clock; the
# file keeps its original daytime name).
#
# THE PROBLEM: the System Health row "Unknown voices got name guesses in last 4
# hours" (system_health:otter-name-resolver) reads only updated_at of
# life-archive/voiceprints/voice-identity-overnight-name-resolver-status.json and
# turns red once it is older than 4 hours (RESOLVER_MAX_AGE_MS in
# scripts/lib/otter-speaker-hypothesis-projection.js). The only code that wrote
# that file was the canonical call inside the card controller
# (refreshOtterNameResolver in scripts/lib/briefing-source-contracts.js), and the
# controller's unattended healers are blacked out 05:30-23:00 CT. After the night
# run the file therefore aged past 4 hours every day (16.8 hours old on
# 2026-10-19) with nothing scheduled to refresh it by day.
#
# THE FIX (this runner): run the exact canonical resolver call every 3 hours
# around the clock (02:20 through 23:20 CT, see
# install-ec2-otter-name-resolver-daytime-cron.sh). The argument list is the same
# one the controller passes (--canonical-health-status, --unknown-only,
# --min-calls 1, --recent-days 7, --resume-existing, --concurrency 2,
# --batch-size 8, --stop-early, --no-refresh), so the daytime run carries the
# same authority and the same declared scope. It never runs any --targets exact
# repair or any scoped --status-scope work: those belong to the controller and
# the exact-call healer. Its only precondition step is the membership catch-up
# below, through the controller's own shared chain.
#
# MEMBERSHIP CATCH-UP (Owner decision: "yes daytime"): --no-refresh judges
# only voices already in the latest clustering, which only the nightly chain
# rebuilt, so calls that landed by day stayed unnamed and the row went red on
# "recent roster-to-recluster membership unproven". Before each run, under both
# locks, scripts/otter-membership-catchup.js runs the controller's shared
# CPU-only chain (no paid model) for at most 6 such calls when the membership
# proof is incomplete, bounded by OTTER_MEMBERSHIP_CATCHUP_MINUTES (15). A
# failed or timed-out catch-up is logged and the resolver still runs; the next
# slot picks up what is left.
#
# THE RECEIPT: the singleton status file itself. This wrapper logs one line with
# updated_at before and after the run, then one verdict line.
#
# THE CONTRACT (Codex deploy review 8c215a0a1d4c): a slot either leaves the
# status newer than the moment this wrapper started, or exits nonzero so the cron
# log shows the gap. Lock contention waits (bounded) instead of skipping with
# exit 0; a run that ends with a status no newer than the start is a failure,
# unless a concurrent canonical run (the controller's night pass) is proven to
# have written it in the meantime.
#
# SAFETY:
#   - Around the clock: the 22:15-05:35 CT briefing reserve does not stop this
#     run (Codex deploy review d024e4684aa9: the 4 hour contract holds at night
#     too). The controller's own night pass already runs this scope inside that
#     window; nice 10, concurrency 2 and the 40 minute bound cap contention.
#   - Own flock (fd 8): a second run waits up to OTTER_NAME_RESOLVER_LOCK_WAIT_S
#     (default 1800 s = 30 min) for the first, then fails loudly (exit 1).
#   - Global-identity flock (fd 7, /tmp/secondbrain-voice-global-recluster.lock,
#     the recluster chain owner's lock): held for the whole run so the 07:10
#     recluster rebuild cannot start mid-run; waits for the rest of the same
#     30 minute budget when that chain holds it, then fails loudly (exit 1).
#   - The resolver's own pid-based canonical run lock makes a concurrent
#     controller-launched canonical run a skip that never touches the status
#     file. This wrapper then waits up to OTTER_NAME_RESOLVER_FRESH_WAIT_S
#     (default 1200 s = 20 min), polling every OTTER_NAME_RESOLVER_POLL_S (30 s),
#     for that run to leave a fresh status, and re-runs the resolver once if it
#     did not.
#   - Bounded: timeout 40m (--kill-after=30s), nice 10, concurrency 2, batch 8.
#     Worst case per slot: 30 min of lock waiting, a 15.5 min catch-up, a 40.5
#     min run, 20 min of fresh waiting, one more 40.5 min run = 146.5 min, inside the 180 min slot
#     spacing (install-ec2-otter-name-resolver-daytime-cron.test.js pins this).
#   - Paid keys stripped (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY)
#     exactly like the controller env; no token file is read or echoed here (the
#     ask-ai ladder resolves its own token path from HOME).
#
# TEST-GATED: under NODE_ENV=test / VITEST=true / OTTER_NAME_RESOLVER_DRY_RUN=1 it
# takes the guards and locks, prints the command it WOULD run, and exits 0 WITHOUT
# spawning node.
#
# Exit status: 0 only when the status file is newer than this wrapper's start
# (advanced by this run, or proven written by a concurrent canonical run); 1 for
# a lock wait that ran out, a resolver error, a timeout kill (124 or 137), or a
# run that ended without a fresh status.
set -uo pipefail

TAG="[otter-name-resolver-daytime]"
ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
ROOT="$(readlink -f "$ROOT_LINK" 2>/dev/null || true)"
[ -n "$ROOT" ] || ROOT="$ROOT_LINK"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
# Cron has a minimal env: pin HOME so the ask-ai ladder resolves its token path.
HOME="${HOME:-/home/ec2-user}"
export HOME
STATUS_PATH="$DATA_DIR/life-archive/voiceprints/voice-identity-overnight-name-resolver-status.json"
OWN_LOCK="${OTTER_NAME_RESOLVER_DAYTIME_LOCK:-/tmp/secondbrain-otter-name-resolver-daytime.lock}"
GLOBAL_LOCK="${OTTER_NAME_RESOLVER_GLOBAL_LOCK:-/tmp/secondbrain-voice-global-recluster.lock}"
# Bounded waits (seconds). Defaults keep the worst case inside one 3 hour slot.
LOCK_WAIT_S="${OTTER_NAME_RESOLVER_LOCK_WAIT_S:-1800}"
FRESH_WAIT_S="${OTTER_NAME_RESOLVER_FRESH_WAIT_S:-1200}"
POLL_S="${OTTER_NAME_RESOLVER_POLL_S:-30}"
START_EPOCH="$(date -u +%s)"

log() { echo "$TAG $(date -u +%FT%TZ) $*"; }
elapsed() { echo $(( $(date -u +%s) - START_EPOCH )); }

# No time-of-day gate: the schedule runs every 3 hours around the clock so the
# 4 hour reader limit holds at night too (Codex deploy review d024e4684aa9). The
# two locks below and the resolver's own canonical run lock are the collision guards.

# Own lock (fd 8), then the global-identity chain lock (fd 7). Both are held for
# the whole run and released when this shell exits. Each wait is bounded by what
# is left of LOCK_WAIT_S; running out is a loud failure, not a silent skip.
exec 8>"$OWN_LOCK"
if ! flock -w "$LOCK_WAIT_S" 8; then
  log "failed: another name-resolver run still holds $OWN_LOCK after $(elapsed)s"
  exit 1
fi
remaining=$(( LOCK_WAIT_S - $(elapsed) ))
[ "$remaining" -ge 1 ] || remaining=1
exec 7>"$GLOBAL_LOCK"
if ! flock -w "$remaining" 7; then
  log "failed: global recluster/identity chain still holds its lock ($GLOBAL_LOCK) after $(elapsed)s"
  exit 1
fi

# The canonical argument set, identical to refreshOtterNameResolver's producer
# call in scripts/lib/briefing-source-contracts.js. A test keeps the two equal.
RESOLVER_ARGS=(
  --canonical-health-status
  --unknown-only
  --min-calls 1
  --recent-days 7
  --resume-existing
  --concurrency 2
  --batch-size 8
  --stop-early
  --no-refresh
)
CATCHUP_MINUTES="${OTTER_MEMBERSHIP_CATCHUP_MINUTES:-15}"
CATCHUP_CMD=(
  timeout --kill-after=30s "${CATCHUP_MINUTES}m"
  nice -n 10
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY
  SECONDBRAIN_DATA_DIR="$DATA_DIR" BRIEFING_CARD_CONTROLLER=1 HOME="$HOME"
  "$NODE_BIN" scripts/otter-membership-catchup.js
)
CMD=(
  timeout --kill-after=30s 40m
  nice -n 10
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY
  SECONDBRAIN_DATA_DIR="$DATA_DIR" BRIEFING_CARD_CONTROLLER=1 HOME="$HOME"
  "$NODE_BIN" scripts/voice-identity-overnight-name-resolver.js "${RESOLVER_ARGS[@]}"
)

# TEST GATE: never spawn the real resolver under test / dry-run.
if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${OTTER_NAME_RESOLVER_DRY_RUN:-}" = "1" ]; then
  log "DRY-RUN (test mode): would catch up membership: (cd $ROOT && ${CATCHUP_CMD[*]})"
  log "DRY-RUN (test mode): would run: (cd $ROOT && ${CMD[*]})"
  exit 0
fi

cd "$ROOT" || { log "cannot cd to $ROOT" >&2; exit 1; }

# Prints: updated_at <TAB> phase <TAB> failed_targets <TAB> updated_at as epoch
# seconds (or placeholders).
read_status() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    let s = {};
    try { s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { s = {}; }
    const v = (x, d) => (x === undefined || x === null || x === "" ? d : String(x));
    const ms = Date.parse(String(s.updated_at || ""));
    const epoch = Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : "none";
    console.log([v(s.updated_at, "none"), v(s.phase, "none"), v(s.failed_targets, "unknown"), epoch].join("\t"));
  ' "$STATUS_PATH" 2>/dev/null || printf 'unreadable\tunreadable\tunknown\tnone\n'
}

# True when the status carries an updated_at at or after this wrapper's start.
status_is_fresh() {
  local epoch="$1"
  [ "$epoch" != "none" ] && [ "$epoch" -ge "$START_EPOCH" ]
}

# Membership catch-up first, never fatal: the resolver still refreshes the stamp.
catchup_out="$("${CATCHUP_CMD[@]}" 2>&1)"
catchup_code=$?
log "membership catch-up exit=$catchup_code $(printf '%s' "$catchup_out" | grep -m1 '^{' || true)"
if [ "$catchup_code" != "0" ]; then
  log "membership catch-up output tail:"
  printf '%s\n' "$catchup_out" | tail -c 2000
fi

IFS=$'\t' read -r before_at before_phase before_failed before_epoch <<< "$(read_status)"

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

# One resolver attempt. Sets: code, after_at, after_phase, after_failed,
# after_epoch, advanced, skipped. Logs the bookkeeping line.
run_once() {
  local attempt="$1"
  : > "$OUT"
  "${CMD[@]}" > "$OUT" 2>&1
  code=$?
  IFS=$'\t' read -r after_at after_phase after_failed after_epoch <<< "$(read_status)"
  advanced="no"
  [ "$after_at" != "$before_at" ] && advanced="yes"
  skipped="no"
  extra=""
  if grep -q '"skipped_concurrent_canonical_run"[[:space:]]*:[[:space:]]*true' "$OUT" 2>/dev/null; then
    skipped="yes"
    extra=" skipped_concurrent_canonical_run=yes"
  fi
  log "exit=$code phase=$after_phase updated_at $before_at -> $after_at advanced=$advanced failed_targets=$after_failed${extra} attempt=$attempt"
  if [ "$code" != "0" ]; then
    # Keep the log honest about a failed run without echoing the whole progress stream.
    log "resolver output tail:"
    tail -c 3000 "$OUT"
  fi
}

# Verdict after a run that exited 0 (attempt 1, or the retry with suffix
# "_on_retry"). Exit 0 only when the status is newer than this wrapper's start:
# advanced=yes alone is no proof, since a stale or unparseable stamp can still
# differ from the one read before the run (Codex deploy review 81ed2719e37c).
# A fresh stamp this run did not change was written by a concurrent canonical
# run (the controller's night pass) while this wrapper waited for its locks;
# that counts. Falls through only for advanced=no and not fresh.
settle() {
  local suffix="$1"
  if status_is_fresh "$after_epoch"; then
    if [ "$advanced" = "yes" ]; then
      log "verdict=ok reason=advanced${suffix}"
    else
      log "verdict=ok reason=fresh_by_concurrent_writer${suffix} updated_at=$after_at"
    fi
    exit 0
  fi
  if [ "$advanced" = "yes" ]; then
    log "failed: status changed ($before_at -> $after_at) but its stamp is not newer than this run's start (start epoch $START_EPOCH): stale or unparseable updated_at"
    exit 1
  fi
}

run_once 1

# Any nonzero resolver exit is a failed cron run: a timeout kill (124 TERM, 137
# KILL after the grace) and a resolver error alike. The tail above is the record.
if [ "$code" != "0" ]; then
  exit 1
fi

settle ""

if [ "$skipped" = "yes" ]; then
  # The holder is still working. Wait (bounded) for it to leave a fresh status.
  waited=0
  while [ "$waited" -lt "$FRESH_WAIT_S" ]; do
    sleep "$POLL_S"
    waited=$(( waited + POLL_S ))
    IFS=$'\t' read -r after_at after_phase after_failed after_epoch <<< "$(read_status)"
    if status_is_fresh "$after_epoch"; then
      log "verdict=ok reason=fresh_by_concurrent_writer_after_wait waited=${waited}s updated_at=$after_at"
      exit 0
    fi
  done
  log "concurrent canonical run left no fresh status after ${waited}s; running once more"
  run_once 2
  if [ "$code" != "0" ]; then
    exit 1
  fi
  settle "_on_retry"
fi

log "failed: resolver exited 0 but the status is not newer than this run's start ($before_at, start epoch $START_EPOCH)"
exit 1
