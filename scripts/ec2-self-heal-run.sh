#!/usr/bin/env bash
#
# ec2-self-heal-run.sh -- EC2 ALWAYS-ON overnight self-heal trigger (green-tomorrow
# WAVE 1, BLOCKER B).
#
# The overnight self-heal had NO cloud trigger: the only trigger was a stale laptop
# task that auth-failed, so the self-heal run-log went stale and SELF-HEAL HEALTH
# stayed a permanent RED required tile while nothing cleared the nightly blockers.
# This runner fires the orchestrator ON EC2, before the 5:30 CT briefing, with the
# Claude auth the heal workers need.
#
# It runs the same card-controller graph from the canonical EC2 build path in
# OVERNIGHT mode. The retired legacy fan-out orchestrator is never a fallback.
# When primary controller authority is enabled, these delayed passes remain
# useful retries of that same graph; the durable controller lease prevents a
# concurrent writer and the exact owner/date ledger preserves cycle budgets.
#
# CLAUDE AUTH: the heal workers spawn `claude -p` via scripts/lib/heal-executor.js,
# whose workerEnv() calls buildClaudeCliEnv() (scripts/lib/cli-output-guard.js).
# buildClaudeCliEnv reads the pushed OAuth access token from $HOME/.claude-oauth-token
# (DEFAULT_TOKEN_PATH) and injects CLAUDE_CODE_OAUTH_TOKEN, stripping any stray
# ANTHROPIC_API_KEY so the Max-plan token wins. Cron runs with a minimal env (HOME
# often unset), so we (1) pin HOME=/home/ec2-user so the default token path resolves
# and (2) ALSO export CLAUDE_CODE_OAUTH_TOKEN from that file as a belt-and-suspenders
# fallback (cleanEnv() preserves it from the process env when the file read is empty).
# Verified against the code 2026-06-29: token file = /home/ec2-user/.claude-oauth-token,
# env var = CLAUDE_CODE_OAUTH_TOKEN.
#
# Install the cron (2:45 + 3:00 AM CT) with scripts/install-ec2-self-heal-cron.sh on
# EC2. The operator installs this on EC2; nothing here SSHes anywhere.
#
# TWO SCHEDULED PASSES = TWO REAL ATTEMPTS (2026-07-18): the 2:45 and 3:00 CT
# crons exist so the night gets two heal attempts, but `flock -n` made the 3:00
# run exit instantly while the 2:45 run still held the lock, so the second pass
# never did any work. `flock -w` now WAITS (bounded) for the holder to finish,
# then runs a real second pass. Concurrency is still impossible: the wait only
# ends when the lock is free. The orchestrator's own internal lock gets the
# same bounded-wait budget via SELF_HEAL_LOCK_WAIT_MS. LOGGED: every run
# prints a dated header.
#
# TEST-GATED: under NODE_ENV=test / VITEST / SELFHEAL_DRY_RUN=1 it prints the command
# it WOULD run and exits 0 WITHOUT spawning node, so a regression test can assert the
# wiring without a real orchestrator run.
set -uo pipefail

# 2026-09-02: nine of twelve post-02:05 healer deploys were REFUSED by
# scripts/lib/deploy-window-guard.js because this runner cd'd into the
# WRITABLE git checkout (secondbrain-current), never a pinned release, so the
# guard's "cwd resolves under /opt/secondbrain-releases/" pin proof could
# never succeed and it fail-closed every time this runner was mid-flight.
# Resolve the immutable release the same way scripts/ec2-card-controller-run.sh
# proves its own pin: CONTROLLER_ROOT is the /opt/secondbrain symlink (or an
# override), readlink -f follows it to the real release directory under
# /opt/secondbrain-releases/<sha>, and THAT resolved path is what we cd into.
# An explicit SECONDBRAIN_ROOT stays the highest-priority override (a
# supervised replay against a specific checkout); the legacy
# secondbrain-current path is only the last-resort fallback when the
# controller root cannot be resolved to an existing directory (e.g. local dev).
CONTROLLER_ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
HEALER_ROOT="${SECONDBRAIN_HEALER_ROOT:-/home/ec2-user/secondbrain-current}"
if [ -n "${SECONDBRAIN_ROOT:-}" ]; then
  ROOT="$SECONDBRAIN_ROOT"
elif RESOLVED_CONTROLLER_ROOT="$(readlink -f "$CONTROLLER_ROOT" 2>/dev/null)" \
  && [ -n "$RESOLVED_CONTROLLER_ROOT" ] && [ -d "$RESOLVED_CONTROLLER_ROOT" ]; then
  ROOT="$RESOLVED_CONTROLLER_ROOT"
else
  ROOT="$HEALER_ROOT"
