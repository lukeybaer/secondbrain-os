#!/usr/bin/env bash
#
# ec2-morning-report-prep-run.sh -- independent strategic research drafting
# before the terminal coordinator freezes current evidence and finalizes.
#
# The overnight controller owns card production through terminal settlement.
# This runner owns only report synthesis/reconciliation. It never refreshes a
# card, starts a controller, or sends delivery. Scheduled 2:00, 4:00, and 5:00
# ticks produce or evidence-hash reuse replaceable model-backed research drafts.
# Only the coordinator's explicit evidence-final mode freezes current evidence
# after repair admission closes. The lock prevents overlap and frozen bytes make
# later ticks no-ops.
set -uo pipefail

CONTROLLER_ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
# 2026-09-02: this runner never cd'd anywhere (cron cwd is /home/ec2-user) and
# ran every command through the /opt/secondbrain SYMLINK path string, so
# scripts/lib/deploy-window-guard.js could never prove a pin for it (the
# guard proves a pin from a PROCESS's kernel-resolved cwd, not an argv path).
# Resolve the immutable release once, the same way
# scripts/ec2-card-controller-run.sh proves its own pin, cd into it before any
# node command, and build every script path from the resolved root.
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
REPORT_EVIDENCE_FILE="$DATA_DIR/agent/briefing-overnight-watch/$DATE-report-evidence-freeze.json"
REPORT_MODE="${BRIEFING_REPORT_MODE:-auto}"
CT_HOUR="${BRIEFING_CT_HOUR:-$(TZ=America/Chicago date +%H)}"
if ! [[ "$CT_HOUR" =~ ^[0-9]{1,2}$ ]] || [ "$CT_HOUR" -gt 23 ]; then
  echo "[morning-report-prep] invalid CT hour: $CT_HOUR" >&2
  exit 2
fi
if [ "$REPORT_MODE" = "auto" ]; then
  if [ "$CT_HOUR" = "2" ] || [ "$CT_HOUR" = "02" ] \
    || [ "$CT_HOUR" = "4" ] || [ "$CT_HOUR" = "04" ] \
    || [ "$CT_HOUR" = "5" ] || [ "$CT_HOUR" = "05" ]; then
    REPORT_MODE="research"
  else
    echo "[morning-report-prep] auto mode refuses outside the 02:00, 04:00, and 05:00 CT report windows (hour=$CT_HOUR)" >&2
    exit 2
  fi
fi
if [ "$REPORT_MODE" != "research" ] && [ "$REPORT_MODE" != "draft" ] && [ "$REPORT_MODE" != "evidence-final" ] && [ "$REPORT_MODE" != "final" ]; then
  echo "[morning-report-prep] invalid BRIEFING_REPORT_MODE=$REPORT_MODE" >&2
  exit 2
fi

WATCH_REPORT_CMD=(
  "$NODE_BIN"
  "$RESOLVED_ROOT/scripts/overnight-watch-report.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
)
if [ "$REPORT_MODE" = "research" ] || [ "$REPORT_MODE" = "draft" ]; then
  # Old cron or callers cannot recreate repeated report drafts. Research
  # captures source-backed notes; only the dated owner starts synthesis.
  if [ "${NODE_ENV:-}" = "test" ] || [ "${VITEST:-}" = "true" ] || [ "${BRIEFING_DRY_RUN:-}" = "1" ]; then
    echo "[morning-report-prep] DRY-RUN: would collect report research with: ${WATCH_REPORT_CMD[*]} --collect-report-notes"
    exit 0
  fi
  cd "$RESOLVED_ROOT"
  exec "${WATCH_REPORT_CMD[@]}" --collect-report-notes
elif [ "$REPORT_MODE" = "evidence-final" ]; then
  WATCH_REPORT_CMD+=(--scheduled-evidence-freeze-final)
  # The final pass is the peer-reviewed one (ExampleCo, 2026-09-07). A relaunch
  # with under twenty minutes of clock skips the review rather than starting
  # one it cannot finish.
  if [ -n "${BRIEFING_REPORT_WRITER_TIMEOUT_S:-}" ] && [[ "${BRIEFING_REPORT_WRITER_TIMEOUT_S}" =~ ^[0-9]+$ ]] && [ "$BRIEFING_REPORT_WRITER_TIMEOUT_S" -lt 1200 ]; then
    export BRIEFING_REPORT_PEER_REVIEW="${BRIEFING_REPORT_PEER_REVIEW:-0}"
  else
    export BRIEFING_REPORT_PEER_REVIEW="${BRIEFING_REPORT_PEER_REVIEW:-1}"
  fi
