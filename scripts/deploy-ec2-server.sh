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
LIVE_DEPS=(
  "scripts/lib/voice-cloud-runtime.js"
  "scripts/lib/live-dev-state.js"
  "scripts/callback-watchdog.js"
  "scripts/vapi-end-of-call.js"
  "scripts/lib/dispatch-delivery.js"
  "scripts/lib/briefing-markdown-sections.js"
  "scripts/lib/briefing-news-reader.js"
  "scripts/cloud-morning-briefing.js"
  # The shared card-controller entrypoint backs both in-briefing ExampleCo-action
  # buttons and the cloud overnight runner. Its source adapters need the same
  # narrow Otter producers on /opt; libs ship in full below.
  "scripts/card-controller.js"
  "scripts/refresh-card.js"
  # Controller source contracts spawn these top-level token collectors. They
  # are not visible to require-scan, so deploy and hash them explicitly.
  "scripts/collect-daily-token-usage.js"
  "scripts/collect-claude-plan-usage.js"
  "scripts/collect-codex-token-usage.js"
  "scripts/collect-bedrock-budget-usage.js"
  "scripts/ec2-card-controller-run.sh"
  "scripts/ec2-morning-briefing-run.sh"
  "scripts/briefing-morning-report.js"
  "scripts/run-scheduled-skill.js"
  "scripts/post-release-scheduled-skill-canary.js"
  "scripts/ensure-neo4j-cpu-cap.js"
  "scripts/install-ec2-card-controller-cron.sh"
  # Wave 4 rung 2: the agentic overnight healer. The morning runner (deployed
  # above) invokes the wrapper, which invokes the driver; ship both so the /opt
  # copy never drifts behind a land (feedback_ec2_build_path_silent_revert).
  "scripts/overnight-agentic-healer.sh"
  "scripts/agentic-healer-driver.js"
  "scripts/otter-call-speaker-rosters.js"
  "scripts/otter-call-completeness-report.js"
  "scripts/otter-text-audio-coverage-report.js"
  # Targeted Otter speaker-mismatch source rung. The controller invokes this
  # only for a specific mismatched call and disables its broad briefing /
  # people-file writers. Keep the full local acoustic chain on /opt so an
  # in-briefing scoped refresh does not depend on a stale build-path sync.
  "scripts/otter-post-ingest-voice-intelligence.js"
  "scripts/otter-full-audio-backfill.js"
  "scripts/otter-diarized-segment-backfill.js"
  "scripts/otter-track-probe-builder.js"
  "scripts/otter-wavlm-speaker-resolver.js"
  "scripts/voice-embedding-ecapa.js"
  "scripts/apply-voice-cluster-resolutions.js"
  "scripts/otter-speaker-identity-completeness.js"
  "scripts/voice-confirmed-match-sanity-check.js"
  "scripts/voice-promote-confirmed-acoustic-matches.js"
  "scripts/otter-life-relevance-enricher.js"
  "scripts/otter-speaker-intelligence-report.js"
  "scripts/sync-otter-speaker-intelligence-to-people-files.js"
  "scripts/sync-voiceprints-to-people-files.js"
  "scripts/content-heal.js"
  "scripts/regenerate-action-items.js"
  "scripts/aws-cost-section.js"
  "scripts/mortgage-rate-indexes.js"
  "scripts/morning-shorts-proposals.js"
  "scripts/viral-tech-clip-proposals.js"
  "scripts/kingdom-equipping-ideas.js"
  "scripts/comm-coaching-card.js"
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

# The cloud card controller must execute the same deployed source that this
# script verifies. Keep this closure explicit and hash-check it below: a
# healthy /opt server paired with a stale /home build-path controller is a
# split-brain deployment, not a successful release.
CONTROLLER_RUNTIME_FILES=(
  "scripts/card-controller.js"
  "scripts/refresh-card.js"
  "scripts/collect-daily-token-usage.js"
  "scripts/collect-claude-plan-usage.js"
  "scripts/collect-codex-token-usage.js"
  "scripts/collect-bedrock-budget-usage.js"
  "scripts/verify-dashboard-cards-live.js"
  "scripts/ec2-card-controller-run.sh"
  "scripts/ec2-morning-briefing-run.sh"
  "scripts/briefing-morning-report.js"
  "scripts/install-ec2-card-controller-cron.sh"
  "scripts/lib/briefing-card-controller.js"
  "scripts/lib/briefing-source-contracts.js"
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

# ============================================================================
# LIVE WRITE: delegated to the atomic-release primitive (the SOLE /opt writer).
# ============================================================================
# This script used to write /opt piecemeal: scp the two server twins, scp+cp
# each LIVE_DEP, tar+extract scripts/lib + scripts/self-heal, then run an inline
# require-scan gate and pm2 restart, rolling back individual .bak files. That
# per-file mutation is exactly the version-skew hazard we are killing: a partial
# write could leave an entrypoint newer than a lib it needs, crash-looping PM2.
#
# scripts/lib/atomic-release.sh replaces all of that. It stages a FULL checkout
# of exactly HEAD's sha into /opt/secondbrain-releases/<sha>, VERIFIES the tree
# loads (node -c + require-scan + import-smoke -- the import-smoke catches a
# stale lib missing an EXPORT, which the old require-scan-only gate could not),
# then does an ATOMIC symlink swap + pm2 restart + POST-RESTART /health, rolling
# the symlink back to the previous release on ANY failure. So the whole tree
# (both server twins, every LIVE_DEP, scripts/lib, scripts/self-heal) ships as
# one immutable unit -- no file can be forgotten, and no half-written window
# exists. The LIVE_DEPS + CONTROLLER_RUNTIME_FILES arrays above are retained as
# the audited entrypoint/closure manifest (checked to exist locally below);
# they no longer drive the copy.
SHA="$(git -C "$ROOT" rev-parse HEAD)"
echo "[deploy] delegating live write to atomic-release.sh (sha $SHA)"
echo "[deploy]   ships /opt/secondbrain/server.js + /opt/secondbrain/ec2-server.js inside the release tree"
if ! bash "$ROOT/scripts/lib/atomic-release.sh" \
  --sha "$SHA" --source-root "$ROOT" --host "$HOST" --key "$KEY"; then
  echo "[deploy] ATOMIC RELEASE FAILED: the primitive either failed verification, or swapped and then rolled back on a health failure. /opt is unchanged from the last good release. See the [atomic-release] lines above." >&2
  exit 1
fi

# Neo4j is enrichment and must not consume the host capacity needed by the
# independent card producers. Reapply and verify the cap after every release.
echo "[deploy] enforcing permanent Neo4j CPU cap"
if ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
  "/usr/bin/node /opt/secondbrain/scripts/ensure-neo4j-cpu-cap.js --apply --data-dir /opt/secondbrain/data"; then
  echo "[deploy] Neo4j CPU cap: PASS"
else
  echo "[deploy] WARNING: Neo4j CPU cap proof failed; release remains live and System Health will retain the non-green receipt." >&2
fi

# Observational post-release scheduled-skill rescue canary. The release has
# already passed atomic swap + /health, so this proof never rolls good code
# back. It forces the Claude rung to fail, proves the Codex rescue reaches a
# real isolated worktree from the source checkout, and writes a runtime receipt
# that System Health grades as current, historical, or failed.
echo "[deploy] running post-release scheduled-skill rescue canary (observational, no rollback)"
if ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
  "/usr/bin/node /opt/secondbrain/scripts/post-release-scheduled-skill-canary.js --release-root /opt/secondbrain --source-root /home/ec2-user/secondbrain-current --data-dir /opt/secondbrain/data --release-sha '$SHA'"; then
  echo "[deploy] post-release scheduled-skill rescue canary: PASS"
else
  echo "[deploy] WARNING: post-release scheduled-skill rescue canary failed; release remains live and System Health will show the current proof failure." >&2
fi

echo "[deploy] auditing curated entrypoint + controller closure exists locally"
for dep in "${LIVE_DEPS[@]}" "${CONTROLLER_RUNTIME_FILES[@]}"; do
  # server.js is minted from ec2-server.js inside the release; it has no repo file.
  [ "$dep" = "server.js" ] && continue
  [ -f "$ROOT/$dep" ] || { echo "[deploy] MANIFEST MISSING LOCAL: $dep" >&2; exit 1; }
done
echo "[deploy] curated closure present locally: OK (shipped inside the atomic release)"

# ============================================================================
# runtime DATA artifacts (NOT code): the ONLY things this script still writes to
# /opt directly, always under /opt/secondbrain/data/, never a code path. These
# are receipts + snapshots the cloud Dev Ops / deploy-parity cards read.
# ============================================================================
if [ -f "$ROOT/data/agent/devops-health-latest.json" ]; then
  echo "[deploy] pushing fresh Dev Ops desktop checkout snapshot"
  scp -i "$KEY" -o StrictHostKeyChecking=no "$ROOT/data/agent/devops-health-latest.json" "$HOST:/tmp/devops-health-latest.json"
  ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
    "sudo mkdir -p /opt/secondbrain/data/agent && sudo cp /tmp/devops-health-latest.json /opt/secondbrain/data/agent/devops-health-latest.json && sudo chown ec2-user:ec2-user /opt/secondbrain/data/agent/devops-health-latest.json && rm -f /tmp/devops-health-latest.json"
else
  echo "[deploy] WARNING: no data/agent/devops-health-latest.json snapshot to ship; EC2 Dev Ops health will red-line snapshot proof."
fi

# D9 land-gate receipt (wave 3a, 2026-07-12): the System Health "Automated
# regression suite" row reads the last land-gate scoped-test result as its
# runtime proof. scripts/land.js writes the receipt on every apply-mode land;
# ship the desktop copy so the cloud row renders the same factual timestamped
# status instead of "no current runtime proof".
if [ -f "$ROOT/data/agent/land-gate-receipt.json" ]; then
  echo "[deploy] pushing latest land-gate receipt"
  scp -i "$KEY" -o StrictHostKeyChecking=no "$ROOT/data/agent/land-gate-receipt.json" "$HOST:/tmp/land-gate-receipt.json"
  ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
    "sudo mkdir -p /opt/secondbrain/data/agent && sudo cp /tmp/land-gate-receipt.json /opt/secondbrain/data/agent/land-gate-receipt.json && sudo chown ec2-user:ec2-user /opt/secondbrain/data/agent/land-gate-receipt.json && rm -f /tmp/land-gate-receipt.json"
else
  echo "[deploy] NOTE: no data/agent/land-gate-receipt.json to ship yet; the Automated regression suite row will stay informational until the first receipted land."
fi

# The require-scan gate, syntax-check, pm2 restart, /health probe, .bak
# rollback, and post-deploy parity diff that used to live here are now ALL
# guarantees of scripts/lib/atomic-release.sh (run above): it require-scans AND
# import-smokes the staged tree before the swap, and health-probes with symlink
# rollback after. Keeping a second, inline copy here would just be a per-file
# /opt writer competing with the sole writer -- exactly what we removed.

# ============================================================================
# deploy receipt (single code authority): record what shipped + how it relates
# to origin/master, and mirror the ledger to /opt/secondbrain/data/ so the
# EC2-side deploy-parity probe can verify /opt independently. A release that
# cannot be receipted FAILS LOUD (feedback_ec2_build_path_silent_revert.md).
# ============================================================================
echo "[deploy] recording deploy receipt"
if ! node "$ROOT/scripts/record-ec2-deploy-receipt.js"; then
  echo "[deploy] RECEIPT FAIL: the release landed but could not be receipted. Fix and re-run so the parity probe has a receipt to verify against." >&2
  exit 1
fi
scp -i "$KEY" -o StrictHostKeyChecking=no "$ROOT/data/agent/ec2-deploy-receipts.jsonl" "$HOST:/tmp/secondbrain-deploy-receipts.jsonl"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
  'sudo mkdir -p /opt/secondbrain/data/agent && sudo cp /tmp/secondbrain-deploy-receipts.jsonl /opt/secondbrain/data/agent/ec2-deploy-receipts.jsonl && sudo chown ec2-user:ec2-user /opt/secondbrain/data/agent/ec2-deploy-receipts.jsonl && rm -f /tmp/secondbrain-deploy-receipts.jsonl'
echo "[deploy] receipt recorded + mirrored to /opt/secondbrain/data/agent/ec2-deploy-receipts.jsonl"
echo "[deploy] OK: released $SHA via atomic-release (/opt/secondbrain -> releases/$SHA), health-verified."
