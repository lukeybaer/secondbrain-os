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
# It runs scripts/overnight-self-heal-orchestrator.js from the canonical EC2 build
# path in OVERNIGHT mode (NOT --midday, so it keeps its deadline and lands before
# the briefing) against the cloud data store SECONDBRAIN_DATA_DIR=/opt/secondbrain/data.
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
# IDEMPOTENT: `flock -n` makes a second invocation a clean no-op while one run is
# mid-flight (the orchestrator also holds its own internal lock). LOGGED: every run
# prints a dated header.
#
# TEST-GATED: under NODE_ENV=test / VITEST / SELFHEAL_DRY_RUN=1 it prints the command
# it WOULD run and exits 0 WITHOUT spawning node, so a regression test can assert the
# wiring without a real orchestrator run.
set -uo pipefail

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${SELFHEAL_LOG_DIR:-/opt/secondbrain/logs}"
LOCK="/tmp/secondbrain-self-heal-run.lock"
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
    echo "[self-heal-run] WARNING: invalid controller authority '$CONTROLLER_AUTHORITY' in $AUTHORITY_FILE; keeping legacy fan-out available."
    CONTROLLER_AUTHORITY="0"
    ;;
esac

STAMP="$(date -u +%FT%TZ)"
echo "[self-heal-run] $STAMP root=$ROOT data_dir=$DATA_DIR token_path=$TOKEN_PATH"

# Once the card-controller is the explicitly enabled overnight authority, this
# legacy fan-out launcher becomes an attended no-op. The 11 PM controller and
# the 5:30 final pass use the same card graph, ledger, scoped QC, and recovery
# journal; running both systems would reintroduce competing writers.
if [ "$CONTROLLER_AUTHORITY" = "1" ]; then
  echo "[self-heal-run] card-controller authority enabled; legacy fan-out self-heal is intentionally skipped."
  exit 0
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

# Build the exact command once so the dry-run print and the real spawn cannot drift.
# OVERNIGHT mode = no --midday flag (keeps the pre-briefing deadline).
CMD=("$NODE_BIN" scripts/overnight-self-heal-orchestrator.js)

# TEST GATE: never spawn the real orchestrator under test / dry-run.
if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${SELFHEAL_DRY_RUN:-}" = "1" ]; then
  echo "[self-heal-run] DRY-RUN (test mode): would run: (cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR HOME=$HOME ${CMD[*]})"
  exit 0
fi

cd "$ROOT" || { echo "[self-heal-run] cannot cd to $ROOT" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# flock -n: if a self-heal run is already going, this run is a clean no-op.
flock -n "$LOCK" env SECONDBRAIN_DATA_DIR="$DATA_DIR" HOME="$HOME" "${CMD[@]}"
status=$?

if [ "$status" = "0" ]; then
  echo "[self-heal-run] $(date -u +%FT%TZ) done (exit 0)."
elif [ "$status" = "1" ]; then
  # flock returns 1 when the lock is held -> a prior run is still going. Benign.
  echo "[self-heal-run] $(date -u +%FT%TZ) skipped: a self-heal run is already going (lock held) OR the orchestrator reported a fatal; see the run log."
else
  echo "[self-heal-run] $(date -u +%FT%TZ) finished with exit $status; see $LOG_DIR/self-heal-cron.log and the orchestrator run log."
fi
exit 0
