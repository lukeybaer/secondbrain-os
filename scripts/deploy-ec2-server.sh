#!/usr/bin/env bash
# deploy-ec2-server.sh
#
# The SINGLE source-of-truth deploy for the EC2 backend. The repo's ec2-server.js
# is canonical; this pushes it to EC2 /opt/secondbrain/server.js AND ec2-server.js
# (PM2 runs server.js; the twin must match), then syntax-checks, restarts, and
# verifies /health + post-deploy parity.
#
# 2026-06-09: created after the repo and EC2 drifted. Two causes: (1) the local
# prettier formatter reflowed ec2-server.js on every edit (now .prettierignore'd),
# (2) people hot-patched EC2 directly instead of deploying the repo. This script
# is the cure for (2): never hand-patch EC2 again, always deploy from the repo.
#
# Usage: bash scripts/deploy-ec2-server.sh
set -euo pipefail

KEY="${SB_KEY:-$HOME/.ssh/sb-key.pem}"
[ -f "$KEY" ] || KEY="$HOME/.ssh/secondbrain-backend-key.pem"
HOST="ec2-user@ExampleCo"
ROOT="$(git rev-parse --show-toplevel)"
SRC="$ROOT/ec2-server.js"
LF="$ROOT/data/agent/_ec2-deploy.lf.js"
LIVE_DEPS=(
  "scripts/lib/voice-cloud-runtime.js"
  "scripts/lib/live-dev-state.js"
  "scripts/callback-watchdog.js"
  "scripts/vapi-end-of-call.js"
  "scripts/lib/dispatch-delivery.js"
  "scripts/lib/briefing-markdown-sections.js"
  "scripts/lib/briefing-news-reader.js"
  "scripts/cloud-morning-briefing.js"
  "scripts/health-self-heal.js"
  "scripts/refresh-briefing-generated-sections.js"
  "scripts/lib/vapi-live-assistant.js"
  "scripts/lib/vapi-tool-contract.js"
  "scripts/lib/vapi-voice-output.js"
  "scripts/lib/voice-spine-query.js"
  "scripts/lib/voice-recent-context.js"
  "scripts/lib/voice-tool-policy.js"
  "scripts/lib/spine-ingress.js"
  "scripts/lib/devops-health.js"
  "scripts/lib/shared-tree-write-guard.js"
  "scripts/lib/shared-tree-guard.js"
  "scripts/lib/integration-session.js"
  "scripts/lib/mutation-surface-matrix.js"
  # New briefing-path modules added in Phase 2-4b. The deployed cloud-morning-briefing.js
  # and ec2-server.js require these; ship them directly so a flaky build-path git-pull
  # cannot leave EC2 importing a file it does not have. See
  # feedback_ec2_build_path_silent_revert.md. Same category as the heal-error-budget.js
  # gap, but on the deploy surface instead of git tracking.
  "scripts/lib/briefing-fallback-expiry.js"
  "scripts/lib/briefing-card-manifest.js"
  "scripts/lib/executor-health-row.js"
  "scripts/otter-processing-coverage-probe.js"
  "scripts/self-heal/briefing-repair-ledger.js"
  "scripts/self-heal/self-heal-health-card.js"
  # Required by self-heal-health-card.js (deployed above), so it must ship too or
  # the live briefing render throws MODULE_NOT_FOUND on EC2.
  "scripts/self-heal/mechanical-recurrence.js"
  # Wave 1 (green-tomorrow): the QC validator is required by a deployed entrypoint, so the
  # blocker-naming fix must ship to /opt, not rely on the build-path sync.
  "scripts/validate-briefing-quality.js"
  # Wave 2 (green-tomorrow): both are required by the deployed briefing/QC entrypoints, so
  # the news-chrome + grounding + blocker-accounting fixes must ship to /opt directly.
  "scripts/lib/news-summarize.js"
  "scripts/verify-dashboard-cards-live.js"
  "scripts/lib/system-health-nongreen.js"
  # News-reader model-spoken auto-play + idempotent skip (2026-07-01). ec2-server.js
  # requires the model playback guard directly so a flaky build-path git-pull cannot
  # leave EC2 importing a missing module on PM2 restart.
  "scripts/lib/news-reader-model-playback.js"
  # Deploy-source freshness gate (2026-07-05): health-self-heal.js requires this
  # module, and the EC2 copy of the healer must not break on a missing require.
  "scripts/lib/deploy-source-freshness.js"
  # Recall Broker (2026-07-06): the hardened /amy/memory/query route requires
  # amy-memory-query.js (now deadline-capped) and the health probe is required
  # by cloud-morning-briefing.js + health-self-heal.js. Ship both to /opt so a
  # flaky build-path git-pull cannot strand a missing require on PM2 restart.
  # (recall-broker-crypto.js rides the full scripts/lib tar below.)
  "scripts/amy-memory-query.js"
  "scripts/recall-broker-health.js"
  # C4 deploy-parity SYSTEM HEALTH row (Codex amendment 3, item W3a, 2026-07-02).
  # cloud-morning-briefing.js requires this row formatter directly, so it must
  # ship to /opt like every other required module -- the probe binary itself
  # (verify-deploy-parity.js) and its pure-logic libs run from the build-path
  # git checkout, not /opt, so they are intentionally NOT listed here.
  "scripts/lib/deploy-parity-row.js"
  # Roster builder (2026-07-07): the deployed refresh-briefing-generated-sections.js
  # reads the roster artifact this script writes, and a /opt-cwd roster rebuild must
  # use the registry-confirmed-cluster binding, not a stale /opt copy. Ship it so
  # the /opt copy never drifts behind a land (feedback_ec2_build_path_silent_revert).
  "scripts/otter-call-speaker-rosters.js"
  # People/memory snapshot generator (2026-07-07): cloud-morning-briefing.js spawns
  # this to write the people-files / memory-delta snapshots the PEOPLE FILES CHANGES
  # and MEMORY.MD CHANGES cards read. It ExampleCos the internal-id/metadata sample
  # filter (isInternalIdOrMetadataLine); ship it so the /opt copy never drifts behind
  # a land and a UUID cannot leak back onto the face (feedback_ec2_build_path_silent_revert).
  "scripts/snapshot-people-and-memory-delta.js"
  # Otter call-history title/summary helper (2026-07-09): deployed
  # refresh-briefing-generated-sections.js imports this directly for generated
  # call display titles, so it must ship with the refresh entrypoint.
  "scripts/otter-call-exec-summaries.js"
  # Voice confirmation queue/review helpers (2026-07-09): deployed
  # refresh-briefing-generated-sections.js imports the queue builder directly,
  # and ec2-server.js opens the review-clips page through the sequence renderer.
  # Ship them with the refresh/server path so recurring acoustic ExampleCos cannot
  # silently fall back to stale /opt copies.
  "scripts/voice-confirmation-queue-build.js"
  "scripts/voice-sample-sequence-review-html.js"
)

