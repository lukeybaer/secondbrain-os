#!/usr/bin/env bash
#
# ec2-otter-recluster-rebuild-run.sh -- the ONE verified write path for the
# global recluster rebuild, used by both the attended one-off and the nightly
# cron tail. Binds the isolation proofs the receipt requires: pins the
# immutable release root, drains and blocks both healer scheduler lanes,
# owns the chain flock and identity cap scope (reentrantly when the nightly
# cron already holds them), and refuses to succeed unless THIS invocation
# appended a passing receipt, so a cap-window deferral or flock skip reads as
# failure. The node controller additionally refuses --write without the cap
# marker and creates the TTL'd healer pause files for the duration.
#
#   /opt/secondbrain/scripts/ec2-otter-recluster-rebuild-run.sh --write
set -euo pipefail

# Pin the physical release before anything else so a mid-run deploy cannot
# split this rebuild across two releases.
ROOT="$(readlink -f "${SECONDBRAIN_ROOT:-/opt/secondbrain}")"
if [ ! -f "$ROOT/scripts/otter-recluster-rebuild-once.js" ]; then
  echo "[rebuild-run] refused: $ROOT does not look like a deployed release" >&2
  exit 75
fi
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
LOCK="/tmp/secondbrain-voice-global-recluster.lock"
INVOCATION_ID="rebuild-$(date +%s)-$$"
EXPECT_WRITE_FLAG=""
for arg in "$@"; do
  [ "$arg" = "--write" ] && EXPECT_WRITE_FLAG="--expect-write"
done
cd "$ROOT"

# Drain the healer lanes: wait for any in-flight pass to finish, then hold
# both scheduler locks for the whole rebuild so no new pass can start. The
# TTL'd pause files (created by the controller) are the second layer.
VP_DIR="$DATA_DIR/life-archive/voiceprints"
mkdir -p "$VP_DIR"
exec 8>"$VP_DIR/otter-call-healer-live-scheduler.lock"
exec 9>"$VP_DIR/otter-call-healer-historical-scheduler.lock"
if ! flock -w 900 8 || ! flock -w 900 9; then
  echo "[rebuild-run] FAILED: healer lanes did not drain within 15 minutes" >&2
  exit 1
fi

run_controller() {
  if [ "${SB_IDENTITY_CAP_ACTIVE:-0}" = "1" ]; then
    # Reentrant path: the nightly cron line already owns the chain flock and
    # this process already runs inside the identity cap scope. A nested
    # systemd scope would ESCAPE the outer cgroup, so run the controller
    # directly.
    env SB_REBUILD_INVOCATION_ID="$INVOCATION_ID" SECONDBRAIN_DATA_DIR="$DATA_DIR" \
      /usr/bin/node "$ROOT/scripts/otter-recluster-rebuild-once.js" "$@"
  else
    flock -n "$LOCK" env \
      SB_IDENTITY_WORK_KIND=global \
      SB_GLOBAL_IDENTITY_MEMORY_MAX="${SB_GLOBAL_IDENTITY_MEMORY_MAX:-2048M}" \
      SB_GLOBAL_IDENTITY_MEMORY_SWAP_MAX="${SB_GLOBAL_IDENTITY_MEMORY_SWAP_MAX:-1024M}" \
      SECONDBRAIN_DATA_DIR="$DATA_DIR" \
      SB_REBUILD_INVOCATION_ID="$INVOCATION_ID" \
      "$ROOT/scripts/ec2-global-identity-cap-run.sh" \
      /usr/bin/node "$ROOT/scripts/otter-recluster-rebuild-once.js" "$@"
  fi
}

set +e
run_controller "$@"
run_status=$?
set -e

# The terminal condition is the receipt, not the exit code: a reserve-window
# deferral or flock skip exits 0 without doing anything, and only a receipt
# from this exact invocation id proves the run reached an accepted end.
if /usr/bin/node "$ROOT/scripts/otter-recluster-rebuild-once.js" \
  --verify-receipt "$INVOCATION_ID" $EXPECT_WRITE_FLAG; then
  echo "[rebuild-run] invocation $INVOCATION_ID verified (runner status $run_status)"
  exit 0
fi
echo "[rebuild-run] FAILED: invocation $INVOCATION_ID has no passing receipt (runner status $run_status)" >&2
exit 1
