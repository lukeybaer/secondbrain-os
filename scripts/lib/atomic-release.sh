#!/usr/bin/env bash
# atomic-release.sh -- the SOLE writer of /opt/secondbrain releases.
#
# ============================================================================
# WHY THIS EXISTS
# ============================================================================
# The PM2 backend runs from /opt/secondbrain. Historically THREE code paths
# mutated that live directory FILE-BY-FILE and then `pm2 restart`:
#   1. scripts/deploy-ec2-server.sh   (scp loop of server twins + LIVE_DEPS)
#   2. scripts/health-self-heal.js    (healEc2DeployDrift: scp ONE file, restart)
#   3. scripts/overnight-self-heal-orchestrator.js (copies only a commit's delta)
# Any of them could leave /opt in a half-written state where an entrypoint is
# newer than a lib it needs, so PM2 loads it and crash-loops with
# "X is not a function" / MODULE_NOT_FOUND. require-scan-check.js only RESOLVES
# specs to files; a PRESENT-but-STALE lib missing an EXPORT sails through it and
# still throws at call time.
#
# This primitive replaces piecemeal mutation with an ATOMIC symlink swap of a
# FULLY-VERIFIED, single-sha release tree:
#
#   1. rsync a FULL checkout of exactly ONE git sha -> /opt/secondbrain-releases/<sha>
#   2. VERIFY the staged tree loads, all BEFORE anything live is touched:
#        a. node -c on the server twins + entrypoints          (syntax)
#        b. require-scan-check.js                                (missing FILES)
#        c. import-smoke-check.js: child-process require()s      (missing EXPORTS
#           server.js, ec2-server.js, and every entrypoint --     require-scan
#           this is what catches the version-skew that            cannot see)
#           require-scan is blind to
#        d. (opt-in) boot the release on a SCRATCH port + curl /health
#   3. ln -sfn <sha> /opt/secondbrain   (ATOMIC rename -- no half-written window)
#   4. pm2 restart + post-restart /health probe
#   5. On ANY failure at step 3/4, roll the symlink back to the previous release
#      and pm2 restart, so a crash-loop is NEVER left live or reported healed.
#
# Idempotent: re-running for an already-staged, already-current sha is a no-op
# beyond re-verification. Logged: every step prints "[atomic-release] ...".
#
# ============================================================================
# ONE-TIME /opt CUTOVER (documented ONLY -- this script does NOT run it, and the
# human performs it as a separate, supervised step per the task's guardrail):
# ============================================================================
#   On the EC2 host, ONCE, to convert the plain /opt/secondbrain dir into a
#   symlink into the releases root:
#     sudo mkdir -p /opt/secondbrain-releases
#     # seed the first release from the current live dir under its HEAD sha:
#     SHA=$(git -C /opt/secondbrain rev-parse HEAD 2>/dev/null || echo bootstrap)
#     sudo rsync -a --delete /opt/secondbrain/ /opt/secondbrain-releases/$SHA/
#     sudo mv /opt/secondbrain /opt/secondbrain.pre-atomic.bak
#     sudo ln -sfn /opt/secondbrain-releases/$SHA /opt/secondbrain
#     # confirm PM2 still resolves its cwd through the symlink, then:
#     pm2 restart secondbrain-backend --update-env && curl -s localhost:3001/health
#   Keep /opt/secondbrain.pre-atomic.bak until a full green morning proves the
#   symlinked layout, then remove it. After cutover, /opt/secondbrain is ALWAYS
#   a symlink and this primitive only ever moves that symlink -- never edits
#   files under it in place.
#
# ============================================================================
# USAGE
#   bash scripts/lib/atomic-release.sh --sha <gitsha> [--source-root DIR]
#        [--host user@host] [--key PATH] [--releases-root DIR] [--opt-link DIR]
#        [--local] [--boot-healthcheck]
#
#   --sha              REQUIRED. Exactly one git sha to release. The staged tree
#                      is content at THIS sha (proven, not "whatever is on disk").
#   --source-root      git checkout to export the sha from (default: repo root).
#   --host / --key     ssh target + key for a REMOTE release (default from env).
#   --releases-root    default /opt/secondbrain-releases
#   --opt-link         the live symlink, default /opt/secondbrain
#   --local            operate on the LOCAL filesystem (no ssh); used for the
#                      on-host release build and for tests.
#   --boot-healthcheck opt-in: also boot the release on a scratch port and curl
#                      /health BEFORE the swap. OFF by default because booting a
#                      full ec2-server.js fires its Telegram/dispatch pollers
#                      (duplicate live side effects during a deploy); enable only
#                      once ec2-server.js honors a no-side-effects smoke mode.
#                      The import-smoke (2c) already proves the server module
#                      evaluates without the skew crash; the post-restart /health
#                      probe (step 4) is the authoritative live check.
# ============================================================================
set -euo pipefail