echo "[deploy] syntax-checking repo ec2-server.js"
node -c "$SRC"

# C4 deploy-parity false-red mitigation (Codex amendment 3, item W3a): create a
# lock file on the EC2 host for the duration of this deploy so
# verify-deploy-parity.js suppresses drift during the mid-deploy window instead
# of reporting a false red while files are momentarily out of sync. Removed via
# a trap so it clears even if this script fails or is interrupted partway.
#
# TOKEN-OWNED (Codex review 2026-07-02): the lock content is a unique token for
# THIS deploy run, and cleanup only removes the file if it still holds that
# exact token. Two overlapping deploys therefore cannot clobber each other's
# lock: whichever one finishes first leaves the lock in place for the other,
# and only the deploy that actually still owns the file clears it.
DEPLOY_LOCK="/tmp/secondbrain-deploy.lock"
DEPLOY_LOCK_TOKEN="deploy-$(date +%s)-$$"
if ! ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "echo $DEPLOY_LOCK_TOKEN > $DEPLOY_LOCK"; then
  echo "[deploy] WARNING: could not create deploy-parity lock ($DEPLOY_LOCK) -- the parity probe may false-red during this deploy window."
fi
cleanup_deploy_lock() {
  ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
    "[ \"\$(cat $DEPLOY_LOCK 2>/dev/null)\" = \"$DEPLOY_LOCK_TOKEN\" ] && rm -f $DEPLOY_LOCK" \
    2>/dev/null || true
}
trap cleanup_deploy_lock EXIT

