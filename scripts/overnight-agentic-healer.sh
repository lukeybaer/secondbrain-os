#!/usr/bin/env bash
#
# overnight-agentic-healer.sh -- WAVE 4 rung 2 of the morning self-heal ladder.
#
# After the mechanical pass (rung 1) and the briefing build have finished, this
# wrapper spawns the AGENTIC HEALER driver (scripts/agentic-healer-driver.js):
# one full dev session (Codex CLI primary, Claude fallback) handed the fresh
# dashboard-qc-result.json defect list with the standing mission to fix the
# defects like an interactive session ExampleCo dispatched: root-cause, code fix in
# an isolated worktree, tests, land via land.js --apply, deploy via
# deploy-ec2-server.sh when EC2-affecting, verify per-card on the live board.
#
# RAILS (enforced in the driver, restated here because this wrapper is the cron
# surface): never runs while the briefing lock is held by an active generation;
# no-repeat-tactics ledger (data/agent/self-heal-tactics.jsonl); hard wall-clock
# budget (default 45 min) with an honest blocked receipt on expiry, never a
# false clear; deploys only through scripts/deploy-ec2-server.sh (no raw copy
# path exists in this file or the driver, and a regression test asserts that).
#
# CLAUDE AUTH: same contract as ec2-morning-briefing-run.sh (HOME +
# CLAUDE_CODE_OAUTH_TOKEN from /home/ec2-user/.claude-oauth-token).
#
# IDEMPOTENT: flock -n on OUR OWN lock makes a second invocation a no-op. The
# briefing lock is never acquired here; the driver only PROBES it (non-blocking)
# and refuses to run when an active generation holds it.
#
# TEST-GATED: under NODE_ENV=test / VITEST / BRIEFING_DRY_RUN=1 it prints the
# command it WOULD run and exits 0 without spawning node.
set -uo pipefail

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
HEALER_LOCK="/tmp/secondbrain-agentic-healer.lock"
BRIEFING_LOCK="${BRIEFING_LOCK_PATH:-/tmp/secondbrain-morning-briefing-run.lock}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
HOME="${HOME:-/home/ec2-user}"
TOKEN_PATH="${CLAUDE_OAUTH_TOKEN_PATH:-$HOME/.claude-oauth-token}"
DATE="${BRIEFING_DATE:-$(TZ=America/Chicago date +%F)}"
BUDGET_MINUTES="${AGENTIC_HEALER_BUDGET_MINUTES:-45}"

STAMP="$(date -u +%FT%TZ)"
echo "[agentic-healer-run] $STAMP root=$ROOT data_dir=$DATA_DIR date=$DATE budget=${BUDGET_MINUTES}m"

if [ -r "$TOKEN_PATH" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_PATH")"
  export CLAUDE_CODE_OAUTH_TOKEN
  echo "[agentic-healer-run] Claude OAuth token loaded from $TOKEN_PATH"
else
  echo "[agentic-healer-run] WARNING: no readable token at $TOKEN_PATH; the Claude fallback rung may be unavailable."
fi
export HOME

# Build the exact command once so the dry-run print and the real spawn cannot drift.
CMD=("$NODE_BIN" scripts/agentic-healer-driver.js --date "$DATE" --budget-minutes "$BUDGET_MINUTES")

if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${BRIEFING_DRY_RUN:-}" = "1" ]; then
  echo "[agentic-healer-run] DRY-RUN (test mode): would run: (cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR HOME=$HOME BRIEFING_LOCK_PATH=$BRIEFING_LOCK ${CMD[*]})"
  exit 0
fi

cd "$ROOT" || { echo "[agentic-healer-run] cannot cd to $ROOT" >&2; exit 1; }
mkdir -p "$LOG_DIR"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

# BACKSTOP timeout: the driver OWNS the 45-minute budget and writes its own
# honest receipt on expiry; this outer cap only exists so a wedged driver can
# never hang the box. Budget + 5 minutes, SIGTERM then SIGKILL the process
# group 30s later.
BACKSTOP_SECONDS=$(( BUDGET_MINUTES * 60 + 300 ))

flock -n "$HEALER_LOCK" timeout --kill-after=30s "${BACKSTOP_SECONDS}s" \
  env SECONDBRAIN_DATA_DIR="$DATA_DIR" HOME="$HOME" BRIEFING_LOCK_PATH="$BRIEFING_LOCK" "${CMD[@]}"
status=$?

if [ "$status" = "0" ]; then
  echo "[agentic-healer-run] $(date -u +%FT%TZ) done (exit 0); receipt appended to $DATA_DIR/agent/overnight-agentic-healer-runs.jsonl"
elif [ "$status" = "1" ]; then
  echo "[agentic-healer-run] $(date -u +%FT%TZ) skipped or crashed (exit 1): another healer run holds the lock, or the driver crashed; see the receipt log."
elif [ "$status" = "124" ] || [ "$status" = "137" ]; then
  echo "[agentic-healer-run] $(date -u +%FT%TZ) BACKSTOP TIMEOUT: the driver exceeded budget+5m and was killed; the last driver-side receipt stands."
else
  echo "[agentic-healer-run] $(date -u +%FT%TZ) finished with exit $status; see $DATA_DIR/agent/overnight-agentic-healer-runs.jsonl"
fi
# The healer never fails its caller: rung 2 is best-effort after the briefing.
exit 0
