#!/usr/bin/env bash
# Activate or roll back the cloud-only 11 PM CT card-controller run. Every
# mutation is serialized, backed up, assembled off to the side, and validated
# before crontab is replaced.
set -euo pipefail
night_owner_is_installed() {
  [ -f "${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}/agent/amy-night-owner.active" ] && return 0
  command -v systemctl >/dev/null 2>&1 && systemctl is-enabled --quiet amy-night-run.timer
}
if night_owner_is_installed; then
  exec bash "${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}/scripts/install-amy-night-owner.sh" --verify
fi

ROOT="${SECONDBRAIN_ROOT:-/home/ec2-user/secondbrain-current}"
CONTROLLER_ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
RUNNER="$CONTROLLER_ROOT/scripts/ec2-card-controller-run.sh"
COORDINATOR_RECOVERY_RUNNER="$CONTROLLER_ROOT/scripts/ec2-overnight-watcher-run.sh"
REPORT_PREP_RUNNER="$CONTROLLER_ROOT/scripts/ec2-morning-report-prep-run.sh"
DELIVERY_WATCHDOG_RUNNER="$CONTROLLER_ROOT/scripts/briefing-delivery-watchdog.js"
# Rollback executes from the deployed runtime, while the scheduled-task fleet
# keeps its source checkout cwd for the tracked task definitions.
SELF_HEAL_RUNNER="$CONTROLLER_ROOT/scripts/ec2-self-heal-run.sh"
AUTHORITY_FILE="${BRIEFING_CARD_CONTROLLER_AUTHORITY_FILE:-$DATA_DIR/agent/briefing-card-controller-authority}"
FLOCK_BIN="${AMY_CRONTAB_FLOCK_BIN:-/usr/bin/flock}"
CRONTAB_LOCK_FILE="${AMY_CRONTAB_MUTATION_LOCK:-/tmp/amy-crontab-mutation.lock}"
BACKUP_DIR="${AMY_CRONTAB_BACKUP_DIR:-$DATA_DIR/agent/crontab-backups}"
TZLINE="CRON_TZ=America/Chicago"
AWK_BIN="${SB_CRON_AWK_BIN:-awk}"
LINE="0 23 * * * /usr/bin/bash $RUNNER >> $LOG_DIR/card-controller-cron.log 2>&1"
COORDINATOR_RECOVERY_LINE="20,26,29 5 * * * SB_WATCHER_RECOVERY_ATTEMPT_ID=deadline-fallback $COORDINATOR_RECOVERY_RUNNER >> $LOG_DIR/morning-briefing-cron.log 2>&1"
REPORT_EARLY_LINE="0,25 2 * * * $REPORT_PREP_RUNNER >> $LOG_DIR/morning-report-prep-cron.log 2>&1"
REPORT_PREP_LINE="0,25 4 * * * $REPORT_PREP_RUNNER >> $LOG_DIR/morning-report-prep-cron.log 2>&1"
REPORT_FINAL_LINE="0,10 5 * * * $REPORT_PREP_RUNNER >> $LOG_DIR/morning-report-prep-cron.log 2>&1"
# This is a read-only post-deadline proof probe. Pre-deadline recovery always
# relaunches the date-locked coordinator, never a second delivery owner.
DELIVERY_WATCHDOG_LINE="31 5 * * * /usr/bin/node $DELIVERY_WATCHDOG_RUNNER --probe --data-dir $DATA_DIR >> $LOG_DIR/morning-briefing-cron.log 2>&1"
LEGACY_MORNING_LINE="20 5 * * * $CONTROLLER_ROOT/scripts/ec2-morning-briefing-run.sh >> $LOG_DIR/morning-briefing-cron.log 2>&1"
LEGACY_WATCHDOG_LINE="26,31 5 * * * BRIEFING_DATE=\$(TZ=America/Chicago date +\%F) /usr/bin/node $DELIVERY_WATCHDOG_RUNNER --data-dir $DATA_DIR >> $LOG_DIR/morning-briefing-cron.log 2>&1"
LEGACY_SELF_HEAL_LINE_1="45 2 * * * $SELF_HEAL_RUNNER >> $LOG_DIR/self-heal-cron.log 2>&1"
LEGACY_SELF_HEAL_LINE_2="0 3 * * * $SELF_HEAL_RUNNER >> $LOG_DIR/self-heal-cron.log 2>&1"
# The scheduled-skill fleet still produces the Scheduled tasks health ledger.
LEGACY_FLEET_LINE="*/30 0-4 * * * cd $ROOT && mkdir -p $LOG_DIR && SECONDBRAIN_DATA_DIR=$DATA_DIR /usr/bin/node scripts/run-cloud-scheduled-tasks.js --trigger cloud-cron >> $LOG_DIR/cloud-scheduled-fleet.log 2>&1"
BLOCK_BEGIN="# BEGIN secondbrain-card-controller"
BLOCK_END="# END secondbrain-card-controller"
MODE="${1:-}"

