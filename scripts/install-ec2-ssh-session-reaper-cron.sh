#!/usr/bin/env bash
# Install the five-minute idle SSH session reaper on the cloud host.
#
# On 2026-10-03 one client held 4,870 command-less SSH tunnels open and they
# filled swap. scripts/ssh-idle-session-reaper.js closes a plain command-less
# tunnel only when it is a burst member (at least 20 tunnel starts from its
# address within 30 minutes either side of its own), it has itself observed
# the 60 second keepalive fingerprint and nothing else for three intervals
# spanning at least 14 minutes, and more than 8 logins from that address match
# that way. Each direction has its own band: client to server between 35
# bytes a minute less 40 and 70 bytes a minute plus 60 (135 to 410 bytes per
# five minutes), server to client between 18 bytes a minute less 30 and 40
# bytes a minute plus 40 (60 to 240). Measured on the production host on
# 2026-10-05: exactly 260 bytes in and 140 bytes out per five minutes for
# every leaked tunnel. It writes the receipt in
# data/agent/ssh-session-health/. The row runs from the immutable release this
# installer resolves, under flock and a hard timeout, so a slow run can never
# stack up behind itself. Deploy reinstalls it after every release swap.
#
# Order: one observe-only proof run goes first, under the same lock and
# timeout the cron row uses, and the row is written only after it exits 0 and
# leaves a fresh, valid, ok receipt. Every other ending removes all reaper
# rows, so no unproven killer cron stays installed.
#
# Exit 0: the row is installed and proven.
# Exit 1: the reaper is not installed; crontab holds no reaper row.
# Exit 75: crontab could not be read or changed, so a reaper row from an
#   earlier install may still be active; the reaper-disabled file stops it.
set -euo pipefail

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${SECONDBRAIN_LOG_DIR:-/opt/secondbrain/logs}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
LOCK=/tmp/secondbrain-ssh-session-reaper.lock
OFF_SWITCH="$DATA_DIR/agent/ssh-session-health/reaper-disabled"
RECEIPT="$DATA_DIR/agent/ssh-session-health/latest.json"
MARK='ssh-idle-session-reaper.js'
proven=0
current=""
next=""
errors=""

# Copies crontab into $current; "no crontab" reads as empty.
read_crontab() {
  [[ -n "$current" && -n "$errors" ]] || return 1
  if crontab -l > "$current" 2> "$errors"; then return 0; fi
  grep -qi 'no crontab' "$errors" || return 1
  : > "$current"
}

# Rewrites crontab without any reaper row, and confirms none is left.
# Leaves crontab unwritten when it holds none.
remove_reaper_rows() {
  read_crontab || return 1
  grep -qF "$MARK" "$current" || return 0
  grep -vF "$MARK" "$current" > "$next" || true
  crontab "$next" || return 1
  read_crontab || return 1
  ! grep -qF "$MARK" "$current"
}

# Every ending except a proven install removes the reaper rows.
finish() {
  local status=$?
  set +e
  if [[ "$proven" != 1 ]]; then
    if remove_reaper_rows; then
      echo "[ssh-session-reaper] not installed: crontab holds no reaper row" >&2
      status=1
    else
      echo "[ssh-session-reaper] not installed, and crontab could not be read or changed: a reaper row from an earlier install may still be active; create $OFF_SWITCH to keep it observe-only" >&2
      status=75
    fi
  fi
  rm -f "$current" "$next" "$errors"
  exit "$status"
}
trap finish EXIT

current="$(mktemp)"
next="$(mktemp)"
errors="$(mktemp)"

ROOT="$(readlink -f "$ROOT_LINK")"
RUNNER="$ROOT/scripts/ssh-idle-session-reaper.js"
RUN="timeout --kill-after=10s 180s env SECONDBRAIN_DATA_DIR=$DATA_DIR $NODE_BIN $RUNNER"
LINE="*/5 * * * * flock -n $LOCK $RUN --apply >> $LOG_DIR/ssh-session-reaper.log 2>&1"

# Never rebuild crontab from an unreadable one: that would drop every other row.
if ! read_crontab; then
  echo "[ssh-session-reaper] refused: could not read the current crontab" >&2
  exit 75
fi
if [[ ! -f "$RUNNER" ]]; then
  echo "[ssh-session-reaper] refused: runner missing from pinned release $ROOT" >&2
  exit 1
fi
# The reaper reads socket owners and signals root-owned sshd monitors, so it
# needs passwordless sudo under cron.
if ! sudo -n true >/dev/null 2>&1; then
  echo "[ssh-session-reaper] refused: passwordless sudo is unavailable" >&2
  exit 1
fi
mkdir -p "$LOG_DIR" "$DATA_DIR/agent/ssh-session-health"

# The proof waits for any in-flight cron run, then runs observe-only under the
# same timeout. It never closes a session. It must exit 0 and leave a receipt
# that parses, has the runner's schema, says ok, and is under three minutes old.
status=0
flock -w 200 "$LOCK" timeout --kill-after=10s 180s env SECONDBRAIN_DATA_DIR="$DATA_DIR" "$NODE_BIN" "$RUNNER" || status=$?
if [[ "$status" != 0 ]]; then
  echo "[ssh-session-reaper] install failed: the observe-only proof run exited $status" >&2
  exit 1
fi
if ! "$NODE_BIN" - "$RECEIPT" <<'JS'
const fs = require('fs');
let receipt = null;
try {
  receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch (error) {
  process.exit(1);
}
const age = Date.now() - Date.parse(receipt && receipt.observedAt);
const fresh = Number.isFinite(age) && age >= -60000 && age <= 180000;
const valid = Boolean(receipt) && receipt.schema === 'secondbrain.ssh-session-health.v1' && receipt.ok === true;
process.exit(valid && fresh ? 0 : 1);
JS
then
  echo "[ssh-session-reaper] install failed: the observe-only proof run left no fresh valid receipt at $RECEIPT" >&2
  exit 1
fi

# Proven: replace every reaper row with this release's row, then confirm
# crontab holds exactly that one. Crontab is read again here so rows other
# jobs added during the proof are kept.
if ! read_crontab; then
  echo "[ssh-session-reaper] install failed: could not read the crontab after the proof" >&2
  exit 1
fi
grep -vF "$MARK" "$current" > "$next" || true
printf '%s\n' "$LINE" >> "$next"
if ! crontab "$next"; then
  echo "[ssh-session-reaper] install failed: crontab refused the new row" >&2
  exit 1
fi
read_crontab || true
rows="$(grep -cF "$MARK" "$current" || true)"
if [[ "$rows" != 1 ]] || ! grep -qxF -- "$LINE" "$current"; then
  echo "[ssh-session-reaper] install failed: crontab holds $rows reaper rows, not exactly the new one" >&2
  exit 1
fi
proven=1
echo "Installed idle SSH session reaper: $LINE"
