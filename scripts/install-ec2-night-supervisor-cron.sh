#!/usr/bin/env bash
# Activate or roll back the EC2 night-supervisor cron (ExampleCo approval
# 2026-08-02, overnight watcher automation). The supervisor is deterministic
# and runs the narrow cloud-recovery contract in scripts/night-supervisor.js.
#
# Cadence: 22:45 and 22:55 CT warmup passes, then every 10 minutes through the
# night (hours 23 and 0-5 CT). The script itself enforces the 05:35 CT cutoff,
# so the 05:40 and 05:50 cron fires exit as no-ops.
#
# This installer is INERT until the coordinator runs it explicitly with
# --activate after Codex review. Refuses to change cron without an explicit
# authority decision, matching install-ec2-card-controller-cron.sh.
set -euo pipefail
if [ -f "${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}/agent/amy-night-owner.active" ]; then
  exec bash "${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}/scripts/install-amy-night-owner.sh" --verify
fi

CONTROLLER_ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
AWK_BIN="${SB_CRON_AWK_BIN:-awk}"
TZLINE="CRON_TZ=America/Chicago"
CMD="cd $CONTROLLER_ROOT && /usr/bin/flock -E 75 -n /tmp/secondbrain-night-supervisor.lock env SECONDBRAIN_DATA_DIR=$DATA_DIR SB_SUPERVISOR_ENFORCE=1 $NODE_BIN scripts/night-supervisor.js >> $LOG_DIR/night-supervisor-cron.log 2>&1 || { rc=\$?; if [ \"\$rc\" -eq 75 ]; then echo \"[night-supervisor] \$(date -u +\%FT\%TZ) skipped: prior pass still owns the supervisor flock\" >> $LOG_DIR/night-supervisor-cron.log; else exit \"\$rc\"; fi; }"
LINE_LATE_EVENING="45,55 22 * * * $CMD"
LINE_OVERNIGHT="*/10 23,0,1,2,3,4,5 * * * $CMD"
BLOCK_BEGIN="# BEGIN secondbrain-night-supervisor"
BLOCK_END="# END secondbrain-night-supervisor"
MODE="${1:-}"

validate_cron_file() {
  local file="$1"
  "$AWK_BIN" '
    BEGIN { timezone = ""; supervisor_rows = 0; invalid = 0 }
    /^[[:space:]]*CRON_TZ=/ {
      timezone = $0
      sub(/^[[:space:]]*CRON_TZ=[[:space:]]*/, "", timezone)
      gsub(/[[:space:]]+$/, "", timezone)
      next
    }
    /night-supervisor[.]js/ {
      supervisor_rows += 1
      if (timezone != "America/Chicago") {
        print "night-supervisor effective timezone is " (timezone == "" ? "host-default" : timezone) ", not America/Chicago" > "/dev/stderr"
        invalid = 1
      }
    }
    END {
      if (supervisor_rows != 2) {
        print "expected exactly two night-supervisor cron rows; found " supervisor_rows > "/dev/stderr"
        invalid = 1
      }
      exit invalid
    }
  ' "$file"
}

case "$MODE" in
  --activate|--rollback) ;;
  --validate)
    test -n "${2:-}" || { echo "Usage: $0 --validate CRONTAB_FILE" >&2; exit 2; }
    validate_cron_file "$2"
    exit $?
    ;;
  *)
    echo "Usage: $0 --activate|--rollback|--validate CRONTAB_FILE" >&2
    echo "Refusing to change cron without an explicit authority decision." >&2
    exit 2
    ;;
esac

mkdir -p "$LOG_DIR"

tmp="$(mktemp)"
raw="$(mktemp)"
cleanup() {
  rm -f "$tmp" "$raw"
}
trap cleanup EXIT
crontab -l 2>/dev/null > "$raw" || true
"$AWK_BIN" -v begin="$BLOCK_BEGIN" -v end="$BLOCK_END" '
  $0 == begin { skip = 1; next }
  $0 == end { skip = 0; next }
  !skip { print }
' "$raw" | grep -v 'night-supervisor.js' > "$tmp" || true

if [ "$MODE" = "--rollback" ]; then
  crontab "$tmp"
  echo "Rolled back: removed every night-supervisor cron line."
  exit 0
fi

{
  echo "$BLOCK_BEGIN"
  echo "$TZLINE"
  echo "$LINE_LATE_EVENING"
  echo "$LINE_OVERNIGHT"
  echo "$BLOCK_END"
} >> "$tmp"
if ! validate_cron_file "$tmp"; then
  echo "Refusing to install an invalid night-supervisor crontab." >&2
  exit 1
fi
crontab "$tmp"

echo "Activated the EC2 night-supervisor cron with bounded cloud recovery:"
echo "$BLOCK_BEGIN"
echo "$TZLINE"
echo "$LINE_LATE_EVENING"
echo "$LINE_OVERNIGHT"
echo "$BLOCK_END"
echo "Recovery is capped per failure class and still honors watcher/controller ownership locks."