else
  WATCH_REPORT_CMD+=(--scheduled-cutoff-final)
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
FREEZE_CMD=(
  "$NODE_BIN"
  "$RESOLVED_ROOT/scripts/briefing-repair-freeze.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
)
REPORT_EVIDENCE_FREEZE_CMD=(
  "$NODE_BIN"
  "$RESOLVED_ROOT/scripts/overnight-watch-report.js"
  --date "$DATE"
  --data-dir "$DATA_DIR"
  --freeze-report-evidence
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

echo "[morning-report-prep] $(date -u +%FT%TZ) report-only checkpoint date=$DATE mode=$REPORT_MODE data_dir=$DATA_DIR root=$RESOLVED_ROOT"

if [ -s "$TERMINAL_STATE_FILE" ] && "$NODE_BIN" -e '
  const fs = require("node:fs");
  const [file, mode] = process.argv.slice(1);
  const row = JSON.parse(fs.readFileSync(file, "utf8"));
  process.exit(["frozen", "delivered"].includes(row.state) || (row.state === "settling" && mode === "draft") ? 0 : 1);
' "$TERMINAL_STATE_FILE" "$REPORT_MODE"; then
  echo "[morning-report-prep] $(date -u +%FT%TZ) skipped: terminal settlement owns report finalization or bytes are already frozen."
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
  && { [ "$REPORT_MODE" = "draft" ] || grep -q 'name="watch-report-state-package-sha256"' "$REPORT_FILE"; } \
  && { [ "$REPORT_MODE" != "final" ] || [ -f "$MORNING_REPORT_FILE" ]; }; then
  if "${CLOSURE_CMD[@]}" --verify >/dev/null 2>&1; then
    echo "[morning-report-prep] $(date -u +%FT%TZ) skipped: same-date strategic report and dated closure receipt are already finalized."
    exit 0
  fi
  echo "[morning-report-prep] $(date -u +%FT%TZ) finalized report lacks a valid dated closure receipt; reconciling the same report owner."
fi

if [ "$TEST_MODE" = "1" ]; then
  echo "[morning-report-prep] DRY-RUN: would stage finalized watch report with: ${WATCH_REPORT_CMD[*]}"
  if [ "$REPORT_MODE" = "draft" ]; then
    echo "[morning-report-prep] DRY-RUN: draft mode stops after the model-backed report draft."
    exit 0
  fi
  if [ "$REPORT_MODE" = "evidence-final" ]; then
    echo "[morning-report-prep] DRY-RUN: would freeze the terminal report evidence package with: ${REPORT_EVIDENCE_FREEZE_CMD[*]}"
    echo "[morning-report-prep] DRY-RUN: would write dated strategic-report closure with: ${CLOSURE_CMD[*]} --write --phase prep"
    exit 0
  fi
  echo "[morning-report-prep] DRY-RUN: would bind the terminal settlement board with: ${FREEZE_CMD[*]}"
  echo "[morning-report-prep] DRY-RUN: would reconcile morning report with: ${REPORT_CMD[*]}"
  echo "[morning-report-prep] DRY-RUN: would write dated report closure with: ${CLOSURE_CMD[*]} --write --phase prep"
  echo "[morning-report-prep] DRY-RUN: would write the hash-bound pre-transport audit with: ${AUDIT_CMD[*]}"
  exit 0
fi

# Prove the same pin scripts/lib/deploy-window-guard.js checks: cd into the
# resolved immutable release before any node command runs.
cd "$RESOLVED_ROOT" || {
  echo "[morning-report-prep] $(date -u +%FT%TZ) cannot cd to $RESOLVED_ROOT" >&2
  exit 1
}

if [ "$REPORT_MODE" = "evidence-final" ]; then
  # Capture the truthful 11 PM-through-settlement token window before the
  # immutable evidence package and report are built. A collector failure is
  # represented honestly in the report and never delays terminal delivery.
  timeout --foreground --kill-after=3s 45s "${TOKEN_CUT_CMD[@]}" || \
    echo "[morning-report-prep] $(date -u +%FT%TZ) elapsed token collector unavailable; report will preserve the explicit unavailable status." >&2
  timeout --foreground --kill-after=3s 45s "${WEEKLY_TOKEN_CMD[@]}" || \
    echo "[morning-report-prep] weekly token collector unavailable; report will show missing evidence." >&2
  timeout --foreground --kill-after=3s 30s "${NIGHTLY_RESIZE_MEASUREMENT_CMD[@]}" || \
    echo "[morning-report-prep] nightly resize measurement unavailable; no synthetic night record will be written." >&2
  "${REPORT_EVIDENCE_FREEZE_CMD[@]}"
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "[morning-report-prep] $(date -u +%FT%TZ) report evidence freeze failed: exit $status; strategic finalization refuses mutable inputs." >&2
    exit "$status"
  fi
fi

if [ "$REPORT_MODE" = "final" ] && [ ! -s "$REPORT_EVIDENCE_FILE" ]; then
  echo "[morning-report-prep] $(date -u +%FT%TZ) final reconciliation refused: same-date report evidence package is missing." >&2
  exit 1
fi

# Final report bytes must reconcile a single frozen board. The controller owns
# the matching no-new-repair cutoff; this receipt makes that boundary visible
# to both the cloud supervisor and attended watcher.
if [ "$REPORT_MODE" = "final" ]; then
  "${FREEZE_CMD[@]}"
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "[morning-report-prep] $(date -u +%FT%TZ) repair-freeze proof failed: exit $status; finalization refuses an unbound board." >&2
    exit "$status"
  fi
fi

# Strategic synthesis permits one validator-directed retry, and each attempt
# may use the full 10-minute subscription rung. The evidence-final pass adds
# one Codex peer review and one revision, so it owns up to 55 minutes of the
# 4:30 to 5:30 hour. --foreground keeps node in this shell's process group:
# on 2026-09-06 and 09-07 the coordinator killed this shell but the detached
# node child survived, so the closure below never ran (orphan mechanism).
if [ -n "${BRIEFING_REPORT_WRITER_TIMEOUT_S:-}" ] && [[ "${BRIEFING_REPORT_WRITER_TIMEOUT_S}" =~ ^[0-9]+$ ]]; then
  WATCH_REPORT_TIMEOUT_S="$BRIEFING_REPORT_WRITER_TIMEOUT_S"
elif [ "$REPORT_MODE" = "evidence-final" ]; then
  WATCH_REPORT_TIMEOUT_S=3300
else
  WATCH_REPORT_TIMEOUT_S=1260
fi
timeout --foreground --kill-after=5s "${WATCH_REPORT_TIMEOUT_S}s" "${WATCH_REPORT_CMD[@]}"
status=$?
if [ "$status" -ne 0 ]; then
  echo "[morning-report-prep] $(date -u +%FT%TZ) watch-report staging failed: exit $status; the next pre-delivery retry remains eligible." >&2
  exit "$status"
fi

if [ "$REPORT_MODE" = "draft" ]; then
  echo "[morning-report-prep] $(date -u +%FT%TZ) model-backed research draft staged; terminal finalization remains owned by the coordinator."
  exit 0
fi

if [ "$REPORT_MODE" = "evidence-final" ]; then
  "${CLOSURE_CMD[@]}" --write --phase prep
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "[morning-report-prep] $(date -u +%FT%TZ) strategic report closure failed: exit $status." >&2
    exit "$status"
  fi
  echo "[morning-report-prep] $(date -u +%FT%TZ) strategic report finalized from the terminal same-date evidence package."
  exit 0
fi

"${REPORT_CMD[@]}"
status=$?
if [ "$status" -ne 0 ]; then
  echo "[morning-report-prep] $(date -u +%FT%TZ) morning-report reconciliation failed: exit $status." >&2
  exit "$status"
fi

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

echo "[morning-report-prep] $(date -u +%FT%TZ) reports staged for the 5:30 delivery checkpoint; dated closure and audit receipts verified."
exit 0
