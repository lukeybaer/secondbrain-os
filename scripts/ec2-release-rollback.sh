#!/usr/bin/env bash
# ec2-release-rollback.sh -- the EXECUTABLE post-success rollback for /opt/secondbrain.
#
# ============================================================================
# WHY THIS EXISTS
# ============================================================================
# scripts/lib/atomic-release.sh has a rollback, but it only exists DURING a
# failing deploy invocation. rollback_symlink() is a function inside that
# process and only fires when the swap, the durable-wiring assertion, a pm2
# restart, or the post-restart /health probe fails before the primitive
# returns. Once the primitive exits green, PREV_TARGET is gone with the process.
#
# scripts/deploy-ec2-server.sh then keeps going for another 200 lines AFTER the
# swap is live: receipt mirror, exact-call ownership, cutover activation,
# indexed Graphiti, Neo4j cap, cron normalization, healer schedules, the
# scheduled-skill canary, build-path sync, parity, release closure. Several of
# those exit 1, and they do so DELIBERATELY leaving the new release live
# ("the health-verified release remains live, but deployment is incomplete").
# That is the right default for a partially-closed deploy, but it means that
# after the deploy process ends there is NO executable way to put /opt back.
#
# Codex gated-deploy review 2026-08-02 raised exactly this, confirmed twice, as
# the last blocker on activating the EC2 night supervisor: an unattended
# supervisor may not be allowed to deploy while the only rollback is a human
# retyping ln -sfn from memory at 3 AM.
#
# This script is that missing executable. It is the SECOND writer of the
# $OPT_LINK symlink and it uses the SAME mechanism the sole release writer uses
# (ln -sfn), the SAME durable-wiring assertion, the SAME pm2 follower
# inventory, and the SAME /health probe, so a rolled-back host is
# indistinguishable from a host the atomic release itself rolled back.
#
# ============================================================================
# THE RULES IT WILL NOT BEND
# ============================================================================
#  1. NEVER roll back blind. --expect-live <full-sha> is REQUIRED and the live
#     release must actually resolve to that sha, or nothing is touched. An
#     operator who is wrong about what is live must not discover it by moving
#     production.
#  2. The target comes from the RETAINED set, in the pruner's own vocabulary
#     (scripts/prune-atomic-releases.js RELEASE_NAME + direct-child enumeration),
#     never from a free-form path. Default: the newest retained release strictly
#     older than live that is PROVEN to have been live.
#     WHY PROVEN (Codex review 2026-08-02, high): atomic-release.sh stages
#     <releases-root>/<sha> BEFORE it verifies the tree and leaves the directory
#     behind when verification fails. "Newest retained older directory" alone
#     can therefore select a release that never passed a gate and never served
#     a request. Proof comes from data/agent/ec2-deploy-receipts.jsonl (written
#     the instant a swap goes live) plus this script's own ok receipts.
#     --allow-unproven-target is the explicit, receipted override.
#  3. One writer at a time, and the live link is re-read under the lock right
#     before the swap. A rollback that resolved against a live release which a
#     concurrent deploy has since replaced must refuse, not overwrite it.
#     KNOWN RESIDUAL RISK (Codex review 2026-08-03, open): this script takes
#     $SWAP_LOCK and refuses while a deploy holds $DEPLOY_LOCK, but
#     scripts/lib/atomic-release.sh does NOT yet take $SWAP_LOCK, so mutual
#     exclusion is one-sided. The recheck under the lock closes the common case
#     (a deploy that already landed) but not a deploy that swaps inside this
#     script's window. Closing it means teaching the release primitive to take
#     the same lock, which is a change to the live release path and is
#     deliberately not made here.
#  4. A rollback that does not come up green is itself a failure. If the target
#     fails durable-wiring verification, a pm2 restart, or /health, this rolls
#     FORWARD to the original release, restarts the stack again, and fails loud.
#     Being stuck on a bad-but-known release beats being stuck on two. The
#     restore is PROVEN by re-reading the link, never assumed: a failed second
#     swap is receipted as restoreVerified=false with the target still live.
#  5. Every attempt that could have touched the live link appends one durable
#     JSON line to data/agent/ec2-release-rollbacks.jsonl. A refusal that
#     provably touched nothing (bad --expect-live, unresolvable target, lock
#     contention) fails loud on stderr without writing a row.
#
# ============================================================================
# USAGE (no interactive prompts, safe over ssh, safe as a cron/supervisor child)
#
#   bash scripts/ec2-release-rollback.sh --expect-live <full-sha> [--to <sha|dir>]
#        [--local] [--host user@host] [--key PATH] [--releases-root DIR]
#        [--opt-link DIR] [--shared-root DIR] [--shared-data DIR]
#        [--durable-logs DIR] [--durable-root DIR] [--data-dir DIR]
#        [--health-port N] [--reason TEXT]
#
#   --expect-live  REQUIRED full 40-char sha the live release MUST resolve to.
#   --to           full sha or a release directory to roll back TO. Default is
#                  the newest PROVEN-LIVE retained release older than live.
#   --allow-unproven-target
#                  accept a retained release with no proven-live receipt. Loud,
#                  recorded on the receipt, and never the default.
#   --local        run on this box (use this ON EC2). Default is ssh to --host.
#   --data-dir     runtime data root for the receipt. Default <opt-link>/data,
#                  which resolves through the release into the shared data dir.
#   --reason       free text recorded on the receipt.
#
# TEST SEAMS (production defaults are the real binaries; these exist so the
# behavioral suite can run the REAL script against a synthetic release tree on
# a host without symlink privilege or pm2):
#   SB_LINK_BIN (ln)  SB_PM2_BIN (pm2)  SB_CURL_BIN (curl)  SB_NODE_BIN (node)
#   SB_HEALTH_ATTEMPTS (10)  SB_HEALTH_INTERVAL (3)  SB_ROLLBACK_STAGE_ROOT
# ============================================================================
set -euo pipefail

