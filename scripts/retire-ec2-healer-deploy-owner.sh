#!/usr/bin/env bash
#
# retire-ec2-healer-deploy-owner.sh -- remove the standing healer deploy owner
# (secondbrain-healer-deploy-owner.service and .timer) that S-1b retired with
# its runner (Owner decision: "The agentic healers are deleted"). A host
# upgraded from an earlier release still carries both units, and the timer
# would fire every 5 minutes against a pruned release path. Every release runs
# this step. Atomic release recovery and the next deploy's own
# `release_transaction recover` now cover a crashed swap.
#
# Run ON EC2 (the deploy does this):
#   bash /opt/secondbrain/scripts/retire-ec2-healer-deploy-owner.sh
#
# It touches only the two named units: disable and stop, remove the unit files,
# daemon-reload, then prove both are gone. Idempotent: already absent exits 0.
set -Eeuo pipefail

UNIT_DIR="${HEALER_OWNER_UNIT_DIR:-/etc/systemd/system}"
SYSTEMCTL_BIN="${HEALER_OWNER_SYSTEMCTL_BIN:-systemctl}"
SUDO_BIN="${HEALER_OWNER_SUDO_BIN:-sudo}"
UNITS=(secondbrain-healer-deploy-owner.timer secondbrain-healer-deploy-owner.service)

sc() { "$SUDO_BIN" "$SYSTEMCTL_BIN" "$@"; }

present=0
for unit in "${UNITS[@]}"; do
  [ -e "$UNIT_DIR/$unit" ] && present=1
done
if [ "$present" = "0" ]; then
  for unit in "${UNITS[@]}"; do
    if sc is-active --quiet "$unit" 2>/dev/null || sc is-enabled --quiet "$unit" 2>/dev/null; then
      present=1
    fi
  done
fi
if [ "$present" = "0" ]; then
  echo "Healer deploy owner already retired: no unit file, not enabled, not active."
  exit 0
fi

# Timer first so it cannot re-fire the service while it is being removed.
for unit in "${UNITS[@]}"; do
  sc disable --now "$unit" 2>/dev/null || sc stop "$unit" 2>/dev/null || true
done
for unit in "${UNITS[@]}"; do
  "$SUDO_BIN" rm -f "$UNIT_DIR/$unit"
done
sc daemon-reload
sc reset-failed "${UNITS[@]}" 2>/dev/null || true

failed=0
for unit in "${UNITS[@]}"; do
  if [ -e "$UNIT_DIR/$unit" ]; then
    echo "Post-retire verification failed: $UNIT_DIR/$unit still exists." >&2
    failed=1
  fi
  if sc is-active --quiet "$unit" 2>/dev/null; then
    echo "Post-retire verification failed: $unit is still active." >&2
    failed=1
  fi
  if sc is-enabled --quiet "$unit" 2>/dev/null; then
    echo "Post-retire verification failed: $unit is still enabled." >&2
    failed=1
  fi
done
[ "$failed" = "0" ] || exit 1
echo "Retired the healer deploy owner timer and service; every other unit is unchanged."
