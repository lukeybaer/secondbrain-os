#!/usr/bin/env bash
set -euo pipefail

# One cgroup owns each current-call or retention process tree. The scheduler
# waits for the scope, the kernel applies the wall and aggregate resource
# ceiling, and KillMode=control-group prevents descendants from surviving a
# timeout or failed runner. Historical/global identity has its stricter
# dedicated wrapper in ec2-global-identity-cap-run.sh.

if [[ "$#" -lt 2 ]]; then
  echo "usage: $0 live|retention <runner> [args...]" >&2
  exit 64
fi

KIND="$1"
shift
RUNNER_LINK="$1"
shift
if ! RUNNER="$(readlink -f "$RUNNER_LINK")" || [[ ! -x "$RUNNER" ]]; then
  echo "[otter-lane-scope] refused $KIND lane: cannot pin executable runner $RUNNER_LINK" >&2
  exit 75
fi

case "$KIND" in
  live)
    MEMORY_HIGH="${SB_OTTER_LIVE_MEMORY_HIGH:-1280M}"
    MEMORY_MAX="${SB_OTTER_LIVE_MEMORY_MAX:-1536M}"
    MEMORY_SWAP_MAX="${SB_OTTER_LIVE_MEMORY_SWAP_MAX:-256M}"
    CPU_QUOTA="${SB_OTTER_LIVE_CPU_QUOTA:-150%}"
    TASKS_MAX="${SB_OTTER_LIVE_TASKS_MAX:-256}"
    RUNTIME_MAX="${SB_OTTER_LIVE_RUNTIME_MAX_SEC:-7200}"
    ;;
  retention)
    MEMORY_HIGH="${SB_OTTER_RETENTION_MEMORY_HIGH:-640M}"
    MEMORY_MAX="${SB_OTTER_RETENTION_MEMORY_MAX:-768M}"
    MEMORY_SWAP_MAX="${SB_OTTER_RETENTION_MEMORY_SWAP_MAX:-0}"
    CPU_QUOTA="${SB_OTTER_RETENTION_CPU_QUOTA:-75%}"
    TASKS_MAX="${SB_OTTER_RETENTION_TASKS_MAX:-128}"
    RUNTIME_MAX="${SB_OTTER_RETENTION_RUNTIME_MAX_SEC:-3600}"
    ;;
  *)
    echo "[otter-lane-scope] invalid lane: $KIND" >&2
    exit 64
    ;;
esac

SYSTEMD_RUN="${SYSTEMD_RUN_BIN:-/usr/bin/systemd-run}"
RUNTIME_UID="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$RUNTIME_UID}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if [[ ! "$RUNTIME_MAX" =~ ^[1-9][0-9]*$ ]] || [[ "$RUNTIME_MAX" -gt 14400 ]]; then
  echo "[otter-lane-scope] refused $KIND lane: RuntimeMaxSec must be 1..14400" >&2
  exit 64
fi
if [[ ! -x "$SYSTEMD_RUN" ]]; then
  echo "[otter-lane-scope] refused $KIND lane: $SYSTEMD_RUN is unavailable" >&2
  exit 75
fi
if [[ ! -S "$XDG_RUNTIME_DIR/bus" ]]; then
  echo "[otter-lane-scope] refused $KIND lane: user systemd bus is unavailable at $XDG_RUNTIME_DIR/bus" >&2
  exit 75
fi

unit="secondbrain-otter-${KIND}-$$-$(date +%s).scope"
exec "$SYSTEMD_RUN" \
  --user \
  --scope \
  --quiet \
  "--unit=$unit" \
  "--property=MemoryHigh=$MEMORY_HIGH" \
  "--property=MemoryMax=$MEMORY_MAX" \
  "--property=MemorySwapMax=$MEMORY_SWAP_MAX" \
  "--property=CPUQuota=$CPU_QUOTA" \
  "--property=TasksMax=$TASKS_MAX" \
  "--property=RuntimeMaxSec=${RUNTIME_MAX}s" \
  --property=TimeoutStopSec=30s \
  --property=KillMode=control-group \
  -- \
  /usr/bin/env "SB_OTTER_SCOPE_UNIT=$unit" "$RUNNER" "$@"
