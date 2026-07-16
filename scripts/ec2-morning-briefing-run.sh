#!/usr/bin/env bash
#
# ec2-morning-briefing-run.sh -- EC2 ALWAYS-ON daily briefing generate + publish.
#
# The 5:30 CT daily briefing (cloud-morning-briefing.js --publish) had NO cloud cron:
# it was triggered only by a laptop scheduled task (daily-briefing.bat), so when the
# laptop did not run it the public dashboard went stale (no fresh dated briefing was
# generated or published). This runner generates + publishes the briefing ON EC2 daily,
# after the overnight self-heal (2:45/3:00) and the otter resolver (4:45), against the
# cloud data store. It publishes clean OR blocked (the clean-or-blocked contract), so
# the dashboard always ExampleCos a fresh dated briefing, never a silent stale one.
#
# CLAUDE AUTH: the news summaries need the Max-plan OAuth token; same contract as the
# self-heal runner (HOME + CLAUDE_CODE_OAUTH_TOKEN from /home/ec2-user/.claude-oauth-token).
#
# IDEMPOTENT: flock -n makes a second invocation a clean no-op. LOGGED: dated header.
# TEST-GATED: under NODE_ENV=test / VITEST / BRIEFING_DRY_RUN=1 it prints the command it
# WOULD run and exits 0 WITHOUT spawning node, so a regression test can assert the wiring.
#
# PRE-BRIEFING MECHANICAL PASS (Codex amendment 2, item W2b): overnight generators can
# still be finishing after 5:30 CT (observed: "6 scheduled tasks failed" at 5:29 that
# were all green by 6:40), so the briefing snapshot is stale mid-flight state. Before
# the build, this runner invokes the orchestrator's mechanical tier via a bounded
# `--mechanical-only` pass so the snapshot is fresh. LOCK ORDERING is load-bearing:
# the mechanical pass takes ITS OWN lock (MECHANICAL_LOCK, a short try-wait flock -w 30,
# never the briefing's own lock), runs under a HARD 10-minute cap with process-group
# kill wiring (timeout --kill-after), and releases its lock BEFORE the existing
# briefing flock (-n, unchanged) is ever acquired. The two locks are separate,
# sequential, non-nested flock invocations -- the briefing never waits on the
# mechanical pass beyond the cap, and the mechanical pass never runs while holding the
# briefing lock. Opportunistic: if the orchestrator does not support --mechanical-only
# yet (concurrent work on another branch), this step logs and skips, and it NEVER
# fails the briefing regardless of its own exit status (`|| true` on the flock call).
# Skippable via BRIEFING_SKIP_MECHANICAL_PASS=1. Logs a dated line either way (ran,
# skipped, or timed out) so the morning log always shows what happened.
set -uo pipefail

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
# Under controller authority, execute the same deployed runtime as the 11 PM
# runner. ROOT remains the legacy full-build path only while authority is off.
CONTROLLER_ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
LOCK="/tmp/secondbrain-morning-briefing-run.lock"
MECHANICAL_LOCK="/tmp/secondbrain-mechanical-pass.lock"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
# Cron has a minimal env: pin HOME so the OAuth token default path resolves.
HOME="${HOME:-/home/ec2-user}"
TOKEN_PATH="${CLAUDE_OAUTH_TOKEN_PATH:-$HOME/.claude-oauth-token}"
# Briefing date = today in Central Time (the briefing's canonical day).
DATE="${BRIEFING_DATE:-$(TZ=America/Chicago date +%F)}"
DATE_ATTEMPT_FILE="${BRIEFING_DATE_ATTEMPT_FILE:-$DATA_DIR/agent/briefing-generation-attempts/$DATE.json}"
DATE_LOCK_FILE="${BRIEFING_DATE_LOCK_FILE:-$DATA_DIR/agent/briefing-generation-attempts/$DATE.lock}"
DATE_LEASE_HELD=0
# Cron does not inherit a terminal's environment. The production authority
# switch therefore lives beside other durable cloud runtime state. An explicit
# environment value remains an emergency override for a single invocation.
AUTHORITY_FILE="${BRIEFING_CARD_CONTROLLER_AUTHORITY_FILE:-$DATA_DIR/agent/briefing-card-controller-authority}"
if [ -n "${BRIEFING_CARD_CONTROLLER_AUTHORITY:-}" ]; then
  CONTROLLER_AUTHORITY="$BRIEFING_CARD_CONTROLLER_AUTHORITY"
