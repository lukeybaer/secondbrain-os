#!/usr/bin/env bash
# Canonical EC2 owner for the full overnight briefing watcher.
set -euo pipefail

SOURCE_ROOT="${SECONDBRAIN_WATCHER_SOURCE_ROOT:-/home/ec2-user/secondbrain-current}"
RUNTIME_ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOG_DIR="${BRIEFING_LOG_DIR:-/opt/secondbrain/logs}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
CONTROL_MODE_FILE="${AMY_BRIEFING_CONTROL_MODE_FILE:-/opt/amy-control/mode}"
CONTROL_TIMER="${AMY_BRIEFING_CONTROL_TIMER:-amy-briefing-control.timer}"
SYSTEMCTL_BIN="${AMY_BRIEFING_SYSTEMCTL_BIN:-/usr/bin/systemctl}"

case "${1:-}" in
  ''|--preflight|--reconcile-release) ;;
  *) echo "Usage: $0 [--preflight|--reconcile-release]" >&2; exit 2 ;;
esac

export SECONDBRAIN_ROOT="$RUNTIME_ROOT"
export SECONDBRAIN_CONTROLLER_ROOT="$RUNTIME_ROOT"
export SECONDBRAIN_HEALER_ROOT="$SOURCE_ROOT"
export SECONDBRAIN_DATA_DIR="$DATA_DIR"
export SB_WATCHER_EXECUTION_HOST=cloud
export SECONDBRAIN_BRIEFING_CODEX_CEILING="gpt-5.6-sol:medium"

# Subscription CLIs are the model authority. A stale inherited key must never
# turn the watcher itself into a paid API process.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY

cloud_control_owns_launch() {
  [ -r "$CONTROL_MODE_FILE" ] || return 1
  [ "$(tr -d '[:space:]' <"$CONTROL_MODE_FILE")" = "active" ] || return 1
  command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1 || return 1
  "$SYSTEMCTL_BIN" is-enabled --quiet "$CONTROL_TIMER" >/dev/null 2>&1 &&
    "$SYSTEMCTL_BIN" is-active --quiet "$CONTROL_TIMER" >/dev/null 2>&1
}

# Active cloud control launches the immutable watcher entrypoint directly.
# A restored legacy cron row reaches this wrapper with no arguments. Only the
# explicit maintenance commands above and a named supervisor recovery may pass
# while active cloud control owns launch.
if [ -z "${1:-}" ] && [ -z "${SB_WATCHER_RECOVERY_ATTEMPT_ID:-}" ] &&
  cloud_control_owns_launch; then
  suppressed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"schema":"amy-legacy-watcher-suppression@1","ts":"%s","pid":%s,"result":"SUPPRESSED_LEGACY_WATCHER_ACTIVE_CLOUD_CONTROL"}\n' \
    "$suppressed_at" "$$"
  exit 0
fi

mkdir -p "$LOG_DIR"
cd "$SOURCE_ROOT"

release_sha() {
  local resolved release_name
  resolved="$(readlink -f "$RUNTIME_ROOT" 2>/dev/null || true)"
  release_name="$(basename "$resolved")"
  # Atomic same-SHA deploys stage into <sha>.reland-<epoch>-<pid>.  Compare
  # the embedded commit identity, but leave every malformed name untouched so
  # the caller's exact SHA equality check still fails closed.
  printf '%s\n' "$release_name" | sed -E 's/^([0-9a-f]{40})(\.reland-[0-9]+-[0-9]+)?$/\1/'
}

reconcile_release() {
  # The watcher may repair code in the writable source checkout, but every
  # controller, verifier, and report entrypoint must execute the same landed
  # release.  Fetch + fast-forward first, then use the canonical atomic deploy
  # when /opt is behind.  --swap-anyway waives only the cron-window check for
  # this pre-work watcher process; atomic validation, Otter lane locks, health
  # checks, and rollback remain mandatory.
  git diff --quiet && git diff --cached --quiet || {
    echo "release reconciliation failed: source checkout has local changes" >&2
    return 1
  }
  git fetch origin master
  git merge --ff-only origin/master
  local source_sha origin_sha runtime_sha
  source_sha="$(git rev-parse HEAD)"
  origin_sha="$(git rev-parse origin/master)"
  [ "$source_sha" = "$origin_sha" ] || {
    echo "release reconciliation failed: source is not landed origin/master ($source_sha != $origin_sha)" >&2
    return 1
  }
  runtime_sha="$(release_sha)"
  if [ "$runtime_sha" != "$source_sha" ]; then
    echo "release reconciliation: runtime ${runtime_sha:-missing} -> source $source_sha"
    OVERNIGHT_WATCHER_RELEASE_RECONCILE=1 bash "$SOURCE_ROOT/scripts/deploy-ec2-server.sh" --local
  fi
  runtime_sha="$(release_sha)"
  [ "$runtime_sha" = "$source_sha" ] || {
    echo "release reconciliation failed: source=$source_sha runtime=${runtime_sha:-missing}" >&2
    return 1
  }
  echo "release reconciliation passed: source=runtime=$source_sha"
}

