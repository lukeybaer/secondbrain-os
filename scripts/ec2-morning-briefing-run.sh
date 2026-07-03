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
CMD=("$NODE_BIN" scripts/cloud-morning-briefing.js --date "$DATE" --publish)

# Mechanical-pass command, built once for the same reason. `--mechanical-only` is
# W2a's flag on the orchestrator (coordinated, landing on another branch); this
# runner calls it opportunistically and tolerates its absence (see header).
MECH_CMD=("$NODE_BIN" scripts/overnight-self-heal-orchestrator.js --mechanical-only)

TEST_MODE=0
if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${BRIEFING_DRY_RUN:-}" = "1" ]; then
  TEST_MODE=1
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
  echo "[morning-briefing-run] DRY-RUN (test mode): would run: (cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR HOME=$HOME ${CMD[*]})"
  exit 0
fi

cd "$ROOT" || { echo "[morning-briefing-run] cannot cd to $ROOT" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# flock -n: if a briefing run is already going, this run is a clean no-op. Acquired
# strictly AFTER the mechanical pass above has released its own separate lock.
flock -n "$LOCK" env SECONDBRAIN_DATA_DIR="$DATA_DIR" HOME="$HOME" "${CMD[@]}"
status=$?

if [ "$status" = "0" ]; then
  echo "[morning-briefing-run] $(date -u +%FT%TZ) done (exit 0, published)."
elif [ "$status" = "1" ]; then
  # flock returns 1 when the lock is held -> a prior run is still going. Benign.
  echo "[morning-briefing-run] $(date -u +%FT%TZ) skipped: a briefing run is already going (lock held) OR the briefing reported a fatal; see the run log."
else
  # Non-zero from cloud-morning-briefing is typically a blocked publish (published
  # anyway, labeled). The dashboard still gets a fresh dated briefing.
  echo "[morning-briefing-run] $(date -u +%FT%TZ) finished with exit $status (likely published-blocked; see $LOG_DIR)."
fi
exit 0