log() { echo "[atomic-release] $*"; }
die() { echo "[atomic-release] ERROR: $*" >&2; exit 1; }

# ---- args ----
SHA=""
SOURCE_ROOT=""
HOST="${SB_DEPLOY_HOST:-ec2-user@ExampleCo}"
KEY="${SB_KEY:-$HOME/.ssh/sb-key.pem}"
[ -f "$KEY" ] || KEY="$HOME/.ssh/secondbrain-backend-key.pem"
RELEASES_ROOT="${SB_RELEASES_ROOT:-/opt/secondbrain-releases}"
OPT_LINK="${SB_OPT_LINK:-/opt/secondbrain}"
LOCAL=0
BOOT_HEALTHCHECK=0
HEALTH_PORT="${SB_HEALTH_PORT:-3001}"
PM2_APP="${SB_PM2_APP:-secondbrain-backend}"
# server twins + entrypoints the import-smoke child-requires. server.js is the
# PM2 twin of ec2-server.js. Overridable so the primitive is not the only place
# the entrypoint set can grow.
SMOKE_ENTRYPOINTS="${SB_SMOKE_ENTRYPOINTS:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --sha) SHA="$2"; shift 2 ;;
    --source-root) SOURCE_ROOT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --releases-root) RELEASES_ROOT="$2"; shift 2 ;;
    --opt-link) OPT_LINK="$2"; shift 2 ;;
    --health-port) HEALTH_PORT="$2"; shift 2 ;;
    --local) LOCAL=1; shift ;;
    --boot-healthcheck) BOOT_HEALTHCHECK=1; shift ;;
    *) die "ExampleCo argument: $1" ;;
  esac
done

[ -n "$SHA" ] || die "--sha is required (release exactly ONE proven git sha)"
[ -n "$SOURCE_ROOT" ] || SOURCE_ROOT="$(git rev-parse --show-toplevel)"
RELEASE_DIR="$RELEASES_ROOT/$SHA"

# The default entrypoint set: the two server twins plus the top-level entrypoints
# PM2 / the cloud controller load. All are `require.main === module` guarded (or
# pure modules), so a child require() just evaluates them -- exactly what catches
# a missing export. Extend via SB_SMOKE_ENTRYPOINTS (whitespace-separated).
default_entrypoints() {
  cat <<'EOF'
ec2-server.js
server.js
scripts/cloud-morning-briefing.js
scripts/card-controller.js
scripts/refresh-card.js
scripts/refresh-briefing-generated-sections.js
scripts/health-self-heal.js
scripts/callback-watchdog.js
scripts/agentic-healer-driver.js
scripts/vapi-end-of-call.js
EOF
}

# ---- run helpers: --local runs on this box; otherwise over ssh ----
sh_run() {
  # Execute a shell snippet either locally or on $HOST.
  if [ "$LOCAL" = "1" ]; then
    bash -c "$1"
  else
    ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "$1"
  fi
}

log "releasing sha=$SHA -> $RELEASE_DIR (link=$OPT_LINK, mode=$([ "$LOCAL" = 1 ] && echo local || echo "ssh:$HOST"))"

