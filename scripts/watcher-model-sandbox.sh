#!/usr/bin/env bash
# Fail-closed filesystem boundary for the untrusted automated watcher model.
set -euo pipefail

SESSION_ROOT="${SB_WATCHER_SESSION_ROOT:?missing SB_WATCHER_SESSION_ROOT}"
DATA_DIR="${SB_WATCHER_DATA_DIR:?missing SB_WATCHER_DATA_DIR}"
CANDIDATE_FILE="${SB_WATCHER_CANDIDATE_FILE:-$DATA_DIR/agent/watcher-learning-candidates.jsonl}"
[ "$CANDIDATE_FILE" = "$DATA_DIR/agent/watcher-learning-candidates.jsonl" ] || {
  echo "watcher sandbox refused unexpected candidate path" >&2
  exit 65
}
RUNTIME_HOME="${SB_WATCHER_RUNTIME_HOME:?missing SB_WATCHER_RUNTIME_HOME}"

[ "${1:-}" = "--" ] || { echo "watcher sandbox requires --" >&2; exit 64; }
shift
[ "$#" -gt 0 ] || { echo "watcher sandbox requires a command" >&2; exit 64; }

case "$SESSION_ROOT" in /home/ec2-user/sb-sessions/watcher-*) ;;
  *) echo "watcher sandbox refused unexpected session root" >&2; exit 65 ;;
esac
case "$DATA_DIR" in /opt/secondbrain/data|/opt/secondbrain-shared/data) ;;
  *) echo "watcher sandbox refused unexpected data root" >&2; exit 65 ;;
esac
case "$RUNTIME_HOME" in /home/ec2-user/.watcher-runtime/watcher-*) ;;
  *) echo "watcher sandbox refused unexpected runtime home" >&2; exit 65 ;;
esac

mkdir -p "$RUNTIME_HOME" "$RUNTIME_HOME/.codex" "$RUNTIME_HOME/.claude" "$SESSION_ROOT/.watcher-requests"
touch "$CANDIDATE_FILE"
chmod 600 "$CANDIDATE_FILE"
chmod 700 "$RUNTIME_HOME" "$RUNTIME_HOME/.codex" "$RUNTIME_HOME/.claude" "$SESSION_ROOT/.watcher-requests"
if [ -r /home/ec2-user/.codex/auth.json ] && [ ! -e "$RUNTIME_HOME/.codex/auth.json" ]; then
  install -m 600 /home/ec2-user/.codex/auth.json "$RUNTIME_HOME/.codex/auth.json"
fi
if [ -r /home/ec2-user/.claude/.credentials.json ] && [ ! -e "$RUNTIME_HOME/.claude/.credentials.json" ]; then
  install -m 600 /home/ec2-user/.claude/.credentials.json "$RUNTIME_HOME/.claude/.credentials.json"
fi
if [ -r /home/ec2-user/.claude.json ] && [ ! -e "$RUNTIME_HOME/.claude.json" ]; then
  install -m 600 /home/ec2-user/.claude.json "$RUNTIME_HOME/.claude.json"
fi

mount --make-rprivate /

# Make the whole home tree read-only, then add back one explicit writable
# worktree island. Parent-first order is required because a later parent bind
# would otherwise hide the child mount in this namespace.
mount --bind /home/ec2-user /home/ec2-user
mount -o remount,bind,ro /home/ec2-user
mount --bind "$SESSION_ROOT" "$SESSION_ROOT"
mount -o remount,bind,rw "$SESSION_ROOT"
mount --bind "$RUNTIME_HOME" "$RUNTIME_HOME"
mount -o remount,bind,rw "$RUNTIME_HOME"

# Production runtime and canonical data are read-only except for the exact
# append-only, noncanonical candidate surface brokered by watcher-safe-cli.
mount --bind /opt /opt
mount -o remount,bind,ro /opt
mount --bind "$CANDIDATE_FILE" "$CANDIDATE_FILE"
mount -o remount,bind,rw "$CANDIDATE_FILE"

export HOME="$RUNTIME_HOME"
export CODEX_HOME="$RUNTIME_HOME/.codex"
export XDG_CONFIG_HOME="$RUNTIME_HOME/.config"
export XDG_CACHE_HOME="$RUNTIME_HOME/.cache"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"

exec /usr/bin/setpriv \
  --no-new-privs \
  --bounding-set=-all \
  --ambient-caps=-all \
  --inh-caps=-all \
  -- "$@"
