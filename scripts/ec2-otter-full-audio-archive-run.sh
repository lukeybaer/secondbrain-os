#!/usr/bin/env bash
set -euo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${OTTER_FULL_AUDIO_ARCHIVE_LOG_DIR:-/opt/secondbrain/logs}"
LOCK_FILE="$DATA_DIR/life-archive/voiceprints/otter-full-audio-archive.lock"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_FILE")"
cd "$ROOT"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[otter-full-audio-archive] pending: another bounded archive pass is active"
  exit 0
fi

SECONDBRAIN_ROOT="$ROOT" \
SECONDBRAIN_DATA_DIR="$DATA_DIR" \
"$NODE_BIN" scripts/otter-full-audio-archive.js \
  --write \
  --max-files "${OTTER_FULL_AUDIO_ARCHIVE_MAX_FILES:-25}"
