#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="${TELEGRAM_VOICE_RUNTIME_DIR:-$HOME/.local/share/secondbrain/telegram-voice-runtime}"
MODEL="${TELEGRAM_VOICE_TRANSCRIBE_MODEL:-small}"
MODEL_ROOT="${TELEGRAM_VOICE_MODEL_ROOT:-$RUNTIME_DIR/models}"
PYTHON="$RUNTIME_DIR/bin/python3"
FASTER_WHISPER_VERSION="1.2.0"
REQUESTS_VERSION="2.32.5"
MARKER="$RUNTIME_DIR/.ready-$MODEL-faster-whisper-$FASTER_WHISPER_VERSION"
MIN_FREE_KB="${TELEGRAM_VOICE_MIN_FREE_KB:-1572864}"

ensure_free_space() {
  local available_kb
  available_kb="$(df -Pk "$(dirname "$RUNTIME_DIR")" | awk 'NR==2 {print $4}')"
  if [[ ! "$available_kb" =~ ^[0-9]+$ ]] || (( available_kb < MIN_FREE_KB )); then
    echo "[telegram-voice-runtime] insufficient free disk for the local runtime" >&2
    exit 75
  fi
}

has_exact_packages() {
  "$PYTHON" -c \
    "import importlib.metadata as m; assert m.version('faster-whisper') == '$FASTER_WHISPER_VERSION'; assert m.version('requests') == '$REQUESTS_VERSION'" \
    >/dev/null 2>&1
}

mkdir -p "$(dirname "$RUNTIME_DIR")"
if [[ ! -x "$PYTHON" ]]; then
  ensure_free_space
  python3 -m venv "$RUNTIME_DIR"
fi

if ! has_exact_packages; then
  ensure_free_space
  "$PYTHON" -m pip install --disable-pip-version-check --no-cache-dir \
    "faster-whisper==$FASTER_WHISPER_VERSION" "requests==$REQUESTS_VERSION"
fi

mkdir -p "$MODEL_ROOT"
if [[ ! -f "$MARKER" ]]; then
  ensure_free_space
  TELEGRAM_VOICE_MODEL="$MODEL" TELEGRAM_VOICE_MODEL_ROOT="$MODEL_ROOT" \
    HF_HUB_DISABLE_TELEMETRY=1 "$PYTHON" - <<'PY'
import os
from faster_whisper import WhisperModel

WhisperModel(
    os.environ["TELEGRAM_VOICE_MODEL"],
    device="cpu",
    compute_type="int8",
    download_root=os.environ["TELEGRAM_VOICE_MODEL_ROOT"],
)
PY
  marker_tmp="$MARKER.$$.tmp"
  printf '%s\n' "faster-whisper=$FASTER_WHISPER_VERSION model=$MODEL" > "$marker_tmp"
  mv "$marker_tmp" "$MARKER"
fi

TELEGRAM_VOICE_MODEL="$MODEL" TELEGRAM_VOICE_MODEL_ROOT="$MODEL_ROOT" \
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
  "$PYTHON" - <<'PY'
import os
from faster_whisper import WhisperModel

WhisperModel(
    os.environ["TELEGRAM_VOICE_MODEL"],
    device="cpu",
    compute_type="int8",
    download_root=os.environ["TELEGRAM_VOICE_MODEL_ROOT"],
    local_files_only=True,
)
PY

echo "[telegram-voice-runtime] ready: $PYTHON model=$MODEL"