# ---- 1. STAGE: rsync a FULL checkout of exactly this sha into the release dir ----
# git archive gives a clean tree of exactly the sha (no worktree dirt), which we
# rsync into place. Idempotent: an identical existing release is overwritten with
# identical content.
STAGE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/sb-atomic-XXXXXX")"
cleanup_stage() { rm -rf "$STAGE_TMP" 2>/dev/null || true; }
trap cleanup_stage EXIT

log "staging sha $SHA from $SOURCE_ROOT"
git -C "$SOURCE_ROOT" archive --format=tar "$SHA" | tar -x -C "$STAGE_TMP"
# server.js is the PM2 twin of ec2-server.js and is NOT tracked in git; mint it.
if [ -f "$STAGE_TMP/ec2-server.js" ]; then
  cp "$STAGE_TMP/ec2-server.js" "$STAGE_TMP/server.js"
fi

if [ "$LOCAL" = "1" ]; then
  mkdir -p "$RELEASE_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$STAGE_TMP/" "$RELEASE_DIR/"
  else
    # rsync-less fallback (e.g. Git Bash): mirror the tree deterministically.
    rm -rf "$RELEASE_DIR"; mkdir -p "$RELEASE_DIR"; cp -a "$STAGE_TMP/." "$RELEASE_DIR/"
  fi
else
  sh_run "mkdir -p '$RELEASE_DIR'"
  # Push the staged tarball once, expand remotely (single transfer, atomic-ish).
  TARBALL="$STAGE_TMP.tar.gz"
  tar -czf "$TARBALL" -C "$STAGE_TMP" .
  scp -i "$KEY" -o StrictHostKeyChecking=no "$TARBALL" "$HOST:/tmp/sb-atomic-$SHA.tar.gz"
  rm -f "$TARBALL"
  sh_run "rm -rf '$RELEASE_DIR' && mkdir -p '$RELEASE_DIR' && sudo tar -xzf /tmp/sb-atomic-$SHA.tar.gz -C '$RELEASE_DIR' && sudo chown -R ec2-user:ec2-user '$RELEASE_DIR' && rm -f /tmp/sb-atomic-$SHA.tar.gz"
fi
log "staged: $RELEASE_DIR"

# node_modules: the release tree has none (git-archived). Link the live shared
# node_modules into the release so the smoke + boot resolve bare specifiers.
if [ "$LOCAL" != "1" ]; then
  sh_run "if [ ! -e '$RELEASE_DIR/node_modules' ] && [ -d '$OPT_LINK/node_modules' ]; then ln -s '$OPT_LINK/node_modules' '$RELEASE_DIR/node_modules'; fi" || true
fi

# ---- 2. VERIFY the staged tree BEFORE touching the live symlink ----
ENTRYPOINTS="$(default_entrypoints)"
[ -n "$SMOKE_ENTRYPOINTS" ] && ENTRYPOINTS="$ENTRYPOINTS
$SMOKE_ENTRYPOINTS"

# 2a. syntax: node -c the server twins + entrypoints. Skip a MISSING file (the
#     entrypoint set is a superset), but a real SYNTAX error must FAIL the
#     release -- hence `|| exit 1` inside the loop, never `|| true`.
ENTRYPOINTS_INLINE="$(echo "$ENTRYPOINTS" | tr '\n' ' ')"
log "verify 2a: node -c server twins + entrypoints"
sh_run "cd '$RELEASE_DIR' && for f in $ENTRYPOINTS_INLINE; do if [ -f \"\$f\" ]; then node -c \"\$f\" || exit 1; fi; done" \
  || die "node -c failed on the staged release ($SHA) -- NOT swapping the live symlink"

# 2b. require-scan: every relative require() RESOLVES to a file on the staged tree
log "verify 2b: require-scan (missing FILES) on the staged release"
sh_run "node '$RELEASE_DIR/scripts/require-scan-check.js' --root '$RELEASE_DIR' server.js ec2-server.js scripts/card-controller.js scripts/refresh-card.js" \
  || die "require-scan failed on the staged release ($SHA) -- a require() resolves to nothing. NOT swapping."