elif [ -r "$AUTHORITY_FILE" ]; then
  CONTROLLER_AUTHORITY="$(tr -d '[:space:]' < "$AUTHORITY_FILE")"
else
  CONTROLLER_AUTHORITY="0"
fi
case "$CONTROLLER_AUTHORITY" in
  0|1) ;;
  *)
    echo "[morning-briefing-run] WARNING: invalid controller authority '$CONTROLLER_AUTHORITY' in $AUTHORITY_FILE; using legacy path."
    CONTROLLER_AUTHORITY="0"
    ;;
esac

STAMP="$(date -u +%FT%TZ)"
echo "[morning-briefing-run] $STAMP root=$ROOT data_dir=$DATA_DIR date=$DATE token_path=$TOKEN_PATH"

if [ -r "$TOKEN_PATH" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_PATH")"
  export CLAUDE_CODE_OAUTH_TOKEN
  echo "[morning-briefing-run] Claude OAuth token loaded from $TOKEN_PATH"
else
  echo "[morning-briefing-run] WARNING: no readable token at $TOKEN_PATH; news summaries may degrade."
fi
export HOME

# Build the exact command once so the dry-run print and the real spawn cannot drift.
# The morning run must create the dated briefing markdown before any per-card
# artifact union can be meaningful. refresh-card --all is a repaint helper, not
# the 5:30 generator.
CMD=("$NODE_BIN" scripts/cloud-morning-briefing.js --date "$DATE" --publish --notify)

# The old card-controller authority switch is now only a deployed-root selector.
# It no longer runs a competing final-pass writer; both branches publish the
# same real cloud briefing.
CONTROLLER_CMD=("${CMD[@]}")

# Mechanical-pass command, built once for the same reason. `--mechanical-only` is
# W2a's flag on the orchestrator (coordinated, landing on another branch); this
# runner calls it opportunistically and tolerates its absence (see header).
MECH_CMD=("$NODE_BIN" scripts/overnight-self-heal-orchestrator.js --mechanical-only)

# RUNG 2 (Wave 4): the AGENTIC OVERNIGHT HEALER. After the mechanical pass
# (rung 1) and the briefing build+publish have finished, this spawns one full
# agentic dev session (claude primary, codex fallback per the ladder) against
# the FRESH dashboard-qc-result.json defect list the publish just wrote, with
# the standing mission to fix remaining defects like an interactive session
# ExampleCo dispatched: root-cause, code fix in an isolated worktree, tests, land
# via land.js --apply, deploy via deploy-ec2-server.sh when EC2-affecting,
# verify per-card on the live board. It runs strictly AFTER the briefing flock
# above is released (the driver additionally PROBES the briefing lock and
# refuses to race an active generation), it is best-effort (its exit never
# fails this runner), and it is skippable via BRIEFING_SKIP_AGENTIC_HEALER=1.
# Budget (45m hard wall clock), no-repeat-tactics ledger, and the
# honest-blocked-receipt-on-expiry rail live in scripts/agentic-healer-driver.js.
HEALER_CMD=(bash scripts/overnight-agentic-healer.sh)
CAP_CMD=("$NODE_BIN" "$CONTROLLER_ROOT/scripts/ensure-neo4j-cpu-cap.js" --apply --data-dir "$DATA_DIR")

# Deterministic incident report from canonical board truth. It is generated
# after bounded repair so its evidence describes the board ExampleCo will see.
REPORT_CMD=("$NODE_BIN" "$CONTROLLER_ROOT/scripts/briefing-morning-report.js" --date "$DATE" --data-dir "$DATA_DIR")

TEST_MODE=0
if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${BRIEFING_DRY_RUN:-}" = "1" ]; then
  TEST_MODE=1
fi

# Docker Compose owns the permanent limit. This bounded recheck runs before
# either morning path and cannot gate independent card production.
if [ "$TEST_MODE" = "1" ]; then
  echo "[morning-briefing-run] DRY-RUN: would enforce Neo4j CPU cap with: ${CAP_CMD[*]}"
elif timeout --kill-after=5s 35s "${CAP_CMD[@]}"; then
  echo "[morning-briefing-run] $(date -u +%FT%TZ) neo4j-cpu-cap: verified."
else
  cap_status=$?
  echo "[morning-briefing-run] $(date -u +%FT%TZ) neo4j-cpu-cap: non-green exit $cap_status; continuing with independent cards." >&2
fi

write_morning_report() {
  report_path="$DATA_DIR/agent/briefing-overnight-watch/$DATE-morning-report.html"
  if [ "$TEST_MODE" = "1" ]; then
    echo "[morning-briefing-run] DRY-RUN: would reconcile morning report with: ${REPORT_CMD[*]} (output: $report_path)"
    return 0
  fi
  if "${REPORT_CMD[@]}"; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) morning-report: reconciled $report_path"
  else
    echo "[morning-briefing-run] $(date -u +%FT%TZ) morning-report: FAILED to reconcile $report_path (non-fatal)." >&2
  fi
}

