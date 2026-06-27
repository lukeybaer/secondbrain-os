'use strict';

const MUTATION_SURFACES = [
  {
    id: 'claude-bash-git-guard',
    file: 'scripts/claude-hooks/shared-tree-guard.mjs',
    operations: ['git-reset', 'git-clean', 'git-commit', 'git-push'],
    enforcement: ['shared-tree-guard', 'integration-lease'],
  },
  {
    id: 'claude-write-guard',
    file: 'scripts/claude-hooks/shared-tree-write-guard.mjs',
    operations: ['write', 'edit', 'notebook-edit'],
    enforcement: ['shared-tree-write-guard', 'integration-lease'],
  },
  {
    id: 'shared-git-hooks',
    file: 'scripts/git-hooks/shared-tree-policy.js',
    operations: ['git-commit', 'git-push'],
    enforcement: ['git-hook-shared-tree-policy', 'integration-lease'],
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
    operations: ['write', 'codegen'],
    enforcement: ['codex-worktree', 'isolated-worktree-required'],
  },
  {
    id: 'self-heal-orchestrator',
    file: 'scripts/overnight-self-heal-orchestrator.js',
    operations: ['write', 'commit', 'push'],
    enforcement: ['isolated-heal-session', 'serialized-landing'],
  },
  {
    id: 'briefing-health-self-heal',
    file: 'scripts/health-self-heal.js',
    operations: ['runtime-write', 'bounded-heal'],
    enforcement: ['devops-health-probe', 'no-shared-cleanup-without-quarantine'],
  },
  {
    id: 'manual-briefing',
    file: 'scripts/manual-briefing-v3.js',
    operations: ['runtime-write', 'briefing-publish'],
    enforcement: ['devops-health-row', 'runtime-data-paths'],
  },
  {
    id: 'integration-session',
    file: 'scripts/integration-session.js',
    operations: ['shared-checkout-integration'],
    enforcement: ['ttl-lock', 'owner-audit', 'guard-validated-lock'],
  },
];

function validateMutationSurfaceMatrix(rows = MUTATION_SURFACES) {
  const problems = [];
  const ids = new Set();
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
      enforcement.includes('integration-lease') ||
      enforcement.includes('isolated-worktree-required') ||
      enforcement.includes('serialized-landing') ||
      enforcement.includes('guard-validated-lock') ||
      enforcement.includes('runtime-data-paths') ||
      enforcement.includes('no-shared-cleanup-without-quarantine');
    if (!hasIsolation) problems.push(`${row.id} has no isolation or lease enforcement`);
  }
  return { ok: problems.length === 0, problems, rows: rows.length };
}

module.exports = {
  MUTATION_SURFACES,
  validateMutationSurfaceMatrix,
};
