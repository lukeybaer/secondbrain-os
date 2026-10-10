#!/usr/bin/env bash
#
# verify-unattended-morning.sh -- the C4 UNATTENDED-MORNING CANARY (Codex
# amendment 3, item W3a, ExampleCo 2026-07-02).
#
# Code runs unattended from TWO EC2 roots (the build-path git checkout for
# cron, the /opt file-copy for the PM2 server) with a manual, partial deploy
# process. This canary answers, in one run, "if nobody touches this box
# tonight, will the 2:45/3:00 self-heal, 2:00/2:25 early draft, 4:00 convergence draft,
# 5:00 finalization, 5:20/5:26/5:29 coordinator recovery, and 5:31 proof audit actually fire
# and run REAL code?" It is a DIAGNOSTIC, not a repair: it prints PASS/FAIL
# per step and exits nonzero on the first class of failure found, so a human
# (or a self-heal worker reading the log) knows exactly what to fix.
#
# Checks, IN ORDER:
#   1. crontab contains the 2:45/3:00 self-heal, 2:00/2:25 early report draft,
#      4:00 convergence draft, 5:00 report finalization, 5:20/5:26/5:29 coordinator recovery,
#      and the 5:31 read-only delivery audit entry,
#      and each entry's target script file actually exists.
#   2. build-path HEAD == origin/master (the git side of deploy parity).
#   3. the deploy-parity probe (scripts/verify-deploy-parity.js) reports ok.
#   4. `node -c` syntax-checks the DEPLOYED server.js and cloud-morning-briefing.js.
#   5. the require-scan gate (scripts/require-scan-check.js) statically resolves
#      the DEPLOYED server.js's relative-require closure under the live root --
#      catches an incomplete deploy (a require added without shipping the file)
#      overnight instead of as a morning PM2 crash. 2026-07-06 deploy-outage fix.
#   6. the briefing lock (/tmp/secondbrain-morning-briefing-run.lock) is free,
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

# ---- Step 1: one installed night owner, otherwise legacy cron ----
# A real systemd owner must be enabled AND active, and it must have written a
# syntactically valid dated terminal state.  Enabled alone is not a run path.
NIGHT_OWNER_PRESENT=0
OWNER_LOAD_STATE=not-found
if command -v systemctl >/dev/null 2>&1; then
  if ! OWNER_LOAD_STATE="$(systemctl show amy-night-run.timer --property=LoadState --value 2>/dev/null)"; then
    fail "cannot inspect amy night owner unit installation"
    OWNER_LOAD_STATE=unknown
  fi
