#!/usr/bin/env node
'use strict';

// Graphiti is deliberately fully off. Keep policy and runtime boundaries aligned.
const fs = require('node:fs');
const path = require('node:path');
const DOC = 'dev-plans/core/graphiti.md';
const KEY_FILES = ['config/graphiti-runtime-policy.json', 'scripts/lib/graphiti-ingestion-policy.js', 'scripts/lib/graphiti-tunnel.js', 'scripts/lib/deploy-graphiti-indexed.sh', 'scripts/__tests__/graphiti-ingestion-policy.test.js'];
const MUST_CONTAIN = [
  ['config/graphiti-runtime-policy.json', '"state": "disabled"'],
  ['config/graphiti-runtime-policy.json', '"ingestion_state": "disabled"'],
  ['scripts/lib/deploy-graphiti-indexed.sh', 'recall and ingestion disabled by owner'],
  ['scripts/lib/deploy-graphiti-indexed.sh', 'docker stop secondbrain-graphiti'],
  ['scripts/lib/deploy-graphiti-indexed.sh', 'exit 0'],
];
const MUST_NOT_CONTAIN = [];
const MUST_NOT_EXIST = [];
function checkDrift(repoRoot) {
  const failures = [];
  const read = (rel) => { try { return fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { return null; } };
  for (const file of KEY_FILES) if (read(file) === null) failures.push(`missing load-bearing file: ${file}`);
  for (const [file, token] of MUST_CONTAIN) if (!read(file)?.includes(token)) failures.push(`invariant lost in ${file}: expected "${token}"`);
  const deploy = read('scripts/lib/deploy-graphiti-indexed.sh') || '';
  if (deploy.indexOf('recall and ingestion disabled by owner') > deploy.indexOf('docker compose version')) failures.push('Graphiti disabled-policy exit must occur before compose selection or service activation');
  const doc = read(DOC);
  if (doc === null) failures.push(`missing core doc: ${DOC}`);
  else if (!/recall and ingestion.*off|disabled.*recall.*ingestion/i.test(doc)) failures.push('Graphiti core doc must state full owner-disabled recall and ingestion');
  return { failures, warnings: [] };
}
if (require.main === module) {
  const result = checkDrift(path.resolve(__dirname, '..'));
  if (result.failures.length) { result.failures.forEach((row) => console.error(`DRIFT: ${row}`)); process.exit(1); }
  console.log('OK: Graphiti off policy is in sync with runtime boundaries.');
}
module.exports = { checkDrift, KEY_FILES, MUST_CONTAIN, MUST_NOT_CONTAIN, MUST_NOT_EXIST };
