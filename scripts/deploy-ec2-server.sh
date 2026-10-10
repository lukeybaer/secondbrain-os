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
# Usage: bash scripts/deploy-ec2-server.sh [--swap-anyway] [--local]
set -euo pipefail

KEY="${SB_KEY:-$HOME/.ssh/sb-key.pem}"
HOST="ec2-user@ExampleCo"
ROOT="$(git rev-parse --show-toplevel)"

# Deploy-window guard override (2026-07-19): the guard below REFUSES the atomic
# swap when a scheduled runner is about to fire or is mid-flight. --swap-anyway
# (or SB_DEPLOY_SWAP_ANYWAY=1) is the explicit, attended override.
SWAP_ANYWAY="${SB_DEPLOY_SWAP_ANYWAY:-0}"
LOCAL_DEPLOY="${SB_DEPLOY_LOCAL:-0}"
# An attended deploy may wait in the kernel flock queue for an exact-call Otter
# pass to reach a stage boundary, and so may an unattended one. Since 2026-09-24 the healer stops admitting targets
# and stops stage chaining the moment the release lock exists, so the wait is
# one in-flight stage (normally one to two minutes); the default is five
# minutes per lane instead of an immediate refusal (ExampleCo: Otter must stop
# blocking releases). Set 0 for the old fail-fast behavior. This is lock
# coordination, not an override: the atomic swap still cannot run until this
# release owns both the live and historical lane locks.
OTTER_LOCK_WAIT_SECONDS="${SB_DEPLOY_OTTER_LOCK_WAIT_SECONDS:-300}"
DEPLOY_DATA_DIR="/opt/secondbrain/data"
for arg in "$@"; do
  case "$arg" in
    --swap-anyway) SWAP_ANYWAY=1 ;;
    --local) LOCAL_DEPLOY=1 ;;
  esac
done
if ! [[ "$OTTER_LOCK_WAIT_SECONDS" =~ ^[0-9]+$ ]] || [ "$OTTER_LOCK_WAIT_SECONDS" -gt 1800 ]; then
  echo "[deploy] REFUSED: SB_DEPLOY_OTTER_LOCK_WAIT_SECONDS must be an integer from 0 through 1800." >&2
  exit 1
fi
# A remote caller may carry its own launcher data root. That root is never valid
# on the SSH target, whose canonical mutable state is fixed under /opt. Only an
# on-host --local or SB_DEPLOY_LOCAL=1 deploy may inherit an explicit data root.
if [ "$LOCAL_DEPLOY" = "1" ]; then
  DEPLOY_DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
fi
[ -f "$KEY" ] || KEY="$HOME/.ssh/secondbrain-backend-key.pem"

# One release graph, two transports. Desktop callers use SSH; an EC2-local
# healer uses --local and executes the same guards, atomic release, receipts,
# cron normalization, and live proofs on-host. EC2 must never need an SSH key
# merely to talk to itself.
target_exec() {
  if [ "$LOCAL_DEPLOY" = "1" ]; then
    bash -lc "$1"
  else
    ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "$1"
  fi
}

target_exec_stdin() {
  if [ "$LOCAL_DEPLOY" = "1" ]; then
    bash -lc "$1"
  else
    ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "$1"
  fi
}

target_copy() {
  local source="$1" destination="$2"
  if [ "$LOCAL_DEPLOY" = "1" ]; then
    cp "$source" "$destination"
  else
    scp -i "$KEY" -o StrictHostKeyChecking=no "$source" "$HOST:$destination"
  fi
}

# A linked worktree can become clean and fully merged while this long-running
# deploy still needs it for post-swap closure checks and receipt generation.
# Lock it before any deploy work so the git janitor cannot reap the source tree
# mid-run. The main worktree is never lockable and does not need this lease.
WORKTREE_LOCK_OWNED=0
GIT_DIR_ABS="$(git -C "$ROOT" rev-parse --absolute-git-dir)"
GIT_COMMON_DIR_ABS="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)"
cleanup_worktree_lock() {
  if [ "$WORKTREE_LOCK_OWNED" -eq 1 ]; then
    git -C "$ROOT" worktree unlock "$ROOT" >/dev/null 2>&1 || true
  fi
}
if [ "$GIT_DIR_ABS" != "$GIT_COMMON_DIR_ABS" ]; then
  if [ -f "$GIT_DIR_ABS/locked" ]; then
    echo "[deploy] source worktree already locked; preserving the caller-owned lease"
  elif git -C "$ROOT" worktree lock --reason "active EC2 deploy $$" "$ROOT"; then
    WORKTREE_LOCK_OWNED=1
    echo "[deploy] source worktree lease acquired"
  else
    echo "[deploy] FAIL: could not lock linked source worktree $ROOT" >&2
    exit 1
  fi
fi
trap cleanup_worktree_lock EXIT