log() { echo "[release-rollback] $*"; }
warn() { echo "[release-rollback] WARN: $*" >&2; }
die() {
  echo "[release-rollback] ERROR: $*" >&2
  exit 1
}

# Resolve the repo/release root from THIS file, never from git: the script must
# also run from inside /opt/secondbrain, which is a git-archived tree with no
# .git directory at all.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

EXPECT_LIVE=""
TO=""
REASON=""
HOST="${SB_DEPLOY_HOST:-ec2-user@ExampleCo}"
KEY="${SB_KEY:-$HOME/.ssh/sb-key.pem}"
[ -f "$KEY" ] || KEY="$HOME/.ssh/secondbrain-backend-key.pem"
RELEASES_ROOT="${SB_RELEASES_ROOT:-/opt/secondbrain-releases}"
OPT_LINK="${SB_OPT_LINK:-/opt/secondbrain}"
SHARED_ROOT="${SB_SHARED_ROOT:-/opt/secondbrain-shared}"
SHARED_DATA="${SB_SHARED_DATA:-}"
DURABLE_LOGS="${SB_DURABLE_LOGS:-}"
DURABLE_ROOT="${SB_DURABLE_ROOT:-}"
DATA_DIR=""
HEALTH_PORT="${SB_HEALTH_PORT:-3001}"
PM2_APP="${SB_PM2_APP:-secondbrain-backend}"
# The SAME follower inventory scripts/lib/atomic-release.sh restarts on a swap.
# Files on disk are not a deployed rollback while an old Node process still
# holds the newer release's modules in memory.
PM2_FOLLOWER_APPS="${SB_PM2_FOLLOWER_APPS:-otter-ingest dispatch-processor ec2-spine-worker callback-watchdog gmail-amy-scan}"
SYSTEMD_FOLLOWER_UNITS="${SB_SYSTEMD_FOLLOWER_UNITS:-signal-ingest-amy.service signal-flow-healer-amy.timer}"
# The SAME durable list atomic-release wires and verifies.
DURABLE_SHARED="${SB_DURABLE_SHARED:-logs|dir|preserve .env|file|secret secrets.env|file|secret .yt-dlp-cookies.txt|file|secret content-review|dir|seeded empire|dir|preserve .auto-memory|dir|preserve}"
LOCAL=0
ALLOW_UNPROVEN=0
# Serializes every live-link writer on the host. mkdir is atomic everywhere,
# including boxes without flock, so this works on EC2 and in test layouts.
SWAP_LOCK="${SB_RELEASE_SWAP_LOCK:-/tmp/secondbrain-release-swap.lock}"
SWAP_LOCK_WAIT="${SB_RELEASE_SWAP_LOCK_WAIT:-30}"
# deploy-ec2-server.sh owns this token file for the length of a deploy.
DEPLOY_LOCK="${SB_DEPLOY_LOCK:-/tmp/secondbrain-deploy.lock}"

