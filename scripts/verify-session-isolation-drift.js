#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DOC = 'dev-plans/core/session-isolation.md';
const KEY_FILES = [
  'scripts/lib/shared-tree-guard.js',
  'scripts/claude-hooks/shared-tree-guard.mjs',
  'scripts/lib/shared-tree-write-guard.js',
  'scripts/claude-hooks/shared-tree-write-guard.mjs',
  'scripts/git-hooks/shared-tree-policy.js',
  'scripts/git-hooks/common-pre-push',
  'scripts/git-hooks/land-push-guard.js',
  'scripts/git-hooks/pre-push',
  'scripts/lib/land-push-proof.js',
  'scripts/lib/land-gate.js',
  'scripts/land.js',
  'scripts/lib/codex-worktree.js',
  'scripts/lib/mutation-surface-matrix.js',
  'scripts/verify-shared-checkout-clean.js',
  'scripts/lib/windows-checkout-processes.ps1',
  '.claude/settings.json',
  'claude-config/settings.json',
];
const RETIRED = [
  'scripts/integration-session.js',
  'scripts/lib/integration-session.js',
  'scripts/lib/land-push-lease.js',
  'scripts/shared-checkout-reconciler.js',
  'scripts/shared-checkout-quarantine.js',
  'scripts/lib/shared-checkout-sync.js',
  'scripts/runtime-code-reconcile.js',
  'scripts/lib/runtime-code-reconciler.js',
  'scripts/claude-hooks/runtime-code-promote.mjs',
  'scripts/claude-hooks/shared-checkout-promote.mjs',
  'scripts/claude-hooks/session-isolation-guard.mjs',
];
const MUST_CONTAIN = [
  ['scripts/lib/shared-tree-write-guard.js', 'evaluateSharedTreeWrite'],
  ['scripts/lib/shared-tree-guard.js', 'evaluateSharedTreeOp'],
  ['scripts/git-hooks/common-pre-push', 'AMY_LAND_PUSH_PROOF_V1'],
  ['scripts/git-hooks/land-push-guard.js', 'SB_LAND_PUSH_PROOF'],
  ['scripts/lib/land-push-proof.js', 'PROOF_SCHEMA'],
  ['scripts/land.js', 'runScopedTests'],
  ['scripts/lib/mutation-surface-matrix.js', 'validateMutationSurfaceMatrix'],
];

function checkDrift(repoRoot) {
  const failures = [];
  const read = (rel) => {
    try { return fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { return null; }
  };
  const doc = read(DOC);
  if (doc === null) failures.push(`missing core doc: ${DOC}`);
  for (const rel of KEY_FILES) if (read(rel) === null) failures.push(`missing load-bearing file: ${rel}`);
  for (const [rel, token] of MUST_CONTAIN) {
    const source = read(rel);
    if (source === null || !source.includes(token)) failures.push(`invariant lost in ${rel}: expected "${token}"`);
  }
  for (const rel of RETIRED) if (read(rel) !== null) failures.push(`retired owner returned: ${rel}`);
  if (doc && !/worktree-only source mutation/i.test(doc)) failures.push('doc no longer states the worktree-only invariant');
  if (doc && !/two-minute session cloud plane/i.test(doc)) failures.push('doc no longer preserves the active session cloud plane');
  return { failures, warnings: [] };
}

function main() {
  const { failures } = checkDrift(path.resolve(__dirname, '..'));
  if (failures.length) {
    console.error(`DRIFT: session-isolation is out of sync (${failures.length})`);
    failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exit(1);
  }
  console.log('OK: session-isolation doc is in sync with the worktree land path.');
}
if (require.main === module) main();
module.exports = { checkDrift, KEY_FILES, MUST_CONTAIN, RETIRED };