SRC="$ROOT/ec2-server.js"
LIVE_DEPS=(
  "scripts/lib/system-health-face-status.js"
  "scripts/lib/graphiti-ingestion-policy.js"
  "scripts/lib/deploy-delta-scope.js"
  "scripts/lib/voice-cloud-runtime.js"
  # The public Vapi custom-LLM endpoint executes subscription inference here;
  # keep its isolated runtime and receipt adapter in the audited EC2 closure.
  "scripts/lib/voice-cloud-inference.js"
  "scripts/lib/codex-app-server-client.js"
  "scripts/lib/codex-voice-attempt-telemetry.js"
  "scripts/lib/claude-voice-subscription-client.js"
  "scripts/lib/voice-lane-router.js"
  "scripts/lib/cli-output-guard.js"
  "scripts/lib/voice-release-proof.js"
  "scripts/lib/voice-internal-self-test.js"
  "scripts/lib/voice-turn-coordinator.js"
  "scripts/lib/voice-traffic-priority.js"
  "scripts/lib/briefing-dashboard-cache.js"
  "scripts/lib/briefing-people-index-cache.js"
  "scripts/backup-health-proof.js"
  "scripts/backup-restore-proof.js"
  "scripts/lib/backup-health.js"
  "scripts/lib/backup-restore-verifier.js"
  "scripts/lib/voice-primary.js"
  "scripts/lib/voice-paid-fallback.js"
  "config/voice-runtime-policy.json"
  # The release-proof hash is a live call-surface contract. Audit every script
  # surface it names so its required Amy-to-Amy canary cannot drift unnoticed.
  "scripts/outbound-call-control.js"
  "scripts/vapi-self-call-status-test.js"
  "scripts/lib/outbound-call-broker.js"
  "scripts/lib/vapi-listen-opening-watcher.js"
  "scripts/lib/outbound-call-control.js"
  "scripts/lib/inference-work-ledger.js"
  "scripts/lib/vapi-call-correlation.js"
  "scripts/lib/vapi-static-model.js"
  "scripts/lib/vapi-voice-decision.js"
  "scripts/lib/voice-self-test-status-seed.js"
  "scripts/lib/live-dev-state.js"
  "scripts/callback-watchdog.js"
  "scripts/vapi-end-of-call.js"
  "scripts/lib/dispatch-delivery.js"
  "scripts/lib/briefing-markdown-sections.js"
  "scripts/lib/briefing-news-reader.js"
  "scripts/cloud-morning-briefing.js"
  # Provider-neutral Claude/Codex session replication, cloud projection,
  # exact-search/Graphiti redrive, and the three briefing health receipts.
  "scripts/session-cloud-plane.js"
  "scripts/session-fts.py"
  "scripts/lib/session-cloud-plane.js"
  "scripts/lib/session-cloud-health.js"
  "scripts/lib/session-cloud-query.js"
  "scripts/lib/session-event-outbox.js"
  "scripts/install-session-cloud-plane-cron.sh"
  # Telegram voice notes use a durable local faster-whisper runtime. The
  # installer pins the package and preloads the model before the live swap.
  "scripts/install-telegram-voice-runtime.sh"
  # Curated state is intentionally outside immutable releases. The deploy gate
  # asserts and atomically seeds this required input into durable runtime data.
  "data/agent/big-decisions.jsonl"
  # Graphiti Brain Advisor: ec2-server.js requires the shared runtime; the
  # scheduled-skill runner invokes the detached CLI; the runtime reads the
  # git-tracked skill learnings at query time. Keep all three in the audited
  # release closure even though the atomic release ships the full checkout.
  "scripts/graphiti-brain-advisor.js"
  "scripts/graphiti-cli.mjs"
  "scripts/lib/graphiti-brain-advisor.js"
  "scripts/lib/graphiti-advisor-health.js"
  "scripts/graphiti-subscription-gateway.js"
  "scripts/graphiti-event-drain.js"
  "scripts/lib/graphiti-overnight-policy.js"
  "scripts/lib/briefing-terminal-state.js"
  "scripts/lib/briefing-night-coordinator.js"
  "scripts/overnight-watcher-launcher.js"
  # Linux watcher sessions enter their resource envelope through this wrapper.
  "scripts/watcher-model-sandbox.sh"
  "skills/memory/graphiti-consult-for-prompts/SKILL.md"
  "skills/memory/graphiti-consult-for-prompts/LEARNINGS.md"
  # The stock Graphiti 0.28.2 Neo4j path scans every embedded relationship.
  # The repo-owned image preserves the MCP contract but uses Neo4j's
  # relationship-vector index, and the compose file is its deployment seam.
  "docker-compose.graphiti.yml"
  "infra/graphiti/Dockerfile"
  "infra/graphiti/main_secondbrain.py"
  # The shared card-controller entrypoint backs both in-briefing ExampleCo-action
  # buttons and the cloud overnight runner. Its source adapters need the same
  # narrow Otter producers on /opt; libs ship in full below.
  "scripts/card-controller.js"
  "scripts/mint-briefing-attended-action.js"
  "scripts/refresh-card.js"
  # Controller source contracts spawn these top-level token collectors. They
  # are not visible to require-scan, so deploy and hash them explicitly.
  "scripts/collect-daily-token-usage.js"
  "scripts/collect-claude-plan-usage.js"
  "scripts/collect-codex-token-usage.js"
  "scripts/collect-bedrock-budget-usage.js"
  "scripts/ec2-card-controller-run.sh"
  "scripts/ec2-morning-report-prep-run.sh"
  "scripts/collect-token-spend-overnight.js"
  "scripts/attach-exact-token-cut.js"
  "scripts/ec2-morning-briefing-run.sh"
  "scripts/lib/briefing-report-closure.js"
  "scripts/overnight-watch-report.js"
  "scripts/recover-briefing-evidence.js"
  # Final report synthesis runs this bounded independent review worker directly.
  "scripts/codex-peer-review.js"
  "scripts/codex-run.js"
  "scripts/night-supervisor.js"
  # The one active night-owner service invokes amy-night-run directly. Its
  # install/cutover, scheduled resize measurement, and pure schedule helpers
  # must be in the audited direct-root list even though atomic release ships
  # the full source snapshot.
  "scripts/install-amy-night-owner.sh"
  "scripts/heal-resource-scope-canary.js"
  "scripts/cloud-maintenance-folds.js"
  "scripts/scoped-test-snapshot.js"
  "scripts/gravity-health.js"
  "scripts/system-health-category-probe.js"
  "scripts/lib/provider-canary.js"
  "scripts/lib/runtime-source-sha.js"
  "scripts/desktop-snapshot-maintenance.js"
  "scripts/lib/land-gate.js"
  "scripts/collect-nightly-resize-measurement.js"
  "scripts/lib/nightly-resize-measurement.js"
  "scripts/lib/night-owner-cutover.js"
  "scripts/lib/nightly-resize-schedule.js"
  "scripts/ec2-overnight-watcher-run.sh"
  "scripts/watcher-checkpoint.js"
  "scripts/cloud-runtime-release-proof.js"
  "scripts/lib/briefing-watcher-control.js"
  "scripts/lib/ec2-endpoint.js"
  "scripts/lib/attended-briefing-tripwire.js"
  "scripts/lib/briefing-card-progress.js"
  "scripts/lib/briefing-email.js"
  "scripts/run-scheduled-skill.js"
  "scripts/memory-consolidation-report.js"
  "scripts/lib/scheduled-skill-promotion-queue.js"
  "scripts/ec2-code-task-release.js"
  "scripts/post-release-scheduled-skill-canary.js"
  "scripts/ensure-neo4j-cpu-cap.js"
  "scripts/install-ec2-card-controller-cron.sh"
  "scripts/verify-unattended-morning.sh"
  "scripts/install-ec2-self-heal-cron.sh"
  "scripts/install-ec2-deploy-parity-cron.sh"
  "scripts/install-ec2-gmail-s3-flow-cron.sh"
  "scripts/ec2-resize-drain.js"
  "scripts/install-ec2-resize-drain.sh"
  "scripts/overnight-capacity-measurement.js"
  "scripts/overnight-capacity-attribution.js"
  "scripts/lib/overnight-capacity-measurement.js"
  "scripts/install-overnight-capacity-measurement-cron.sh"
  "scripts/morning-retro.js"
  "scripts/lib/morning-retro.js"
  "scripts/install-morning-retro-cron.sh"
  "scripts/ssh-idle-session-reaper.js"
  "scripts/lib/ssh-idle-sessions.js"
  "scripts/install-ec2-ssh-session-reaper-cron.sh"
  "scripts/lib/daytime-fleet-cron.js"
  "scripts/install-ec2-daytime-scheduled-fleet-cron.sh"
  "scripts/ec2-storage-pressure-maintenance.js"
  "scripts/lib/storage-pressure-maintenance.js"
  "scripts/install-ec2-storage-pressure-maintenance.sh"
  "scripts/ec2-storage-pressure-maintenance-run.sh"
  "scripts/git-janitor.js"
  "scripts/lib/briefing-delivery-slo.js"
  # Wave 4 rung 2: the agentic overnight healer. The morning runner (deployed
  # above) invokes the wrapper, which invokes the driver; ship both so the /opt
  # copy never drifts behind a land (feedback_ec2_build_path_silent_revert).
  "scripts/overnight-agentic-healer.sh"
  "scripts/agentic-healer-driver.js"
  # The healer driver may land an approved repair and deploy the resulting
  # origin/master commit. Keep those spawned entrypoints in the audited
  # runtime closure even though the atomic release already ships the full tree.
  "scripts/land.js"
  "scripts/deploy-ec2-server.sh"
  "scripts/verify-controller-deploy-authority.js"
  "scripts/lib/deploy-window-guard.js"
  "scripts/lib/scan-output-lander.js"
  # Guard-floor entry (Codex review round 3, 2026-08-25): quoted by name
  # inside core.test.js's guard-floor assertion, same as its four siblings
  # immediately above, so the spawned-scripts scan treats it the same way.
  "scripts/verify-cards-drift.js"
  "scripts/verify-core-doc-citations.js"
  "scripts/verify-core-doc-shape.js"
  "scripts/verify-core-registry-drift.js"
  "scripts/verify-gravity-drift.js"
  # cloud-first drift lint (2026-08-24 g26 introduction, commit 47a9dd976):
  # core.test.js spawns this like every other drift lint above, and it
  # requires the two lib modules below. All three were missing from LIVE_DEPS
  # for a day; scripts/__tests__/deploy-manifest-covers-spawned-scripts.test.js
  # and scripts/__tests__/deploy-manifest-covers-drift-lint-family.test.js pin
  # the gap shut.
  "scripts/verify-cloud-first-drift.js"
  "scripts/lib/cloud-first-policy.js"
  "scripts/lib/live-deps-parser.js"
  # The rest of the always-on drift-lint family (LINTS in core.test.js) had
  # the SAME gap for their own local requires, caught by widening
  # deploy-manifest-covers-drift-lint-family.test.js from a 2-file hand list to
  # a generic AST-based require-closure walk over every LINTS entry (Codex
  # review, 2026-08-25): verify-core-registry-drift.js, verify-core-doc-shape.js,
  # and verify-gravity-drift.js all require core-component-registry.js;
  # verify-gravity-drift.js also requires gravity-registry.js and
  # hook-delivery.js; verify-cards-drift.js requires card-skills.js, which
  # requires system-health-nongreen.js (already shipped below), which requires
  # system-health-tests-row.js, which requires land-gate-receipt.js;
  # briefing-card-manifest.js (already shipped below) requires
  # operator-identity.js. All transitive.
  "scripts/lib/core-component-registry.js"
  "scripts/lib/gravity-registry.js"
  "scripts/lib/hook-delivery.js"
  "scripts/lib/card-skills.js"
  "scripts/lib/system-health-tests-row.js"
  "scripts/lib/land-gate-receipt.js"
  "scripts/lib/operator-identity.js"
  "scripts/lib/agentic-closure-queue.js"
  # Targeted Otter speaker-mismatch source rung. The controller invokes this
  # only for a specific mismatched call and disables its broad briefing /
  # people-file writers. Keep the full local acoustic chain on /opt so an
  # in-briefing scoped refresh does not depend on a stale build-path sync.
  # It spawns this enrollment step by repo-relative path on every run.
  "scripts/voice-enrollment-strengthen.js"
  # Orphaned name-judge recovery. Both pipelines that publish new cluster
  # membership spawn these, so they have to be on the box or the step fails
  # every run and the stranded proposals stay stranded.
  "scripts/voice-name-judge-orphan-report.js"
  "scripts/voice-name-judge-orphan-rejudge.js"
  "scripts/lib/voice-name-judge-orphans.js"
  # The dispatcher spawns the resolver by absolute path, so the resolver has to
  # be on /opt too or every re-judge exits before it starts.
  "scripts/voice-identity-overnight-name-resolver.js"
  # Closure of the resolver: it spawns both of these directly.
  "scripts/voice-name-calibration-gate.js"
  # Pre-existing gap surfaced by the same closure guard: run-scheduled-skill.js
  # is deployed and spawns this, but it was never shipped. Adding it here is the
  # one-line fix rather than leaving a known-missing runtime dependency.
  "scripts/memory-consolidation-report.js"
  # The healer reads this file to fingerprint its exec-summary repair stage.
  "scripts/lib/otter-exec-summary-artifacts.js"
  "scripts/lib/otter-healer-pause.js"
  "scripts/activate-otter-exact-call-cutover.js"
  "scripts/voice-efs-reconcile.js"
  "scripts/lib/otter-exact-scope-state.js"
  "scripts/install-ec2-voice-efs-reconcile-cron.sh"
  "scripts/lib/otter-call-closure-verifier.js"
  "scripts/lib/otter-call-stage-receipt-store.js"
  "scripts/lib/otter-call-processing-graph.js"
  "scripts/lib/otter-call-processing-cycles.js"
  "scripts/lib/healer-attempt-history.js"
  "scripts/lib/otter-architecture-provenance.js"
  "scripts/lib/otter-call-event-queue.js"
  "scripts/lib/otter-raw-archive-receipt.js"
  "scripts/lib/otter-call-healer-handoff.js"
  "scripts/lib/otter-call-processing-ledger.js"
  "scripts/lib/voice-name-conflicts.js"
  "scripts/lib/otter-monotonic-identity.js"
  "scripts/lib/otter-storage-capacity.js"
  "scripts/lib/otter-derived-audio-retention.js"
  "scripts/lib/otter-full-audio-archive.js"
  "scripts/lib/otter-exact-call-envelope.js"
  "scripts/lib/otter-exact-call-envelope-producer.js"
  "scripts/lib/otter-exact-call-people-projection.js"
  "scripts/lib/voice-reference-provenance.js"
  "scripts/lib/voice-name-judge-coverage.js"
  "scripts/lib/people-name-match.js"
  "scripts/lib/recluster-publish-lock.js"
  "deploy/voice-fargate/otter-producer-contract.json"
  "config/otter-release-compatibility.json"
  "scripts/lib/otter-release-compatibility.js"
  "scripts/migrate-legacy-voice-reference-provenance.js"
  "scripts/lib/otter-exact-call-aggregate-reconcile.js"
  "scripts/lib/voice-fargate-trigger.js"
  "scripts/lib/otter-cohort-burst-runner.js"
  "scripts/voice-incremental-recluster.js"
  "scripts/voice-name-conflict-audit.js"
  "scripts/voice-promote-sandbox-reference-matches.js"
  "scripts/speaker-identity-change-hook.js"
  "scripts/ec2-otter-call-healer-run.sh"
  "scripts/ec2-global-identity-cap-run.sh"
  "scripts/ec2-otter-lane-scope-run.sh"
  "scripts/ec2-otter-healer-pause-recovery-run.sh"
  "scripts/ec2-otter-derived-audio-retention-run.sh"
  "scripts/ec2-otter-full-audio-archive-run.sh"
  "scripts/install-ec2-otter-call-healer-cron.sh"
  "scripts/install-ec2-voice-recluster-cron.sh"
  "scripts/install-ec2-otter-full-audio-archive-cron.sh"
  "scripts/otter-wavlm-speaker-resolver.js"
  "scripts/voice-embedding-ecapa.js"
  "scripts/apply-voice-cluster-resolutions.js"
  "scripts/voice-confirmed-match-sanity-check.js"
  "scripts/voice-promote-confirmed-acoustic-matches.js"
  "scripts/sync-voiceprints-to-people-files.js"
  "scripts/voice-people-file-projection-audit.js"
  "scripts/voice-people-file-target-repair.js"
  "scripts/lib/otter-stage-budgets.js"
  "scripts/lib/voice-name-conflict-proof.js"
  "scripts/content-heal.js"
  # Data-only second stage for content card refreshes: makes unseen source
  # candidates summary-ready before the artifact renderer selects the top N.
  "scripts/news-summary-refresh.js"
  # One-owner clean-room refresh for the three delivery-critical news cards.
  "scripts/news-straight-line-refresh.js"
  "scripts/jev-news-production-refresh.js"
  "scripts/lib/jev-news-ranker.js"
  "scripts/lib/news-topic-preferences.js"
  "scripts/lib/news-topic-control-page.js"
  "scripts/lib/jev-decision-gate.js"
  "scripts/lib/jev-control-plane.js"
  "scripts/lib/forbidden-people.js"
  "scripts/lib/jev-control-plane-backend.js"
  "scripts/jev-control-plane-backend.js"
  "scripts/jev-outreach-approval.js"
  "scripts/jev-strategic-decision.js"
  "scripts/calibrate-jev-control-plane.js"
  "scripts/lib/jev-client.js"
  "scripts/lib/jev-budget.js"
  "scripts/lib/news-story-identity.js"
  "scripts/lib/briefing-cards/card-format.js"
  # Canonical exact-card launch envelope with a process-tree deadline.
  "scripts/news-refresh.js"
  "scripts/lib/news-attempt-ledger.js"
  "scripts/regenerate-action-items.js"
  "scripts/pre-draft-replies.js"
  "scripts/lib/pre-drafted-replies.js"
  # regenerate-action-items.js SPAWNS this verifier (python3 scripts/verify-action-item-replies.py).
  # It was absent from /opt for an unknown period: spawnSync returned status:null with empty
  # streams and the failure read as an ordinary "verifier skipped", blocking action_items.
  # A spawned sibling is a runtime dependency exactly like a require()d one. Pinned by
  # scripts/__tests__/deploy-manifest-covers-spawned-scripts.test.js.
  "scripts/morning-shorts-proposals.js"
  "scripts/viral-tech-clip-proposals.js"
  "scripts/lib/viral-clip-thesis.js"
  "scripts/lib/viral-view-velocity.js"
  "scripts/lib/transcribe-audio-window.py"
  "scripts/comm-coaching-card.js"
  "scripts/lib/psychology-card.js"
  "scripts/lib/psychology-card-view.js"
  "config/psychology-concepts.json"
  # health-self-heal can invoke the lifetime Graphiti discovery pass before
  # draining coverage gaps; the spawned script must ship with its caller.
  "scripts/graphiti-lifetime-coverage-health.js"
  "scripts/graphiti-backfill-lifetime.js"
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
  "scripts/lib/mutation-surface-matrix.js"
  # New briefing-path modules added in Phase 2-4b. The deployed cloud-morning-briefing.js
  # and ec2-server.js require these; ship them directly so a flaky build-path git-pull
  # cannot leave EC2 importing a file it does not have. See
  # feedback_ec2_build_path_silent_revert.md. Same category as the heal-error-budget.js
  # gap, but on the deploy surface instead of git tracking.
  "scripts/lib/briefing-fallback-expiry.js"
  "scripts/lib/briefing-card-manifest.js"
  "scripts/lib/briefing-day-manifest.js"
  "scripts/lib/executor-health-row.js"
  "scripts/self-heal/briefing-repair-ledger.js"
  "scripts/self-heal/self-heal-health-card.js"
  # Required by self-heal-health-card.js (deployed above), so it must ship too or
  # the live briefing render throws MODULE_NOT_FOUND on EC2.
  "scripts/self-heal/mechanical-recurrence.js"
  "scripts/self-heal/mechanical-runbook.js"
  "scripts/self-heal/verdict.js"
  # Blocker-to-lesson loop (landed 2026-07-16): agentic-healer-driver.js requires
  # the first two at module load, and ec2-morning-briefing-run.sh invokes the
  # fallback-capture and rollup entrypoints directly. Missing any of these on
  # /opt would crash the deployed healer driver with MODULE_NOT_FOUND.
  "scripts/self-heal/card-blocker-lessons.js"
  "scripts/self-heal/hardening-backlog-sync.js"
  "scripts/self-heal/card-blocker-lessons-fallback-capture.js"
  "scripts/self-heal/card-blocker-lessons-rollup.js"
  # Wave 1 (green-tomorrow): the QC validator is required by a deployed entrypoint, so the
  # blocker-naming fix must ship to /opt, not rely on the build-path sync.
  "scripts/validate-briefing-quality.js"
  # Wave 2 (green-tomorrow): both are required by the deployed briefing/QC entrypoints, so
  # the news-chrome + grounding + blocker-accounting fixes must ship to /opt directly.
  "scripts/lib/news-summarize.js"
  "scripts/verify-dashboard-cards-live.js"
  "scripts/lib/system-health-nongreen.js"
  "scripts/lib/system-health-owner-gated.js"
  "scripts/lib/video-work-policy.js"
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
  # People/memory snapshot generator (2026-07-07): cloud-morning-briefing.js spawns
  # this to write the people-files / memory-delta snapshots the PEOPLE FILES CHANGES
  # and MEMORY.MD CHANGES cards read. It carries the internal-id/metadata sample
  # filter (isInternalIdOrMetadataLine); ship it so the /opt copy never drifts behind
  # a land and a UUID cannot leak back onto the face (feedback_ec2_build_path_silent_revert).
  "scripts/snapshot-people-and-memory-delta.js"
  # Otter call-history title/summary helper (2026-07-09): deployed
  # refresh-briefing-generated-sections.js imports this directly for generated
  # call display titles, so it must ship with the refresh entrypoint.
  # Voice confirmation queue/review helpers (2026-07-09): deployed
  # refresh-briefing-generated-sections.js imports the queue builder directly,
  # and ec2-server.js opens the review-clips page through the sequence renderer.
  # Ship them with the refresh/server path so recurring acoustic unknowns cannot
  # silently fall back to stale /opt copies.
  "scripts/voice-sample-sequence-review-html.js"
  # ── SPAWNED siblings of the entrypoints above (2026-07-19) ──────────────────
  # Found by scripts/__tests__/deploy-manifest-covers-spawned-scripts.test.js when
  # the verify-action-item-replies.py gap was fixed. A spawned script is a runtime
  # dependency exactly like a require()d module, but the require-scan closure
  # (deploy-live-deps-covers-self-heal.test.js) is blind to a spawn edge -- and
  # blind to .py entirely. Each of these is invoked by a DEPLOYED entrypoint:
  #   voice-embedding-ecapa.py     <- voice-embedding-ecapa.js (the ECAPA embedder
  #                                   itself; without it acoustic matching cannot run)
  #   fetch-recent-gmail.py        <- regenerate-action-items.js
  #   life-archive-fast-search.py  <- amy-memory-query.js (the /amy/memory/query route)
  #   life-archive.py, graphiti-event-drain.js, graphiti-coverage-health.js,
  #   auto-regen-rejected-videos.js, suggest-token-reduction.js,
  #   run-cloud-scheduled-tasks.js <- health-self-heal.js heal actions
  "scripts/voice-embedding-ecapa.py"
  "scripts/fetch-recent-gmail.py"
  "scripts/life-archive.py"
  "scripts/graphiti-event-drain.js"
  "scripts/graphiti-coverage-health.js"
  "scripts/auto-regen-rejected-videos.js"
  # Provider fallback helpers for the video.regenerate runner below. Keep the
  # repair-feedback worker auditable on EC2.
  "scripts/dispatch-feedback-to-claude.js"
  # ec2-spine-worker.js launches this bounded video.regenerate attempt through
  # a computed path, outside the literal-spawn scanner.
  "scripts/video-regen-task-runner.js"
  # land.js invokes this renderer through its core-document closure.
  "scripts/render-core-components-html.js"
  # overnight watcher receives this helper through SB_WATCHER_SAFE_CLI, so the
  # environment-mediated edge is likewise invisible to literal-spawn scans.
  "scripts/watcher-safe-cli.js"
  "scripts/suggest-token-reduction.js"
  "scripts/run-cloud-scheduled-tasks.js"
  # Transitive spawn closure of auto-regen-rejected-videos.js (surfaced by the same
  # test once its parent was added): the EC2 rebuild engine plus the two quality
  # gates it runs per regenerated video.
  "scripts/ec2-build-from-queue.py"
  "scripts/check-thumbnail-quality.py"
  "scripts/check-video-content-not-blank.py"
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
  "scripts/ec2-card-controller-exact-run.sh"
  "scripts/mint-briefing-attended-action.js"
  "scripts/ec2-morning-report-prep-run.sh"
  "scripts/collect-token-spend-overnight.js"
  "scripts/attach-exact-token-cut.js"
  "scripts/ec2-morning-briefing-run.sh"
  "scripts/lib/briefing-report-closure.js"
  "scripts/overnight-watch-report.js"
  "scripts/night-supervisor.js"
  "scripts/ec2-overnight-watcher-run.sh"
  "scripts/watcher-checkpoint.js"
  "scripts/cloud-runtime-release-proof.js"
  "scripts/lib/briefing-watcher-control.js"
  "scripts/lib/ec2-endpoint.js"
  "scripts/lib/attended-briefing-tripwire.js"
  "scripts/lib/briefing-card-progress.js"
  "scripts/install-ec2-card-controller-cron.sh"
  "scripts/lib/briefing-notify.js"
  "scripts/lib/briefing-email.js"
  "scripts/lib/briefing-card-controller.js"
  "scripts/lib/briefing-attended-action.js"
  "scripts/lib/briefing-day-manifest.js"
  "scripts/lib/briefing-source-contracts.js"
  "scripts/session-cloud-plane.js"
  "scripts/lib/session-cloud-plane.js"
  "scripts/lib/session-cloud-health.js"
  # YOUTUBE VIDEO PERFORMANCE (ExampleCo ask Q7, 2026-08-16). The card controller
  # spawns the collector through the youtube-video-stats source contract, and
  # the collector requires the reconcile script for the channel sign-in, so all
  # three must ship together or the card blocks permanently on the cloud host.
  "scripts/youtube-video-stats.js"
  "scripts/social-channel-stats.js"
  "scripts/reconcile-manifest-with-youtube.js"
  "scripts/lib/briefing-cards/youtube-video-performance-card.js"
  # ExampleCo 48-HOUR WEATHER uses the same receipt-before-render contract.
  "scripts/ExampleCo-weather.js"
  "scripts/lib/briefing-cards/ExampleCo-weather-card.js"
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
OTTER_LANE_DRAIN_REQUEST="/tmp/secondbrain-otter-lane-drain.request"
DEPLOY_LOCK_TOKEN="deploy-$(date +%s)-$$"
OTTER_HEALER_LOCK_FILE="$DEPLOY_DATA_DIR/life-archive/voiceprints/otter-call-healer-live-scheduler.lock"
# Both lane locks are held for the deploy window: the lanes schedule under
# SEPARATE flocks, so quiescing only the live lock would let an old-release
# historical worker keep mutating shared data across the atomic swap
# (Codex review 353c6b8c72cd, critical).
OTTER_HEALER_HISTORICAL_LOCK_FILE="$DEPLOY_DATA_DIR/life-archive/voiceprints/otter-call-healer-historical-scheduler.lock"
OTTER_HEALER_DEPLOY_LOCK_LOG=""
OTTER_HEALER_DEPLOY_LOCK_PID=""
# The parity token used to be written HERE, before the deploy-window mutex
# was acquired. That ordering let a second deploy overwrite the token while
# the first deploy still held the mutex, which made the first deploy's Otter
# lane-lock holder (keyed on that token) exit and release both healer-lane
# locks mid-swap (Codex round-4 review, finding 1). The token write now
# happens only AFTER the mutex is acquired, below the trap registration.
release_otter_healer_deploy_lock() {
  # The remote holder exits when the token-owned deploy lock disappears.
  # Waiting here keeps the SSH child from becoming an orphan.
  if [ -n "$OTTER_HEALER_DEPLOY_LOCK_PID" ]; then
    local attempt
    for attempt in 1 2 3 4 5; do
      if ! kill -0 "$OTTER_HEALER_DEPLOY_LOCK_PID" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    kill "$OTTER_HEALER_DEPLOY_LOCK_PID" 2>/dev/null || true
    wait "$OTTER_HEALER_DEPLOY_LOCK_PID" 2>/dev/null || true
    OTTER_HEALER_DEPLOY_LOCK_PID=""
  fi
  if [ -n "$OTTER_HEALER_DEPLOY_LOCK_LOG" ]; then
    rm -f "$OTTER_HEALER_DEPLOY_LOCK_LOG" 2>/dev/null || true
    OTTER_HEALER_DEPLOY_LOCK_LOG=""
  fi
}
acquire_otter_healer_deploy_lock() {
  OTTER_HEALER_DEPLOY_LOCK_LOG="$(mktemp "${TMPDIR:-/tmp}/sb-otter-deploy-lock-XXXXXX")"
  local remote_command
  local flock_mode="-n"
  local readiness_attempts=5
  if [ "$OTTER_LOCK_WAIT_SECONDS" -gt 0 ]; then
    flock_mode="-w $OTTER_LOCK_WAIT_SECONDS"
    # The locks are nested in a fixed order. In the worst case each lane can
    # consume its own bounded wait before the READY marker is emitted.
    readiness_attempts=$((OTTER_LOCK_WAIT_SECONDS * 2 + 15))
    echo "[deploy] Otter quiescence: waiting up to ${OTTER_LOCK_WAIT_SECONDS}s per lane lock (up to $((OTTER_LOCK_WAIT_SECONDS * 2))s total, plus transport overhead)"
  fi
  # flock_mode contains only the internal -n literal or -w plus the validated
  # integer above. It is deliberately word-split into separate remote argv.
  # Pinned-release dispatchers ignore the plain deploy lock and finish on their
  # own immutable code. Only this lane-lock wait asks them to stop admitting
  # new targets, through a drain request bound to this deploy's token.
  remote_command="mkdir -p '$(dirname "$OTTER_HEALER_LOCK_FILE")' && printf '%s' '$DEPLOY_LOCK_TOKEN' > '$OTTER_LANE_DRAIN_REQUEST' && exec flock $flock_mode '$OTTER_HEALER_LOCK_FILE' flock $flock_mode '$OTTER_HEALER_HISTORICAL_LOCK_FILE' bash -lc 'echo OTTER_HEALER_DEPLOY_LOCK_READY; while [ \"\$(cat \"$DEPLOY_LOCK\" 2>/dev/null)\" = \"$DEPLOY_LOCK_TOKEN\" ]; do sleep 1; done'"
  target_exec "$remote_command" >"$OTTER_HEALER_DEPLOY_LOCK_LOG" 2>&1 &
  OTTER_HEALER_DEPLOY_LOCK_PID=$!

  local attempt
  for ((attempt = 1; attempt <= readiness_attempts; attempt++)); do
    if grep -q '^OTTER_HEALER_DEPLOY_LOCK_READY$' "$OTTER_HEALER_DEPLOY_LOCK_LOG" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$OTTER_HEALER_DEPLOY_LOCK_PID" 2>/dev/null; then
      return 1
    fi
    sleep 1
  done
  return 1
}
cleanup_deploy_lock() {
  target_exec "[ \"\$(cat $DEPLOY_LOCK 2>/dev/null)\" = \"$DEPLOY_LOCK_TOKEN\" ] && rm -f $DEPLOY_LOCK" \
    2>/dev/null || true
}
# DEPLOY-WINDOW MUTEX (Codex review 2026-08-24, finding A): the token file
# above suppresses parity false-reds but is NOT a mutex; a concurrent deploy
# simply overwrites it, letting the first deploy's lane-lock holder exit and
# the sampled live release be swapped before cutover. This flock IS the
# mutex: one target-side lock under the deploy data dir, held from
# live-release sampling through post-swap release verification (released by
# the EXIT trap after every later step), shared by the SSH and --local
# transports via target_exec. A second deploy waits at most its bounded
# window and then REFUSES, fail closed.
DEPLOY_WINDOW_LOCK_FILE="$DEPLOY_DATA_DIR/agent/deploy-window.lock"
DEPLOY_WINDOW_OWNER_FILE="$DEPLOY_DATA_DIR/agent/deploy-window.owner"
DEPLOY_WINDOW_WAIT_SECONDS="${SB_DEPLOY_WINDOW_LOCK_WAIT_SECONDS:-120}"
if ! [[ "$DEPLOY_WINDOW_WAIT_SECONDS" =~ ^[0-9]+$ ]] || [ "$DEPLOY_WINDOW_WAIT_SECONDS" -gt 1800 ]; then
  echo "[deploy] REFUSED: SB_DEPLOY_WINDOW_LOCK_WAIT_SECONDS must be an integer from 0 through 1800." >&2
  exit 1
fi
DEPLOY_WINDOW_LOCK_LOG=""
DEPLOY_WINDOW_LOCK_PID=""
DEPLOY_WINDOW_LOCK_FAILURE=""
release_deploy_window_lock() {
  if [ -n "$DEPLOY_WINDOW_LOCK_PID" ]; then
    # The remote holder exits when the owner file stops carrying our token.
    target_exec "[ \"\$(cat $DEPLOY_WINDOW_OWNER_FILE 2>/dev/null)\" = \"$DEPLOY_LOCK_TOKEN\" ] && rm -f $DEPLOY_WINDOW_OWNER_FILE" 2>/dev/null || true
    local attempt
    for attempt in 1 2 3 4 5; do
      if ! kill -0 "$DEPLOY_WINDOW_LOCK_PID" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    kill "$DEPLOY_WINDOW_LOCK_PID" 2>/dev/null || true
    wait "$DEPLOY_WINDOW_LOCK_PID" 2>/dev/null || true
    DEPLOY_WINDOW_LOCK_PID=""
  fi
  if [ -n "$DEPLOY_WINDOW_LOCK_LOG" ]; then
    rm -f "$DEPLOY_WINDOW_LOCK_LOG" 2>/dev/null || true
    DEPLOY_WINDOW_LOCK_LOG=""
  fi
}
acquire_deploy_window_lock() {
  DEPLOY_WINDOW_LOCK_LOG="$(mktemp "${TMPDIR:-/tmp}/sb-deploy-window-lock-XXXXXX")"
  local remote_command
  # The holder writes our token into the owner file while it owns the flock,
  # then loops until release removes the token; token ownership keeps two
  # deploys from clobbering each other's release path exactly like the
  # parity lock above.
  remote_command="mkdir -p '$(dirname "$DEPLOY_WINDOW_LOCK_FILE")' && exec flock -w $DEPLOY_WINDOW_WAIT_SECONDS '$DEPLOY_WINDOW_LOCK_FILE' bash -lc 'echo $DEPLOY_LOCK_TOKEN > \"$DEPLOY_WINDOW_OWNER_FILE\"; echo DEPLOY_WINDOW_LOCK_READY; while [ \"\$(cat \"$DEPLOY_WINDOW_OWNER_FILE\" 2>/dev/null)\" = \"$DEPLOY_LOCK_TOKEN\" ]; do sleep 1; done; rm -f \"$DEPLOY_WINDOW_OWNER_FILE\"'"
  target_exec "$remote_command" >"$DEPLOY_WINDOW_LOCK_LOG" 2>&1 &
  DEPLOY_WINDOW_LOCK_PID=$!
  DEPLOY_WINDOW_LOCK_FAILURE=""
  local attempt readiness_attempts=$((DEPLOY_WINDOW_WAIT_SECONDS + 15)) started_at=$SECONDS
  for ((attempt = 1; attempt <= readiness_attempts; attempt++)); do
    if grep -q '^DEPLOY_WINDOW_LOCK_READY$' "$DEPLOY_WINDOW_LOCK_LOG" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$DEPLOY_WINDOW_LOCK_PID" 2>/dev/null; then
      # A holder that dies before the wait elapses never queued on the lock
      # (for example SSH could not connect); report its real error instead.
      if [ $((SECONDS - started_at)) -lt "$DEPLOY_WINDOW_WAIT_SECONDS" ]; then
        DEPLOY_WINDOW_LOCK_FAILURE="$(tail -c 600 "$DEPLOY_WINDOW_LOCK_LOG" 2>/dev/null | tr '\n' ' ')"
        DEPLOY_WINDOW_LOCK_FAILURE="${DEPLOY_WINDOW_LOCK_FAILURE:-lock holder exited with no output}"
      fi
      return 1
    fi
    sleep 1
  done
  return 1
}
cleanup_deploy_locks() {
  cleanup_deploy_lock
  release_otter_healer_deploy_lock
  release_deploy_window_lock
  cleanup_worktree_lock
}
trap cleanup_deploy_locks EXIT

# DEPLOY HOLD LEASE (agent delivery protocol, 2026-09-27): the only way to hold
# a deploy is scripts/deploy-hold.js (90-minute cap, one renewal, hard expiry).
# Chat messages between agents never hold a deploy. An active lease refuses
# before anything shared is touched and prints when to retry; exit 75 is a
# temporary refusal. SB_DEPLOY_IGNORE_HOLD=1 is ExampleCo's explicit override.
if [ "${SB_DEPLOY_IGNORE_HOLD:-0}" != "1" ]; then
  DEPLOY_HOLD_JSON="$(target_exec "cat '$DEPLOY_DATA_DIR/agent/deploy-hold.json' 2>/dev/null" 2>/dev/null || true)"
  if [ -n "$DEPLOY_HOLD_JSON" ]; then
    DEPLOY_HOLD_RC=0
    DEPLOY_HOLD_VERDICT="$(printf '%s' "$DEPLOY_HOLD_JSON" | node "$ROOT/scripts/deploy-hold.js" check)" || DEPLOY_HOLD_RC=$?
    if [ "$DEPLOY_HOLD_RC" = "75" ]; then
      echo "[deploy] REFUSED (temporary): deploys are $DEPLOY_HOLD_VERDICT. Retry after it expires; /opt is untouched." >&2
      exit 75
    fi
  fi
else
  echo "[deploy] deploy hold lease ignored (SB_DEPLOY_IGNORE_HOLD=1)."
fi

# DEPLOY-WINDOW MUTEX FIRST (Codex round-4 review, finding 1): acquire the
# cross-deploy mutex BEFORE writing any shared token or lock state. The trap
# above is already armed, so any later failure releases the mutex. A refused
# acquire has written nothing shared, so a waiting deploy can never disturb
# the holder's parity token or its lane-lock keepalive.
if ! acquire_deploy_window_lock; then
  if [ -n "$DEPLOY_WINDOW_LOCK_FAILURE" ]; then
    echo "[deploy] REFUSED: the deploy-window lock holder could not start (not a lock conflict): $DEPLOY_WINDOW_LOCK_FAILURE /opt is untouched." >&2
    exit 1
  fi
  echo "[deploy] REFUSED: another deploy holds the deploy-window lock ($DEPLOY_WINDOW_LOCK_FILE) and it could not be acquired within ${DEPLOY_WINDOW_WAIT_SECONDS}s. /opt is untouched." >&2
  exit 1
fi
echo "[deploy] deploy-window mutex: acquired ($DEPLOY_WINDOW_LOCK_FILE, token $DEPLOY_LOCK_TOKEN)"
if ! target_exec "echo $DEPLOY_LOCK_TOKEN > $DEPLOY_LOCK"; then
  echo "[deploy] WARNING: could not create deploy-parity lock ($DEPLOY_LOCK) -- the parity probe may false-red during this deploy window."
fi

# ============================================================================
# SOURCE-PROVENANCE GATE (2026-07-19): runs BEFORE the atomic swap below.
# ============================================================================
# Defect class this kills: shipping a sha that is not origin/master. This script
# used to take `git rev-parse HEAD` and ship it, with no fetch, no comparison to
# origin/master, and no ancestry check anywhere before the swap. Every other
# gate here is an INTEGRITY check (does the tree parse, require, import-smoke,
# answer /health); none of them is a PROVENANCE check, and a stale tree passes
# integrity perfectly. On 2026-07-19 sha 59d92950 shipped BEHIND master and only
# a human reading the receipt afterward caught it. record-ec2-deploy-receipt.js
# below runs AFTER the swap is already live and only WARNS, so it can report the
# accident but cannot prevent it.
#
# Fail CLOSED: fetch origin and refuse unless the sha being shipped IS
# origin/master. Behind (stale), ahead (unlanded), diverged, and any unprovable
# state all refuse, naming both shas. Override for genuine emergencies:
# SB_DEPLOY_ALLOW_STALE_SOURCE=1, which prints a loud warning and records the
# override to data/agent/deploy-provenance-overrides.jsonl.
#
# The gate EMITS the exact sha it approved, and the release below ships that
# pinned sha after re-proving HEAD has not moved. Without the pin this would be
# a TOCTOU hole: the gate checks HEAD here, the release re-runs
# `git rev-parse HEAD` ~80 lines later, and the worktree lock only stops the
# janitor from reaping the tree, not a concurrent checkout/reset/rebase from
# moving the ref in between (Codex peer review, 2026-07-19).
echo "[deploy] source-provenance gate: verifying the deploying sha is origin/master"
PROVENANCE_SHA_FILE="$(mktemp "${TMPDIR:-/tmp}/sb-deploy-provenance-XXXXXX")"
cleanup_provenance_tmp() { rm -f "$PROVENANCE_SHA_FILE" 2>/dev/null || true; }
if ! node "$ROOT/scripts/check-deploy-provenance.js" --emit-sha-file "$PROVENANCE_SHA_FILE"; then
  cleanup_provenance_tmp
  echo "[deploy] REFUSED: source-provenance gate failed (named shas + reason above). /opt is untouched. Land your work, then redeploy from a checkout at origin/master, or override with SB_DEPLOY_ALLOW_STALE_SOURCE=1." >&2
  exit 1
fi
VERIFIED_SHA="$(tr -d '[:space:]' < "$PROVENANCE_SHA_FILE")"
cleanup_provenance_tmp
if [ -z "$VERIFIED_SHA" ]; then
  echo "[deploy] REFUSED: the source-provenance gate passed but emitted no sha, so there is nothing to pin the release to (fail closed)." >&2
  exit 1
fi

# ============================================================================
# DEPLOY-WINDOW GUARD (2026-07-19): runs BEFORE the atomic swap below.
# ============================================================================
# Race class this kills: an atomic symlink swap landing at the instant a
# scheduled cron runner starts and resolves the /opt/secondbrain symlink (the
# 2026-07-19 incident shape). Runners execute from pinned immutable releases
# under /opt/secondbrain-releases/<sha>, so a runner mid-flight beyond a short
# startup grace is SAFE to swap under once its pin is proven; the 2026-08-23/24
# incident was this guard refusing two swaps on a blanket +/- 2 minute cron
# window that distrusted exactly those pinned runners. Before invoking the
# atomic-release primitive, snapshot the EC2 crontab, the process table
# (pid,etimes,args), per-pid /proc cwd links, and the host clock, and let
# scripts/lib/deploy-window-guard.js decide: a runner-family cron
# (ec2-*-run.sh) firing within the startup grace (default 15s,
# SB_DEPLOY_STARTUP_GRACE_SECONDS) of NOW, a runner-family process provably
# inside that grace since start, or a mid-flight runner whose immutable-release
# pin cannot be proven, REFUSES the deploy with a named reason and the minutes
# to wait. Override: --swap-anyway or SB_DEPLOY_SWAP_ANYWAY=1 (attended,
# explicit). Fail CLOSED: if the snapshots cannot be taken, the window cannot
# be proven clear, so the deploy refuses.
ALLOWED_ACTIVE_RUNNERS=()
if [ "${OVERNIGHT_WATCHER_RELEASE_RECONCILE:-0}" = "1" ]; then
  if [ "$LOCAL_DEPLOY" != "1" ] || ! ps -p "$PPID" -o args= | grep -q 'ec2-overnight-watcher-run.sh'; then
    echo "[deploy] REFUSED: overnight watcher release authority was claimed outside the local watcher parent process." >&2
    exit 1
  fi
  ALLOWED_ACTIVE_RUNNERS+=(ec2-overnight-watcher-run.sh)
  echo "[deploy] watcher-start guard: authorized only the owning overnight watcher runner; every sibling runner remains protected"
fi
if [ -n "${CARD_CONTROLLER_SUPERVISOR_LOCK_TOKEN:-}${CARD_CONTROLLER_PARENT_RUN_ID:-}${CARD_CONTROLLER_LEASE_TOKEN:-}${CARD_CONTROLLER_SCOPE_TOKEN:-}" ]; then
  echo "[deploy] controller-delegation guard: proving the live controller lease before allowing its own runner"
  if ! node "$ROOT/scripts/verify-controller-deploy-authority.js" --data-dir "$DEPLOY_DATA_DIR"; then
    echo "[deploy] REFUSED: controller-delegation environment is present but does not prove the live lease. /opt is untouched." >&2
    exit 1
  fi
  ALLOWED_ACTIVE_RUNNERS+=(ec2-card-controller-run.sh)
  echo "[deploy] controller-delegation guard: authorized only the owning card-controller runner; every sibling runner remains protected"
fi

# ============================================================================
# OTTER PUBLISH-ROUTE-DRAIN COMPATIBILITY GATE (GAP 2A, 2026-08-24).
# ============================================================================
# The verdict is conclusive from the release DELTA, not digest string
# identity, and it is computed HERE, after the source-provenance gate, so the
# target side is the provenance-pinned sha the atomic release will actually
# ship (Codex review f8233d0db296, finding 1: resolving HEAD before the pin
# left a window where commit B shipped under commit A's MATCH). The running
# release emits its per-path selected-surface receipt; the target side reads
# committed git blobs of the pinned sha, immune to checkout dirt and Windows
# eol smudge (Codex review 71cad320a4ab, finding 1). MATCH means no
# manifest-selected path differs and lets pinned workers drain across the
# swap; the receipt lists every compared path. DIFFERENT names the exact
# differing selected paths. UNKNOWN covers only genuinely unprovable states
# (missing manifest, unreadable release tree, absent or malformed running
# receipt) and, like DIFFERENT, keeps the conservative both-lane quiescence.
# Sampling the live receipt here also minimizes the window between sampling
# and the lock decision below (review f8233d0db296, finding 2); cross-deploy
# serialization itself is owned by the land and deploy locks, not this gate.
# The deploy-window mutex has been held since BEFORE the parity token or any
# other shared lock state was written (Codex round-4 review, finding 1), so
# the release sampled here is the release the swap below actually replaces.
# Bind the running receipt to the IMMUTABLE physical release root, never the
# /opt/secondbrain symlink: the symlink is a moving name, and the receipt
# must describe the release directory that was actually sampled.
LIVE_RELEASE_PHYSICAL_ROOT="$(target_exec "readlink -f /opt/secondbrain 2>/dev/null || echo /opt/secondbrain" 2>/dev/null | tail -n 1 || true)"
case "$LIVE_RELEASE_PHYSICAL_ROOT" in
  /*) : ;;
  *) LIVE_RELEASE_PHYSICAL_ROOT="/opt/secondbrain" ;;
esac
LIVE_RELEASE_SHA="${LIVE_RELEASE_PHYSICAL_ROOT##*/}"
DEPLOY_DELTA_SCOPE_JSON=""
if [[ "$LIVE_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] \
  && git -C "$ROOT" cat-file -e "$LIVE_RELEASE_SHA^{commit}" 2>/dev/null \
  && DEPLOY_DELTA_SCOPE_JSON="$(git -C "$ROOT" diff --name-only "$LIVE_RELEASE_SHA" "$VERIFIED_SHA" | node "$ROOT/scripts/lib/deploy-delta-scope.js")"; then
  echo "[deploy] subsystem delta classified from live $LIVE_RELEASE_SHA to target $VERIFIED_SHA"
else
  DEPLOY_DELTA_SCOPE_JSON='{"schema":"secondbrain.deploy-delta-scope.v1","provable":false,"graphiti_changed":true,"graphiti_paths":[],"unknown_reason":"live-to-target git delta unavailable"}'
  echo "[deploy] subsystem delta unprovable; Graphiti deployment remains fail-safe enabled"
fi
GRAPHITI_RELEASE_CHANGED="$(printf '%s' "$DEPLOY_DELTA_SCOPE_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(d).graphiti_changed===true?"1":"0")}catch{process.stdout.write("1")}})')"
LIVE_OTTER_RECEIPT_FILE="$(mktemp "${TMPDIR:-/tmp}/sb-otter-live-receipt-XXXXXX")"
target_exec "if [ -f '$LIVE_RELEASE_PHYSICAL_ROOT/scripts/lib/otter-release-compatibility.js' ]; then /usr/bin/node '$LIVE_RELEASE_PHYSICAL_ROOT/scripts/lib/otter-release-compatibility.js' --root '$LIVE_RELEASE_PHYSICAL_ROOT' --json; else printf 'missing\n'; fi" > "$LIVE_OTTER_RECEIPT_FILE" 2>/dev/null || true
OTTER_DELTA_RECEIPTS_FILE="$ROOT/data/agent/otter-release-delta-receipts.jsonl"
# One attempt id keys every row of this assessment. Rows are phase-qualified
# (<id>.assessment, <id>.decision) so the durable mirror can append-if-absent:
# a lost SSH acknowledgement retry cannot duplicate a row, and the ledger's
# authoritative record per attempt is its decision row (Codex review
# 045723f49d7c, finding 3; the ledger records BOTH the comparison assessment
# and the final gate decision, decision authoritative).
OTTER_DELTA_ATTEMPT_ID="delta-$(date +%s)-$$-$RANDOM"
# Verdict LOGIC must itself be the pinned logic: a dirty compatibility helper
# or deploy gate in this checkout could mint any verdict for blobs it does not
# implement (Codex review 6e7f7868004c, finding 2). git diff applies the clean
# filter, so an unmodified CRLF checkout stays clean here.
OTTER_GATE_DIRTY_REASON=""
if ! git -C "$ROOT" diff --quiet "$VERIFIED_SHA" -- scripts/lib/otter-release-compatibility.js scripts/lib/deploy-delta-scope.js scripts/deploy-ec2-server.sh scripts/lib/atomic-release.sh scripts/lib/gravity-amendments-reconcile.js 2>/dev/null; then
  # REFUSE for EVERY verdict (Codex round-4 review, finding 2, superseding
  # the demote-only handling): demotion only degrades MATCH, but with a
  # DIFFERENT verdict a dirty atomic-release.sh would still execute the
  # swap from this mutable worktree, so origin/master provenance would not
  # prove the release-control bytes that actually ran. Only the mutex and
  # parity token exist yet; the EXIT trap releases both.
  echo "[deploy] REFUSED: release-control files (deploy-ec2-server.sh, atomic-release.sh, gravity-amendments-reconcile.js, deploy-delta-scope.js, or otter-release-compatibility.js) differ from provenance-pinned $VERIFIED_SHA. Commit or stash that drift; /opt is untouched." >&2
  exit 1