validate_cron_file() {
  local file="$1"
  local expected_mode="${2:-active}"
  test "$expected_mode" = "active" || test "$expected_mode" = "rollback" || {
    echo "validation mode must be active or rollback" >&2
    return 2
  }
  DELIVERY_WATCHDOG_LINE="$DELIVERY_WATCHDOG_LINE" "$AWK_BIN" \
    -v expected_mode="$expected_mode" \
    -v fleet_line="$LEGACY_FLEET_LINE" \
    -v controller_line="$LINE" \
    -v report_early_line="$REPORT_EARLY_LINE" \
    -v report_prep_line="$REPORT_PREP_LINE" \
    -v report_final_line="$REPORT_FINAL_LINE" \
    -v coordinator_recovery_line="$COORDINATOR_RECOVERY_LINE" \
    -v self_heal_line_1="$LEGACY_SELF_HEAL_LINE_1" \
    -v self_heal_line_2="$LEGACY_SELF_HEAL_LINE_2" '
    # Read the watchdog row from ENVIRON to keep byte-exact validation aligned
    # with the installed command without another shell/awk escaping layer.
    BEGIN { timezone = ""; fleet = 0; controller = 0; report = 0; watchdog = 0; coordinator_recovery = 0; selfheal = 0; invalid = 0; delivery_watchdog_line = ENVIRON["DELIVERY_WATCHDOG_LINE"] }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*CRON_TZ=/ {
      timezone = $0
      sub(/^[[:space:]]*CRON_TZ=[[:space:]]*/, "", timezone)
      gsub(/[[:space:]]+$/, "", timezone)
      next
    }
    /run-cloud-scheduled-tasks[.]js --trigger cloud-cron/ { fleet += 1; target = "scheduled-task fleet"; if ($0 != fleet_line) invalid = 1 }
    /ec2-card-controller-run[.]sh/ { controller += 1; target = "card controller"; if ($0 != controller_line) invalid = 1 }
    /ec2-morning-report-prep-run[.]sh/ { report += 1; target = "report preparation"; if ($0 != report_early_line && $0 != report_prep_line && $0 != report_final_line) invalid = 1 }
    /briefing-delivery-watchdog[.]js/ { watchdog += 1; target = "delivery watchdog"; if ($0 != delivery_watchdog_line) invalid = 1 }
    /SB_WATCHER_RECOVERY_ATTEMPT_ID=deadline-fallback .*ec2-overnight-watcher-run[.]sh/ { coordinator_recovery += 1; target = "coordinator recovery"; if ($0 != coordinator_recovery_line) invalid = 1 }
    /ec2-self-heal-run[.]sh/ { selfheal += 1; target = "legacy self-heal"; if ($0 != self_heal_line_1 && $0 != self_heal_line_2) invalid = 1 }
    /run-cloud-scheduled-tasks[.]js --trigger cloud-cron|ec2-card-controller-run[.]sh|ec2-morning-report-prep-run[.]sh|briefing-delivery-watchdog[.]js|SB_WATCHER_RECOVERY_ATTEMPT_ID=deadline-fallback .*ec2-overnight-watcher-run[.]sh|ec2-self-heal-run[.]sh/ {
      if (timezone != "America/Chicago") {
        print target " effective timezone is " (timezone == "" ? "host-default" : timezone) ", not America/Chicago" > "/dev/stderr"
        invalid = 1
      }
    }
    END {
      expected_controller = expected_mode == "active" ? 1 : 0
      expected_report = 3
      expected_selfheal = 2
      if (fleet != 1 || controller != expected_controller || report != expected_report || watchdog != 1 || coordinator_recovery != 1 || selfheal != expected_selfheal) {
        print "expected " expected_mode " fleet/controller/report/watchdog/coordinator-recovery/self-heal rows 1/" expected_controller "/" expected_report "/1/1/" expected_selfheal "; found " fleet "/" controller "/" report "/" watchdog "/" coordinator_recovery "/" selfheal > "/dev/stderr"
        invalid = 1
      }
      exit invalid
    }
  ' "$file"
}