NODE_BIN="${SB_NODE_BIN:-node}"
LINK_BIN="${SB_LINK_BIN:-ln}"
PM2_BIN="${SB_PM2_BIN:-pm2}"
CURL_BIN="${SB_CURL_BIN:-curl}"
HEALTH_ATTEMPTS="${SB_HEALTH_ATTEMPTS:-10}"
HEALTH_INTERVAL="${SB_HEALTH_INTERVAL:-3}"

while [ $# -gt 0 ]; do
  case "$1" in
    --expect-live) EXPECT_LIVE="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --releases-root) RELEASES_ROOT="$2"; shift 2 ;;
    --opt-link) OPT_LINK="$2"; shift 2 ;;
    --shared-root) SHARED_ROOT="$2"; shift 2 ;;
    --shared-data) SHARED_DATA="$2"; shift 2 ;;
    --durable-logs) DURABLE_LOGS="$2"; shift 2 ;;
    --durable-root) DURABLE_ROOT="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --health-port) HEALTH_PORT="$2"; shift 2 ;;
    --allow-unproven-target) ALLOW_UNPROVEN=1; shift ;;
    --local) LOCAL=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$EXPECT_LIVE" ] || die "--expect-live <full-sha> is REQUIRED; this rollback never runs blind"

# Same derivation rules as scripts/lib/atomic-release.sh, so a --local test
# layout stays self-contained and production keeps its pinned durable homes.
[ -n "$SHARED_DATA" ] || SHARED_DATA="$SHARED_ROOT/data"
if [ -z "$DURABLE_LOGS" ]; then
  if [ "$SHARED_ROOT" = "/opt/secondbrain-shared" ]; then
    DURABLE_LOGS="/opt/secondbrain-logs"
  else
    DURABLE_LOGS="$SHARED_ROOT/logs"
  fi
fi
if [ -z "$DURABLE_ROOT" ]; then
  if [ "$SHARED_ROOT" = "/opt/secondbrain-shared" ]; then
    DURABLE_ROOT="/opt/secondbrain-durable"
  else
    DURABLE_ROOT="$SHARED_ROOT/durable"
  fi
fi
[ -n "$DATA_DIR" ] || DATA_DIR="$OPT_LINK/data"

# Run-scoped caller state must never reach a live service: `pm2 restart
# --update-env` copies this shell's environment into it. Same list as
# scripts/lib/service-env-scrub.js (parity pinned by service-env-scrub.test.js).
scrub_run_scoped_env() {
  local name
  for name in $(compgen -e); do
    case "$name" in
      CARD_CONTROLLER_*|BRIEFING_CONTROLLER_*|BRIEFING_CARD_CONTROLLER_*|BRIEFING_NIGHT_*|CLAUDE_CODE_MESSAGING_*|CLAUDE_CODE_SESSION_*|BRIEFING_DATE|BRIEFING_HUMAN_ACTION_TOKEN|AMY_NIGHT_OWNER|CLAUDECODE|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXECPATH|CLAUDE_EFFORT|CLAUDE_PID|CODEX_CI|CODEX_SESSION_ID|CODEX_THREAD_ID) unset "$name" ;;
    esac
  done
}
scrub_run_scoped_env

# ---- run helpers: --local runs on this box; otherwise over ssh --------------
sh_run() {
  if [ "$LOCAL" = "1" ]; then
    bash -c "$1"
  else
    ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "$1"
  fi
}

target_copy() {
  if [ "$LOCAL" = "1" ]; then
    cp "$1" "$2"
  else
    scp -i "$KEY" -o StrictHostKeyChecking=no "$1" "$HOST:$2"
  fi
}

# ---- stage the decision helper on the TARGET, outside the live release -----
# Same shape as the voice-provenance preflight in deploy-ec2-server.sh. The
# release we are rolling AWAY from may be exactly the broken thing, so the
# rollback must not load its own decision logic out of it.
STAGE_ROOT="${SB_ROLLBACK_STAGE_ROOT:-}"
if [ -z "$STAGE_ROOT" ]; then
  if [ "$LOCAL" = "1" ]; then STAGE_ROOT="${TMPDIR:-/tmp}"; else STAGE_ROOT="/tmp"; fi