# W5 Stage 2 parity snapshot: right after the cloud build, copy the published
# markdown to a CLOUD-PROVENANCE snapshot the desktop parity runner
# (scripts/briefing-parity-run.js) compares against. The live
# briefing-<date>.md is written by BOTH the desktop publish (scp) and this
# build, so it cannot prove which generator produced it; this snapshot is
# taken only by THIS runner, only after ITS build, so a morning where the EC2
# build failed has no snapshot and the parity ledger records an honest skip
# instead of a false PARITY day. Best-effort: never fails the briefing.
RUN_START_EPOCH="$(date +%s)"
snapshot_parity_artifact() {
  build_exit="$1"
  src="$DATA_DIR/briefings/briefing-$DATE.md"
  dir="$DATA_DIR/briefings/parity"
  if [ "$TEST_MODE" = "1" ]; then
    echo "[morning-briefing-run] DRY-RUN: would snapshot parity artifact $src -> $dir/cloud-briefing-$DATE.md"
    return 0
  fi
  if [ ! -f "$src" ]; then
    echo "[morning-briefing-run] parity-snapshot: no $src to snapshot (build exit $build_exit); skipped."
    return 0
  fi
  # Codex 2026-07-12 finding 4 (adopted): only snapshot a file THIS run wrote.
  # The desktop publish scp's onto the same path, so an mtime older than this
  # run's start means the on-disk copy is not provably cloud-built (e.g. the
  # controller final pass had nothing to splice). Also require the briefing
  # date inside the file so a mislabeled artifact cannot masquerade.
  src_mtime="$(stat -c %Y "$src" 2>/dev/null || echo 0)"
  if [ "$src_mtime" -lt "$RUN_START_EPOCH" ]; then
    echo "[morning-briefing-run] parity-snapshot: $src predates this run (mtime $src_mtime < start $RUN_START_EPOCH); provenance unproven, skipped."
    return 0
  fi
  if ! grep -q "$DATE" "$src" 2>/dev/null; then
    echo "[morning-briefing-run] parity-snapshot: $src does not carry date $DATE; skipped."
    return 0
  fi
  mkdir -p "$dir" 2>/dev/null || true
  if cp "$src" "$dir/cloud-briefing-$DATE.md" 2>/dev/null; then
    printf '{"ts":"%s","date":"%s","generator":"ec2-morning-briefing-run","buildExit":%s}\n' \
      "$(date -u +%FT%TZ)" "$DATE" "${build_exit:-0}" > "$dir/cloud-briefing-$DATE.provenance.json" 2>/dev/null || true
    echo "[morning-briefing-run] parity-snapshot: wrote $dir/cloud-briefing-$DATE.md"
  else
    echo "[morning-briefing-run] parity-snapshot: copy failed (non-fatal)."
  fi
}

print_date_generation_lease_dry_run() {
  echo "[morning-briefing-run] DRY-RUN: date-generation lease would use $DATE_ATTEMPT_FILE (repeat override: BRIEFING_ALLOW_REPEAT=1)."
}