fi
# The verdict HELPER executes from the pinned blob, never the working copy
# (Codex review 1638328c6402, finding 1): a dirty helper cannot compute the
# verdict at all. The deploy script itself is mutable by construction, the
# same residual every gate in this file shares; the dirty-check above plus
# the provenance gate cover accidental drift of this decision path.
OTTER_PINNED_HELPER="$(mktemp "${TMPDIR:-/tmp}/sb-otter-compat-helper-XXXXXX")"
git -C "$ROOT" show "$VERIFIED_SHA":scripts/lib/otter-release-compatibility.js > "$OTTER_PINNED_HELPER" 2>/dev/null || true
OTTER_DELTA_RAW_JSON="$(
  node "$OTTER_PINNED_HELPER" --root "$ROOT" --verdict --target-git-ref "$VERIFIED_SHA" \
    --running-receipt "$LIVE_OTTER_RECEIPT_FILE"
)" || true
rm -f "$LIVE_OTTER_RECEIPT_FILE" "$OTTER_PINNED_HELPER" 2>/dev/null || true
# One dependency-free evaluator produces BOTH the persisted receipt and the
# decision, so every persisted row is valid JSON equal to the final effective
# verdict, even when the helper itself crashed (Codex review 6e7f7868004c,
# finding 3). Line 1: effective receipt JSON. Line 2: verdict<TAB>summary.
OTTER_COMPAT_EVAL="$(printf '%s' "$OTTER_DELTA_RAW_JSON" | node -e '
let d = "";
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => {
  const pinned = process.argv[1] || "";
  const dirtyReason = process.argv[2] || "";
  const unknown = (reason) => ({
    schema: "secondbrain.otter-release-delta-verdict.v1",
    generated_at_utc: new Date().toISOString(),
    running_digest: null, target_digest: null, target_sha: null,
    compared_paths: [], differing_paths: [],
    verdict: "UNKNOWN", quiesce_required: true,
    unknown_reason: reason, summary: "unprovable: " + reason,
  });
  const demote = (row, reason) => ({
    ...row,
    verdict: "UNKNOWN",
    quiesce_required: true,
    unknown_reason: reason,
    summary: "unprovable: " + reason,
  });
  const attemptId = process.argv[3] || "";
  let r = null;
  try { r = JSON.parse(d); } catch { r = null; }
  if (!r || typeof r !== "object" || typeof r.verdict !== "string") {
    r = unknown("delta verdict helper produced no parseable receipt");
  }
  r.attempt_id = attemptId;
  r.phase = "assessment";
  if (r.verdict === "MATCH" && String(r.target_sha || "") !== pinned) {
    r = demote(r, "delta receipt sha " + (r.target_sha || "none") + " does not match provenance-pinned " + pinned);
  }
  if (dirtyReason && r.verdict === "MATCH") {
    r = demote(r, dirtyReason);
  }
  process.stdout.write(JSON.stringify(r) + "\n" + r.verdict + "\t" + (r.summary || "no summary"));
});
' "$VERIFIED_SHA" "$OTTER_GATE_DIRTY_REASON" "$OTTER_DELTA_ATTEMPT_ID.assessment")"
OTTER_DELTA_VERDICT_JSON="$(printf '%s\n' "$OTTER_COMPAT_EVAL" | head -n 1)"
OTTER_COMPAT_PARSED="$(printf '%s\n' "$OTTER_COMPAT_EVAL" | tail -n 1)"
OTTER_COMPAT_VERDICT="${OTTER_COMPAT_PARSED%%$'\t'*}"
OTTER_COMPAT_SUMMARY="${OTTER_COMPAT_PARSED#*$'\t'}"
# The durable mirror lands BEFORE any persistence of a MATCH: a MATCH whose
# receipt exists only in this reapable worktree must not unlock the no-wait
# drain, and every persisted row must equal the FINAL effective decision
# (Codex reviews f8233d0db296 and 1638328c6402, finding 3). Mirror failure
# demotes MATCH inside the receipt JSON itself, then the demoted row is what
# both ledgers receive.
otter_delta_demote_json() {
  printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",(c)=>{d+=c});process.stdin.on("end",()=>{let r;try{r=JSON.parse(d);}catch{r=null;}if(!r||typeof r!=="object"){r={schema:"secondbrain.otter-release-delta-verdict.v1",generated_at_utc:new Date().toISOString(),running_digest:null,target_digest:null,target_sha:null,compared_paths:[],differing_paths:[]};}const reason=process.argv[1]||"demoted";r.verdict="UNKNOWN";r.quiesce_required=true;r.unknown_reason=reason;r.summary="unprovable: "+reason;process.stdout.write(JSON.stringify(r));});' "$2"
}
otter_delta_mirror() {
  # $1 = row JSON, $2 = phase-qualified attempt marker. grep-guarded append
  # under flock: a retry after a lost SSH ack cannot append the row twice.
  printf '%s\n' "$1" | target_exec_stdin "mkdir -p $DEPLOY_DATA_DIR/agent && flock $DEPLOY_DATA_DIR/agent/otter-release-delta-receipts.jsonl.lock -c 'touch $DEPLOY_DATA_DIR/agent/otter-release-delta-receipts.jsonl; grep -qF \"$2\" $DEPLOY_DATA_DIR/agent/otter-release-delta-receipts.jsonl || cat >> $DEPLOY_DATA_DIR/agent/otter-release-delta-receipts.jsonl'"
}
OTTER_DELTA_MIRRORED=0
if otter_delta_mirror "$OTTER_DELTA_VERDICT_JSON" "$OTTER_DELTA_ATTEMPT_ID.assessment"; then
  OTTER_DELTA_MIRRORED=1