fi
STAGE_DIR="$STAGE_ROOT/secondbrain-release-rollback-$$"
SWAP_LOCK_OWNED=0
cleanup_run() {
  sh_run "rm -rf '$STAGE_DIR'" >/dev/null 2>&1 || true
  if [ "$SWAP_LOCK_OWNED" = "1" ]; then
    sh_run "rm -rf '$SWAP_LOCK'" >/dev/null 2>&1 || true
    SWAP_LOCK_OWNED=0
  fi
}
trap cleanup_run EXIT

# ---- ONE writer at a time -------------------------------------------------
# Codex review 2026-08-02, high finding: --expect-live was proven once and the
# swap happened later with nothing serializing the two, so a concurrent deploy
# could go live in between and be silently overwritten (and then rolled forward
# onto an even older target). Take an exclusive host lock BEFORE resolving, hold
# it through the swap, and refuse outright while a deploy owns its own lock.
if sh_run "[ -f '$DEPLOY_LOCK' ]"; then
  die "REFUSED: a deploy owns $DEPLOY_LOCK right now. Wait for it to finish, then re-run with the sha it left live. $OPT_LINK is untouched."
fi
lock_attempt=0
until sh_run "mkdir '$SWAP_LOCK' 2>/dev/null"; do
  lock_attempt=$((lock_attempt + 1))
  if [ "$lock_attempt" -ge "$SWAP_LOCK_WAIT" ]; then
    die "REFUSED: could not take the release swap lock $SWAP_LOCK after ${SWAP_LOCK_WAIT}s; another live-link writer holds it. $OPT_LINK is untouched."
  fi
  sleep 1
done
SWAP_LOCK_OWNED=1
sh_run "printf '%s\n' 'ec2-release-rollback pid $$' > '$SWAP_LOCK/owner'" >/dev/null 2>&1 || true
log "swap lock acquired: $SWAP_LOCK"

sh_run "rm -rf '$STAGE_DIR' && mkdir -p '$STAGE_DIR/scripts/lib'" \
  || die "could not prepare the bounded rollback stage dir $STAGE_DIR"
target_copy "$ROOT/scripts/lib/ec2-release-rollback.js" "$STAGE_DIR/scripts/lib/ec2-release-rollback.js" \
  || die "could not stage the rollback resolver"
target_copy "$ROOT/scripts/prune-atomic-releases.js" "$STAGE_DIR/scripts/prune-atomic-releases.js" \
  || die "could not stage the retained-release vocabulary (prune-atomic-releases.js)"
HELPER="$STAGE_DIR/scripts/lib/ec2-release-rollback.js"

# ---- 1. RESOLVE: prove what is live, then choose the target -----------------
log "resolving: expect-live=$EXPECT_LIVE to=${TO:-<newest retained release older than live>} releases=$RELEASES_ROOT link=$OPT_LINK"
if ! RESOLUTION="$(sh_run "SB_ROLLBACK_RELEASES_ROOT='$RELEASES_ROOT' SB_ROLLBACK_LIVE_LINK='$OPT_LINK' SB_ROLLBACK_EXPECT_LIVE='$EXPECT_LIVE' SB_ROLLBACK_TO='$TO' SB_ROLLBACK_DATA_DIR='$DATA_DIR' SB_ROLLBACK_ALLOW_UNPROVEN='$ALLOW_UNPROVEN' $NODE_BIN '$HELPER' --mode resolve")"; then
  die "REFUSED: the rollback target could not be proven (named reason above). $OPT_LINK is untouched."
fi

PREV_TARGET="$(printf '%s\n' "$RESOLUTION" | sed -n 1p)"
FROM_SHA="$(printf '%s\n' "$RESOLUTION" | sed -n 2p)"
FROM_RELEASE="$(printf '%s\n' "$RESOLUTION" | sed -n 3p)"
TARGET_DIR="$(printf '%s\n' "$RESOLUTION" | sed -n 4p)"
TO_SHA="$(printf '%s\n' "$RESOLUTION" | sed -n 5p)"
TO_RELEASE="$(printf '%s\n' "$RESOLUTION" | sed -n 6p)"
TARGET_PROVEN="$(printf '%s\n' "$RESOLUTION" | sed -n 7p)"
if [ -z "$PREV_TARGET" ] || [ -z "$TARGET_DIR" ] || [ -z "$FROM_SHA" ] || [ -z "$TO_SHA" ]; then
  die "REFUSED: the resolver returned an incomplete answer (fail closed). $OPT_LINK is untouched."