# 2c. import-smoke: child-process require() EVALUATES each entrypoint so a
#     PRESENT-but-STALE lib missing an EXPORT throws HERE, before the swap.
#     THIS is the check require-scan cannot do.
log "verify 2c: import-smoke (missing EXPORTS -- require-scan is blind to these)"
sh_run "node '$RELEASE_DIR/scripts/lib/import-smoke-check.js' --root '$RELEASE_DIR' --server-port 39117 $ENTRYPOINTS_INLINE" \
  || die "import-smoke failed on the staged release ($SHA) -- an entrypoint throws at require (version skew / missing export). NOT swapping the live symlink."

# 2d. OPT-IN scratch-port boot + /health (see header for why it is off by default)
if [ "$BOOT_HEALTHCHECK" = "1" ]; then
  log "verify 2d: booting release on scratch port + curl /health (opt-in)"
  sh_run "cd '$RELEASE_DIR' && PORT=39118 SB_SMOKE_BOOT=1 node ec2-server.js & boot_pid=\$!; ok=0; for i in 1 2 3 4 5 6 7 8; do sleep 2; c=\$(curl -s -o /dev/null -w '%{http_code}' -m 6 http://127.0.0.1:39118/health 2>/dev/null || echo 000); [ \"\$c\" = 200 ] && { ok=1; break; }; done; kill \$boot_pid 2>/dev/null || true; [ \"\$ok\" = 1 ]" \
    || die "scratch-port boot /health failed on the staged release ($SHA) -- NOT swapping."
fi

log "verify: staged release $SHA loads clean (syntax + require-scan + import-smoke$([ "$BOOT_HEALTHCHECK" = 1 ] && echo ' + boot-health'))"

# ---- capture the CURRENT release target so we can roll back the symlink ----
PREV_TARGET="$(sh_run "readlink -f '$OPT_LINK' 2>/dev/null || true" || true)"
log "current live target: ${PREV_TARGET:-<none / not-yet-a-symlink>}"

# ---- 3. ATOMIC SWAP: ln -sfn does an atomic rename of the symlink ----
log "swap: ln -sfn $RELEASE_DIR -> $OPT_LINK (atomic)"
sh_run "ln -sfn '$RELEASE_DIR' '$OPT_LINK'" \
  || die "symlink swap failed -- live target unchanged (still ${PREV_TARGET:-original})"

# ---- 4. pm2 restart + POST-RESTART /health, roll the symlink back on failure ----
rollback_symlink() {
  if [ -n "$PREV_TARGET" ] && [ "$PREV_TARGET" != "$RELEASE_DIR" ]; then
    log "ROLLBACK: restoring symlink -> $PREV_TARGET and restarting pm2"
    sh_run "ln -sfn '$PREV_TARGET' '$OPT_LINK'; pm2 restart '$PM2_APP' --update-env >/dev/null 2>&1 || true" || true
  else
    log "ROLLBACK: no distinct previous release to restore to (first release or same sha)"
  fi
}

log "restart: pm2 restart $PM2_APP"
if ! sh_run "pm2 restart '$PM2_APP' --update-env >/dev/null 2>&1"; then
  rollback_symlink
  die "pm2 restart failed after swap ($SHA) -- rolled the symlink back"
fi

log "health: probing http://127.0.0.1:$HEALTH_PORT/health after restart"
HEALTH_OK="$(sh_run "code=000; for i in 1 2 3 4 5 6 7 8 9 10; do sleep 3; code=\$(curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1:$HEALTH_PORT/health 2>/dev/null || echo 000); [ \"\$code\" = 200 ] && break; done; echo \$code")"
if [ "$HEALTH_OK" != "200" ]; then
  log "post-restart /health returned HTTP ${HEALTH_OK:-000}"
  rollback_symlink
  die "post-restart /health FAILED ($SHA) -- rolled the symlink back to the last good release"
fi

log "OK: released $SHA. $OPT_LINK -> $RELEASE_DIR, pm2 restarted, /health 200."
