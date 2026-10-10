#!/usr/bin/env bash
# Install the 13:10-16:40 CT daytime scheduled-skill fleet cron row.
#
# ExampleCo 2026-09-14: secondbrain-nightly-enhancement, video-quality-research,
# and weekly-warmth-audit moved off the overnight box. At midnight they burned
# roughly 2.6M Codex tokens combined and pushed Codex over its usage limit
# before the briefing news card could run. The daytime EC2 box is a 4 GB
# t3.medium, hence AMY_CLOUD_SCHEDULED_CONCURRENCY=1 and the niced process in
# the installed row.
#
# Mirrors the house style of install-ec2-card-controller-cron.sh (flock,
# backup, mktemp, validate before writing crontab) and install-amy-night-owner.sh
# (re-read crontab and refuse if it changed during preparation). All parsing,
# stripping, and validation is the pure module scripts/lib/daytime-fleet-cron.js;
# this script only ever calls it via a temp-file handoff so a large crontab
# never rides an argv (Linux argv is bounded, and a hand-tuned crontab has
# grown to that size on this fleet before).
set -Eeuo pipefail

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
ROOT="$(readlink -f "$ROOT_LINK")"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
FLOCK_BIN="${AMY_CRONTAB_FLOCK_BIN:-/usr/bin/flock}"
CRONTAB_LOCK_FILE="${AMY_CRONTAB_MUTATION_LOCK:-/tmp/amy-crontab-mutation.lock}"
BACKUP_DIR="${AMY_CRONTAB_BACKUP_DIR:-$DATA_DIR/agent/crontab-backups}"
LIB="$ROOT/scripts/lib/daytime-fleet-cron.js"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

case "${1:-}" in
  '') MODE=install ;;
  --dry-run) MODE=dry-run ;;
  --verify) MODE=verify ;;
  *)
    echo "Usage: $0 [--dry-run|--verify]" >&2
    exit 2
    ;;
esac

current="$(mktemp)"
transformed="$(mktemp)"
cleanup() { rm -f "$current" "$transformed"; }
trap cleanup EXIT

if [ "$MODE" = verify ]; then
  crontab -l > "$current" 2>/dev/null || true
  "$NODE_BIN" -e '
    const m = require(process.argv[1]);
    const fs = require("fs");
    m.assertDaytimeFleetRow(fs.readFileSync(process.argv[2], "utf8"));
  ' "$LIB" "$current"
  echo "Verified: exactly one daytime scheduled fleet cron row at America/Chicago."
  exit 0
fi

if [ "$MODE" = dry-run ]; then
  crontab -l > "$current" 2>/dev/null || true
  "$NODE_BIN" -e '
    const m = require(process.argv[1]);
    const fs = require("fs");
    fs.writeFileSync(process.argv[3], m.installDaytimeFleetRow(fs.readFileSync(process.argv[2], "utf8")));
  ' "$LIB" "$current" "$transformed"
  cat "$transformed"
  exit 0
fi

mkdir -p "$BACKUP_DIR" "$(dirname "$CRONTAB_LOCK_FILE")"
exec 9>"$CRONTAB_LOCK_FILE"
if ! "$FLOCK_BIN" -w 30 9; then
  echo "Refusing to change cron: timed out waiting for $CRONTAB_LOCK_FILE." >&2
  exit 1
fi

# A failed read must never look like an empty crontab: installing over an
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

read_crontab "$current" || exit 1
backup="$BACKUP_DIR/daytime-fleet-before-$(date -u +%Y%m%dT%H%M%SZ)-$$.cron"
cp "$current" "$backup"
chmod 600 "$backup" 2>/dev/null || true

"$NODE_BIN" -e '
  const m = require(process.argv[1]);
  const fs = require("fs");
  fs.writeFileSync(process.argv[3], m.installDaytimeFleetRow(fs.readFileSync(process.argv[2], "utf8")));
' "$LIB" "$current" "$transformed"

"$NODE_BIN" -e '
  const m = require(process.argv[1]);
  const fs = require("fs");
  const after = fs.readFileSync(process.argv[2], "utf8");
  const before = fs.readFileSync(process.argv[3], "utf8");
  m.assertDaytimeFleetRow(after);
  m.assertOnlyDaytimeBlockChanged(before, after);
' "$LIB" "$transformed" "$current"

recheck="$(mktemp)"
trap 'rm -f "$current" "$transformed" "$recheck"' EXIT
read_crontab "$recheck" || exit 1
cmp -s "$current" "$recheck" || {
  echo "Cron changed during daytime fleet install preparation; no schedule changed" >&2
  exit 3
}

crontab "$transformed"
echo "Installed daytime scheduled-skill fleet cron (13:10-16:40 CT)."
echo "pre-change backup: $backup"
