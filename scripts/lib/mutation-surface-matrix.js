'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MUTATION_SURFACES = [
  {
    id: 'execution-phase-supervisor',
    file: 'scripts/lib/execution-supervisor.js',
    operations: ['write', 'model-phase'],
    enforcement: ['codex-worktree', 'isolated-worktree-required', 'checkpoint-identity'],
    proofTokens: ['ensureCodexWorktree', 'planIdentity', 'execution-plan-locks', 'checkpointPath'],
  },
  {
    id: 'execution-operation-sequence',
    file: 'scripts/lib/execution-operations.js',
    operations: ['runtime-write', 'authorized-command'],
    enforcement: ['runtime-data-paths', 'per-unit-lock', 'preflight'],
    proofTokens: ['assertRuntimeOutsideCheckout', 'preflightOperationSequence', 'ownerToken'],
  },
  {
    id: 'briefing-evidence-pretransport-recovery',
    file: 'scripts/lib/briefing-evidence-recovery.js',
    operations: ['runtime-write', 'evidence-supersession'],
    enforcement: ['runtime-data-paths', 'notification-and-finalizer-leases', 'no-prior-transport'],
    proofTokens: ['assertRuntimeDataRoot', 'acquireNotify', 'acquireWriter', 'originalUnavailable', 'assertLegacyEligibility'],
  },
  {
    id: 'night-owner-maintenance-folds',
    file: 'scripts/cloud-maintenance-folds.js',
    operations: ['runtime-write', 'bounded-maintenance'],
    enforcement: ['runtime-data-paths', 'dated-native-proof'],
    proofTokens: ['assertRuntimeDataRoot', 'runActivity'],
  },
  {
    id: 'night-owner-scoped-tests',
    file: 'scripts/scoped-test-snapshot.js',
    operations: ['runtime-write', 'test-run'],
    enforcement: ['runtime-data-paths', 'isolated-test-data'],
    proofTokens: ['assertRuntimeDataRoot', 'mkdtempSync'],
  },
  {
    id: 'desktop-snapshot-maintenance',
    file: 'scripts/desktop-snapshot-maintenance.js',
    operations: ['runtime-write', 'snapshot-publish'],
    enforcement: ['runtime-data-paths', 'single-owner-lock'],
    proofTokens: ['defaultDataDir', 'withSnapshotOwnerLock'],
  },
  {
    id: 'claude-bash-git-guard',
    file: 'scripts/claude-hooks/shared-tree-guard.mjs',
    operations: ['git-reset', 'git-clean', 'git-commit', 'git-push'],
    enforcement: ['shared-tree-guard'],
  },
  {
    id: 'claude-write-guard',
    file: 'scripts/claude-hooks/shared-tree-write-guard.mjs',
    operations: ['write', 'edit', 'notebook-edit'],
    enforcement: ['shared-tree-write-guard'],
  },
  {
    id: 'shared-git-hooks',
    file: 'scripts/git-hooks/shared-tree-policy.js',
    operations: ['git-commit', 'git-push'],
    enforcement: ['git-hook-shared-tree-policy'],
  },
  {
    id: 'scheduled-skill-runner',
    file: 'scripts/run-scheduled-skill.js',
    operations: ['write', 'memory-write', 'lessons-write'],
    enforcement: ['codex-worktree', 'isolated-worktree-required'],
  },
  {
    id: 'dispatch-rescue-runner',
    file: 'scripts/process-dispatches.js',
    operations: ['write', 'memory-write', 'codegen'],
    enforcement: ['codex-worktree', 'isolated-worktree-required'],
  },
  {
    id: 'ec2-spine-worker',
    file: 'scripts/ec2-spine-worker.js',
    operations: ['write', 'codegen', 'commit', 'push', 'deploy'],
    enforcement: ['codex-worktree', 'isolated-worktree-required', 'serialized-landing', 'atomic-release'],
    proofTokens: ['ensureCodexWorktree', "path.join(worktree, 'scripts', 'land.js')", 'ec2-code-task-release.js'],
  },
  {
    id: 'video-regen-task-runner',
    file: 'scripts/video-regen-task-runner.js',
    operations: ['runtime-write', 'model-phase'],
    enforcement: ['runtime-data-paths', 'spine-task-lease', 'hard-process-deadline'],
    proofTokens: ['renewLease', 'attemptTimeoutMs', 'evaluateVideoRegenOutcome'],
  },
  {
    id: 'self-heal-orchestrator',
    file: 'scripts/overnight-self-heal-orchestrator.js',
    operations: ['write', 'commit', 'push'],
    enforcement: ['isolated-heal-session', 'serialized-landing'],
  },
  {
    id: 'agentic-briefing-healer',
    file: 'scripts/agentic-healer-driver.js',
    operations: ['write', 'codegen', 'commit', 'deploy', 'briefing-publish'],
    enforcement: ['isolated-worktree-required', 'serialized-landing'],
  },
  {
    id: 'briefing-health-self-heal',
    file: 'scripts/health-self-heal.js',
    operations: ['runtime-write', 'bounded-heal'],
    enforcement: ['devops-health-probe', 'no-shared-cleanup-without-quarantine'],
  },
  {
    id: 'system-health-category-probe',
    file: 'scripts/system-health-category-probe.js',
    operations: ['runtime-write', 'test-run'],
    enforcement: ['runtime-data-paths', 'current-release-source'],
    proofTokens: ['SECONDBRAIN_DATA_DIR', 'collectCategoryProof'],
  },
  {
    id: 'exact-release-test-source',
    file: 'scripts/lib/system-health-test-category.js',
    operations: ['detached-test-worktree', 'runtime-write', 'test-run'],
    enforcement: ['runtime-data-paths', 'current-release-source', 'owned-worktree-cleanup', 'isolated-test-data'],
    proofTokens: ['assertRuntimeDataRoot', 'acquireMatchingTestSource', 'assertMatchingTestSource', 'mkdtempSync', 'cleanup'],
  },
  {
    id: 'manual-briefing',
    file: 'scripts/manual-briefing-v3.js',
    operations: ['runtime-write', 'briefing-publish'],
    enforcement: ['devops-health-row', 'runtime-data-paths'],
  },
  {
    id: 'desktop-life-archive-daily-maintenance',
    file: 'scripts/life-archive-daily-maintenance.ps1',
    operations: ['runtime-write'],
    enforcement: ['runtime-data-paths'],
    proofTokens: ['Assert-RuntimeDataDir', '$DataDir'],
  },
  {
    id: 'desktop-task-consolidation',
    file: 'scripts/desktop-task-consolidation.ps1',
    operations: ['scheduler-write', 'runtime-write'],
    enforcement: ['runtime-data-paths'],
    proofTokens: ['Export-ScheduledTask', 'Assert-NotProtected', '-ConfirmApply'],
  },
  {
    id: 'news-refresh-envelope',
    file: 'scripts/news-refresh.js',
    operations: ['runtime-write', 'briefing-publish', 'process-cancellation'],
    enforcement: ['runtime-data-paths', 'exact-card-scope', 'hard-process-deadline'],
    proofTokens: ['SECONDBRAIN_DATA_DIR', 'killProcessTree(child'],
  },
  {
    id: 'news-straight-line-refresh',
    file: 'scripts/news-straight-line-refresh.js',
    operations: ['runtime-write', 'briefing-publish'],
    enforcement: ['runtime-data-paths', 'single-owner-lock'],
    proofTokens: ['SECONDBRAIN_DATA_DIR', 'acquireOwnerLock(dataDir, date)'],
  },
  {
    id: 'voice-git-people-sync',
    file: 'scripts/voice-git-people-sync.js',
    operations: ['tracked-write', 'commit', 'push'],
    enforcement: ['isolated-worktree-required', 'serialized-landing'],
    proofTokens: ['ensureCodexWorktree', "['scripts/land.js', '--apply']"],
  },
  {
    id: 'speaker-people-file-sync',
    file: 'scripts/sync-otter-speaker-intelligence-to-people-files.js',
    operations: ['tracked-write', 'memory-write'],
    enforcement: ['shared-tree-write-guard'],
    proofTokens: [
      'people-file-write-guard',
      'if (write) assertPeopleFileWriteAllowed({ repo: PEOPLE_ROOT });',
    ],
  },
  {
    id: 'voiceprint-people-file-sync',
    file: 'scripts/sync-voiceprints-to-people-files.js',
    operations: ['tracked-write', 'memory-write'],
    enforcement: ['shared-tree-write-guard'],
    proofTokens: [
      'people-file-write-guard',
      'if (args.write) assertPeopleFileWriteAllowed({ repo: PEOPLE_ROOT });',
    ],
  },
  {
    id: 'exact-call-people-file-projection',
    file: 'scripts/otter-exact-call-people-projection.js',
    // Since 2026-09-21 exact-call work stages People content in runtime state;
    // the daily batch owns the guarded People-file write.
    operations: ['runtime-write'],
    enforcement: ['runtime-data-paths'],
    proofTokens: ['stagePeopleLearning({'],
  },
  {
    id: 'people-file-stub-writer',
    file: 'scripts/lib/voice-people-stub.js',
    operations: ['tracked-write', 'memory-write'],
    enforcement: ['shared-tree-write-guard'],
    proofTokens: ['people-file-write-guard', 'assertPeopleFileWriteAllowed({'],
  },
];

