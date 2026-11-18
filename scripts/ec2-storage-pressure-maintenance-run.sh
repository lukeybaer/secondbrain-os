#!/usr/bin/env bash
set -euo pipefail

ROOT_LINK="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
ROOT="$(readlink -f "$ROOT_LINK")"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
SOURCE_ROOT="${SECONDBRAIN_BUILD_PATH_ROOT:-/home/ec2-user/secondbrain-current}"
ROTATE_FILE="/etc/logrotate.d/secondbrain-derived-logs"
# PACKET C (item 2, 2026-09-01): the receipts ledger split into a
# per-briefing-date directory (scripts/lib/dated-jsonl-ledger.js); the pre-
# split flat file (overnight-agentic-healer-runs.jsonl) stays alongside it as
# a bounded legacy fallback. git-janitor.js's pendingCoordinatorWorktrees()
# reads whichever of the two this path is: a directory (new layout) unions a
# bounded lookback window of dated files plus the legacy sibling; a file
# (old layout, or a test fixture) behaves exactly as before.
RECEIPTS="$DATA_DIR/agent/overnight-agentic-healer-runs"

[[ "$(id -u)" == "0" ]] || { echo "[storage-pressure] root is required for all-process cwd proof" >&2; exit 75; }
for required in "$ROOT/scripts/git-janitor.js" "$ROOT/scripts/ec2-storage-pressure-maintenance.js" "$SOURCE_ROOT/.git" "$DATA_DIR/tasks" "$ROTATE_FILE"; do
  [[ -e "$required" ]] || { echo "[storage-pressure] required proof path missing: $required" >&2; exit 75; }
done

/usr/sbin/logrotate "$ROTATE_FILE"

# Root can inspect every /proc/<pid>/cwd. Git's one-process safe.directory
# override permits the audit without mutating repository configuration.
set +e
(cd "$SOURCE_ROOT" && \
  GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=safe.directory \
  GIT_CONFIG_VALUE_0='*' \
  SECONDBRAIN_TASKS_DIR="$DATA_DIR/tasks" \
  SB_GIT_JANITOR_REQUIRE_PROCESS_CWD_PROOF=1 \
  SB_GIT_JANITOR_REQUIRE_COORDINATOR_PROOF=1 \
  SB_GIT_JANITOR_REQUIRE_CLEANUP_BASELINE_PROOF=1 \
  SB_GIT_JANITOR_COORDINATOR_RECEIPTS="$RECEIPTS" \
  SB_GIT_JANITOR_MANIFEST_DIR="$DATA_DIR/agent" \
  /usr/bin/node "$ROOT/scripts/git-janitor.js" --apply --cap=20)
janitor_status=$?
set -e
if [[ "$janitor_status" -ne 0 ]]; then
  echo "[storage-pressure] strict janitor failed; unsafe worktrees were preserved" >&2
  SECONDBRAIN_DATA_DIR="$DATA_DIR" /usr/bin/node "$ROOT/scripts/ec2-storage-pressure-maintenance.js" --sample
  # Bounded qc-receipt/publish-journal/heal-session/recovery-log pruning is
  # independent of worktree safety, so it still runs on a failed janitor pass
  # -- a night the janitor is unhappy is exactly when disk pressure matters most.
  SECONDBRAIN_DATA_DIR="$DATA_DIR" /usr/bin/node "$ROOT/scripts/ec2-storage-pressure-maintenance.js" --retention --apply
  exit "$janitor_status"
fi

SECONDBRAIN_DATA_DIR="$DATA_DIR" /usr/bin/node "$ROOT/scripts/ec2-storage-pressure-maintenance.js" --mark-baseline
SECONDBRAIN_DATA_DIR="$DATA_DIR" /usr/bin/node "$ROOT/scripts/ec2-storage-pressure-maintenance.js" --retention --apply