fi
if [ "$OTTER_DELTA_MIRRORED" != "1" ] && [ "$OTTER_COMPAT_VERDICT" = "MATCH" ]; then
  OTTER_COMPAT_VERDICT="UNKNOWN"
  OTTER_COMPAT_SUMMARY="durable receipt mirror failed; MATCH demoted to both-lane quiescence"
  OTTER_DELTA_VERDICT_JSON="$(otter_delta_demote_json "$OTTER_DELTA_VERDICT_JSON" "durable receipt mirror failed; MATCH demoted to both-lane quiescence")"
  # The retry reuses the same assessment marker: if the first append actually
  # landed and only its acknowledgement was lost, the guard keeps the ledger
  # single-rowed and the decision row below carries the authoritative ruling.
  if otter_delta_mirror "$OTTER_DELTA_VERDICT_JSON" "$OTTER_DELTA_ATTEMPT_ID.assessment"; then
    OTTER_DELTA_MIRRORED=1
  fi
fi
OTTER_DELTA_LOCAL_PERSISTED=0
if { mkdir -p "$(dirname "$OTTER_DELTA_RECEIPTS_FILE")" && printf '%s\n' "$OTTER_DELTA_VERDICT_JSON" >> "$OTTER_DELTA_RECEIPTS_FILE"; } 2>/dev/null; then
  OTTER_DELTA_LOCAL_PERSISTED=1