case "$MODE" in
  --activate|--rollback) ;;
  --validate)
    test -n "${2:-}" || { echo "Usage: $0 --validate CRONTAB_FILE [active|rollback]" >&2; exit 2; }
    validate_cron_file "$2" "${3:-active}"
    exit $?
    ;;
  *)
    echo "Usage: $0 --activate|--rollback|--validate CRONTAB_FILE [active|rollback]" >&2
    echo "Refusing to change cron without an explicit authority decision." >&2
    exit 2
    ;;
esac

mkdir -p "$LOG_DIR" "$(dirname "$AUTHORITY_FILE")" "$BACKUP_DIR" "$(dirname "$CRONTAB_LOCK_FILE")"
chmod +x "$RUNNER" "$COORDINATOR_RECOVERY_RUNNER" "$REPORT_PREP_RUNNER" "$DELIVERY_WATCHDOG_RUNNER" "$SELF_HEAL_RUNNER" 2>/dev/null || true
exec 9>"$CRONTAB_LOCK_FILE"
if ! "$FLOCK_BIN" -w 30 9; then
  echo "Refusing to change cron: timed out waiting for $CRONTAB_LOCK_FILE." >&2
  exit 1
fi

tmp="$(mktemp)"
raw="$(mktemp)"
cleanup() { rm -f "$tmp" "$raw"; }
trap cleanup EXIT
crontab -l 2>/dev/null > "$raw" || true

"$AWK_BIN" -v begin="$BLOCK_BEGIN" -v end="$BLOCK_END" '
  $0 == begin { skip = 1; next }
  $0 == end { skip = 0; next }
  !skip { print }
' "$raw" > "$tmp"

# Remove only byte-exact rows this installer owns. A hand-tuned row survives
# and makes validation fail closed instead of being silently replaced.
for owned_line in \
  "$LEGACY_FLEET_LINE" \
  "$LINE" \
  "$REPORT_EARLY_LINE" \
  "$REPORT_PREP_LINE" \
  "$REPORT_FINAL_LINE" \
  "$DELIVERY_WATCHDOG_LINE" \
  "$COORDINATOR_RECOVERY_LINE" \
  "$LEGACY_MORNING_LINE" \
  "$LEGACY_WATCHDOG_LINE" \
  "$LEGACY_SELF_HEAL_LINE_1" \
  "$LEGACY_SELF_HEAL_LINE_2"; do
  filtered="$(mktemp)"
  grep -Fvx "$owned_line" "$tmp" > "$filtered" || true
  mv "$filtered" "$tmp"
done

{
  echo "$BLOCK_BEGIN"
  echo "$TZLINE"
  echo "$LEGACY_FLEET_LINE"
  if [ "$MODE" = "--activate" ]; then
    echo "$LINE"
  fi
  # These are delayed retries of the same canonical controller graph, not a
  # competing legacy writer. The controller lease makes overlap impossible,
  # while 02:45 and 03:00 remain real recovery opportunities after a settled,
  # failed, or prematurely exited 23:00 run.
  echo "$LEGACY_SELF_HEAL_LINE_1"
  echo "$LEGACY_SELF_HEAL_LINE_2"
  # Report staging is independent of card-repair authority and remains active
  # during emergency rollback.
  echo "$REPORT_EARLY_LINE"
  echo "$REPORT_PREP_LINE"
  echo "$REPORT_FINAL_LINE"
  echo "$DELIVERY_WATCHDOG_LINE"
  echo "$COORDINATOR_RECOVERY_LINE"
  echo "$BLOCK_END"
} >> "$tmp"

expected_mode="active"
authority="1"
if [ "$MODE" = "--rollback" ]; then
  expected_mode="rollback"
  authority="0"
fi
if ! validate_cron_file "$tmp" "$expected_mode"; then
  echo "Refusing to install a briefing crontab with a wrong schedule, timezone, or row count." >&2
  exit 1
fi

backup="$BACKUP_DIR/card-controller-before-${expected_mode}-$(date -u +%Y%m%dT%H%M%SZ)-$$.cron"
cp "$raw" "$backup"
chmod 600 "$backup" 2>/dev/null || true
crontab "$tmp"
printf '%s\n' "$authority" > "$AUTHORITY_FILE"

echo "Installed validated $expected_mode briefing cron under $TZLINE."
echo "authority marker: $AUTHORITY_FILE = $authority"
echo "pre-change backup: $backup"