acquire_date_generation_lease() {
  attempt_dir="$(dirname "$DATE_ATTEMPT_FILE")"
  mkdir -p "$attempt_dir" 2>/dev/null || {
    echo "[morning-briefing-run] date-generation lease: cannot create $attempt_dir; skipping full generation." >&2
    return 1
  }
  exec 9>"$DATE_LOCK_FILE" || {
    echo "[morning-briefing-run] date-generation lease: cannot open $DATE_LOCK_FILE; skipping full generation." >&2
    return 1
  }
  if ! flock -n 9; then
    echo "[morning-briefing-run] date-generation lease: another full run for $DATE is active; skipped."
    return 1
  fi
  if [ -f "$DATE_ATTEMPT_FILE" ] && [ "${BRIEFING_ALLOW_REPEAT:-}" != "1" ]; then
    echo "[morning-briefing-run] date-generation lease: $DATE already attempted at $DATE_ATTEMPT_FILE; skipped. Set BRIEFING_ALLOW_REPEAT=1 for supervised repair."
    return 1
  fi
  tmp="$DATE_ATTEMPT_FILE.$$"
  printf '{"ts":"%s","date":"%s","pid":%s,"host":"%s","root":"%s","repeatOverride":%s}\n' \
    "$(date -u +%FT%TZ)" "$DATE" "$$" "$(hostname 2>/dev/null || echo ExampleCo)" "$ROOT" \
    "$([ "${BRIEFING_ALLOW_REPEAT:-}" = "1" ] && echo true || echo false)" > "$tmp" 2>/dev/null || {
      echo "[morning-briefing-run] date-generation lease: cannot write $tmp; skipping full generation." >&2
      rm -f "$tmp" 2>/dev/null || true
      return 1
    }
  mv "$tmp" "$DATE_ATTEMPT_FILE" 2>/dev/null || {
    echo "[morning-briefing-run] date-generation lease: cannot publish $DATE_ATTEMPT_FILE; skipping full generation." >&2
    rm -f "$tmp" 2>/dev/null || true
    return 1
  }
  DATE_LEASE_HELD=1
  echo "[morning-briefing-run] date-generation lease: acquired for $DATE at $DATE_ATTEMPT_FILE."
  return 0
}

release_date_generation_lease() {
  if [ "${DATE_LEASE_HELD:-0}" = "1" ]; then
    DATE_LEASE_HELD=0
    exec 9>&- 2>/dev/null || true
    echo "[morning-briefing-run] date-generation lease: released lock for $DATE; attempt marker remains."
  fi
}

# LESSONS RUNTIME ROOT (Codex review 2026-07-15): $ROOT defaults to the
# LEGACY full-build path (/home/ec2-user/secondbrain-current) while the
# deployed runtime under controller authority is $CONTROLLER_ROOT
# (/opt/secondbrain). The lesson helpers are best-effort, so pointing them at
# a root that does not contain scripts/self-heal/ would SILENTLY no-op lesson
# capture on the real deployment. Resolve the first root that actually
# contains the helper script (authority prefers the deployed runtime), and
# log LOUDLY when neither does: fail-open for the briefing, never silent.
resolve_lessons_root() {
  probe="scripts/self-heal/card-blocker-lessons-fallback-capture.js"
  if [ "$CONTROLLER_AUTHORITY" = "1" ]; then
    first="$CONTROLLER_ROOT"; second="$ROOT"
  else
    first="$ROOT"; second="$CONTROLLER_ROOT"
  fi
  if [ -f "$first/$probe" ]; then echo "$first"; return 0; fi
  if [ -f "$second/$probe" ]; then echo "$second"; return 0; fi
  echo ""
  return 0
}

