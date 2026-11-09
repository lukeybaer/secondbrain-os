#!/usr/bin/env bash
# touched-tests-gate.sh -- verify step 2e of atomic-release.sh (S-2, 2026-10-29).
#
# Runs, ON the target host, the Vitest files changed between the live release
# and the staged one, against the staged sha, BEFORE the live symlink swap. A
# test that passes on the PC but fails on EC2 (Python 3.9, Amazon Linux) used to
# ship and turn the System Health test row red all night. Exit nonzero blocks
# the release; the failing test names are printed by release-touched-tests.js.
#
#   bash scripts/lib/touched-tests-gate.sh --source-root DIR --sha SHA \
#     --prev-target LIVE_RELEASE_DIR --release-dir STAGED_RELEASE_DIR \
#     --receipt HOST_RECEIPT_FILE [--test-source-root DIR] [--deps-cache DIR] \
#     (--local | --host H --key K)
#
# FAIL CLOSED (Codex review f4b05f7ec4fa): an unprovable roster (unknown or
# unfetchable live sha) or an unprovable run (no exact-release checkout,
# dependencies that cannot be matched or prepared, a batch with no report, a
# roster that did not finish) exits nonzero. The COMPLETE roster runs in
# batches of SB_TOUCHED_TESTS_BATCH_SIZE (default 20) inside one overall
# SB_TOUCHED_TESTS_TIMEOUT_MS budget (default 900000). Every outcome, including
# no touched tests, writes the host receipt named by --receipt. Attended
# emergency override: SB_DEPLOY_SKIP_TOUCHED_TESTS=1 (loud warning, and the
# override itself is written to the receipt).
set -euo pipefail

log() { echo "[touched-tests] $*"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SOURCE_ROOT=""
SHA=""
PREV_TARGET=""
RELEASE_DIR=""
RECEIPT=""
TEST_SOURCE_ROOT="${SB_TOUCHED_TESTS_SOURCE_ROOT:-/home/ec2-user/secondbrain-current}"
DEPS_CACHE="${SB_TOUCHED_TESTS_DEPS_CACHE:-/opt/secondbrain-shared/test-deps}"
LOCAL=0
HOST=""
KEY=""
BATCH_SIZE="${SB_TOUCHED_TESTS_BATCH_SIZE:-20}"
TIMEOUT_MS="${SB_TOUCHED_TESTS_TIMEOUT_MS:-900000}"

while [ $# -gt 0 ]; do
  case "$1" in
    --source-root) SOURCE_ROOT="$2"; shift 2 ;;
    --sha) SHA="$2"; shift 2 ;;
    --prev-target) PREV_TARGET="$2"; shift 2 ;;
    --release-dir) RELEASE_DIR="$2"; shift 2 ;;
    --receipt) RECEIPT="$2"; shift 2 ;;
    --test-source-root) TEST_SOURCE_ROOT="$2"; shift 2 ;;
    --deps-cache) DEPS_CACHE="$2"; shift 2 ;;
    --local) LOCAL=1; shift ;;
    --host) HOST="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    *) echo "[touched-tests] ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SOURCE_ROOT" ] && [ -n "$SHA" ] && [ -n "$RELEASE_DIR" ] && [ -n "$RECEIPT" ] || {
  echo "[touched-tests] ERROR: --source-root, --sha, --release-dir and --receipt are required" >&2
  exit 2
}

HELPER="scripts/lib/release-touched-tests.js"
on_host() {
  if [ "$LOCAL" = "1" ]; then
    bash -c "$1"
  else
    ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "$1"
  fi
}

# Release dirs are named <sha> or <sha>.reland-<ts>-<pid>.
PREV_SHA="$(basename "${PREV_TARGET:-none}" | grep -oiE '^[0-9a-f]{40}' || true)"

if [ "${SB_DEPLOY_SKIP_TOUCHED_TESTS:-0}" = "1" ]; then
  log "WARNING: touched-test gate SKIPPED by SB_DEPLOY_SKIP_TOUCHED_TESTS=1 (attended override); touched tests are unproven on the host"
  on_host "node '$RELEASE_DIR/$HELPER' record-override --release-root '$RELEASE_DIR' --sha '$SHA' --from '$PREV_SHA' --receipt '$RECEIPT' --reason 'SB_DEPLOY_SKIP_TOUCHED_TESTS=1'" || {
    echo "[touched-tests] ERROR: the attended override could not be recorded in the receipt $RECEIPT; refusing to skip unrecorded" >&2
    exit 1
  }
  exit 0
fi

if ! SELECTED="$(node "$SCRIPT_DIR/release-touched-tests.js" select --repo "$SOURCE_ROOT" --from "$PREV_SHA" --to "$SHA")"; then
  echo "[touched-tests] ERROR: the touched-test roster cannot be proved (live ${PREV_TARGET:-<none>} -> $SHA); NOT releasing" >&2
  exit 1
fi
if [ -z "$SELECTED" ]; then
  COUNT=0
  log "no touched test files (live ${PREV_SHA} -> $SHA); recording the empty roster"
else
  COUNT="$(printf '%s\n' "$SELECTED" | grep -c .)"
  log "running all $COUNT touched test file(s) on the target host against the staged release $SHA (batches of $BATCH_SIZE, ${TIMEOUT_MS} ms budget)"
  printf '%s\n' "$SELECTED" | sed 's/^/[touched-tests]   /'
fi
FILES_B64="$(printf '%s' "$SELECTED" | base64 | tr -d '\n\r')"
on_host "node '$RELEASE_DIR/$HELPER' run --release-root '$RELEASE_DIR' --source-root '$TEST_SOURCE_ROOT' --sha '$SHA' --from '$PREV_SHA' --files-b64 '$FILES_B64' --receipt '$RECEIPT' --timeout-ms '$TIMEOUT_MS' --batch-size '$BATCH_SIZE' --deps-cache '$DEPS_CACHE'"
