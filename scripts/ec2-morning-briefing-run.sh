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
set -uo pipefail

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
LOCK="/tmp/secondbrain-morning-briefing-run.lock"
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

# TEST GATE: never spawn the real briefing under test / dry-run.
if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${BRIEFING_DRY_RUN:-}" = "1" ]; then
  echo "[morning-briefing-run] DRY-RUN (test mode): would run: (cd $ROOT && SECONDBRAIN_DATA_DIR=$DATA_DIR HOME=$HOME ${CMD[*]})"
  exit 0
fi

cd "$ROOT" || { echo "[morning-briefing-run] cannot cd to $ROOT" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# flock -n: if a briefing run is already going, this run is a clean no-op.
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