fi
log "live now: $FROM_RELEASE ($PREV_TARGET)"
log "rolling back to: $TO_RELEASE ($TARGET_DIR), proven-live=${TARGET_PROVEN:-0}"
if [ "$TARGET_PROVEN" != "1" ]; then
  warn "target $TO_RELEASE has NO proven-live receipt and is being accepted only because --allow-unproven-target was passed"
fi

# ---- shared stack operations (identical to the atomic release's) -----------
FOLLOWERS_RESTARTED=""
FOLLOWERS_SKIPPED=""
HEALTH_CODE=""
SWAP_HEALTH_CODE=""

restart_stack() {
  FOLLOWERS_RESTARTED=""
  FOLLOWERS_SKIPPED=""
  if ! sh_run "$PM2_BIN restart '$PM2_APP' --update-env >/dev/null 2>&1"; then
    return 1
  fi
  local follower
  for follower in $PM2_FOLLOWER_APPS; do
    if sh_run "$PM2_BIN describe '$follower' >/dev/null 2>&1"; then
      if ! sh_run "SECONDBRAIN_DATA_DIR='$SHARED_DATA' $PM2_BIN restart '$follower' --update-env >/dev/null 2>&1"; then
        return 1
      fi
      FOLLOWERS_RESTARTED="${FOLLOWERS_RESTARTED} $follower"
    else
      FOLLOWERS_SKIPPED="${FOLLOWERS_SKIPPED} $follower"
    fi
  done
  local unit
  for unit in $SYSTEMD_FOLLOWER_UNITS; do
    if sh_run "systemctl cat '$unit' >/dev/null 2>&1"; then
      if ! sh_run "sudo -n systemctl restart '$unit' >/dev/null 2>&1"; then
        return 1
      fi
      FOLLOWERS_RESTARTED="${FOLLOWERS_RESTARTED} $unit"
    else
      FOLLOWERS_SKIPPED="${FOLLOWERS_SKIPPED} $unit"
    fi
  done
  return 0
}

health_probe() {
  local snippet
  snippet="code=000; i=0; while [ \$i -lt $HEALTH_ATTEMPTS ]; do i=\$((i+1)); if [ $HEALTH_INTERVAL -gt 0 ]; then sleep $HEALTH_INTERVAL; fi; code=\$($CURL_BIN -s -o /dev/null -w '%{http_code}' -m 8 'http://127.0.0.1:$HEALTH_PORT/health' 2>/dev/null || echo 000); if [ \"\$code\" = '200' ]; then break; fi; done; printf '%s' \"\$code\""
  HEALTH_CODE="$(sh_run "$snippet" 2>/dev/null || true)"
  [ "$HEALTH_CODE" = "200" ]
}