fi
if [ "$OTTER_DELTA_LOCAL_PERSISTED" != "1" ] && [ "$OTTER_COMPAT_VERDICT" = "MATCH" ]; then
  # Symmetric fail-closed with the mirror path (Opus review 2026-08-24,
  # finding 6): a MATCH whose compared-paths receipt has no local record is
  # not auditable, so it must not authorize the no-lock drain. The demoted
  # row reaches the durable mirror through the decision row below, which is
  # the authoritative per-attempt ruling.
  OTTER_COMPAT_VERDICT="UNKNOWN"
  OTTER_COMPAT_SUMMARY="local compared-paths receipt append failed; MATCH demoted to both-lane quiescence"
  OTTER_DELTA_VERDICT_JSON="$(otter_delta_demote_json "$OTTER_DELTA_VERDICT_JSON" "local compared-paths receipt append failed; MATCH demoted to both-lane quiescence")"
fi
if [ "$OTTER_DELTA_LOCAL_PERSISTED" = "1" ] && [ "$OTTER_DELTA_MIRRORED" = "1" ]; then
  echo "[deploy] Otter release delta receipt appended to $OTTER_DELTA_RECEIPTS_FILE and mirrored to $DEPLOY_DATA_DIR/agent/otter-release-delta-receipts.jsonl"
elif [ "$OTTER_DELTA_MIRRORED" = "1" ]; then
  echo "[deploy] WARNING: Otter release delta receipt mirrored to $DEPLOY_DATA_DIR/agent/otter-release-delta-receipts.jsonl but the local append to $OTTER_DELTA_RECEIPTS_FILE failed"
elif [ "$OTTER_DELTA_LOCAL_PERSISTED" = "1" ]; then
  echo "[deploy] WARNING: Otter release delta receipt written to $OTTER_DELTA_RECEIPTS_FILE but NOT mirrored to $DEPLOY_DATA_DIR/agent/otter-release-delta-receipts.jsonl (mirror append failed)"
else
  echo "[deploy] WARNING: Otter release delta receipt could not be persisted anywhere (local and durable appends both failed)"
fi
OTTER_RELEASE_COMPATIBLE=0
if [ "$OTTER_COMPAT_VERDICT" = "MATCH" ] && [ "$OTTER_DELTA_MIRRORED" = "1" ] && [ "$OTTER_DELTA_LOCAL_PERSISTED" = "1" ]; then
  OTTER_RELEASE_COMPATIBLE=1
  echo "[deploy] Otter release compatibility: MATCH ($OTTER_COMPAT_SUMMARY); pinned old workers may drain across the atomic swap"
elif [ "$OTTER_COMPAT_VERDICT" = "DIFFERENT" ]; then
  echo "[deploy] Otter release compatibility: DIFFERENT ($OTTER_COMPAT_SUMMARY); both healer lanes must quiesce"
else
  echo "[deploy] Otter release compatibility: UNKNOWN ($OTTER_COMPAT_SUMMARY); both healer lanes must quiesce"
fi
# The authoritative per-attempt record is this DECISION row: whatever the
# assessment rows say (including a lost-ack MATCH assessment later demoted),
# the decision row states the final ruling the deploy actually enforced.
otter_delta_build_decision_json() {
  node -e 'process.stdout.write(JSON.stringify({schema:"secondbrain.otter-release-delta-decision.v1",attempt_id:process.argv[1]||"",generated_at_utc:new Date().toISOString(),phase:"decision",verdict:process.argv[2]||"UNKNOWN",quiesce_required:process.argv[3]!=="1",drain:process.argv[3]==="1",summary:process.argv[4]||""}));' "$OTTER_DELTA_ATTEMPT_ID.decision" "$OTTER_COMPAT_VERDICT" "$OTTER_RELEASE_COMPATIBLE" "$OTTER_COMPAT_SUMMARY"
}
OTTER_DELTA_DECISION_JSON="$(otter_delta_build_decision_json)"
OTTER_DECISION_LOCAL=0
if { printf '%s\n' "$OTTER_DELTA_DECISION_JSON" >> "$OTTER_DELTA_RECEIPTS_FILE"; } 2>/dev/null; then
  OTTER_DECISION_LOCAL=1
else
  echo "[deploy] WARNING: could not append the Otter delta decision row to $OTTER_DELTA_RECEIPTS_FILE"
fi
OTTER_DECISION_MIRRORED=0
if otter_delta_mirror "$OTTER_DELTA_DECISION_JSON" "$OTTER_DELTA_ATTEMPT_ID.decision"; then
  OTTER_DECISION_MIRRORED=1
else
  echo "[deploy] WARNING: Otter delta decision row could not be mirrored to $DEPLOY_DATA_DIR/agent/otter-release-delta-receipts.jsonl"
fi
if [ "$OTTER_DECISION_MIRRORED" != "1" ]; then
  # The worktree-local ledger above is gitignored and lives in a REAPABLE
  # session worktree (Codex round-5 review, finding 1, superseding the
  # round-4 local-or-mirror rule): once this worktree unlocks and is
  # reaped, a local-only decision row disappears, so it can never be the
  # swap's only decision record. When the target mirror append fails, the
  # row must also land in a durable runtime location OUTSIDE any
  # worktree, or the deploy refuses outright for EVERY verdict. No lane
  # lock is held yet; the EXIT trap releases the mutex and parity token.
  OTTER_DECISION_DURABLE_FALLBACK=0
  DURABLE_DECISION_LEDGER="${SB_DURABLE_DECISION_LEDGER:-$HOME/.secondbrain/otter-release-delta-receipts.jsonl}"
  if { mkdir -p "$(dirname "$DURABLE_DECISION_LEDGER")" && printf '%s\n' "$OTTER_DELTA_DECISION_JSON" >> "$DURABLE_DECISION_LEDGER"; } 2>/dev/null; then
    OTTER_DECISION_DURABLE_FALLBACK=1
    echo "[deploy] Otter delta decision row persisted to the durable non-worktree fallback $DURABLE_DECISION_LEDGER (mirror append failed; a reapable worktree copy does not count)"
  fi
  if [ "$OTTER_DECISION_DURABLE_FALLBACK" != "1" ]; then
    echo "[deploy] REFUSED: the Otter delta decision row could not be mirrored to the target and could not be persisted to the durable non-worktree fallback ($DURABLE_DECISION_LEDGER) for verdict $OTTER_COMPAT_VERDICT; a worktree-only decision record is reapable and does not count. /opt is untouched." >&2
    exit 1
  fi
