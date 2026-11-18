#!/usr/bin/env bash
#
# retire-ec2-night-regrade-crons.sh -- remove the two 4:45 AM CT catch-up cron
# lines that S-5 retired with their scripts (Owner decision #b: "Delete the
# loop, both re-grade jobs ..."), and prove they are gone. Every release runs
# it, because a host upgraded from an earlier release still carries the lines.
#
# Run ON EC2 (the deploy does this):
#   bash /opt/secondbrain/scripts/retire-ec2-night-regrade-crons.sh
#
# It touches only non-comment lines that run backup-upload-regrade.js or
# red-card-regrade.js. Same house style as the Venture App retire: the
# shared crontab lock, a backup first, refuse on an unreadable crontab or one
# that changed under it, re-read and verify after. Idempotent.
set -Eeuo pipefail

DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
FLOCK_BIN="${AMY_CRONTAB_FLOCK_BIN:-/usr/bin/flock}"
CRONTAB_LOCK_FILE="${AMY_CRONTAB_MUTATION_LOCK:-/tmp/amy-crontab-mutation.lock}"
BACKUP_DIR="${AMY_CRONTAB_BACKUP_DIR:-$DATA_DIR/agent/crontab-backups}"
RETIRED_RE='(backup-upload-regrade|red-card-regrade)[.]js'

current="$(mktemp)"
transformed="$(mktemp)"
recheck="$(mktemp)"
cleanup() { rm -f "$current" "$transformed" "$recheck"; }
trap cleanup EXIT

# A failed read must never look like an empty crontab: writing over an
# unreadable crontab would erase every other job on the box. Only the explicit
# "no crontab" answer counts as empty.
read_crontab() {
  local out="$1" err
  err="$(mktemp)"
  if crontab -l > "$out" 2> "$err"; then
    rm -f "$err"
    return 0
  fi
  if grep -qi "no crontab" "$err"; then
    : > "$out"
    rm -f "$err"
    return 0
  fi
  echo "Refusing to change cron: crontab -l failed: $(head -c 300 "$err")" >&2
  rm -f "$err"
  return 1
}

retired_line_count() {
  local n
  n="$(grep -v '^[[:space:]]*#' "$1" | grep -c -E "$RETIRED_RE" || true)"
  echo "${n:-0}"
}

mkdir -p "$BACKUP_DIR" "$(dirname "$CRONTAB_LOCK_FILE")"
exec 9>"$CRONTAB_LOCK_FILE"
if ! "$FLOCK_BIN" -w 30 9; then
  echo "Refusing to change cron: timed out waiting for $CRONTAB_LOCK_FILE." >&2
  exit 1
fi
read_crontab "$current" || exit 1
if [ "$(retired_line_count "$current")" = "0" ]; then
  echo "Night re-grade cron lines already retired: no active line."
  exit 0
fi
backup="$BACKUP_DIR/night-regrade-before-retire-$(date -u +%Y%m%dT%H%M%SZ)-$$.cron"
cp "$current" "$backup"
chmod 600 "$backup" 2>/dev/null || true
awk -v re="$RETIRED_RE" '
  /^[[:space:]]*#/ { print; next }
  $0 ~ re { next }
  { print }
' "$current" > "$transformed"
if [ "$(retired_line_count "$transformed")" != "0" ]; then
  echo "Refusing to write a crontab that still carries a retired re-grade line." >&2
  exit 1
fi
read_crontab "$recheck" || exit 1
cmp -s "$current" "$recheck" || {
  echo "Cron changed during the night re-grade retirement; no schedule changed" >&2
  exit 3
}
crontab "$transformed"
read_crontab "$recheck" || exit 1
if [ "$(retired_line_count "$recheck")" != "0" ]; then
  echo "Post-retire verification failed; restore from $backup if the crontab looks wrong." >&2
  exit 1
fi
echo "Retired the night re-grade cron lines; every other job is unchanged."
echo "pre-change backup: $backup"
