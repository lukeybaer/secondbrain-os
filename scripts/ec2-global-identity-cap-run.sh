#!/usr/bin/env bash
set -euo pipefail

# One admission boundary for archive-wide/global identity work. Current exact
# calls do not use this wrapper. Historical and global work is excluded from
# the 22:15-05:35 CT briefing reserve and, outside that window, runs in a
# transient user cgroup capped at 512 MB with no swap borrowing.

KIND="${SB_IDENTITY_WORK_KIND:-global}"
MEMORY_MAX="${SB_GLOBAL_IDENTITY_MEMORY_MAX:-512M}"
MEMORY_SWAP_MAX="${SB_GLOBAL_IDENTITY_MEMORY_SWAP_MAX:-0}"
SYSTEMD_RUN="${SYSTEMD_RUN_BIN:-/usr/bin/systemd-run}"
HHMM="${SB_IDENTITY_CT_HHMM:-$(TZ=America/Chicago date +%H%M)}"

if [ "$#" -lt 1 ]; then
  echo "usage: SB_IDENTITY_WORK_KIND=global|historical $0 <command> [args...]" >&2
  exit 64
fi
if ! [[ "$HHMM" =~ ^[0-2][0-9][0-5][0-9]$ ]]; then
  echo "[identity-cap] invalid CT HHMM value: $HHMM" >&2
  exit 64
fi

minutes=$((10#${HHMM:0:2} * 60 + 10#${HHMM:2:2}))
briefing_start=$((22 * 60 + 15))
briefing_end=$((5 * 60 + 35))
if [ "$minutes" -ge "$briefing_start" ] || [ "$minutes" -lt "$briefing_end" ]; then
  echo "[identity-cap] deferred $KIND identity work at ${HHMM} CT; 22:15-05:35 is reserved for the briefing and current exact calls"
  exit 0
fi

if [ "${SB_IDENTITY_CAP_DRY_RUN:-0}" = "1" ]; then
  echo "[identity-cap] DRY-RUN kind=$KIND MemoryMax=$MEMORY_MAX MemorySwapMax=$MEMORY_SWAP_MAX command=$*"
  exit 0
fi
if [ ! -x "$SYSTEMD_RUN" ]; then
  echo "[identity-cap] refused $KIND identity work: $SYSTEMD_RUN is unavailable, so the 512 MB ceiling cannot be enforced" >&2
  exit 75
fi

unit="secondbrain-${KIND}-identity-$$-$(date +%s).scope"
exec "$SYSTEMD_RUN" \
  --user \
  --scope \
  --quiet \
  "--unit=$unit" \
  "--property=MemoryHigh=$MEMORY_MAX" \
  "--property=MemoryMax=$MEMORY_MAX" \
  "--property=MemorySwapMax=$MEMORY_SWAP_MAX" \
  --property=CPUQuota=100% \
  --property=TasksMax=128 \
  --property=RuntimeMaxSec=7200s \
  --property=TimeoutStopSec=30s \
  --property=KillMode=control-group \
  -- \
  /usr/bin/env SB_IDENTITY_CAP_ACTIVE=1 "$@"