fi


# Otter mutation quiescence is semantic, not blanket. A compatible target lets
# a worker pinned to its old immutable release drain while new schedules route
# through the new symlink. Any Otter/voice semantic change, missing helper, or
# unprovable digest retains both locks. --swap-anyway never waives that branch.
if [ "$OTTER_RELEASE_COMPATIBLE" = "1" ]; then
  echo "[deploy] deploy-window guard: compatible Otter contract; publish-route-drain without lane lock wait"
else
  echo "[deploy] deploy-window guard: acquiring both exact-call Otter healer lane locks"
  if ! acquire_otter_healer_deploy_lock; then
    echo "[deploy] REFUSED: an exact-call Otter healer lane lock is already held or could not be proven. Wait for that repair to finish; /opt is untouched." >&2
    exit 1
  fi
  echo "[deploy] deploy-window guard: incompatible/unknown Otter contract quiesced for this token-owned deploy"
fi
ALLOWED_ACTIVE_RUNNERS+=(ec2-otter-call-healer-run.sh)
# Pause recovery takes the same live + historical scheduler locks in the same
# fixed order before it can mutate anything. Once this deploy owns both locks,
# every recovery fire is a proven no-op. Exempt its cron proximity as a
# lock-covered operation; otherwise its */5 schedule plus the +/-2 minute
# window leaves no possible minute in which any unattended deploy can start.
ALLOWED_ACTIVE_RUNNERS+=(ec2-otter-healer-pause-recovery-run.sh)
ALLOWED_ACTIVE_RUNNER_CSV="$(IFS=,; echo "${ALLOWED_ACTIVE_RUNNERS[*]}")"
CONTROLLER_GUARD_ARGS=(--allow-active-runner "$ALLOWED_ACTIVE_RUNNER_CSV")
echo "[deploy] deploy-window guard: Otter runner coordination proven (compatible drain or both-lane quiescence)"

if [ "$SWAP_ANYWAY" = "1" ]; then
  echo "[deploy] deploy-window guard OVERRIDDEN (--swap-anyway / SB_DEPLOY_SWAP_ANYWAY=1): skipping scheduled-runner proximity checks only."
else
  echo "[deploy] deploy-window guard: checking EC2 cron proximity + mid-flight scheduled runners"
  GUARD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/sb-deploy-guard-XXXXXX")"
  cleanup_guard_tmp() { rm -rf "$GUARD_TMP" 2>/dev/null || true; }
  if ! target_exec "crontab -l 2>/dev/null || true" > "$GUARD_TMP/crontab.txt" \
    || ! target_exec "ps -eo pid,etimes,args 2>/dev/null || true" > "$GUARD_TMP/ps.txt" \
    || ! target_exec 'for d in /proc/[0-9]*; do printf "%s %s\n" "${d#/proc/}" "$(readlink "$d/cwd" 2>/dev/null || true)"; done 2>/dev/null || true' > "$GUARD_TMP/cwd.txt" \
    || ! target_exec "date +%s; date +%z" > "$GUARD_TMP/clock.txt"; then
    cleanup_guard_tmp
    echo "[deploy] REFUSED: could not snapshot the EC2 crontab/process table/clock for the deploy-window guard (fail closed). Re-run when SSH is healthy, or override with --swap-anyway / SB_DEPLOY_SWAP_ANYWAY=1." >&2
    exit 1
  fi
  HOST_NOW="$(sed -n 1p "$GUARD_TMP/clock.txt")"
  HOST_UTC_OFFSET="$(sed -n 2p "$GUARD_TMP/clock.txt")"
  if ! node "$ROOT/scripts/lib/deploy-window-guard.js" \
    --cron-file "$GUARD_TMP/crontab.txt" --ps-file "$GUARD_TMP/ps.txt" \
    --cwd-file "$GUARD_TMP/cwd.txt" \
    --now "$HOST_NOW" --host-utc-offset "${HOST_UTC_OFFSET:-+0000}" \
    --grace-seconds "${SB_DEPLOY_STARTUP_GRACE_SECONDS:-15}" \
    "${CONTROLLER_GUARD_ARGS[@]}"; then
    cleanup_guard_tmp
    echo "[deploy] REFUSED: a scheduled runner is inside its startup grace, or a mid-flight runner's immutable-release pin cannot be proven (named reasons above). Wait it out, or override with --swap-anyway / SB_DEPLOY_SWAP_ANYWAY=1." >&2
    exit 1
  fi
  cleanup_guard_tmp
  echo "[deploy] deploy-window guard: clear to swap"
fi

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
# Durable logs (deploy-blindness fix, 2026-07-19): the release-prep step inside
# atomic-release.sh (link_durable_logs_into_release) wires the new release's
# logs/ entry as a SYMLINK to the durable /opt/secondbrain-logs and MIGRATES any
# real logs/ files out of the current release first (mv -n, never deleted). So a
# log written at /opt/secondbrain/logs/x.log PRE-swap stays readable at the same
# path POST-swap BY CONSTRUCTION: both releases resolve logs/ to the one durable
# dir, and cron lines appending through /opt/secondbrain/logs keep working.
#
# Releases deployed BEFORE this fix each hold an orphaned log shard at
# /opt/secondbrain-releases/<sha>/logs. Do NOT delete them. Optional one-time
# consolidation (COPY, never delete), oldest release first:
#   for d in $(ls -dtr /opt/secondbrain-releases/*/logs 2>/dev/null); do \
#     [ -L "$d" ] && continue; for f in "$d"/*; do [ -f "$f" ] && \
#     cat "$f" >> "/opt/secondbrain-logs/orphan-shards-$(basename "$f")"; done; done
SHA="$(git -C "$ROOT" rev-parse HEAD)"
# A coalesced healer batch selects one immutable target SHA. The deploy
# adapter passes that selection explicitly so this script cannot silently ship
# a newer or older checkout and then satisfy the wrong per-card waiter.
EXPECTED_SHA="${SECONDBRAIN_DEPLOY_EXPECTED_SHA:-}"
if [ -n "$EXPECTED_SHA" ]; then
  if ! printf '%s' "$EXPECTED_SHA" | grep -Eq '^[0-9a-fA-F]{40}$'; then
    echo "[deploy] REFUSED: SECONDBRAIN_DEPLOY_EXPECTED_SHA is not a full git SHA. /opt is untouched." >&2
    exit 1
  fi
  if [ "$(printf '%s' "$EXPECTED_SHA" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$SHA" | tr '[:upper:]' '[:lower:]')" ]; then
    echo "[deploy] REFUSED: exact requested SHA mismatch. requested=$EXPECTED_SHA source=$SHA. /opt is untouched." >&2
    exit 1
  fi
fi
# Ship the sha the provenance gate APPROVED, and prove HEAD is still that sha.
# If the ref moved between the gate and here, the approval no longer covers what
# we would ship, so refuse rather than deploy an unvetted commit.
if [ "$SHA" != "$VERIFIED_SHA" ]; then
  echo "[deploy] REFUSED: HEAD moved after the source-provenance gate approved it. approved=$VERIFIED_SHA now=$SHA. /opt is untouched. Re-run the deploy so the gate re-verifies the current sha." >&2
  exit 1
fi

# Matching now fails closed on exact reference provenance. Stage the proven
# migration implementation in /tmp and verify the durable live registry is
# already current BEFORE swapping code. The authorized write remains a separate
# attended migration with its own immutable receipts and audit. A deploy must
# never silently make every legacy reference ineligible.
VOICE_PREFLIGHT_ROOT="/tmp/secondbrain-voice-provenance-preflight-$SHA"
echo "[deploy] verifying live trusted voice-reference provenance"
if ! target_exec "rm -rf '$VOICE_PREFLIGHT_ROOT' && mkdir -p '$VOICE_PREFLIGHT_ROOT/lib'"; then
  echo "[deploy] REFUSED: could not prepare the bounded voice provenance preflight directory; /opt is untouched." >&2
  exit 1
fi
if ! target_copy \
  "$ROOT/scripts/lib/voice-reference-provenance.js" \
  "$VOICE_PREFLIGHT_ROOT/lib/voice-reference-provenance.js" ||
  ! target_copy \
  "$ROOT/scripts/migrate-legacy-voice-reference-provenance.js" \
  "$VOICE_PREFLIGHT_ROOT/migrate-legacy-voice-reference-provenance.js"; then
  target_exec "rm -rf '$VOICE_PREFLIGHT_ROOT'" || true
  echo "[deploy] REFUSED: could not stage the voice provenance preflight; /opt is untouched." >&2
  exit 1
fi
if ! target_exec \
  "SECONDBRAIN_DATA_DIR='$DEPLOY_DATA_DIR' /usr/bin/node '$VOICE_PREFLIGHT_ROOT/migrate-legacy-voice-reference-provenance.js' --require-current --data-dir '$DEPLOY_DATA_DIR'"; then
  target_exec "rm -rf '$VOICE_PREFLIGHT_ROOT'" || true
  echo "[deploy] REFUSED: trusted voice-reference provenance is not current. Run the authorized audited migration before deploying; /opt is untouched." >&2
  exit 1
fi
target_exec "rm -rf '$VOICE_PREFLIGHT_ROOT'" || true
echo "[deploy] live trusted voice-reference provenance: PASS"

# BIG DECISIONS is git-tracked curated state, but atomic releases replace the
# archived data/ tree with the one durable runtime symlink. Seed this required
# input explicitly on every deploy, preserving the prior runtime copy by SHA.
# A missing local ledger refuses before the live code swap, so a replacement
# instance cannot silently render an empty decision card.
BIG_DECISIONS_SOURCE="$ROOT/data/agent/big-decisions.jsonl"
BIG_DECISIONS_REMOTE_TMP="/tmp/secondbrain-big-decisions-$SHA.jsonl"
if [ ! -s "$BIG_DECISIONS_SOURCE" ]; then
  echo "[deploy] REFUSED: required curated input is missing or empty: $BIG_DECISIONS_SOURCE" >&2
  exit 1
fi
if ! target_copy "$BIG_DECISIONS_SOURCE" "$BIG_DECISIONS_REMOTE_TMP"; then
  echo "[deploy] REFUSED: could not stage Big Decisions ledger on EC2; /opt is untouched." >&2
  exit 1
fi
if ! target_exec \
  "set -e; mkdir -p /opt/secondbrain/data/agent; if [ -f /opt/secondbrain/data/agent/big-decisions.jsonl ] && ! cmp -s /opt/secondbrain/data/agent/big-decisions.jsonl '$BIG_DECISIONS_REMOTE_TMP'; then cp -p /opt/secondbrain/data/agent/big-decisions.jsonl /opt/secondbrain/data/agent/big-decisions.pre-deploy-$SHA.jsonl; fi; mv '$BIG_DECISIONS_REMOTE_TMP' /opt/secondbrain/data/agent/big-decisions.jsonl"; then
  echo "[deploy] REFUSED: could not atomically seed Big Decisions ledger; live code is untouched." >&2
  exit 1
fi
echo "[deploy] required Big Decisions ledger: PASS"

# Memory Hygiene reads its weekly receipt from the durable data symlink, while
# the scheduled producer lands the canonical receipt in git. Reconcile the
# tracked receipt before cutover, but never replace a newer runtime receipt.
MEMORY_RECEIPT_SOURCE="$ROOT/data/agent/memory-consolidation-state.json"
MEMORY_RECEIPT_REMOTE_TMP="/tmp/secondbrain-memory-consolidation-$SHA.json"
MEMORY_RECONCILER_REMOTE_TMP="/tmp/secondbrain-memory-consolidation-reconcile-$SHA.js"
if [ ! -s "$MEMORY_RECEIPT_SOURCE" ]; then
  echo "[deploy] REFUSED: required Memory Hygiene receipt is missing or empty: $MEMORY_RECEIPT_SOURCE" >&2
  exit 1
fi
if ! target_copy "$MEMORY_RECEIPT_SOURCE" "$MEMORY_RECEIPT_REMOTE_TMP" ||
  ! target_copy "$ROOT/scripts/reconcile-memory-consolidation-receipt.js" "$MEMORY_RECONCILER_REMOTE_TMP"; then
  echo "[deploy] REFUSED: could not stage the Memory Hygiene receipt reconciler; /opt is untouched." >&2
  exit 1
fi
if ! target_exec "/usr/bin/node '$MEMORY_RECONCILER_REMOTE_TMP' '$MEMORY_RECEIPT_REMOTE_TMP' /opt/secondbrain/data/agent/memory-consolidation-state.json && rm -f '$MEMORY_RECONCILER_REMOTE_TMP' '$MEMORY_RECEIPT_REMOTE_TMP'"; then
  echo "[deploy] REFUSED: could not reconcile the Memory Hygiene receipt; live code is untouched." >&2
  exit 1
fi
echo "[deploy] Memory Hygiene durable receipt: PASS"

echo "[deploy] provisioning local Telegram voice runtime"
if ! target_exec_stdin "bash -s" < "$ROOT/scripts/install-telegram-voice-runtime.sh"; then
  echo "[deploy] TELEGRAM VOICE RUNTIME FAIL: local transcription was not proven; /opt is untouched." >&2
  exit 1
