#!/usr/bin/env bash
#
# ec2-morning-report-prep-run.sh -- the one report build.
#
# The report is built once from the night's job log and the final board (S-9,
# 2026-11-11): collect the token cuts, build the report (one model call drafts
# the levers; the final build is peer reviewed), write the morning incident
# report, the dated closure receipt, and the pre-transport audit. There are no
# staged drafts, evidence freezes or finalizer leases. The lock prevents
# overlap; a report that is already finalized with a valid closure is a no-op.
# This runner never refreshes a card, starts a controller, or sends delivery.
set -uo pipefail

CONTROLLER_ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
# Resolve the immutable release once and cd into it before any node command so
# scripts/lib/deploy-window-guard.js can prove the pin from the process cwd.
RESOLVED_ROOT="$(readlink -f "$CONTROLLER_ROOT" 2>/dev/null)"
if [ -z "$RESOLVED_ROOT" ]; then
  RESOLVED_ROOT="$CONTROLLER_ROOT"
fi
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
PREP_LOCK="${BRIEFING_REPORT_PREP_LOCK:-/tmp/secondbrain-morning-report-prep.lock}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
HOME="${HOME:-/home/ec2-user}"
DATE="${BRIEFING_DATE:-$(TZ=America/Chicago date +%F)}"
export SECONDBRAIN_BRIEFING_CODEX_CEILING="gpt-5.6-sol:medium"
REPORT_FILE="$DATA_DIR/briefings/watch-report-$DATE.html"
TERMINAL_STATE_FILE="$DATA_DIR/agent/briefing-terminal-state-$DATE.json"
REPORT_MODE="${BRIEFING_REPORT_MODE:-auto}"
CT_HOUR="${BRIEFING_CT_HOUR:-$(TZ=America/Chicago date +%H)}"
if ! [[ "$CT_HOUR" =~ ^[0-9]{1,2}$ ]] || [ "$CT_HOUR" -gt 23 ]; then
  echo "[morning-report-prep] invalid CT hour: $CT_HOUR" >&2
  exit 2
fi
if [ "$REPORT_MODE" = "auto" ]; then
  if [ "$CT_HOUR" = "4" ] || [ "$CT_HOUR" = "04" ] \
    || [ "$CT_HOUR" = "5" ] || [ "$CT_HOUR" = "05" ]; then
    REPORT_MODE="final"
  else
    echo "[morning-report-prep] auto mode refuses outside the 04:00 and 05:00 CT report windows (hour=$CT_HOUR)" >&2
    exit 2
  fi
fi
if [ "$REPORT_MODE" != "research" ] && [ "$REPORT_MODE" != "draft" ] && [ "$REPORT_MODE" != "evidence-final" ] && [ "$REPORT_MODE" != "final" ]; then
  echo "[morning-report-prep] invalid BRIEFING_REPORT_MODE=$REPORT_MODE" >&2
  exit 2
fi

# Old callers may still ask for a research note or a draft. There are none
# anymore: the single build is the report, so those modes are a no-op.
if [ "$REPORT_MODE" = "research" ] || [ "$REPORT_MODE" = "draft" ]; then
  echo "[morning-report-prep] $(date -u +%FT%TZ) mode=$REPORT_MODE has no staged draft; the single build owns the report."
  exit 0
fi

WATCH_REPORT_CMD=(
  "$NODE_BIN"
  "$RESOLVED_ROOT/scripts/overnight-watch-report.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
)
# The final build is the peer-reviewed one (owner decision). A relaunch with
# under twenty minutes of clock skips the review rather than starting one it
# cannot finish.
if [ "$REPORT_MODE" = "evidence-final" ] || [ "$REPORT_MODE" = "final" ]; then
  if [ -n "${BRIEFING_REPORT_WRITER_TIMEOUT_S:-}" ] && [[ "${BRIEFING_REPORT_WRITER_TIMEOUT_S}" =~ ^[0-9]+$ ]] && [ "$BRIEFING_REPORT_WRITER_TIMEOUT_S" -lt 1200 ]; then
    export BRIEFING_REPORT_PEER_REVIEW="${BRIEFING_REPORT_PEER_REVIEW:-0}"
  else
    export BRIEFING_REPORT_PEER_REVIEW="${BRIEFING_REPORT_PEER_REVIEW:-1}"
  fi
fi
REPORT_CMD=(
  "$NODE_BIN"
  "$RESOLVED_ROOT/scripts/briefing-morning-report.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
)
CLOSURE_CMD=(
  "$NODE_BIN"
  "$RESOLVED_ROOT/scripts/briefing-report-closure.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
)
AUDIT_CMD=(
  "$NODE_BIN"
  "$RESOLVED_ROOT/scripts/briefing-final-delivery-audit.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
  --pre-transport
  --write-receipt
)
TOKEN_CUT_CMD=(
  "$NODE_BIN"
  "$RESOLVED_ROOT/scripts/collect-token-spend-overnight.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
  --allow-elapsed
)
WEEKLY_TOKEN_CMD=(
  "$NODE_BIN"
  "$RESOLVED_ROOT/scripts/collect-token-spend-weekly.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
)
NIGHTLY_RESIZE_MEASUREMENT_CMD=(
  "$NODE_BIN"
  "$RESOLVED_ROOT/scripts/collect-nightly-resize-measurement.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
)

TEST_MODE=0
if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${BRIEFING_DRY_RUN:-}" = "1" ]; then
  TEST_MODE=1
fi

echo "[morning-report-prep] $(date -u +%FT%TZ) report build date=$DATE mode=$REPORT_MODE data_dir=$DATA_DIR root=$RESOLVED_ROOT"

