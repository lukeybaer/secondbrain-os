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
#   1. git-archive a FULL checkout of exactly ONE git sha -> /opt/secondbrain-releases/<sha>
#   1b. wire the STABLE shared node_modules + data AND the DURABLE logs dir into
#       that release (see below)
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
# STABLE SHARED STATE (the two heavy, persistent, NON-code trees)
# ============================================================================
# A git-archived release is CODE ONLY. Two things it must NOT carry per-release:
#   * node_modules  -- not tracked in git, and huge.
#   * data/         -- the ENTIRE backend runtime state (tasks, agent ledgers,
#                      briefing artifacts, youtube, ~most of the live /opt). A
#                      handful of data/ files ARE tracked, so git-archive drops a
#                      STALE snapshot into the release; using it would SHADOW the
#                      live runtime state and the backend would boot blank ->
#                      /health fails -> rollback -> deploys silently stop working.
# So both live OUTSIDE any release, in $SHARED_ROOT (default /opt/secondbrain-shared),
# and every staged release SYMLINKS into them:
#     <release>/node_modules -> /opt/secondbrain-shared/node_modules   (read-only-ish)
#     <release>/data         -> /opt/secondbrain-shared/data           (the ONE live,
#                                                       read-write dir, SAME physical
#                                                       dir across every release)
# The stale git-archived data/ snapshot is DELETED and the shared dir symlinked over
# it. This decouples releases from state and avoids the old release->release chaining
# (linking node_modules from $OPT_LINK broke newer releases when an old one was pruned).
#
# Why NO env change is needed: the backend reaches its state via BOTH hardcoded
# "/opt/secondbrain/data/..." literals AND path.join(__dirname, 'data', ...). Post
# cutover /opt/secondbrain -> <release> and <release>/data -> $SHARED_DATA, so BOTH
# resolve to the shared live dir. SECONDBRAIN_DATA_DIR (when set) defaults to
# /opt/secondbrain/data, which resolves the same way. The data path is unchanged;
# only what it points AT changes, and it keeps pointing at the one live dir.
#
# ============================================================================
# DURABLE LOGS (deploy-blindness fix, 2026-07-19)
# ============================================================================
# logs/ used to be a REAL directory inside each release tree, so every symlink
# swap ORPHANED the live log files mid-write: the 5:30 briefing cron kept
# appending to the OLD release's logs/morning-briefing-cron.log (its open fd
# kept the resolved path) while anything tailing /opt/secondbrain/logs went
# blind, and each release accumulated its own shard of the log history. data/
# never had this problem because it lives OUTSIDE the release; logs now get the
# SAME treatment:
#     <release>/logs -> $DURABLE_LOGS   (default /opt/secondbrain-logs -- ONE
#                                        durable dir, SAME physical dir across
#                                        every release)
# INVARIANT (by construction): a log line written through $OPT_LINK/logs BEFORE
# the swap and a line written AFTER the swap land in the SAME durable file,
# because every release's logs entry resolves to the one durable dir. Migration
# is MOVE-only and no-clobber (mv -n): log content is never deleted.
#
# ============================================================================
# DURABLE SHARED MUTABLE PATHS (generalized durable-logs treatment, 2026-07-19)
# ============================================================================
# Same defect class as durable logs: ANY mutable file or dir living INSIDE the
# release tree is orphaned (or vanishes) on every symlink swap. The known
# in-tree mutable paths ride the DURABLE_SHARED list below and get ONE durable
# home OUTSIDE every release, with the release entry a SYMLINK to it:
#     <release>/<name> -> $DURABLE_ROOT/<name>   (production default
#                                                 /opt/secondbrain-durable)
# logs keeps its pre-existing durable home ($DURABLE_LOGS) and pinned step.
# The list covers: .env + secrets.env (sourced by crons, read by
# verify-dashboard-cards-live.js), .yt-dlp-cookies.txt (mode-600, manually
# placed), content-review/ (runtime manifests + rejections.jsonl), empire/
# (video build config/assets), .claude/ + .auto-memory/ (state ec2-server.js
# reads). Rules, mirroring the logs migration exactly:
#   * MIGRATE-BEFORE-REPLACE: a live release's REAL file/dir content is moved
#     (mv -n, no-clobber) into the durable home BEFORE any symlink replaces
#     it; live content is NEVER deleted -- the release FAILS instead.
#   * SECRETS DISCIPLINE: contents of env/cookie files are never printed
#     (paths only); secret-mode durable files are enforced to mode 600 and
#     ec2-user ownership; the durable root lives OUTSIDE every git-archived
#     tree so nothing secret can ride a release or a git surface.
#   * Idempotent: an already-migrated layout (every entry already a symlink)
#     is a pure no-op on re-run.
#   * Post-swap VERIFY: every durable name must resolve THROUGH $OPT_LINK to
#     its durable home and be writable, or the swap is rolled back.
#
# ============================================================================
# ONE-TIME /opt CUTOVER (bootstrap) -- run ONCE, supervised, per the guardrail.
# This is now MECHANIZED by --bootstrap (idempotent + safe to re-run), so the
# heavy node_modules + data MOVE to shared happens exactly once and correctly.
# ============================================================================
#   On the EC2 host, ONCE, to convert the plain /opt/secondbrain dir into a
#   symlink into the releases root AND move its heavy state to the shared root:
#
#     # (a) make the shared + releases roots and give ec2-user ownership so the
#     #     primitive (which runs without sudo) can write them:
#     sudo mkdir -p /opt/secondbrain-releases /opt/secondbrain-shared
#     sudo chown ec2-user:ec2-user /opt/secondbrain-releases /opt/secondbrain-shared
#
#     # (b) note the currently-deployed sha BEFORE moving anything:
#     SHA=$(git -C /opt/secondbrain rev-parse HEAD 2>/dev/null || echo bootstrap)
#
#     # (c) run the bootstrap. --bootstrap MOVES (never copies -- no 25G dup)
#     #     /opt/secondbrain/{node_modules,data} -> /opt/secondbrain-shared/,
#     #     preserves the ORIGINAL tree as /opt/secondbrain.pre-atomic.bak, stages
#     #     the first release with the shared symlinks wired, verifies it loads,
#     #     then ln -sfn's it to /opt/secondbrain, pm2-restarts + /health-checks:
#     bash scripts/lib/atomic-release.sh --sha "$SHA" --bootstrap \
#          --host ec2-user@ExampleCo --key ~/.ssh/sb-key.pem
#
#   Re-running --bootstrap is a no-op once the shared trees exist and /opt is a
#   symlink (every step is guarded). Keep /opt/secondbrain.pre-atomic.bak until a
#   full green morning proves the symlinked layout, then remove it. After cutover,
#   /opt/secondbrain is ALWAYS a symlink, node_modules + data live in
#   /opt/secondbrain-shared/, and this primitive only ever moves the symlink --
#   never edits files under a live release in place.
#
# ============================================================================
# USAGE
#   bash scripts/lib/atomic-release.sh --sha <gitsha> [--source-root DIR]
#        [--host user@host] [--key PATH] [--releases-root DIR] [--opt-link DIR]
#        [--shared-root DIR] [--shared-node-modules DIR] [--shared-data DIR]
#        [--bootstrap] [--stage-only] [--local] [--boot-healthcheck]
#
#   --sha              REQUIRED. Exactly one git sha to release. The staged tree
#                      is content at THIS sha (proven, not "whatever is on disk").
#   --source-root      git checkout to export the sha from (default: repo root).
#   --host / --key     ssh target + key for a REMOTE release (default from env).
#   --releases-root    default /opt/secondbrain-releases
#   --opt-link         the live symlink, default /opt/secondbrain
#   --shared-root      stable root holding node_modules + data OUTSIDE releases.
#                      Default /opt/secondbrain-shared (SB_SHARED_ROOT).
#   --shared-node-modules  override the shared node_modules dir
#                      (default <shared-root>/node_modules, SB_SHARED_NODE_MODULES).
#   --shared-data      override the shared data dir; this is the ONE live runtime
#                      state dir shared by every release
#                      (default <shared-root>/data, SB_SHARED_DATA).
#   --durable-logs     the ONE durable logs dir every release's logs/ entry
#                      symlinks to (SB_DURABLE_LOGS). Default
#                      /opt/secondbrain-logs when the shared root is the
#                      production default; <shared-root>/logs otherwise, so
#                      --local test layouts stay self-contained and never touch
#                      a root-owned /opt path.
#   --durable-root     the ONE durable root holding every OTHER mutable
#                      in-tree path from the DURABLE_SHARED list, as
#                      <durable-root>/<name> (SB_DURABLE_ROOT). Default
#                      /opt/secondbrain-durable when the shared root is the
#                      production default; <shared-root>/durable otherwise
#                      (same test-layout rule as --durable-logs). MUST live
#                      outside the releases tree.
#   --bootstrap        ONE-TIME cutover: MOVE the live node_modules + data out of a
#                      plain /opt/secondbrain into <shared-root>, back the original
#                      up as /opt/secondbrain.pre-atomic.bak, then do a normal
#                      staged release + swap. Idempotent + safe to re-run.
#   --stage-only       stage the release + wire the shared symlinks, then STOP
#                      (no verify/swap/restart). For pre-staging and for tests.
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
# STABLE shared state OUTSIDE releases: node_modules + the ONE live data dir.
SHARED_ROOT="${SB_SHARED_ROOT:-/opt/secondbrain-shared}"
SHARED_NODE_MODULES="${SB_SHARED_NODE_MODULES:-}"
SHARED_DATA="${SB_SHARED_DATA:-}"
# DURABLE logs dir OUTSIDE releases: log files survive every symlink swap.
DURABLE_LOGS="${SB_DURABLE_LOGS:-}"
# DURABLE root for every OTHER mutable in-tree path (env files, cookies,
# content-review, empire, .claude, .auto-memory): survives every swap.
DURABLE_ROOT="${SB_DURABLE_ROOT:-}"
LOCAL=0
BOOTSTRAP=0
STAGE_ONLY=0
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
    --shared-root) SHARED_ROOT="$2"; shift 2 ;;
    --shared-node-modules) SHARED_NODE_MODULES="$2"; shift 2 ;;
    --shared-data) SHARED_DATA="$2"; shift 2 ;;
    --durable-logs) DURABLE_LOGS="$2"; shift 2 ;;
    --durable-root) DURABLE_ROOT="$2"; shift 2 ;;
    --health-port) HEALTH_PORT="$2"; shift 2 ;;
    --bootstrap) BOOTSTRAP=1; shift ;;
    --stage-only) STAGE_ONLY=1; shift ;;
    --local) LOCAL=1; shift ;;
    --boot-healthcheck) BOOT_HEALTHCHECK=1; shift ;;
    *) die "ExampleCo argument: $1" ;;
  esac