fi
echo "[deploy] local Telegram voice runtime: PASS"

# The one-use attended-action HMAC must not reuse the briefing URL capability
# token. Seed a dedicated durable secret under the deploy mutex and never print
# it. Atomic release preserves .env into the new immutable release.
echo "[deploy] provisioning dedicated attended-action signing secret"
if ! target_exec 'set -euo pipefail; attended_env=/opt/secondbrain/.env; if grep -q "^BRIEFING_ATTENDED_ACTION_SECRET=" "$attended_env" 2>/dev/null; then exit 0; fi; umask 077; attended_secret="$(openssl rand -hex 32)"; printf "\nBRIEFING_ATTENDED_ACTION_SECRET=%s\n" "$attended_secret" >> "$attended_env"; chmod 600 "$attended_env"'; then
  echo "[deploy] REFUSED: could not provision the dedicated attended-action signing secret; /opt code is untouched." >&2
  exit 1
fi
echo "[deploy] attended-action signing secret: PRESENT"

echo "[deploy] delegating live write to atomic-release.sh (sha $SHA, provenance-verified)"
echo "[deploy]   ships /opt/secondbrain/server.js + /opt/secondbrain/ec2-server.js inside the release tree"
echo "[deploy]   release logs/ is a symlink to the durable /opt/secondbrain-logs -- live log files survive the swap"
ATOMIC_RELEASE_ARGS=(--sha "$SHA" --source-root "$ROOT")
if [ "$LOCAL_DEPLOY" = "1" ]; then
  ATOMIC_RELEASE_ARGS+=(--local)
else
  ATOMIC_RELEASE_ARGS+=(--host "$HOST" --key "$KEY")
fi
if ! bash "$ROOT/scripts/lib/atomic-release.sh" "${ATOMIC_RELEASE_ARGS[@]}"; then
  echo "[deploy] ATOMIC RELEASE FAILED: the primitive either failed verification, or swapped and then rolled back on a health failure. /opt is unchanged from the last good release. See the [atomic-release] lines above." >&2
  exit 1
fi

# This cron entrypoint deliberately lives outside immutable releases so its
# schedule survives swaps. Refresh it from the just-proven release every deploy
# and verify exact bytes; a stale copy previously wrote generated coverage into
# the source checkout and invalidated exact category proofs mid-run.
echo "[deploy] installing durable Gmail attachment index tick"
if ! target_exec 'set -euo pipefail; install -d -m 0755 /opt/secondbrain-shared/bin; install -m 0755 /opt/secondbrain/scripts/gmail-attachment-index-tick.sh /opt/secondbrain-shared/bin/gmail-attachment-index-tick.sh; cmp -s /opt/secondbrain/scripts/gmail-attachment-index-tick.sh /opt/secondbrain-shared/bin/gmail-attachment-index-tick.sh'; then
  echo "[deploy] RELEASE CLOSURE INCOMPLETE: durable Gmail attachment index tick did not match the live release." >&2
  exit 1
fi
echo "[deploy] durable Gmail attachment index tick: PASS"

echo "[deploy] verifying attended-action signing secret from the new live release"
if ! target_exec '/usr/bin/node -e '\''const { resolveAttendedActionSecret } = require("/opt/secondbrain/scripts/lib/briefing-attended-action.js"); process.exit(resolveAttendedActionSecret() ? 0 : 1);'\'''; then
  echo "[deploy] RELEASE CLOSURE INCOMPLETE: the live release cannot resolve its dedicated attended-action signing secret." >&2
  exit 1
fi
echo "[deploy] live attended-action signing secret: VERIFIED"

# The release data/ directory is a durable runtime symlink, so a tracked file
# under data/ is not a reliable way to ship new audit exemptions. Merge the
# canonical config copy into durable state and verify readback before calling
# the release closed. Runtime-only local overrides are preserved.
echo "[deploy] reconciling paid-provider API audit allowlist"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data /usr/bin/node /opt/secondbrain/scripts/api-audit-allowlist-parity.js --write'; then
  echo "[deploy] API audit allowlist parity: PASS"
else
  echo "[deploy] RELEASE CLOSURE INCOMPLETE: tracked API audit exemptions did not survive into durable runtime state." >&2
  exit 1
fi

# ============================================================================
# deploy receipt (single code authority): record what shipped + how it relates
# to origin/master, and mirror the ledger to /opt/secondbrain/data/ so the
# EC2-side deploy-parity probe can verify /opt independently. A release that
# cannot be receipted FAILS LOUD (feedback_ec2_build_path_silent_revert.md).
#
# Codex gate ff30fbb4d641: this ran AFTER the post-release steps below, which
# each exit 1 on failure. The swap above is the moment $SHA becomes live, so
# any exit between there and here left /opt running a release with no receipt,
# and the parity probe reports drift against a sha nothing recorded. The
# receipt describes what IS live, so it is written the instant that is true.
# record-ec2-deploy-receipt.js is purely local (git metadata + jsonl append),
# with no host or Graphiti dependency, so nothing below is a prerequisite.
# ============================================================================
echo "[deploy] recording deploy receipt"
if ! RECEIPT_JSON="$(node "$ROOT/scripts/record-ec2-deploy-receipt.js")"; then
  echo "[deploy] RECEIPT FAIL: the release landed but could not be receipted. Fix and re-run so the parity probe has a receipt to verify against." >&2
  exit 1
fi

# APPEND the one receipt just written; never mirror the local ledger over the
# remote one. Codex gate ff30fbb4d641 round 3, then confirmed by executing it:
# the local ledger is gitignored (.gitignore:126) and absent from every fresh
# worktree, while record-ec2-deploy-receipt.js appends to the DEPLOYING
# worktree by design. So a deploy from a fresh worktree produced a ONE-LINE
# ledger, and `cp` over the remote file collapsed real history to that one
# line. Measured: a 5-receipt production ledger truncated to 1, unrecoverable,
# because nothing tracks or backs up that file. Two deploys in a night from
# two worktrees also made overnight-watch-report.js (which windows over ALL
# rows via readWindowedJsonl) undercount deploys.
#
# Appending a single line is idempotent-safe here: the receipt carries its own
# timestamp and sha, and readLatestReceipt consumers take the final line.
# APPEND-IF-ABSENT, under a lock. Codex gate 05a8e5b45303 finding 3: a plain
# `tee -a` is not idempotent. The failure path below tells the operator to
# retry, and a retry of the SAME attempt used to append a second row, which
# overnight-watch-report.js:261 counts as a separate deploy event. So the naive
# append traded truncation for double-counting.
#
# The dedupe key is (repoHead, serverSha256), taken from the receipt itself.
# A retry of the same attempt reproduces both, so it is suppressed; a genuinely
# different release changes serverSha256, so it appends. Known and accepted
# trade-off: re-deploying byte-identical content twice records one row, which is
# correct for a parity ledger whose subject is what /opt CONTAINS.
#
# flock serializes concurrent deploys so two racing appends cannot interleave.
# The receipt travels base64 in an env var and the program travels on stdin via
# `node -`, the same shape as the deploy-graphiti-indexed.sh handoff, so no JSON
# quoting ever reaches the SSH command line. The dedupe and append rules live in
# scripts/lib/append-deploy-receipt.js where they are readable and testable,
# rather than inline in nested shell quoting.
RECEIPT_B64="$(printf '%s' "$RECEIPT_JSON" | base64 | tr -d '\n')"
if ! target_exec_stdin \
  "SB_DEPLOY_RECEIPT_B64='$RECEIPT_B64' sudo -E node - \
   && sudo chown ec2-user:ec2-user /opt/secondbrain/data/agent/ec2-deploy-receipts.jsonl" \
  < "$ROOT/scripts/lib/append-deploy-receipt.js"; then
  echo "[deploy] RECEIPT MIRROR FAIL: the release is LIVE but /opt has no receipt for it. The parity probe will report receipt drift until this is repaired. Re-run this deploy; the append is idempotent on (repoHead, serverSha256), so a retry cannot double-count." >&2
  exit 1
fi
echo "[deploy] receipt recorded + appended to /opt/secondbrain/data/agent/ec2-deploy-receipts.jsonl"

# Fargate publishes immutable exact-call bundles through shared EFS. EC2
# promotes them, emits durable events, owns handoff/cycle state, and writes the
# ExampleCo-facing graph. Reassert every coordination directory on every release so
# a stale root-owned directory cannot strand a call or hide its defect proof.
echo "[deploy] normalizing exact-call coordination ownership"
if target_exec \
  'sudo install -d -o ec2-user -g ec2-user -m 0755 /opt/secondbrain/data/life-archive/voiceprints/otter-exact-call-envelopes /opt/secondbrain/data/life-archive/voiceprints/otter-exact-call-envelopes/inbox /opt/secondbrain/data/life-archive/voiceprints/otter-exact-call-envelopes/staging /opt/secondbrain/data/life-archive/voiceprints/otter-exact-call-dispatch-events /opt/secondbrain/data/life-archive/voiceprints/otter-exact-call-dispatch-events/events /opt/secondbrain/data/life-archive/voiceprints/otter-exact-call-dispatch-events/pending /opt/secondbrain/data/life-archive/voiceprints/otter-call-healer-handoffs /opt/secondbrain/data/life-archive/voiceprints/otter-call-healer-handoffs/settled /opt/secondbrain/data/life-archive/voiceprints/otter-call-processing-cycles /opt/secondbrain/data/life-archive/voiceprints/otter-call-processing-cycles/receipts /opt/secondbrain/data/life-archive/voiceprints/otter-call-processing-graphs /opt/secondbrain/data/life-archive/voiceprints/otter-call-processing-attempt-contexts'; then
echo "[deploy] exact-call coordination ownership: PASS"
else
  echo "[deploy] EXACT-CALL OWNERSHIP FAIL: EC2 cannot reliably promote, dispatch, heal, or render call proof." >&2
  exit 1
fi

# Historical probe directories can outlive the release that created them. A
# root-run recovery used to leave those durable call directories root-owned;
# the ordinary ec2-user producer could still read every old clip but could not
# write the next missing one, so ffmpeg failed only after the full Otter source
# fanout. Normalize only the durable probe-audio tree and preserve its modes and
# bytes. `find -xdev` keeps the repair on this data filesystem and `chown -h`
# avoids following any unexpected symlink.
echo "[deploy] normalizing Otter probe-audio ownership"
if target_exec \
  'sudo install -d -o ec2-user -g ec2-user -m 0775 /opt/secondbrain/data/otter/audio && sudo find /opt/secondbrain/data/otter/audio -xdev \( \! -user ec2-user -o \! -group ec2-user \) -exec chown -h ec2-user:ec2-user {} +'; then
  echo "[deploy] Otter probe-audio ownership: PASS"
else
  echo "[deploy] OTTER PROBE-AUDIO OWNERSHIP FAIL: the canonical ec2-user producer may be unable to create missing probe clips." >&2
  exit 1
fi

# The graph fails closed when the live consumer SHA is not the current immutable
# cutover-chain tip. A consumer-only release that preserves the producer's core
# contract is safe to activate from the already-verified producer bundle. Make
# that activation part of every guarded deploy so a successful code swap cannot
# leave all exact calls architecture-blocked until an attended repair. Initial
# producer cutover remains explicit: the helper skips when no cutover exists and
# fails loudly on a malformed chain or a producer/consumer core-hash mismatch.
echo "[deploy] advancing exact-call cutover to the live consumer release"
if target_exec \
  "SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data /usr/bin/node /opt/secondbrain/scripts/activate-otter-exact-call-cutover.js --advance-current-consumer --consumer-sha '$SHA'"; then
  echo "[deploy] exact-call consumer activation: PASS"
else
  echo "[deploy] EXACT-CALL ACTIVATION FAIL: release is live, but the graph is correctly blocked until producer/consumer provenance is reconciled." >&2
  exit 1
fi

# Graphiti extraction crosses a private Unix socket to the subscription-only
# Codex then Claude ladder. The helper proves authentication, starts the MCP
# container without provider keys, and verifies a real owner-scope fact query.
if [ "$GRAPHITI_RELEASE_CHANGED" = "1" ]; then
  echo "[deploy] deploying subscription-backed Graphiti runtime (runtime delta selected)"
  if target_exec_stdin "bash -s" < "$ROOT/scripts/lib/deploy-graphiti-indexed.sh"; then
    echo "[deploy] subscription-backed Graphiti runtime: PASS"
  else
    echo "[deploy] SUBSCRIPTION GRAPHITI DEPLOY FAIL" >&2
    exit 1
  fi

  # Neo4j is enrichment and must not consume the host capacity needed by the
  # independent card producers. Reapply and verify the cap with each selected
  # Graphiti runtime change.
  echo "[deploy] enforcing permanent Neo4j CPU cap"
  if target_exec \
    "node /opt/secondbrain/scripts/ensure-neo4j-cpu-cap.js --apply --data-dir /opt/secondbrain/data"; then
    echo "[deploy] Neo4j CPU cap: PASS"
  else
    echo "[deploy] WARNING: Neo4j CPU cap proof failed; release remains live and System Health will retain the non-green receipt." >&2
  fi
else
  echo "[deploy] Graphiti runtime: SKIPPED (unchanged deploy delta)"
fi

# Restore the pre-briefing self-heal schedule on every release. The installer
# defaults to the mutable build checkout, so bind both roots to the immutable
# live link before it writes crontab. The morning normalizer below then adds the
# independent report-prep rows and canonical 5:30 delivery row.
echo "[deploy] normalizing pre-briefing self-heal cron to the deployed runtime"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_CONTROLLER_ROOT=/opt/secondbrain /opt/secondbrain/scripts/install-ec2-self-heal-cron.sh >/dev/null'; then
  echo "[deploy] pre-briefing self-heal cron: PASS"