# Normalize CRLF -> LF so the deployed file is clean on Linux.
tr -d '\r' < "$SRC" > "$LF"

echo "[deploy] backing up live server.js + ec2-server.js"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
  'ts=$(date +%s); cp /opt/secondbrain/server.js /opt/secondbrain/server.js.bak-$ts; cp /opt/secondbrain/ec2-server.js /opt/secondbrain/ec2-server.js.bak-$ts; echo "  backed up @ $ts"'

echo "[deploy] pushing repo ec2-server.js -> EC2 server.js + ec2-server.js"
scp -i "$KEY" -o StrictHostKeyChecking=no "$LF" "$HOST:/opt/secondbrain/server.js"
scp -i "$KEY" -o StrictHostKeyChecking=no "$LF" "$HOST:/opt/secondbrain/ec2-server.js"

echo "[deploy] pushing live backend dependencies"
for dep in "${LIVE_DEPS[@]}"; do
  if [ -f "$ROOT/$dep" ]; then
    dep_dir="$(dirname "$dep")"
    tmp="/tmp/secondbrain-deploy-${dep//[^A-Za-z0-9._-]/_}"
    scp -i "$KEY" -o StrictHostKeyChecking=no "$ROOT/$dep" "$HOST:$tmp"
    ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
      "sudo mkdir -p /opt/secondbrain/$dep_dir && sudo cp $tmp /opt/secondbrain/$dep && sudo chown ec2-user:ec2-user /opt/secondbrain/$dep && rm -f $tmp"
  fi
done

# 2026-07-06 deploy-outage fix: LIVE_DEPS is a hand-curated list of top-level
# entrypoint scripts, and it drifts -- a land can add a new require() inside
# ec2-server.js (or anything it transitively requires) without anyone
# remembering to add the new file to this array. scripts/lib/ and
# scripts/self-heal/ are pure library code (no entrypoints of their own, cheap
# to ship in full), so instead of trying to keep every library file curated by
# hand, ship the WHOLE directories every deploy. This kills the curated-list-
# drift class for libs outright; LIVE_DEPS stays the curated list only for
# top-level entrypoint scripts (callback-watchdog.js, cloud-morning-briefing.js,
# etc.) that are not under scripts/lib/ or scripts/self-heal/.
echo "[deploy] pushing scripts/lib/ + scripts/self-heal/ in full (kills curated-list drift for libs)"
for libdir in "scripts/lib" "scripts/self-heal"; do
  if [ -d "$ROOT/$libdir" ]; then
    tmp_tar="/tmp/secondbrain-deploy-$(basename "$libdir").tar.gz"
    tar -czf "$tmp_tar" -C "$ROOT" "$libdir"
    scp -i "$KEY" -o StrictHostKeyChecking=no "$tmp_tar" "$HOST:$tmp_tar"
    rm -f "$tmp_tar"
    ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
      "sudo mkdir -p /opt/secondbrain/$libdir && sudo tar -xzf $tmp_tar -C /opt/secondbrain && sudo chown -R ec2-user:ec2-user /opt/secondbrain/$libdir && rm -f $tmp_tar"
  fi
done

if [ -f "$ROOT/data/agent/devops-health-latest.json" ]; then
  echo "[deploy] pushing fresh Dev Ops desktop checkout snapshot"
  scp -i "$KEY" -o StrictHostKeyChecking=no "$ROOT/data/agent/devops-health-latest.json" "$HOST:/tmp/devops-health-latest.json"
  ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
    "sudo mkdir -p /opt/secondbrain/data/agent && sudo cp /tmp/devops-health-latest.json /opt/secondbrain/data/agent/devops-health-latest.json && sudo chown ec2-user:ec2-user /opt/secondbrain/data/agent/devops-health-latest.json && rm -f /tmp/devops-health-latest.json"
else
  echo "[deploy] WARNING: no data/agent/devops-health-latest.json snapshot to ship; EC2 Dev Ops health will red-line snapshot proof."
