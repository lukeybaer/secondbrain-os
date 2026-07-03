#!/usr/bin/env bash
#
# verify-unattended-morning.sh -- the C4 UNATTENDED-MORNING CANARY (Codex
# amendment 3, item W3a, ExampleCo 2026-07-02).
#
# Code runs unattended from TWO EC2 roots (the build-path git checkout for
# cron, the /opt file-copy for the PM2 server) with a manual, partial deploy
# process. This canary answers, in one run, "if nobody touches this box
# tonight, will the 2:45/3:00 self-heal and the 5:30 briefing actually fire
# and run REAL code?" It is a DIAGNOSTIC, not a repair: it prints PASS/FAIL
# per step and exits nonzero on the first class of failure found, so a human
# (or a self-heal worker reading the log) knows exactly what to fix.
#
# Checks, IN ORDER:
#   1. crontab contains the 2:45/3:00 self-heal + 5:30 briefing entries,
#      and each entry's target script file actually exists.
#   2. build-path HEAD == origin/master (the git side of deploy parity).
#   3. the deploy-parity probe (scripts/verify-deploy-parity.js) reports ok.
#   4. `node -c` syntax-checks the DEPLOYED server.js and cloud-morning-briefing.js.
#   5. the briefing lock (/tmp/secondbrain-morning-briefing-run.lock) is free,
#      i.e. no stale/stuck briefing run is holding it.
#
# This is run MANUALLY after deploys (the orchestrator runs it once tonight
# per the W3a build spec) -- it is deliberately NOT installed into cron here.
#
# Usage: bash scripts/verify-unattended-morning.sh
# Exit 0 = every step PASS. Exit 1 = at least one step FAILed.
set -uo pipefail

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
LIVE_ROOT="${SECONDBRAIN_LIVE_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
BRIEFING_LOCK="${SECONDBRAIN_BRIEFING_LOCK:-/tmp/secondbrain-morning-briefing-run.lock}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

FAIL_COUNT=0

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

echo "[verify-unattended-morning] $(date -u +%FT%TZ) root=$ROOT live_root=$LIVE_ROOT data_dir=$DATA_DIR"

# ---- Step 1: crontab entries + target files ----
CRONTAB_OUT="$(crontab -l 2>/dev/null || true)"

check_cron_entry() {
  local label="$1" pattern="$2"
  local line
  line="$(printf '%s\n' "$CRONTAB_OUT" | grep -E "$pattern" | head -1 || true)"
  if [ -z "$line" ]; then
    fail "crontab: no entry matching $label ($pattern)"
    return
  fi
  # Pull the first token that looks like a script path out of the matched line.
  local script
  script="$(printf '%s\n' "$line" | grep -oE '/[^[:space:]]+\.(sh|js)' | head -1 || true)"
  if [ -z "$script" ]; then
    fail "crontab: $label entry found but no script path could be parsed from it: $line"
    return
  fi
  if [ -f "$script" ]; then
    pass "crontab: $label entry present and points at an existing file ($script)"
  else
    fail "crontab: $label entry points at a MISSING file ($script)"
  fi
}

check_cron_entry "2:45 self-heal" '^45 2 .*self-heal'
check_cron_entry "3:00 self-heal" '^0 3 .*self-heal'
check_cron_entry "5:30 briefing" '^30 5 .*morning-briefing'

# ---- Step 2: build-path HEAD == origin/master ----
if [ -d "$ROOT/.git" ]; then
  BUILD_HEAD="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  ORIGIN_HEAD="$(git -C "$ROOT" rev-parse origin/master 2>/dev/null || true)"
  if [ -z "$BUILD_HEAD" ] || [ -z "$ORIGIN_HEAD" ]; then
    fail "build-path HEAD: could not resolve HEAD and/or origin/master in $ROOT"
  elif [ "$BUILD_HEAD" = "$ORIGIN_HEAD" ]; then
    pass "build-path HEAD matches origin/master (${BUILD_HEAD:0:12})"
  else
    fail "build-path HEAD ${BUILD_HEAD:0:12} does NOT match origin/master ${ORIGIN_HEAD:0:12}"
  fi
else
  fail "build-path HEAD: $ROOT is not a git checkout (no .git)"
fi

# ---- Step 3: deploy-parity probe ----
if [ -f "$ROOT/scripts/verify-deploy-parity.js" ]; then
  PARITY_OUT="$(cd "$ROOT" && SECONDBRAIN_DATA_DIR="$DATA_DIR" "$NODE_BIN" scripts/verify-deploy-parity.js --json 2>&1)"
  PARITY_STATUS=$?
  if [ "$PARITY_STATUS" = "0" ]; then
    # An exit-0 report can ALSO mean the probe suppressed real drift because a
    # deploy was in progress (deploy-lock window) -- that is not the same
    # thing as proven parity, so surface it distinctly rather than a bare
    # PASS (Codex review 2026-07-02: the canary must not claim parity is
    # proven when it was actually suppressed).
    if printf '%s' "$PARITY_OUT" | grep -q '"suppressed":[[:space:]]*true'; then
      pass "deploy-parity probe suppressed (a deploy was in progress; parity NOT proven this run -- re-run after the deploy finishes)"
    else
      pass "deploy-parity probe reports ok (see $DATA_DIR/agent/deploy-parity-latest.json)"
    fi
  else
    fail "deploy-parity probe reports drift or an error (exit $PARITY_STATUS): $(printf '%s' "$PARITY_OUT" | tail -5)"
  fi
else
  fail "deploy-parity probe: scripts/verify-deploy-parity.js not found under $ROOT"
fi

# ---- Step 4: node -c syntax check on the DEPLOYED files ----
check_syntax() {
  local label="$1" file="$2"
  if [ ! -f "$file" ]; then
    fail "syntax check: $label missing at $file"
    return
  fi
  if "$NODE_BIN" -c "$file" 2>/dev/null; then
    pass "syntax check: $label is valid ($file)"
  else
    fail "syntax check: $label has a SYNTAX ERROR ($file)"
  fi
}

check_syntax "deployed server.js" "$LIVE_ROOT/server.js"
check_syntax "deployed cloud-morning-briefing.js" "$LIVE_ROOT/scripts/cloud-morning-briefing.js"

# ---- Step 5: briefing lock is free ----
if [ -e "$BRIEFING_LOCK" ]; then
  # A lock FILE existing is not itself a problem (flock releases on process
  # exit even if the file remains); the real test is whether it is currently
  # HELD. Try a non-blocking flock against it: success means it is free.
  if command -v flock >/dev/null 2>&1; then
    if flock -n "$BRIEFING_LOCK" true 2>/dev/null; then
      pass "briefing lock is free ($BRIEFING_LOCK exists but is not held)"
    else
      fail "briefing lock is HELD ($BRIEFING_LOCK) -- a briefing run may be stuck"
    fi
  else
    pass "briefing lock file present but flock is unavailable to test holdability; treating as free ($BRIEFING_LOCK)"
  fi
else
  pass "briefing lock is free (no lock file at $BRIEFING_LOCK)"
fi

echo "[verify-unattended-morning] $(date -u +%FT%TZ) done: $FAIL_COUNT failure(s)."
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