function validateMutationSurfaceMatrix(rows = MUTATION_SURFACES, options = {}) {
  const problems = [];
  const ids = new Set();
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..');
  const readFile = options.readFile || ((file) => fs.readFileSync(file, 'utf8'));
  for (const row of rows) {
    if (!row || !row.id) problems.push('row missing id');
    else if (ids.has(row.id)) problems.push(`duplicate row id ${row.id}`);
    else ids.add(row.id);
    if (!row || !row.file) problems.push(`${row && row.id ? row.id : 'row'} missing file`);
    if (!row || !Array.isArray(row.operations) || row.operations.length === 0) {
      problems.push(`${row && row.id ? row.id : 'row'} missing operations`);
    }
    if (!row || !Array.isArray(row.enforcement) || row.enforcement.length === 0) {
      problems.push(`${row && row.id ? row.id : 'row'} missing enforcement`);
    }
    const enforcement = (row && row.enforcement) || [];
    const hasIsolation =
        enforcement.includes('isolated-worktree-required') ||
      enforcement.includes('serialized-landing') ||
      enforcement.includes('shared-tree-guard') ||
      enforcement.includes('shared-tree-write-guard') ||
      enforcement.includes('git-hook-shared-tree-policy') ||
      enforcement.includes('guard-validated-lock') ||
      enforcement.includes('runtime-data-paths') ||
      enforcement.includes('no-shared-cleanup-without-quarantine');
    if (!hasIsolation) problems.push(`${row.id} has no isolation or lease enforcement`);
    if (Array.isArray(row.proofTokens) && row.proofTokens.length) {
      let source = '';
      try {
        source = String(readFile(path.join(repoRoot, row.file)) || '');
      } catch (error) {
        problems.push(`${row.id} enforcement source unreadable: ${error.message || error}`);
      }
      for (const token of row.proofTokens) {
        if (!source.includes(token)) problems.push(`${row.id} missing enforcement token ${token}`);
      }
    }
  }
  return { ok: problems.length === 0, problems, rows: rows.length };
}

module.exports = {
  MUTATION_SURFACES,
  validateMutationSurfaceMatrix,
};