else
  echo "[deploy] CRON FAIL: release is live but the 2:45/3:00 self-heal schedule was not installed." >&2
  exit 1
fi

# Normalize the complete briefing-owned cron block after the legacy self-heal
# installer mutates crontab. Preserve the current controller authority decision,
# while making the scheduled fleet and every briefing row share one effective
# America/Chicago timezone from the validated installer.
echo "[deploy] normalizing briefing cron to the deployed runtime"
if target_exec \
  'controller_mode=--rollback; if [ "$(cat /opt/secondbrain/data/agent/briefing-card-controller-authority 2>/dev/null || true)" = "1" ]; then controller_mode=--activate; fi; SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_CONTROLLER_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data BRIEFING_LOG_DIR=/opt/secondbrain/logs bash /opt/secondbrain/scripts/install-ec2-card-controller-cron.sh "$controller_mode" >/dev/null'; then
  echo "[deploy] briefing cron: PASS"
else
  echo "[deploy] CRON FAIL: release is live but the briefing-owned schedules were not normalized to the deployed runtime with CT semantics." >&2
  exit 1
fi

# Deploy parity is evidence, not a one-time deployment side effect. Install an
# independent hourly probe from the Git build path so the artifact cannot age
# out when no deploy happens for several days.
echo "[deploy] installing periodic deploy-parity proof"
if target_exec \
  'SECONDBRAIN_BUILD_PATH_ROOT=/home/ec2-user/secondbrain-current SECONDBRAIN_DATA_DIR=/opt/secondbrain/data bash /opt/secondbrain/scripts/install-ec2-deploy-parity-cron.sh'; then
  echo "[deploy] deploy-parity cron: PASS"
else
  echo "[deploy] CRON FAIL: release is live but periodic deploy-parity proof was not installed." >&2
  exit 1
fi

echo "[deploy] installing provider-neutral session projection reconciliation"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data bash /opt/secondbrain/scripts/install-session-cloud-plane-cron.sh'; then
  echo "[deploy] session cloud reconciliation: PASS"
else
  echo "[deploy] CRON FAIL: release is live but session cloud reconciliation was not installed." >&2
  exit 1
fi

# Gmail-to-S3 parity used to depend on a Windows wrapper, so its otherwise
# valid proof aged out after cloud cutover.  The release now owns the schedule
# that produces and repairs the same canonical artifact before the watcher.
echo "[deploy] installing cloud Gmail-to-S3 durability proof"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain bash /opt/secondbrain/scripts/install-ec2-gmail-s3-flow-cron.sh'; then
  echo "[deploy] Gmail-to-S3 durability cron: PASS"
else
  echo "[deploy] CRON FAIL: release is live but Gmail-to-S3 durability proof was not installed." >&2
  exit 1
fi

echo "[deploy] installing bounded admission drain for scheduled stop/start boundaries"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data bash /opt/secondbrain/scripts/install-ec2-resize-drain.sh'; then
  echo "[deploy] EC2 resize admission drain: PASS"
else
  echo "[deploy] SERVICE FAIL: release is live but the resize admission drain was not installed." >&2
  exit 1
fi

echo "[deploy] installing three-night capacity measurement"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data bash /opt/secondbrain/scripts/install-overnight-capacity-measurement-cron.sh'; then
  echo "[deploy] overnight capacity measurement: PASS"
else
  echo "[deploy] CRON FAIL: release is live but three-night capacity measurement was not installed." >&2
  exit 1
fi

echo "[deploy] installing model-free morning retrospective (5:40 AM CT)"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data bash /opt/secondbrain/scripts/install-morning-retro-cron.sh'; then
  echo "[deploy] morning retrospective: PASS"
else
  echo "[deploy] CRON FAIL: release is live but the morning retrospective was not installed." >&2
  exit 1
fi

# Leaked command-less SSH tunnels from one client filled swap on 2026-10-03.
# The reaper closes only plain command-less tunnels it has itself observed
# showing the leak's 60 second keepalive and nothing else for three quiet
# intervals (four observations), each direction inside its own band (135 to
# 410 bytes in and 60 to 240 out per five minutes; measured on the production
# host on 2026-10-05: exactly 260 bytes in and 140 bytes out per five minutes
# for every leaked tunnel), that also belong to a burst of tunnel starts
# from their source, and only once that source holds more than eight. Its
# installer proves an observe-only run under the cron lock before writing the
# row, and on status 1 has removed every reaper row; any other failure
# (including an unreachable host) may leave an earlier row active. A failure
# here warns instead of exiting, so it can never skip the night-owner reassert
# or the healer deploy-owner pin below; System Health still measures open SSH
# logins directly.
echo "[deploy] installing idle SSH session reaper"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data bash /opt/secondbrain/scripts/install-ec2-ssh-session-reaper-cron.sh'; then
  echo "[deploy] idle SSH session reaper: PASS"
else
  reaper_status=$?
  if [ "$reaper_status" = 1 ]; then
    echo "[deploy] WARNING: idle SSH session reaper is NOT installed (its installer removed every reaper row); release remains live and System Health still measures open SSH logins." >&2
  else
    echo "[deploy] WARNING: idle SSH session reaper install could not be confirmed (status $reaper_status); a reaper row from an earlier deploy may still be active, and /opt/secondbrain/data/agent/ssh-session-health/reaper-disabled keeps it observe-only. Release remains live and System Health still measures open SSH logins." >&2
  fi
fi

# ExampleCo 2026-09-14: secondbrain-nightly-enhancement, video-quality-research, and
# weekly-warmth-audit moved off the overnight box into this 13:10-16:40 CT
# daytime row so the overnight box and its Codex/Claude quota go to the
# briefing cards. See scripts/lib/cloud-scheduled-fleet.js and
# scripts/lib/daytime-fleet-cron.js.
echo "[deploy] installing daytime scheduled-skill fleet cron"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data bash /opt/secondbrain/scripts/install-ec2-daytime-scheduled-fleet-cron.sh'; then
  echo "[deploy] daytime scheduled-skill fleet cron: PASS"
else
  echo "[deploy] CRON FAIL: release is live but the daytime scheduled-skill fleet cron was not installed." >&2
  exit 1
fi

echo "[deploy] installing safe storage pressure maintenance"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data SECONDBRAIN_BUILD_PATH_ROOT=/home/ec2-user/secondbrain-current bash /opt/secondbrain/scripts/install-ec2-storage-pressure-maintenance.sh'; then
  echo "[deploy] storage pressure maintenance: PASS"
else
  echo "[deploy] STORAGE FAIL: release is live but bounded log/worktree maintenance was not installed." >&2
  exit 1
fi

# The exact-call healer is part of the release graph, not an incidental
# crontab state left by an attended setup. Reinstall both the live five-minute
# lane and the separate historical lane after every atomic release.
echo "[deploy] installing exact-call Otter healer schedules"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain bash /opt/secondbrain/scripts/install-ec2-otter-call-healer-cron.sh'; then
  echo "[deploy] exact-call Otter healer schedules: PASS"
else
  echo "[deploy] CRON FAIL: release is live but exact-call Otter healer schedules were not installed." >&2
  exit 1
fi

echo "[deploy] installing locked voice EFS reconciliation"
if target_exec \
  'SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data bash /opt/secondbrain/scripts/install-ec2-voice-efs-reconcile-cron.sh'; then
  echo "[deploy] voice EFS reconciliation schedule: PASS"
else
  echo "[deploy] CRON FAIL: release is live but voice EFS reconciliation was not safely scheduled." >&2
  exit 1
fi

# Several older cron installers normalize the single sequential CRON_TZ line.
# Reassert the already-approved night-supervisor block only after every other
# deploy-owned cron mutation, so its two rows cannot silently fall back to the
# host timezone. The installer validates the effective timezone and exact row
# count before it writes crontab.
echo "[deploy] installing the approved single night owner after all cron installers"
if target_exec \
  'SECONDBRAIN_CONTROLLER_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data bash /opt/secondbrain/scripts/install-amy-night-owner.sh --apply'; then
  echo "[deploy] single night owner: PASS"
else
  echo "[deploy] SCHEDULE FAIL: release is live but the single night owner cutover is incomplete." >&2
  exit 1
fi

# The owner unit deliberately pins an immutable release path so it can survive
# a broken live symlink. Atomic release currently retains three releases, which
# keeps the prior pin valid through the swap and prune. Reinstall after the
# other schedule owners so a failure here cannot suppress their normalization;
# the next timer start then uses this new immutable release.
echo "[deploy] installing standing healer deploy owner"
if target_exec \
  "SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR='$DEPLOY_DATA_DIR' bash /opt/secondbrain/scripts/install-healer-deploy-owner.sh"; then
  echo "[deploy] standing healer deploy owner: PASS"
else
  echo "[deploy] SERVICE FAIL: release is live but the standing healer deploy owner was not pinned to it." >&2
  exit 1
fi

# Bound the paperwork-cohort report's bootstrap window: the deploy itself
# generates the first report so health's staleness gate takes over from the
# moment the release is live, and a missing report can never be an unbounded
# blind spot (Codex review 353c6b8c72cd).
echo "[deploy] seeding the paperwork cohort report"
if target_exec \
  'cd /opt/secondbrain && SECONDBRAIN_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data node scripts/otter-exact-closure-paperwork-sweep.js --write'; then
  echo "[deploy] paperwork cohort report: PASS"
else
  echo "[deploy] REPORT FAIL: release is live but the paperwork cohort report could not be generated." >&2
  exit 1
fi

# Post-release scheduled-skill rescue canary. The release has already passed
# atomic swap + /health, so this proof does not roll good code back. It is still
# part of release CLOSURE: a failure exits nonzero so the coordinator preserves
# the landed/live SHA as resumable integration work instead of claiming deploy
# completion and waiting for an attended rescue.
echo "[deploy] running post-release scheduled-skill rescue canary (required closure proof, no rollback)"
if target_exec \
  "/usr/bin/node /opt/secondbrain/scripts/post-release-scheduled-skill-canary.js --release-root /opt/secondbrain --source-root /home/ec2-user/secondbrain-current --data-dir /opt/secondbrain/data --release-sha '$SHA'"; then
  echo "[deploy] post-release scheduled-skill rescue canary: PASS"
else
  echo "[deploy] RELEASE CLOSURE INCOMPLETE: post-release scheduled-skill rescue canary failed. The health-verified release remains live, but deploy completion is withheld so the same SHA can resume closure." >&2
  exit 1
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
  target_copy "$ROOT/data/agent/devops-health-latest.json" "/tmp/devops-health-latest.json"
  target_exec \
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
  target_copy "$ROOT/data/agent/land-gate-receipt.json" "/tmp/land-gate-receipt.json"
  target_exec \
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

# The receipt is recorded immediately after the atomic swap above, not here,
# so a post-release step that exits cannot leave /opt running an unreceipted
# release.
cleanup_deploy_lock
echo "[deploy] synchronizing the EC2 build path before parity"
if target_exec '/home/ec2-user/ec2-sync-build-path.sh'; then
  echo "[deploy] build-path sync: PASS"
else
  echo "[deploy] WARNING: build-path sync failed; parity remains the release gate." >&2
fi
echo "[deploy] projecting landed global adapters from the clean EC2 build path"
if target_exec \
  'cd /home/ec2-user/secondbrain-current && SECONDBRAIN_BUILD_PATH_ROOT=/home/ec2-user/secondbrain-current /usr/bin/node scripts/project-global-adapters.js'; then
  echo "[deploy] global adapter projection: PASS"
else
  echo "[deploy] ERROR: landed global adapter projection failed; live hooks remain unchanged and deployment is incomplete." >&2
  exit 1
fi
echo "[deploy] running an unlocked post-deploy parity proof"
if target_exec \
  'cd /home/ec2-user/secondbrain-current && SECONDBRAIN_DATA_DIR=/opt/secondbrain/data /usr/bin/node scripts/verify-deploy-parity.js --json'; then
  echo "[deploy] post-deploy parity: PASS"
else
  echo "[deploy] ERROR: post-deploy parity is non-green; the health-verified release remains live, but deployment is incomplete." >&2
  exit 1
fi
echo "[deploy] proving the complete unattended morning schedule after every cron installer"
if target_exec \
  'SECONDBRAIN_ROOT=/home/ec2-user/secondbrain-current SECONDBRAIN_LIVE_ROOT=/opt/secondbrain SECONDBRAIN_DATA_DIR=/opt/secondbrain/data bash /opt/secondbrain/scripts/verify-unattended-morning.sh'; then
  echo "[deploy] unattended morning schedule: PASS"
else
  echo "[deploy] ERROR: the live release is healthy but the complete self-heal/report/delivery schedule is not proven." >&2
  exit 1
fi
echo "[deploy] recording final release-closure verdict"
if target_exec \
  "SECONDBRAIN_DATA_DIR=/opt/secondbrain/data /usr/bin/node /opt/secondbrain/scripts/record-release-closure.js --data-dir /opt/secondbrain/data --sha '$SHA' --stage deployment-proved --target 'standalone-deploy-repaint:$SHA'"; then
  echo "[deploy] deployment proof receipt: PASS; exact owning-unit repaint remains in the coordinator transaction"
  echo "[deploy] release closure: pending-exact-repaint by design; this deploy does not trigger the repaint. The pending row carries the consumable target id standalone-deploy-repaint:$SHA (Codex round-5 review, finding 3) so a coordinator-owned agentic healer work unit (scripts/agentic-healer-driver.js, consuming scripts/record-release-closure.js receipts) can claim, repaint, and close this release."
else
  echo "[deploy] RELEASE CLOSURE INCOMPLETE: final closure receipt could not be written; the same SHA must resume closure." >&2
  exit 1
fi
echo "[deploy] OK: released $SHA via atomic-release (/opt/secondbrain -> releases/$SHA), health-verified; final closure follows exact owning-unit repaint."