done

[ -n "$SHA" ] || die "--sha is required (release exactly ONE proven git sha)"
[ -n "$SOURCE_ROOT" ] || SOURCE_ROOT="$(git rev-parse --show-toplevel)"
RELEASE_DIR="$RELEASES_ROOT/$SHA"
# Derive the shared sub-paths from --shared-root unless overridden explicitly.
[ -n "$SHARED_NODE_MODULES" ] || SHARED_NODE_MODULES="$SHARED_ROOT/node_modules"
[ -n "$SHARED_DATA" ] || SHARED_DATA="$SHARED_ROOT/data"
# Durable-logs default: production uses /opt/secondbrain-logs (ec2-user owned,
# sibling of the shared root). A NON-default shared root means a test / scratch
# layout, so keep logs beside it instead of touching a root-owned /opt path.
if [ -z "$DURABLE_LOGS" ]; then
  if [ "$SHARED_ROOT" = "/opt/secondbrain-shared" ]; then
    DURABLE_LOGS="/opt/secondbrain-logs"
  else
    DURABLE_LOGS="$SHARED_ROOT/logs"
  fi
fi
# Durable-root default mirrors the durable-logs rule: production gets an
# ec2-user-owned sibling of the shared root; a NON-default shared root means a
# test / scratch layout, so the durable home stays beside it.
if [ -z "$DURABLE_ROOT" ]; then
  if [ "$SHARED_ROOT" = "/opt/secondbrain-shared" ]; then
    DURABLE_ROOT="/opt/secondbrain-durable"
  else
    DURABLE_ROOT="$SHARED_ROOT/durable"
  fi