if [ -s "$TERMINAL_STATE_FILE" ] && "$NODE_BIN" -e '
  const fs = require("node:fs");
  const row = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.exit(["frozen", "delivered"].includes(row.state) ? 0 : 1);
' "$TERMINAL_STATE_FILE"; then
  echo "[morning-report-prep] $(date -u +%FT%TZ) skipped: the report bytes are already frozen or delivered."
  exit 0
fi

if [ "$TEST_MODE" != "1" ]; then
  exec 8>"$PREP_LOCK"
  if ! flock -n 8; then
    echo "[morning-report-prep] $(date -u +%FT%TZ) skipped: another report-prep process owns the lock."
    exit 0
  fi
fi

mkdir -p "$LOG_DIR" 2>/dev/null || true
export HOME SECONDBRAIN_DATA_DIR="$DATA_DIR"
export SB_AUTOMATED_AGENT=1 SB_GRAPHITI_WORK_PRODUCT=overnight-report-recommendations

MORNING_REPORT_FILE="$DATA_DIR/agent/briefing-overnight-watch/$DATE-morning-report.html"
if [ -f "$REPORT_FILE" ] \
  && grep -q 'name="watch-report-finalized" content="true"' "$REPORT_FILE" \
  && grep -q 'name="watch-report-analysis" content="llm"' "$REPORT_FILE" \
  && [ -f "$MORNING_REPORT_FILE" ]; then
  if "${CLOSURE_CMD[@]}" --verify >/dev/null 2>&1; then
    echo "[morning-report-prep] $(date -u +%FT%TZ) skipped: same-date strategic report and dated closure receipt are already finalized."
    exit 0
  fi
  echo "[morning-report-prep] $(date -u +%FT%TZ) finalized report lacks a valid dated closure receipt; reconciling."
fi

if [ "$TEST_MODE" = "1" ]; then
  echo "[morning-report-prep] DRY-RUN: would build the report with: ${WATCH_REPORT_CMD[*]} --final"
  echo "[morning-report-prep] DRY-RUN: would write the morning incident report with: ${REPORT_CMD[*]}"
  echo "[morning-report-prep] DRY-RUN: would write dated strategic-report closure with: ${CLOSURE_CMD[*]} --write --phase prep"
  echo "[morning-report-prep] DRY-RUN: would write the hash-bound pre-transport audit with: ${AUDIT_CMD[*]}"
  exit 0
fi

cd "$RESOLVED_ROOT" || {
  echo "[morning-report-prep] $(date -u +%FT%TZ) cannot cd to $RESOLVED_ROOT" >&2
  exit 1
}

# Capture the truthful 11 PM-through-settlement token window before the report
# is built. A collector failure is represented honestly in the report and
# never delays delivery.
timeout --foreground --kill-after=3s 45s "${TOKEN_CUT_CMD[@]}" || \
  echo "[morning-report-prep] $(date -u +%FT%TZ) elapsed token collector unavailable; report will preserve the explicit unavailable status." >&2
timeout --foreground --kill-after=3s 45s "${WEEKLY_TOKEN_CMD[@]}" || \
  echo "[morning-report-prep] weekly token collector unavailable; report will show missing evidence." >&2
timeout --foreground --kill-after=3s 30s "${NIGHTLY_RESIZE_MEASUREMENT_CMD[@]}" || \
  echo "[morning-report-prep] nightly resize measurement unavailable; no synthetic night record will be written." >&2

# One build. Synthesis permits one validator-directed retry and the final pass
# adds one peer review and one revision. --foreground keeps node in this
# shell's process group so a killed shell never orphans the build.
if [ -n "${BRIEFING_REPORT_WRITER_TIMEOUT_S:-}" ] && [[ "${BRIEFING_REPORT_WRITER_TIMEOUT_S}" =~ ^[0-9]+$ ]]; then
  WATCH_REPORT_TIMEOUT_S="$BRIEFING_REPORT_WRITER_TIMEOUT_S"
else
  WATCH_REPORT_TIMEOUT_S=3300
fi
# The writer plans its peer review and revision inside this limit, so it is told
# the moment the limit ends (epoch milliseconds). A supervisor relaunch ends at
# 05:05 CT, ahead of the 05:15 clock the writer would otherwise plan against.
export BRIEFING_REPORT_WRITER_DEADLINE_MS="$(( ($(date +%s) + 10#${WATCH_REPORT_TIMEOUT_S}) * 1000 ))"
timeout --foreground --kill-after=5s "${WATCH_REPORT_TIMEOUT_S}s" "${WATCH_REPORT_CMD[@]}" --final
status=$?
if [ "$status" -ne 0 ]; then
  echo "[morning-report-prep] $(date -u +%FT%TZ) report build failed: exit $status; the next pre-delivery retry remains eligible." >&2
  exit "$status"
fi

# The internal incident report is deterministic and model-free. A write
# failure is logged and the closure then reports the gap honestly.
"${REPORT_CMD[@]}" || \
  echo "[morning-report-prep] $(date -u +%FT%TZ) morning incident report write failed; the closure receipt will record the gap." >&2

"${CLOSURE_CMD[@]}" --write --phase prep
status=$?
if [ "$status" -ne 0 ]; then
  echo "[morning-report-prep] $(date -u +%FT%TZ) dated report-closure receipt failed: exit $status; delivery remains blocked on explicit report proof." >&2
  exit "$status"
fi

"${AUDIT_CMD[@]}"
status=$?
if [ "$status" -ne 0 ]; then
  echo "[morning-report-prep] $(date -u +%FT%TZ) pre-transport report audit failed: exit $status; delivery remains blocked until the 5:30 notifier re-audits valid bytes." >&2
  exit "$status"
fi

echo "[morning-report-prep] $(date -u +%FT%TZ) report built; dated closure and audit receipts verified."
exit 0