if [ "${1:-}" = "--preflight" ]; then
  test -d "$SOURCE_ROOT/.git" || { echo "preflight failed: source checkout missing" >&2; exit 1; }
  test -w "$SOURCE_ROOT" || { echo "preflight failed: source checkout is not writable" >&2; exit 1; }
  test -w "$RUNTIME_ROOT" || { echo "preflight failed: runtime root is not writable" >&2; exit 1; }
  test -w "$DATA_DIR" || { echo "preflight failed: data root is not writable" >&2; exit 1; }
  test -e "$SOURCE_ROOT/node_modules" || { echo "preflight failed: shared dependencies are missing" >&2; exit 1; }
  command -v git >/dev/null || { echo "preflight failed: git missing" >&2; exit 1; }
  command -v claude >/dev/null || { echo "preflight failed: Claude CLI missing" >&2; exit 1; }
  command -v codex >/dev/null || { echo "preflight failed: Codex CLI missing" >&2; exit 1; }
  "$NODE_BIN" --version >/dev/null
  git ls-remote --exit-code origin HEAD >/dev/null
  probe_parent="/home/ec2-user/sb-sessions"
  mkdir -p "$probe_parent"
  probe_root="$(mktemp -d -p "$probe_parent" cloud-watcher-preflight-XXXXXX)"
  probe_worktree="$probe_root/worktree"
  cleanup_probe() {
    git -C "$SOURCE_ROOT" worktree remove --force "$probe_worktree" >/dev/null 2>&1 || true
    rmdir "$probe_root" >/dev/null 2>&1 || true
  }
  trap cleanup_probe EXIT
  git worktree add --detach "$probe_worktree" HEAD >/dev/null
  git -C "$probe_worktree" push --dry-run origin HEAD:refs/heads/codex/cloud-watcher-access-preflight >/dev/null
  cleanup_probe
  trap - EXIT
  sudo -n true
  runtime_sha="$(release_sha)"
  source_sha="$(git rev-parse HEAD)"
  if [ "$runtime_sha" != "$source_sha" ]; then
    echo "preflight: source/runtime release mismatch ($source_sha != ${runtime_sha:-missing}); attempting one bounded reconcile" >&2
    if ! reconcile_release; then
      echo "preflight failed: release reconcile did not resolve the source/runtime mismatch" >&2
      exit 1
    fi
    runtime_sha="$(release_sha)"
    source_sha="$(git rev-parse HEAD)"
    test "$runtime_sha" = "$source_sha" || { echo "preflight failed: source/runtime release mismatch persists after reconcile ($source_sha != ${runtime_sha:-missing})" >&2; exit 1; }
  fi
  echo "cloud watcher preflight passed: source, runtime, data, model CLIs, git read/write, sudo access, and one release identity are available"
  exit 0
fi

if [ "${1:-}" = "--reconcile-release" ]; then
  reconcile_release
  exit 0
fi

export SB_WATCHER_PRE_SESSION_COMMAND="/usr/bin/bash $SOURCE_ROOT/scripts/ec2-overnight-watcher-run.sh --reconcile-release"
# Release freshness is advisory to the outer watcher. A safe deploy can be
# delayed by another component's lane lock, but that sibling-owned lock must
# never leave the whole night without its last-known-good watcher.
export SB_WATCHER_PRE_SESSION_POLICY=advisory
cd "$RUNTIME_ROOT"
if [ -n "${BRIEFING_DATE:-}" ]; then
  watcher_args=(--data-dir "$DATA_DIR" --date "$BRIEFING_DATE")
  if [ -n "${SB_WATCHER_RECOVERY_ATTEMPT_ID:-}" ]; then
    watcher_args+=(--attempt-id "$SB_WATCHER_RECOVERY_ATTEMPT_ID")
  fi
  exec "$NODE_BIN" scripts/overnight-watcher-launcher.js "${watcher_args[@]}"
fi
exec "$NODE_BIN" scripts/overnight-watcher-launcher.js --data-dir "$DATA_DIR"