fi
# The durable home must NEVER live inside a git-archived release tree: a
# release is disposable and git-archive must never be able to carry (or a
# prune delete) durable mutable state, least of all the secret env/cookie files.
case "$DURABLE_ROOT" in
  "$RELEASES_ROOT"/*|"$RELEASES_ROOT") die "durable root $DURABLE_ROOT must live OUTSIDE the releases tree ($RELEASES_ROOT)" ;;
esac

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

# ---- wire the STABLE shared node_modules + data into a staged release ----
# These two heavy, persistent, NON-code trees live in $SHARED_ROOT, OUTSIDE any
# release, so releases stay code-only + disposable and data/ is the SAME physical
# live dir across EVERY release. git-archive ExampleCos a STALE tracked data/ snapshot
# into the release; we DELETE it and symlink the live shared dir over it, so no
# release ever shadows the runtime state with a committed snapshot. We deliberately
# do NOT chain node_modules through $OPT_LINK (the old behavior) -- that made
# release->release links that break when an old release is pruned. rm -rf on a
# SYMLINK removes only the link, never the shared target (no trailing slash).
link_shared_into_release() {
  sh_run "
    set -e
    mkdir -p '$SHARED_DATA'
    rm -rf '$RELEASE_DIR/node_modules'
    ln -s '$SHARED_NODE_MODULES' '$RELEASE_DIR/node_modules'
    rm -rf '$RELEASE_DIR/data'
    ln -s '$SHARED_DATA' '$RELEASE_DIR/data'
  " || die "failed to wire shared node_modules/data symlinks into $RELEASE_DIR"
}

# ---- wire the DURABLE logs dir into a staged release (logs survive the swap) ----
# WHY (2026-07-19 deploy-blindness defect): logs/ used to be a REAL dir inside
# each release tree, so the atomic swap orphaned live log files mid-write -- the
# 5:30 briefing cron kept appending into the OLD release (its open fd kept the
# resolved path) while any monitor tailing $OPT_LINK/logs went blind. The
# release's logs entry is now a SYMLINK to the ONE durable dir, exactly like data/.
# INVARIANT BY CONSTRUCTION: a log written at $OPT_LINK/logs/x.log PRE-swap and a
# line appended POST-swap land in the SAME durable file, because every release
# resolves logs/ to $DURABLE_LOGS.
#
# MIGRATE-BEFORE-REPLACE, never delete: the first run after this ships finds the
# CURRENT live release still owning a REAL logs/ dir with live files. Those are
# MOVED into $DURABLE_LOGS before any dir is replaced by a symlink -- mv -n is
# no-clobber (a name collision leaves the source file in place), and a same-
# filesystem mv is rename(2), which preserves inodes so a writer holding an open
# fd keeps appending to the same file in its new durable home. Nothing here ever
# rm -rf's a real logs dir: if a staged logs/ cannot be fully drained, the
# release FAILS rather than delete log content.
link_durable_logs_into_release() {
  sh_run "
    set -e
    if ! mkdir -p '$DURABLE_LOGS' 2>/dev/null; then
      sudo mkdir -p '$DURABLE_LOGS' && sudo chown ec2-user:ec2-user '$DURABLE_LOGS'
    fi
    # MIGRATE (first run): drain the CURRENT live release's real logs/ into the
    # durable dir, then leave the durable symlink behind so pre-swap writers
    # opening NEW files land durable too. rmdir refuses a non-empty dir, so a
    # mid-window write or a name collision is preserved, never force-deleted.
    live_release=\"\$(readlink -f '$OPT_LINK' 2>/dev/null || true)\"
    if [ -n \"\$live_release\" ] && [ -d \"\$live_release/logs\" ] && [ ! -L \"\$live_release/logs\" ]; then
      find \"\$live_release/logs\" -mindepth 1 -maxdepth 1 -exec mv -n {} '$DURABLE_LOGS/' \;
      if rmdir \"\$live_release/logs\" 2>/dev/null; then
        ln -s '$DURABLE_LOGS' \"\$live_release/logs\"
      fi
    fi
    # During the one-time bootstrap the plain live tree moves to
    # <opt-link>.pre-atomic.bak before this wiring pass. Recover its logs from
    # that retained tree instead of creating an empty durable directory.
    if [ -d '$OPT_LINK.pre-atomic.bak/logs' ] && [ ! -L '$OPT_LINK.pre-atomic.bak/logs' ]; then
      find '$OPT_LINK.pre-atomic.bak/logs' -mindepth 1 -maxdepth 1 -exec mv -n {} '$DURABLE_LOGS/' \;
      if rmdir '$OPT_LINK.pre-atomic.bak/logs' 2>/dev/null; then
        ln -s '$DURABLE_LOGS' '$OPT_LINK.pre-atomic.bak/logs'
      fi
    fi
    # REPLACE: the staged release's logs entry becomes the durable symlink.
    # git-archive stages no logs/ today (untracked); guard anyway by draining
    # any real dir first -- and FAIL rather than delete undrained log content.
    if [ -d '$RELEASE_DIR/logs' ] && [ ! -L '$RELEASE_DIR/logs' ]; then
      find '$RELEASE_DIR/logs' -mindepth 1 -maxdepth 1 -exec mv -n {} '$DURABLE_LOGS/' \;
      rmdir '$RELEASE_DIR/logs'
    fi
    if [ -L '$RELEASE_DIR/logs' ]; then rm -f '$RELEASE_DIR/logs'; fi
    ln -s '$DURABLE_LOGS' '$RELEASE_DIR/logs'
  " || die "failed to wire durable logs into $RELEASE_DIR (log content is never deleted -- drain any leftover real logs/ into $DURABLE_LOGS manually and re-run)"
}

# ---- wire EVERY durable mutable in-tree path into a staged release ----------
# Generalization of the durable-logs treatment (see header): the LIST drives
# behavior. Entry format name|kind|policy:
#   kind=dir     durable entry is a DIRECTORY. Live real dirs are DRAINED into
#                it (mv -n no-clobber, rmdir only when empty, NEVER force-
#                delete a real dir) exactly like the logs migration; the live
#                dir gets the durable symlink left behind when fully drained
#                so pre-swap writers keep landing durable.
#   kind=file    durable entry is a FILE symlinked into the release. A live
#                real file is MIGRATED (mv -n) and replaced by a symlink; the
#                release symlink may DANGLE until the file is first placed --
#                writing through the release path then CREATES the durable
#                file, so manual placement keeps working unchanged.
#   policy=secret    (files) enforce mode 600 + ec2-user ownership on the
#                    durable copy. Contents are NEVER printed, only paths.
#   policy=seeded    (dirs) git TRACKS seed files under this name (e.g.
#                    content-review/LEARNINGS.md), so every fresh git-archive
#                    stages copies whose names the durable dir already owns
#                    after the first migration. Those staged duplicates are
#                    tracked content at the released sha (reconstructible via
#                    `git show`), never runtime content -- the staged tree was
#                    created THIS run -- so they are dropped after the mv -n
#                    drain instead of failing every subsequent release.
#                    Runtime truth in the durable dir always wins, matching
#                    how data/ already shadows its stale tracked snapshot.
#   policy=preserve  (dirs) no tracked seeds exist: a staged leftover FAILS
#                    the release (rmdir of a non-empty dir) rather than delete.
# logs rides the list for coverage/verification but is WIRED by the dedicated,
# source-pinned link_durable_logs_into_release step above (same treatment, its
# own pinned durable home + regression suite).
DURABLE_SHARED="${SB_DURABLE_SHARED:-logs|dir|preserve .env|file|secret secrets.env|file|secret .yt-dlp-cookies.txt|file|secret content-review|dir|seeded empire|dir|preserve .claude|dir|seeded .auto-memory|dir|preserve}"

durable_path_for() {
  # logs predates the durable root and keeps its own pinned durable home.
  if [ "$1" = "logs" ]; then echo "$DURABLE_LOGS"; else echo "$DURABLE_ROOT/$1"; fi
}

link_durable_into_release() {
  local name="$1" kind="$2" policy="$3" durable
  durable="$(durable_path_for "$name")"
  if [ "$kind" = "dir" ]; then
    local drop_seeded=':'
    if [ "$policy" = "seeded" ]; then
      # Staged git-archive duplicates of names the durable dir already owns:
      # tracked at the released sha, reconstructible, never runtime content.
      drop_seeded="find '$RELEASE_DIR/$name' -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
    fi
    sh_run "
      set -e
      if ! mkdir -p '$durable' 2>/dev/null; then
        sudo mkdir -p '$durable' && sudo chown ec2-user:ec2-user '$durable'
      fi
      live_release=\"\$(readlink -f '$OPT_LINK' 2>/dev/null || true)\"
      if [ -n \"\$live_release\" ] && [ -d \"\$live_release/$name\" ] && [ ! -L \"\$live_release/$name\" ]; then
        find \"\$live_release/$name\" -mindepth 1 -maxdepth 1 -exec mv -n {} '$durable/' \;
        if rmdir \"\$live_release/$name\" 2>/dev/null; then
          ln -s '$durable' \"\$live_release/$name\"
        fi
      fi
      if [ -d '$OPT_LINK.pre-atomic.bak/$name' ] && [ ! -L '$OPT_LINK.pre-atomic.bak/$name' ]; then
        find '$OPT_LINK.pre-atomic.bak/$name' -mindepth 1 -maxdepth 1 -exec mv -n {} '$durable/' \;
        if rmdir '$OPT_LINK.pre-atomic.bak/$name' 2>/dev/null; then
          ln -s '$durable' '$OPT_LINK.pre-atomic.bak/$name'
        fi
      fi
      if [ -d '$RELEASE_DIR/$name' ] && [ ! -L '$RELEASE_DIR/$name' ]; then
        find '$RELEASE_DIR/$name' -mindepth 1 -maxdepth 1 -exec mv -n {} '$durable/' \;
        $drop_seeded
        rmdir '$RELEASE_DIR/$name'
      fi
      if [ -L '$RELEASE_DIR/$name' ]; then rm -f '$RELEASE_DIR/$name'; fi
      ln -s '$durable' '$RELEASE_DIR/$name'
    " || die "failed to wire durable dir '$name' into $RELEASE_DIR (content is never deleted -- drain any leftover real $name/ into $durable manually and re-run)"
  else
    local enforce_secret=':'
    if [ "$policy" = "secret" ]; then
      # mv preserves the mode of an already-600 file; this ENFORCES 600 even
      # when the file was placed sloppier. Ownership is best-effort because a
      # non-root ec2-user run already owns what it migrated (and --local test
      # layouts have no ec2-user). Never prints file contents.
      enforce_secret="if [ -f '$durable' ]; then chmod 600 '$durable'; chown ec2-user:ec2-user '$durable' 2>/dev/null || true; fi"
    fi
    sh_run "
      set -e
      if ! mkdir -p '$DURABLE_ROOT' 2>/dev/null; then
        sudo mkdir -p '$DURABLE_ROOT' && sudo chown ec2-user:ec2-user '$DURABLE_ROOT'
      fi
      live_release=\"\$(readlink -f '$OPT_LINK' 2>/dev/null || true)\"
      if [ -n \"\$live_release\" ] && [ -f \"\$live_release/$name\" ] && [ ! -L \"\$live_release/$name\" ]; then
        mv -n \"\$live_release/$name\" '$durable'
        if [ ! -e \"\$live_release/$name\" ]; then
          ln -s '$durable' \"\$live_release/$name\"
        fi
      fi
      if [ -f '$OPT_LINK.pre-atomic.bak/$name' ] && [ ! -L '$OPT_LINK.pre-atomic.bak/$name' ]; then
        mv -n '$OPT_LINK.pre-atomic.bak/$name' '$durable'
        if [ ! -e '$OPT_LINK.pre-atomic.bak/$name' ]; then
          ln -s '$durable' '$OPT_LINK.pre-atomic.bak/$name'
        fi
      fi
      if [ -f '$RELEASE_DIR/$name' ] && [ ! -L '$RELEASE_DIR/$name' ]; then
        # A tracked copy of a durable file inside the archive (should never
        # happen for secrets): migrate what the durable home does not own yet,
        # then drop the staged duplicate -- it is reconstructible from the sha
        # and a stale secret copy must not ride the release tree.
        mv -n '$RELEASE_DIR/$name' '$durable'
        rm -f '$RELEASE_DIR/$name'
      fi
      rm -f '$RELEASE_DIR/$name'
      if ! ln -s '$durable' '$RELEASE_DIR/$name' 2>/dev/null; then
        # Degraded-symlink boxes (test layouts) cannot link a dangling target;
        # materialize an empty durable file first. On production ln -s never
        # takes this branch.
        [ -e '$durable' ] || : > '$durable'
        ln -s '$durable' '$RELEASE_DIR/$name'
      fi
      $enforce_secret
    " || die "failed to wire durable file '$name' into $RELEASE_DIR (content is never deleted -- place/repair $durable manually and re-run)"
  fi
}

link_durable_shared_into_release() {
  local spec name kind policy
  for spec in $DURABLE_SHARED; do
    name="${spec%%|*}"
    kind="${spec#*|}"; kind="${kind%%|*}"
    policy="${spec##*|}"
    # logs is wired by the pinned dedicated step above; skip, do not double-run.
    [ "$name" = "logs" ] && continue
    link_durable_into_release "$name" "$kind" "$policy"
  done
}

# ---- ONE-TIME cutover: move the live node_modules + data OUT to $SHARED_ROOT ----
# Idempotent + safe to re-run: every step is guarded, so a second run (or a run
# after the cutover already happened) is a no-op. MOVES (never copies) the heavy
# trees so the live 25G is preserved, not duplicated, and data/ becomes the single
# shared live dir. Preserves the ORIGINAL tree as $OPT_LINK.pre-atomic.bak. The
# normal stage+link+verify+swap below then creates the first release and points
# $OPT_LINK at it. Only acts while $OPT_LINK is a PLAIN dir (pre-cutover); once it
# is a symlink this whole block is skipped.
bootstrap_shared_layout() {
  log "bootstrap: cutover $OPT_LINK -> shared layout ($SHARED_ROOT), moving node_modules+data (idempotent)"
  sh_run "
    set -e
    mkdir -p '$RELEASES_ROOT' '$SHARED_ROOT'
    if [ ! -L '$OPT_LINK' ] && [ -d '$OPT_LINK' ]; then
      if [ ! -e '$SHARED_NODE_MODULES' ] && [ -e '$OPT_LINK/node_modules' ]; then
        mv '$OPT_LINK/node_modules' '$SHARED_NODE_MODULES'
      fi
      if [ ! -e '$SHARED_DATA' ] && [ -e '$OPT_LINK/data' ]; then
        mv '$OPT_LINK/data' '$SHARED_DATA'
      fi
      if [ ! -e '$OPT_LINK.pre-atomic.bak' ]; then
        mv '$OPT_LINK' '$OPT_LINK.pre-atomic.bak'
      else
        rm -rf '$OPT_LINK'
      fi
    fi
  " || die "bootstrap cutover failed for $OPT_LINK"
}

log "releasing sha=$SHA -> $RELEASE_DIR (link=$OPT_LINK, mode=$([ "$LOCAL" = 1 ] && echo local || echo "ssh:$HOST"))"

# ---- 0. BOOTSTRAP (opt-in): one-time cutover BEFORE staging the first release ----
[ "$BOOTSTRAP" = "1" ] && bootstrap_shared_layout

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

# ---- 1b. wire STABLE shared node_modules + data into the release (both modes) ----
# BEFORE verify, so import-smoke/boot resolve bare specifiers AND any data reads hit
# the ONE live shared dir. Replaces the old node_modules-only, remote-only,
# $OPT_LINK-chained link, and adds the data symlink that decouples runtime state.
link_shared_into_release
log "linked shared: $RELEASE_DIR/node_modules -> $SHARED_NODE_MODULES, $RELEASE_DIR/data -> $SHARED_DATA"
link_durable_logs_into_release
log "linked durable logs: $RELEASE_DIR/logs -> $DURABLE_LOGS (log files survive the swap by construction)"
link_durable_shared_into_release
log "linked durable shared: env/cookies/mutable state -> $DURABLE_ROOT/<name> per DURABLE_SHARED (in-tree mutable paths survive every swap)"

# stage-only: prepared a release dir with shared symlinks wired, but DO NOT verify,
# swap, or restart. Used to pre-stage a release and by the tests.
if [ "$STAGE_ONLY" = "1" ]; then
  log "stage-only: staged + wired shared symlinks for $SHA at $RELEASE_DIR (NO verify/swap/restart)"
  exit 0
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

# ---- post-swap durable-wiring assertion (before restart) -------------------
# Every DURABLE_SHARED name must resolve THROUGH the live path to its durable
# home and that home must be writable (a missing durable FILE is fine -- the
# dangling symlink IS the contract -- but its parent must be writable so a
# write can create it). Prints paths only, never contents. On failure the
# swap is rolled back exactly like a failed health probe.
verify_durable_wiring() {
  local spec name durable
  for spec in $DURABLE_SHARED; do
    name="${spec%%|*}"
    durable="$(durable_path_for "$name")"
    sh_run "
      target=\"\$(readlink '$OPT_LINK/$name' 2>/dev/null || true)\"
      if [ \"\$target\" != '$durable' ]; then
        echo \"[atomic-release] durable wiring BROKEN post-swap: $OPT_LINK/$name -> \${target:-<not a symlink>} (want $durable)\" >&2
        exit 1
      fi
      if [ -e '$durable' ]; then
        [ -w '$durable' ] || { echo '[atomic-release] durable target not writable: $durable' >&2; exit 1; }
      else
        parent=\"\$(dirname '$durable')\"
        [ -w \"\$parent\" ] || { echo \"[atomic-release] durable parent not writable: \$parent\" >&2; exit 1; }
      fi
    " || return 1
  done
  return 0
}

log "verify: durable wiring resolves through $OPT_LINK post-swap (every DURABLE_SHARED name)"
if ! verify_durable_wiring; then
  rollback_symlink
  die "post-swap durable-wiring verification FAILED ($SHA) -- rolled the symlink back"
fi

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