# LESSONS FALLBACK CAPTURE (Codex review 2026-07-12): the primary lesson
# chokepoint (scripts/agentic-healer-driver.js feedSelfHealHealth) only fires
# when the agentic healer actually runs. BRIEFING_SKIP_AGENTIC_HEALER=1 makes
# the whole driver never start, which would otherwise silently mean "no
# lesson captured" on exactly the days that flag is used. This reads the live
# board artifact THIS run's own build/publish just wrote (never a stale or
# missing one) and records one lesson row per still-defective card directly.
# Best-effort, never fails or blocks this runner.
run_lessons_fallback_capture() {
  LESSONS_ROOT="$(resolve_lessons_root)"
  if [ -z "$LESSONS_ROOT" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-fallback-capture: NO runtime root contains scripts/self-heal (checked $CONTROLLER_ROOT and $ROOT); lesson capture SKIPPED. Deploy the self-heal scripts. (non-fatal)"
    return 0
  fi
  if [ "$TEST_MODE" = "1" ]; then
    echo "[morning-briefing-run] DRY-RUN: lessons-fallback-capture would run: (cd $LESSONS_ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR $NODE_BIN scripts/self-heal/card-blocker-lessons-fallback-capture.js --date $DATE --reason \"agentic healer skipped this cycle (BRIEFING_SKIP_AGENTIC_HEALER=1)\")"
    return 0
  fi
  ( cd "$LESSONS_ROOT" 2>/dev/null && SECONDBRAIN_DATA_DIR="$DATA_DIR" "$NODE_BIN" scripts/self-heal/card-blocker-lessons-fallback-capture.js --date "$DATE" --reason "agentic healer skipped this cycle (BRIEFING_SKIP_AGENTIC_HEALER=1)" ) \
    && echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-fallback-capture: recorded blocked-card lessons without a healer run (root: $LESSONS_ROOT)." \
    || echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-fallback-capture: finished non-zero (non-fatal, best-effort)."
  return 0
}

# WEEKLY LESSONS ROLLUP (ExampleCo dispatch 2026-07-12 evening, item 4): every
# Friday (by the CT briefing DATE, not the host clock), append a dated digest
# of the week's card-blocker lessons (data/agent/card-blocker-lessons.jsonl,
# fed by the agentic healer's structured lesson capture -- see rung 2 below)
# to dev-plans/core/briefing.LESSONS.md. Best-effort: it NEVER fails or blocks
# this runner. Skippable via BRIEFING_SKIP_LESSONS_ROLLUP=1.
run_weekly_lessons_rollup() {
  if [ "${BRIEFING_SKIP_LESSONS_ROLLUP:-}" = "1" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-rollup: skipped (BRIEFING_SKIP_LESSONS_ROLLUP=1)."
    return 0
  fi
  DOW="$(date -d "$DATE" +%u 2>/dev/null || echo 0)"
  if [ "$DOW" != "5" ]; then
    return 0
  fi
  LESSONS_ROOT="$(resolve_lessons_root)"
  if [ -z "$LESSONS_ROOT" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-rollup: NO runtime root contains scripts/self-heal (checked $CONTROLLER_ROOT and $ROOT); rollup SKIPPED. Deploy the self-heal scripts. (non-fatal)"
    return 0
  fi
  if [ "$TEST_MODE" = "1" ]; then
    echo "[morning-briefing-run] DRY-RUN: lessons-rollup would run (Friday, $DATE): (cd $LESSONS_ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR $NODE_BIN scripts/self-heal/card-blocker-lessons-rollup.js --date $DATE)"
    return 0
  fi
  ( cd "$LESSONS_ROOT" 2>/dev/null && SECONDBRAIN_DATA_DIR="$DATA_DIR" "$NODE_BIN" scripts/self-heal/card-blocker-lessons-rollup.js --date "$DATE" ) \
    && echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-rollup: appended (dev-plans/core/briefing.LESSONS.md, root: $LESSONS_ROOT)." \
    || echo "[morning-briefing-run] $(date -u +%FT%TZ) lessons-rollup: finished non-zero (non-fatal, best-effort)."
  return 0
}

if [ "$CONTROLLER_AUTHORITY" = "1" ]; then
  # No legacy mechanical pass under card-controller authority. It has a
  # different fan-out model and would become a competing writer again.
  if [ "$TEST_MODE" = "1" ]; then
    print_date_generation_lease_dry_run
    echo "[morning-briefing-run] DRY-RUN (card-controller authority): would run: (cd $CONTROLLER_ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR ${CONTROLLER_CMD[*]})"
    if [ "${BRIEFING_SKIP_AGENTIC_HEALER:-}" = "1" ]; then
      echo "[morning-briefing-run] agentic-healer: skipped (BRIEFING_SKIP_AGENTIC_HEALER=1)."
      run_lessons_fallback_capture
    else
      echo "[morning-briefing-run] DRY-RUN (card-controller authority): agentic-healer rung 2 would run after the controller pass: (cd $ROOT && BRIEFING_DATE=$DATE SECONDBRAIN_DATA_DIR=$DATA_DIR HOME=$HOME ${HEALER_CMD[*]})"
    fi
    write_morning_report
    snapshot_parity_artifact 0
    run_weekly_lessons_rollup
    exit 0
  fi
  if ! acquire_date_generation_lease; then
    exit 0
  fi
  cd "$CONTROLLER_ROOT" || { echo "[morning-briefing-run] cannot cd to deployed controller runtime $CONTROLLER_ROOT" >&2; exit 1; }
  mkdir -p "$LOG_DIR"
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
  flock -n "$LOCK" env SECONDBRAIN_DATA_DIR="$DATA_DIR" HOME="$HOME" "${CONTROLLER_CMD[@]}"
  status=$?
  if [ "$status" = "0" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) card-controller final pass completed."
  else
    echo "[morning-briefing-run] $(date -u +%FT%TZ) card-controller final pass exit=$status; briefing remains honestly labeled until its scoped repairs pass."
  fi
  # RUNG 2 (Wave 4) runs on the controller-authority path too (Codex review
  # 2026-07-12: without this the healer was silently bypassed the moment the
  # authority marker flips to 1). The healer executes against the git build
  # path ($ROOT), never the /opt file-copy runtime, and its exit never fails
  # this runner.
  if [ "${BRIEFING_SKIP_AGENTIC_HEALER:-}" = "1" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) agentic-healer: skipped (BRIEFING_SKIP_AGENTIC_HEALER=1)."
    if [ "$status" = "1" ]; then
      echo "[morning-briefing-run] lessons-fallback-capture: skipped (exit 1: lock held; this invocation built nothing, so its artifact provenance is unproven)."
    else
      run_lessons_fallback_capture
    fi
  else
    cd "$ROOT" || echo "[morning-briefing-run] WARNING: cannot cd to $ROOT for the agentic healer."
    BRIEFING_DATE="$DATE" SECONDBRAIN_DATA_DIR="$DATA_DIR" HOME="$HOME" SECONDBRAIN_ROOT="$ROOT" "${HEALER_CMD[@]}"
    healer_status=$?
    echo "[morning-briefing-run] $(date -u +%FT%TZ) agentic-healer: finished with exit $healer_status (receipt: $DATA_DIR/agent/overnight-agentic-healer-runs.jsonl)."
  fi
  write_morning_report
  # W5 parity snapshot AFTER the healer: the healer may have repaired cards
  # and republished the markdown, so the snapshot captures the finished
  # cloud-built board.
  snapshot_parity_artifact "$status"
  run_weekly_lessons_rollup
  release_date_generation_lease
  exit 0
fi

# PRE-BRIEFING MECHANICAL PASS: runs (or is described, under dry-run) BEFORE the
# briefing's own lock is ever touched. See header for the full lock-ordering
# rationale; this step must never block or fail the briefing build.
if [ "${BRIEFING_SKIP_MECHANICAL_PASS:-}" = "1" ]; then
  echo "[morning-briefing-run] $(date -u +%FT%TZ) mechanical-pass: skipped (BRIEFING_SKIP_MECHANICAL_PASS=1)."
elif [ "$TEST_MODE" = "1" ]; then
  echo "[morning-briefing-run] DRY-RUN (test mode): mechanical-pass would run: (cd $ROOT && flock -w 30 \"$MECHANICAL_LOCK\" timeout --kill-after=15s 600s env SECONDBRAIN_DATA_DIR=$DATA_DIR HOME=$HOME ${MECH_CMD[*]})"
else
  (
    cd "$ROOT" 2>/dev/null || exit 99
    # flock -w 30: short try-wait on OUR OWN lock, never the briefing lock. If a
    # mechanical pass is already running this run skips rather than queuing behind
    # it. timeout --kill-after=15s 600s: hard 10-minute cap, SIGTERM then SIGKILL
    # the whole process group 15s later if it ignores SIGTERM, so a hung
    # orchestrator invocation can never hang the briefing build.
    flock -w 30 "$MECHANICAL_LOCK" timeout --kill-after=15s 600s \
      env SECONDBRAIN_DATA_DIR="$DATA_DIR" HOME="$HOME" "${MECH_CMD[@]}"
  )
  mech_status=$?
  if [ "$mech_status" = "0" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) mechanical-pass: ran, exit 0."
  elif [ "$mech_status" = "124" ] || [ "$mech_status" = "137" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) mechanical-pass: TIMED OUT (10-minute cap), killed. Continuing to briefing build."
  elif [ "$mech_status" = "1" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) mechanical-pass: could not acquire its lock within 30s (another pass running); skipped."
  elif [ "$mech_status" = "99" ]; then
    echo "[morning-briefing-run] $(date -u +%FT%TZ) mechanical-pass: cannot cd to $ROOT; skipped. Continuing to briefing build."
  else
    echo "[morning-briefing-run] $(date -u +%FT%TZ) mechanical-pass: finished with exit $mech_status (orchestrator may not support --mechanical-only yet). Continuing to briefing build."
  fi
  # The mechanical pass NEVER fails the briefing build regardless of its own exit.
  true
fi

# TEST GATE: never spawn the real briefing under test / dry-run.
if [ "$TEST_MODE" = "1" ]; then
  print_date_generation_lease_dry_run
  echo "[morning-briefing-run] DRY-RUN (test mode): would run: (cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR HOME=$HOME ${CMD[*]})"
  if [ "${BRIEFING_SKIP_AGENTIC_HEALER:-}" = "1" ]; then
    echo "[morning-briefing-run] agentic-healer: skipped (BRIEFING_SKIP_AGENTIC_HEALER=1)."
    run_lessons_fallback_capture
  else
    echo "[morning-briefing-run] DRY-RUN (test mode): agentic-healer rung 2 would run after the briefing: (cd $ROOT && BRIEFING_DATE=$DATE SECONDBRAIN_DATA_DIR=$DATA_DIR HOME=$HOME ${HEALER_CMD[*]})"
  fi
  write_morning_report
  snapshot_parity_artifact 0
  run_weekly_lessons_rollup
  exit 0
fi

if ! acquire_date_generation_lease; then
  exit 0
fi

cd "$ROOT" || { echo "[morning-briefing-run] cannot cd to $ROOT" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# flock -n: if a briefing run is already going, this run is a clean no-op. Acquired
# strictly AFTER the mechanical pass above has released its own separate lock.
flock -n "$LOCK" env SECONDBRAIN_DATA_DIR="$DATA_DIR" HOME="$HOME" "${CMD[@]}"
status=$?

# PER-CARD COMPLETION (ExampleCo wave 3a, 2026-07-12): the completion line
# enumerates per-card outcomes from the canonical live-board artifact instead
# of a scalar verdict ("published-blocked"). Every card is published; "held"
# means a card's own gate labeled it defect/blocked on its tile.
COMPLETION="$(/usr/bin/node "$ROOT/scripts/briefing-completion-line.js" --data-dir "$DATA_DIR" 2>/dev/null || true)"
[ -n "$COMPLETION" ] || COMPLETION="per-card state unavailable: completion reader failed; see $LOG_DIR"

if [ "$status" = "0" ]; then
  echo "[morning-briefing-run] $(date -u +%FT%TZ) done (exit 0): $COMPLETION"
elif [ "$status" = "1" ]; then
  # flock returns 1 when the lock is held -> a prior run is still going. Benign.
  echo "[morning-briefing-run] $(date -u +%FT%TZ) skipped: a briefing run is already going (lock held) OR the briefing reported a fatal; see the run log."
else
  # Non-zero from cloud-morning-briefing means one or more cards were held by
  # their own gates (still published, labeled). Enumerate them.
  echo "[morning-briefing-run] $(date -u +%FT%TZ) finished with exit $status: $COMPLETION (see $LOG_DIR)"
fi

# RUNG 2 (Wave 4): agentic healer, strictly after the briefing flock released.
# Best-effort: whatever its exit, this runner still exits 0 below, so rung 2
# can never fail or delay the published briefing (it only heals after it).
if [ "${BRIEFING_SKIP_AGENTIC_HEALER:-}" = "1" ]; then
  echo "[morning-briefing-run] $(date -u +%FT%TZ) agentic-healer: skipped (BRIEFING_SKIP_AGENTIC_HEALER=1)."
  if [ "$status" = "1" ]; then
    echo "[morning-briefing-run] lessons-fallback-capture: skipped (exit 1: lock held; this invocation built nothing, so its artifact provenance is unproven)."
  else
    run_lessons_fallback_capture
  fi
else
  BRIEFING_DATE="$DATE" SECONDBRAIN_DATA_DIR="$DATA_DIR" HOME="$HOME" SECONDBRAIN_ROOT="$ROOT" "${HEALER_CMD[@]}"
  healer_status=$?
  echo "[morning-briefing-run] $(date -u +%FT%TZ) agentic-healer: finished with exit $healer_status (receipt: $DATA_DIR/agent/overnight-agentic-healer-runs.jsonl)."
fi
write_morning_report
# W5 parity snapshot AFTER the build. Exit 1 (lock held / fatal) does NOT
# snapshot: the dated artifact on disk might be the desktop-published copy,
# and a false cloud-provenance snapshot would fake a PARITY day. The in-flight
# run that holds the lock takes its own snapshot when it finishes.
if [ "$status" != "1" ]; then
  snapshot_parity_artifact "$status"
else
  echo "[morning-briefing-run] parity-snapshot: skipped (exit 1: lock held or fatal; provenance unproven)."
fi
run_weekly_lessons_rollup
release_date_generation_lease
exit 0