fi
if [ "$OWNER_LOAD_STATE" != not-found ]; then
  NIGHT_OWNER_PRESENT=1
  if [ "$OWNER_LOAD_STATE" != loaded ]; then fail "amy night owner unit is not loaded ($OWNER_LOAD_STATE)"; fi
  if systemctl is-enabled --quiet amy-night-run.timer 2>/dev/null && systemctl is-active --quiet amy-night-run.timer 2>/dev/null; then
    pass "amy night owner timer is enabled and active"
  else
    fail "amy night owner timer is disabled or inactive"
  fi
  # The launcher accepts manual preparation from 22:00, but the installed
  # timer starts at 23:00. Until then today's terminal receipt owns proof.
  NIGHT_DATE="$("$NODE_BIN" -e 'const m=require(process.argv[1]),ct=m.ctDateAndHour(Date.now());process.stdout.write(ct.hour>=23?m.addDays(ct.date,1):ct.date)' "$ROOT/scripts/lib/briefing-night-date.js")"
  if [[ ! "$NIGHT_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then fail "cannot resolve installed night date"; fi
  NIGHT_STATE="$DATA_DIR/agent/briefing-terminal-state-$NIGHT_DATE.json"
  if [ -f "$NIGHT_STATE" ] && [ -f "$ROOT/scripts/lib/briefing-terminal-state.js" ] \
    && "$NODE_BIN" -e 'const m=require(process.argv[1]);const [dataDir,date]=process.argv.slice(2);process.exit(m.inspectTerminalState({dataDir,date}).status === "valid" ? 0 : 1)' "$ROOT/scripts/lib/briefing-terminal-state.js" "$DATA_DIR" "$NIGHT_DATE"; then
    pass "amy night owner dated state is valid ($NIGHT_STATE)"
    if ! "$NODE_BIN" -e 'const m=require(process.argv[1]);const [dataDir,date]=process.argv.slice(2);process.exit(m.inspectTerminalState({dataDir,date}).receipt?.state === "delivered" ? 0 : 1)' "$ROOT/scripts/lib/briefing-terminal-state.js" "$DATA_DIR" "$NIGHT_DATE"; then
      if systemctl is-active --quiet amy-night-run.service 2>/dev/null; then
        pass "unfinished night has an active owner service"
      else
        fail "unfinished night has no active owner service"
      fi
    fi
  else
    fail "amy night owner dated state is missing or invalid ($NIGHT_STATE)"
  fi
  for legacy_timer in amy-briefing-control.timer secondbrain-storage-pressure-maintenance.timer; do
    if systemctl is-enabled --quiet "$legacy_timer" 2>/dev/null || systemctl is-active --quiet "$legacy_timer" 2>/dev/null; then
      fail "legacy timer remains enabled or active ($legacy_timer)"
    fi
  done
  if "$NODE_BIN" "$ROOT/scripts/lib/night-owner-cutover.js" --active; then
    pass "amy night owner has no active legacy process competitor"
  else
    fail "legacy process inspection failed or an active competitor remains"
  fi
  SCHEDULE_TEXT="$(LC_ALL=C crontab -l 2>&1)"; CRON_STATUS=$?
  if [ "$CRON_STATUS" != 0 ]; then
    if [[ "$SCHEDULE_TEXT" != "no crontab for "* ]]; then fail "cannot inspect user crontab"; fi
    SCHEDULE_TEXT=""
  fi
  if sudo -n true 2>/dev/null; then
    ROOT_CRON="$(sudo -n env LC_ALL=C crontab -l 2>&1)"; CRON_STATUS=$?
    if [ "$CRON_STATUS" != 0 ]; then
      if [[ "$ROOT_CRON" != "no crontab for "* ]]; then fail "cannot inspect root crontab"; fi
      ROOT_CRON=""
    fi
    SCHEDULE_TEXT+=$'\n'"$ROOT_CRON"
    shopt -s nullglob
    SYSTEM_CRON_FILES=()
    for cron_file in /etc/crontab /etc/cron.d/*; do
      if [ -f "$cron_file" ]; then SYSTEM_CRON_FILES+=("$cron_file"); fi
    done
    if [ "${#SYSTEM_CRON_FILES[@]}" -gt 0 ]; then
      if SYSTEM_CRON="$(sudo -n cat "${SYSTEM_CRON_FILES[@]}")"; then
        SCHEDULE_TEXT+=$'\n'"$SYSTEM_CRON"
      else fail "cannot inspect system cron files"; fi
    fi
  else
    fail "cannot inspect root/system schedules without noninteractive sudo"
  fi
  if printf '%s\n' "$SCHEDULE_TEXT" | "$NODE_BIN" "$ROOT/scripts/lib/night-owner-cutover.js"; then
    pass "amy night owner has no scheduled legacy competitor"
  else
    fail "amy night owner has a scheduled legacy competitor"
  fi
fi

if [ "$NIGHT_OWNER_PRESENT" = "0" ]; then
CRONTAB_OUT="$(crontab -l 2>/dev/null || true)"

# RESOLVED_CRON_SCRIPT is set as a side effect of the LAST check_cron_entry
# call, so a caller can capture it immediately after a specific call (see the
# watchdog entry below) -- Codex review 2026-09-01 round 3: step 1b's --probe
# fallback originally hardcoded $ROOT/scripts/briefing-delivery-watchdog.js
# as the probe target, which is only a guess at what cron actually invokes.
# If the installed crontab line points at a stale or different file, probing
# the guessed path could report a healthy COMPLETE while the REAL cron route
# is broken. Probing the exact path this step already extracted from the
# live crontab line closes that gap.
RESOLVED_CRON_SCRIPT=""
check_cron_entry() {
  local label="$1" pattern="$2"
  RESOLVED_CRON_SCRIPT=""
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
  RESOLVED_CRON_SCRIPT="$script"
  if [ -f "$script" ]; then
    pass "crontab: $label entry present and points at an existing file ($script)"
  else
    fail "crontab: $label entry points at a MISSING file ($script)"
  fi
}

check_cron_entry "2:45 self-heal" '^45 2 .*self-heal'
check_cron_entry "3:00 self-heal" '^0 3 .*self-heal'
check_cron_entry "2:00/2:25 early report draft" '^0,25 2 .*morning-report-prep'
check_cron_entry "4:00 report draft" '^0,25 4 .*morning-report-prep'
check_cron_entry "5:00 report finalization" '^0,10 5 .*morning-report-prep'
check_cron_entry "5:20/5:26/5:29 coordinator recovery" '^20,26,29 5 .*SB_WATCHER_RECOVERY_ATTEMPT_ID=deadline-fallback .*ec2-overnight-watcher-run\.sh'
check_cron_entry "5:31 delivery proof audit" '^31 5 .*briefing-delivery-watchdog\.js --probe'
WATCHDOG_CRON_SCRIPT="$RESOLVED_CRON_SCRIPT"
fi

if [ "$NIGHT_OWNER_PRESENT" = "0" ]; then
# ---- Step 1b: delivery watchdog receipt liveness ----
# check_cron_entry above only proves the cron LINE exists; it says nothing
# about whether the watchdog actually RAN. Before 2026-09-01 the installed
# line omitted --date/BRIEFING_DATE, so the watchdog threw "requires a valid
# date" on every single invocation and wrote NO receipt at all -- this canary
# passed for weeks while delivery proof was never actually produced. Assert a
# receipt for today's (or yesterday's, if this canary runs before the CT date
# rolls past midnight) CT date exists and does not carry that failure mode.
WATCHDOG_TODAY_CT="$(TZ=America/Chicago date +%F)"
WATCHDOG_YESTERDAY_CT="$(TZ=America/Chicago date -d 'yesterday' +%F 2>/dev/null || TZ=America/Chicago date -v-1d +%F 2>/dev/null || true)"

# Codex review 2026-09-01 round 4 [critical]: letting the --probe fallback
# below self-heal on ANY day, indefinitely, would let a PERMANENTLY broken
# cron entry pass this gate forever as long as the independent 5:20 delivery
# keeps succeeding -- exactly the "always-green canary" failure class this
# whole feature exists to prevent, just with a longer fuse than the PENDING
# gap round 2 already closed. Bound the fallback to a genuinely verified
# first-deploy window: the build-path commit at $ROOT must be recent (this
# host's clock, no external input). Past that window, a missing cron
# receipt goes straight to a hard FAIL with no fallback at all -- exactly
# how this check behaved before --probe existed.
#
# Round 5 review raised two further, narrower findings, both accepted as
# documented limitations rather than fixed here (both are fail-SAFE, not
# fail-open, and both would require new infrastructure well beyond this
# feature's scope):
#   - Commit CREATION time (git log %ct) is a proxy for DEPLOY time, not a
#     durable deploy receipt. A commit older than the grace window that is
#     deployed for the first time today gets no self-heal and still hard-
#     FAILs pending real cron evidence -- annoying (needs a human to know
#     this is expected), never silently wrong. Closing this for real would
#     mean the deploy pipeline writing its own timestamped deploy receipt,
#     which does not exist yet anywhere in this repo.
#   - The probe below runs the cron-resolved SCRIPT via $NODE_BIN, not by
#     parsing cron's own interpreter invocation out of the crontab line.
#     This matches every other node-invoking step already in this same
#     script (syntax check, deploy-parity probe) -- not a regression this
#     change introduced -- and reconstructing cron's exact invocation is a
#     separate, larger effort.
WATCHDOG_DEPLOY_GRACE_SECONDS="${WATCHDOG_DEPLOY_GRACE_SECONDS:-86400}"
WITHIN_DEPLOY_GRACE_WINDOW=0
if [ -d "$ROOT/.git" ]; then
  WATCHDOG_COMMIT_EPOCH="$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || true)"
  WATCHDOG_NOW_EPOCH="$(date +%s)"
  if [ -n "$WATCHDOG_COMMIT_EPOCH" ] && [ -n "$WATCHDOG_NOW_EPOCH" ]; then
    WATCHDOG_COMMIT_AGE_SECONDS=$((WATCHDOG_NOW_EPOCH - WATCHDOG_COMMIT_EPOCH))
    if [ "$WATCHDOG_COMMIT_AGE_SECONDS" -ge 0 ] \
      && [ "$WATCHDOG_COMMIT_AGE_SECONDS" -le "$WATCHDOG_DEPLOY_GRACE_SECONDS" ]; then
      WITHIN_DEPLOY_GRACE_WINDOW=1
    fi
  fi
fi

WATCHDOG_RECEIPT=""
for d in "$WATCHDOG_TODAY_CT" "$WATCHDOG_YESTERDAY_CT"; do
  [ -n "$d" ] || continue
  candidate="$DATA_DIR/agent/briefing-delivery-watchdog-$d.json"
  if [ -f "$candidate" ]; then
    WATCHDOG_RECEIPT="$candidate"
    break
  fi
done
if [ -n "$WATCHDOG_RECEIPT" ]; then
  # Codex review 2026-09-01 round 3 [high]: the literal 'requires a valid
  # date' string only ever caught ONE specific historical crash message.
  # Generalize to any recorded ERROR state, not just that one string --
  # MISSED/PENDING canonical receipts still pass here deliberately: a real
  # cron receipt in either state still proves the watchdog RAN (this step's
  # stated, narrow purpose -- see the header comment above), even though it
  # does not prove delivery succeeded; that is a separate concern this
  # specific liveness step has never claimed to cover.
  if grep -q 'requires a valid date' "$WATCHDOG_RECEIPT" 2>/dev/null \
    || grep -q '"state": *"ERROR"' "$WATCHDOG_RECEIPT" 2>/dev/null; then
    fail "delivery watchdog receipt: $WATCHDOG_RECEIPT carries an ERROR / 'requires a valid date' failure -- the watchdog ran but crashed before producing a real result"
  else
    pass "delivery watchdog receipt: $WATCHDOG_RECEIPT exists and does not carry the 'requires a valid date' failure"
  fi
elif [ "$WITHIN_DEPLOY_GRACE_WINDOW" = "1" ] && [ -n "$WATCHDOG_CRON_SCRIPT" ] && [ -f "$WATCHDOG_CRON_SCRIPT" ]; then
  # 2026-09-01 deploy proof failure (19:08 CT): the FIRST deploy that ships
  # the assertion above has, by construction, no cron-produced receipt yet --
  # the 5:26/5:31 cron already fired hours earlier (under the OLD code, or
  # not at all since deploy), so this canary FAILed a perfectly healthy
  # watchdog purely because nothing had invoked it since the deploy.
  #
  # Self-heal WITHOUT weakening the canary (Codex review 2026-09-01, four
  # rounds; each round's fix is what makes the current code correct):
  #   Round 1: --probe writes to a SEPARATE
  #   briefing-delivery-watchdog-probe-<date>.json file, so it can never be
  #   mistaken for, or overwrite, real cron-produced evidence, and the
  #   outcome is decided by the probe's PARSED delivery state, not by "a
  #   file exists".
  #   Round 2 [critical]: PENDING only means "not due yet", true on EVERY
  #   pre-deadline run regardless of whether the watchdog can run at all --
  #   accepting it would pass this gate on any early run, any day, forever.
  #   Only COMPLETE -- delivery independently proven via the live marker
  #   file, evidence a broken watchdog cannot fake -- self-heals; PENDING
  #   FAILs exactly like MISSED/ERROR.
  #   Round 2 [high]: reading whatever probe receipt already sat at that
  #   path (without proving THIS invocation wrote it) let a stale COMPLETE
  #   from an earlier run mask a later regression. Delete any existing
  #   probe receipt for today before invoking, so anything found afterward
  #   can only have come from this run.
  #   Round 3 [high]: probing a hardcoded $ROOT path was only a GUESS at
  #   what cron actually invokes -- a stale or different real cron target
  #   could be broken while the guessed path stayed healthy. Probe the
  #   EXACT path check_cron_entry already extracted from the live crontab
  #   line ($WATCHDOG_CRON_SCRIPT) instead.
  #   Round 3 [medium, partially addressed]: validate the resulting
  #   receipt actually names today's date and carries `probe: true`, so a
  #   corrupted or wrong-shaped file cannot be misread as COMPLETE. This
  #   does NOT fully close a true concurrent-invocation race (two canary
  #   runs probing at once) -- that residual risk is accepted here because
  #   this script is a manually/orchestrator-run diagnostic, not a
  #   concurrently-invoked service.
  #   Round 4 [critical]: an unbounded probe-based self-heal would let a
  #   PERMANENTLY broken cron pass this gate forever, on any day, as long
  #   as the independent 5:20 delivery kept succeeding. This branch is now
  #   reachable ONLY inside WITHIN_DEPLOY_GRACE_WINDOW (computed above from
  #   the build-path commit's real age) -- past that window a missing cron
  #   receipt hard-FAILs with no fallback, same as before --probe existed.
  rm -f "$DATA_DIR/agent/briefing-delivery-watchdog-probe-$WATCHDOG_TODAY_CT.json" 2>/dev/null
  "$NODE_BIN" "$WATCHDOG_CRON_SCRIPT" --probe \
    --date "$WATCHDOG_TODAY_CT" --data-dir "$DATA_DIR" >/dev/null 2>&1
  PROBE_RECEIPT="$DATA_DIR/agent/briefing-delivery-watchdog-probe-$WATCHDOG_TODAY_CT.json"
  PROBE_STATE=""
  if [ -f "$PROBE_RECEIPT" ] \
    && grep -q "\"date\": *\"$WATCHDOG_TODAY_CT\"" "$PROBE_RECEIPT" 2>/dev/null \
    && grep -q '"probe": *true' "$PROBE_RECEIPT" 2>/dev/null; then
    PROBE_STATE="$(grep -o '"state": *"[A-Za-z]*"' "$PROBE_RECEIPT" 2>/dev/null | head -1 | sed -E 's/.*"([A-Za-z]+)"$/\1/')"
  fi
  if [ -z "$PROBE_STATE" ]; then
    fail "delivery watchdog receipt: no cron receipt for $WATCHDOG_TODAY_CT or $WATCHDOG_YESTERDAY_CT under $DATA_DIR/agent, and probing the cron-resolved watchdog ($WATCHDOG_CRON_SCRIPT) with --probe produced no usable, well-formed receipt at $PROBE_RECEIPT -- the watchdog code itself may be broken"
  elif [ "$PROBE_STATE" = "COMPLETE" ]; then
    pass "delivery watchdog receipt: no cron receipt yet for $WATCHDOG_TODAY_CT or $WATCHDOG_YESTERDAY_CT (cron may not have fired since deploy) -- a fresh --probe of the cron-resolved watchdog ($WATCHDOG_CRON_SCRIPT) independently confirms delivery is already COMPLETE at $PROBE_RECEIPT"
  else
    fail "delivery watchdog receipt: no cron receipt for $WATCHDOG_TODAY_CT or $WATCHDOG_YESTERDAY_CT, and a fresh --probe of the cron-resolved watchdog reports $PROBE_STATE (only COMPLETE self-heals) at $PROBE_RECEIPT -- this is a real failure, not a day-one false alarm"
  fi
else
  if [ "$WITHIN_DEPLOY_GRACE_WINDOW" != "1" ]; then
    fail "delivery watchdog receipt: no briefing-delivery-watchdog-<date>.json under $DATA_DIR/agent for $WATCHDOG_TODAY_CT or $WATCHDOG_YESTERDAY_CT -- the cron line exists but never produced a receipt, and the build-path commit at $ROOT is outside the ${WATCHDOG_DEPLOY_GRACE_SECONDS}s first-deploy grace window, so no --probe self-heal is attempted"
  else
    fail "delivery watchdog receipt: no briefing-delivery-watchdog-<date>.json under $DATA_DIR/agent for $WATCHDOG_TODAY_CT or $WATCHDOG_YESTERDAY_CT -- the cron line exists but never produced a receipt, and no cron-resolved watchdog script is available to probe"
  fi
fi

fi

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

# ---- Step 5: require-scan gate on the DEPLOYED server.js ----
REQUIRE_SCAN="$LIVE_ROOT/scripts/require-scan-check.js"
if [ -f "$REQUIRE_SCAN" ] && [ -f "$LIVE_ROOT/server.js" ]; then
  REQUIRE_SCAN_OUT="$("$NODE_BIN" "$REQUIRE_SCAN" --root "$LIVE_ROOT" server.js 2>&1)"
  REQUIRE_SCAN_STATUS=$?
  if [ "$REQUIRE_SCAN_STATUS" = "0" ]; then
    pass "require-scan: deployed server.js's require closure resolves cleanly under $LIVE_ROOT"
  else
    fail "require-scan: deployed server.js has an unresolved require under $LIVE_ROOT: $(printf '%s' "$REQUIRE_SCAN_OUT" | tail -5)"
  fi
else
  fail "require-scan: gate script or deployed server.js missing ($REQUIRE_SCAN / $LIVE_ROOT/server.js)"
fi

# ---- Step 6: briefing lock is free ----
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