fi

# Require-resolution gate (2026-07-06): BEFORE pm2 restart, statically walk the
# relative-require closure of the just-deployed server.js on EC2 and abort if
# anything is missing. `node -c` only syntax-checks; it never resolves
# requires, so a missing module was previously invisible until PM2 actually
# loaded it and crash-looped. This gate runs against the shipped
# require-scan-check.js (scripts/lib/require-scan.js does the walking), so it
# needs no repo checkout on EC2 -- only the files this same deploy just copied.
echo "[deploy] pushing require-scan gate"
scp -i "$KEY" -o StrictHostKeyChecking=no "$ROOT/scripts/require-scan-check.js" "$HOST:/tmp/secondbrain-deploy-require-scan-check.js"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
  "sudo cp /tmp/secondbrain-deploy-require-scan-check.js /opt/secondbrain/scripts/require-scan-check.js && sudo chown ec2-user:ec2-user /opt/secondbrain/scripts/require-scan-check.js && rm -f /tmp/secondbrain-deploy-require-scan-check.js"

echo "[deploy] require-scan gate: resolving server.js's require closure on EC2 (before restart)"
if ! ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
  'node /opt/secondbrain/scripts/require-scan-check.js --root /opt/secondbrain server.js'; then
  echo "[deploy] REQUIRE-SCAN FAIL: server.js requires a module that is missing on EC2. Rolling back the on-disk file (PM2 was never restarted, so the old process was already still running; this just keeps the ON-DISK copy consistent with it too, so the deploy-parity probe and the nightly canary do not false-red against a half-deployed file). See MISSING lines above; add the module to LIVE_DEPS (or scripts/lib or scripts/self-heal, which ship in full) and redeploy."
  ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
    'cp "$(ls -t /opt/secondbrain/server.js.bak-* | head -1)" /opt/secondbrain/server.js; cp "$(ls -t /opt/secondbrain/ec2-server.js.bak-* | head -1)" /opt/secondbrain/ec2-server.js'
  exit 1
fi

echo "[deploy] syntax-check + restart + health on EC2"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" '
  node -c /opt/secondbrain/server.js || { echo "[deploy] SYNTAX FAIL on EC2, rolling back"; cp "$(ls -t /opt/secondbrain/server.js.bak-* | head -1)" /opt/secondbrain/server.js; exit 1; }
  node -c /opt/secondbrain/scripts/callback-watchdog.js || { echo "[deploy] CALLBACK WATCHDOG SYNTAX FAIL on EC2"; exit 1; }
  pm2 restart secondbrain-backend --update-env >/dev/null
  if pm2 describe callback-watchdog >/dev/null 2>&1; then
    pm2 restart callback-watchdog --update-env >/dev/null
  else
    pm2 start /opt/secondbrain/scripts/callback-watchdog.js --name callback-watchdog --cwd /opt/secondbrain --update-env >/dev/null
  fi
  pm2 save >/dev/null
  code=000
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 8 http://127.0.0.1:3001/health 2>/dev/null || echo 000)
    [ "$code" = "200" ] && break
  done
  echo "  /health HTTP $code (after $((i*3))s)"
  [ "$code" = "200" ] || { echo "[deploy] HEALTH FAIL, rolling back"; cp "$(ls -t /opt/secondbrain/server.js.bak-* | head -1)" /opt/secondbrain/server.js; pm2 restart secondbrain-backend --update-env >/dev/null; exit 1; }
'

echo "[deploy] verifying post-deploy parity (whitespace-insensitive)"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" 'tr -d "\r" < /opt/secondbrain/server.js' > "$ROOT/data/agent/_ec2-live-after.js"
DIFF=$(diff -w "$LF" "$ROOT/data/agent/_ec2-live-after.js" | grep -cE '^[<>]' || true)
rm -f "$LF" "$ROOT/data/agent/_ec2-live-after.js"
if [ "$DIFF" -eq 0 ]; then
  echo "[deploy] OK: repo and live EC2 server.js are now identical."
else
  echo "[deploy] WARNING: $DIFF lines still differ after deploy. Investigate."
  exit 1
fi