fi
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${SELFHEAL_LOG_DIR:-/opt/secondbrain/logs}"
LOCK="/tmp/secondbrain-self-heal-run.lock"
# Bounded lock wait so the second scheduled pass (3:00 CT) waits out the first
# (2:45 CT) instead of instantly skipping. 45 minutes covers a full first pass
# and still leaves headroom before the 5:30 briefing.
LOCK_WAIT_SECONDS="${SELFHEAL_LOCK_WAIT_SECONDS:-2700}"
SELF_HEAL_LOCK_WAIT_MS="${SELF_HEAL_LOCK_WAIT_MS:-$((LOCK_WAIT_SECONDS * 1000))}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
# Cron has a minimal env: pin HOME so buildClaudeCliEnv's default token path resolves.
HOME="${HOME:-/home/ec2-user}"
TOKEN_PATH="${CLAUDE_OAUTH_TOKEN_PATH:-$HOME/.claude-oauth-token}"
# This durable cloud marker is intentionally shared with the 5:30 runner. Cron
# has no inherited terminal environment, so both wrappers must read the same
# persisted authority decision after restart. An explicit env value is an
# emergency one-run override.
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
    echo "[self-heal-run] WARNING: invalid controller authority '$CONTROLLER_AUTHORITY' in $AUTHORITY_FILE; using the card-controller recovery graph."
    CONTROLLER_AUTHORITY="0"
    ;;
esac

STAMP="$(date -u +%FT%TZ)"
DATE="${BRIEFING_DATE:-$(TZ=America/Chicago date +%F)}"
echo "[self-heal-run] $STAMP root=$ROOT controller_root=$CONTROLLER_ROOT healer_root=$HEALER_ROOT data_dir=$DATA_DIR date=$DATE token_path=$TOKEN_PATH"

# Controller authority changes ownership, not whether the delayed safeguards
# exist. Both paths invoke the same card graph and durable ledger. If the 23:00
# controller is still live, its lease makes this pass an honest no-op; if it
# exited with red work, this pass gets a real chance to continue that work.
if [ "$CONTROLLER_AUTHORITY" = "1" ]; then
  echo "[self-heal-run] card-controller authority enabled; running the lease-protected canonical recovery graph."
fi

# Export the Max-plan OAuth token for the spawned heal workers. buildClaudeCliEnv
# also reads the file directly, but exporting here covers a minimal-cron env and
# keeps the contract explicit. Never echo the token value.
if [ -r "$TOKEN_PATH" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_PATH")"
  export CLAUDE_CODE_OAUTH_TOKEN
  echo "[self-heal-run] Claude OAuth token loaded from $TOKEN_PATH"
else
  echo "[self-heal-run] WARNING: no readable token at $TOKEN_PATH; heal workers may auth-fail."
fi
export HOME

# Build the exact owner-safe recovery command once so dry-run and real spawn
# cannot drift. The controller reserves each card or exact metric cycle in the
# durable ledger before it launches any healer.
CMD=("$NODE_BIN" scripts/card-controller.js --mode overnight --cards all --date "$DATE" --data-dir "$DATA_DIR")

# TEST GATE: never spawn the real orchestrator under test / dry-run.
if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${SELFHEAL_DRY_RUN:-}" = "1" ]; then
  echo "[self-heal-run] DRY-RUN (test mode): would run: (cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR HOME=$HOME SECONDBRAIN_HEALER_ROOT=$HEALER_ROOT SECONDBRAIN_CONTROLLER_ROOT=$CONTROLLER_ROOT ${CMD[*]})"
  exit 0
fi

cd "$ROOT" || { echo "[self-heal-run] cannot cd to $ROOT" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# flock -w: if a self-heal run is already going, WAIT (bounded) for it to
# finish, then run a real second pass. Two scheduled passes = two attempts.
# SECONDBRAIN_HEALER_ROOT/SECONDBRAIN_CONTROLLER_ROOT mirror
# ec2-card-controller-run.sh so the spawned card-controller graph can locate
# the writable healer source (HEALER_ROOT) even while ROOT (this process's
# proven cwd) is the read-only pinned release.
flock -w "$LOCK_WAIT_SECONDS" "$LOCK" env SECONDBRAIN_DATA_DIR="$DATA_DIR" HOME="$HOME" \
  SECONDBRAIN_HEALER_ROOT="$HEALER_ROOT" SECONDBRAIN_CONTROLLER_ROOT="$CONTROLLER_ROOT" \
  SELF_HEAL_LOCK_WAIT_MS="$SELF_HEAL_LOCK_WAIT_MS" "${CMD[@]}"
status=$?

if [ "$status" = "0" ]; then
  echo "[self-heal-run] $(date -u +%FT%TZ) done (exit 0)."
elif [ "$status" = "1" ]; then
  # flock returns 1 when the wait budget expired with the lock still held ->
  # the prior run outlived the whole wait window. Benign but logged.
  echo "[self-heal-run] $(date -u +%FT%TZ) skipped: a prior self-heal run held the lock for the whole ${LOCK_WAIT_SECONDS}s wait window OR the orchestrator reported a fatal; see the run log."
else
  echo "[self-heal-run] $(date -u +%FT%TZ) finished with exit $status; see $LOG_DIR/self-heal-cron.log and the orchestrator run log."
fi
exit 0