# The same post-swap assertion atomic-release runs before restarting: every
# DURABLE_SHARED name must resolve THROUGH the live link to its durable home,
# and that home (or its parent, for a not-yet-created durable file) must be
# writable. Paths only, never contents.
verify_durable_wiring() {
  local spec name durable
  for spec in $DURABLE_SHARED; do
    name="${spec%%|*}"
    if [ "$name" = "logs" ]; then durable="$DURABLE_LOGS"; else durable="$DURABLE_ROOT/$name"; fi
    sh_run "
      if [ ! -L '$OPT_LINK/$name' ]; then
        echo '[release-rollback] durable wiring BROKEN post-swap: $OPT_LINK/$name is not a symlink' >&2
        exit 1
      fi
      want=\"\$(readlink -f '$durable' 2>/dev/null || echo '$durable')\"
      got=\"\$(readlink -f '$OPT_LINK/$name' 2>/dev/null || true)\"
      if [ \"\$got\" != \"\$want\" ]; then
        echo \"[release-rollback] durable wiring BROKEN post-swap: $OPT_LINK/$name resolves to \${got:-<nothing>} (want \$want)\" >&2
        exit 1
      fi
      if [ -e '$durable' ]; then
        [ -w '$durable' ] || { echo '[release-rollback] durable target not writable: $durable' >&2; exit 1; }
      else
        parent=\"\$(dirname '$durable')\"
        [ -w \"\$parent\" ] || { echo \"[release-rollback] durable parent not writable: \$parent\" >&2; exit 1; }
      fi
    " || return 1
  done
  return 0
}

# The live release, as a PHYSICAL directory identity. `cd ... && pwd -P`
# rather than `readlink -f` on purpose: readlink resolves links but does not
# normalize path vocabulary, so a caller-supplied path and a link-resolved one
# can name the same directory as two different strings. Comparing those raw
# strings would refuse a perfectly good rollback (or, on a host where the two
# happen to agree, hide a real live-target change).
live_target_now() { sh_run "cd '$OPT_LINK' 2>/dev/null && pwd -P || true" 2>/dev/null || true; }

# True when the live link currently resolves to the SAME directory as $1.
live_is() {
  sh_run "
    want=\"\$(cd '$1' 2>/dev/null && pwd -P || true)\"
    got=\"\$(cd '$OPT_LINK' 2>/dev/null && pwd -P || true)\"
    [ -n \"\$want\" ] && [ \"\$got\" = \"\$want\" ]
  " >/dev/null 2>&1
}

RECEIPT_LINE=""
write_receipt() {
  local status="$1" rolled="$2" forward_health="$3" reason="$4" restore_verified="$5"
  # Single quotes are the only quoting in the remote command, so strip them.
  reason="${reason//\'/}"
  local live_after
  live_after="$(live_target_now)"
  local cmd
  cmd="SB_ROLLBACK_STATUS='$status'"
  cmd="$cmd SB_ROLLBACK_EXPECT_LIVE='$EXPECT_LIVE'"
  cmd="$cmd SB_ROLLBACK_FROM_SHA='$FROM_SHA' SB_ROLLBACK_FROM_RELEASE='$FROM_RELEASE'"
  cmd="$cmd SB_ROLLBACK_TO_SHA='$TO_SHA' SB_ROLLBACK_TO_RELEASE='$TO_RELEASE'"
  cmd="$cmd SB_ROLLBACK_OPT_LINK='$OPT_LINK' SB_ROLLBACK_LIVE_AFTER='$live_after'"
  cmd="$cmd SB_ROLLBACK_FOLLOWERS='$FOLLOWERS_RESTARTED' SB_ROLLBACK_FOLLOWERS_SKIPPED='$FOLLOWERS_SKIPPED'"
  cmd="$cmd SB_ROLLBACK_HEALTH_CODE='$SWAP_HEALTH_CODE'"
  cmd="$cmd SB_ROLLBACK_ROLLED_FORWARD='$rolled' SB_ROLLBACK_FORWARD_HEALTH='$forward_health'"
  cmd="$cmd SB_ROLLBACK_RESTORE_VERIFIED='$restore_verified' SB_ROLLBACK_TARGET_PROVEN='${TARGET_PROVEN:-0}'"
  cmd="$cmd SB_ROLLBACK_REASON='$reason' SB_ROLLBACK_DATA_DIR='$DATA_DIR'"
  cmd="$cmd $NODE_BIN '$HELPER' --mode receipt"
  if ! RECEIPT_LINE="$(sh_run "$cmd")"; then
    warn "could not append the rollback receipt to $DATA_DIR/agent/ec2-release-rollbacks.jsonl"
    return 1
  fi
  log "receipt: $RECEIPT_LINE"
  return 0
}

# A rollback whose target does not come up green is a failure, not a result.
# Roll FORWARD to the release that was live when this started, restart the same
# stack, probe health again, receipt the whole attempt, and exit nonzero.
#
# Codex review 2026-08-02, high finding: a failed second swap used to only warn,
# and the receipt still claimed a successful roll forward. The restore is now
# PROVEN by re-reading the live link, and an unproven restore is the loudest
# outcome this script has, because production is then still on the bad target.
roll_forward() {
  local why="$1"
  local pre_followers="$FOLLOWERS_RESTARTED" pre_skipped="$FOLLOWERS_SKIPPED"
  warn "ROLL FORWARD: $why"
  warn "ROLL FORWARD: restoring $OPT_LINK -> $PREV_TARGET ($FROM_RELEASE)"
  sh_run "$LINK_BIN -sfn '$PREV_TARGET' '$OPT_LINK'" \
    || warn "the restoring symlink write itself failed"

  local restored_to restore_verified=0
  restored_to="$(live_target_now)"
  if live_is "$PREV_TARGET"; then
    restore_verified=1
  fi

  local restart_ok=1
  restart_stack || {
    restart_ok=0
    warn "pm2 restart failed while rolling forward to $FROM_RELEASE"
  }
  local forward_health="red"
  if health_probe; then forward_health="green"; fi
  FOLLOWERS_RESTARTED="$pre_followers"
  FOLLOWERS_SKIPPED="$pre_skipped"
  [ "$restart_ok" = "1" ] || restore_verified=0

  local receipt_note=""
  write_receipt failed 1 "$forward_health" "$why" "$restore_verified" \
    || receipt_note=" NO RECEIPT WAS WRITTEN: record this attempt in $DATA_DIR/agent/ec2-release-rollbacks.jsonl by hand."
  if [ "$restore_verified" = "1" ]; then
    die "ROLLBACK FAILED: $why. Rolled FORWARD to the original release $FROM_RELEASE, restore VERIFIED (health $forward_health).$receipt_note"
  fi
  die "ROLLBACK FAILED and the ROLL FORWARD COULD NOT BE PROVEN: $why. $OPT_LINK resolves to ${restored_to:-<unreadable>}, wanted $PREV_TARGET. PRODUCTION MAY STILL BE ON THE ROLLBACK TARGET $TO_RELEASE. Fix the link by hand now.$receipt_note"
}

# ---- 2. ATOMIC SWAP: ln -sfn, the same mechanism atomic-release.sh uses -----
# Re-read the live link UNDER THE LOCK. The resolver proved --expect-live a few
# lines ago; this proves nothing moved since, so a concurrent writer that beat
# us here is refused instead of overwritten.
LIVE_BEFORE_SWAP="$(live_target_now)"
if ! live_is "$PREV_TARGET"; then
  die "REFUSED: the live release changed after it was proven. expected $PREV_TARGET, found ${LIVE_BEFORE_SWAP:-<unreadable>}. $OPT_LINK is untouched. Re-run with the sha that is actually live."
fi

log "swap: $LINK_BIN -sfn $TARGET_DIR -> $OPT_LINK (atomic)"
if ! sh_run "$LINK_BIN -sfn '$TARGET_DIR' '$OPT_LINK'"; then
  # A command that exited nonzero is NOT proof it changed nothing: it may have
  # removed the old link and failed to write the new one. Re-prove the live
  # target before claiming production is untouched.
  if live_is "$PREV_TARGET"; then
    write_receipt failed 0 "" "symlink swap failed; live target proven unchanged" 1 || true
    die "symlink swap failed; live target PROVEN unchanged (still $FROM_RELEASE). Nothing was rolled back."
  fi
  roll_forward "symlink swap failed AND $OPT_LINK no longer resolves to $FROM_RELEASE"
fi

# ---- 3. the SAME post-swap verification the deploy runs ---------------------
log "verify: durable wiring resolves through $OPT_LINK post-swap (every DURABLE_SHARED name)"
if ! verify_durable_wiring; then
  roll_forward "post-swap durable-wiring verification FAILED on $TO_RELEASE"
fi

log "restart: pm2 restart $PM2_APP plus every installed follower"
if ! restart_stack; then
  roll_forward "pm2 restart FAILED after rolling back to $TO_RELEASE"
fi

log "health: probing http://127.0.0.1:$HEALTH_PORT/health after restart"
if ! health_probe; then
  SWAP_HEALTH_CODE="$HEALTH_CODE"
  roll_forward "post-restart /health returned HTTP ${HEALTH_CODE:-000} on $TO_RELEASE"
fi
SWAP_HEALTH_CODE="$HEALTH_CODE"

# ---- 4. durable receipt ----------------------------------------------------
if ! write_receipt ok 0 "" "$REASON" 1; then
  die "rolled back to $TO_RELEASE and it is healthy, but the receipt could not be written. Repair $DATA_DIR/agent/ec2-release-rollbacks.jsonl and record this rollback."
fi

log "OK: rolled back $FROM_SHA -> $TO_SHA. $OPT_LINK -> $TARGET_DIR, pm2 restarted, /health 200."
log "NOTE: the release you rolled away from is still retained; redeploy deliberately, do not assume the next deploy knows about this."
