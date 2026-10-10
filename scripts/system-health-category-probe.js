#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { collectCategoryProof } = require('./lib/system-health-test-category');
function main(argv = process.argv.slice(2)) {
  const arg = (name) => { const i = argv.indexOf(name); return i < 0 ? '' : argv[i + 1] || ''; };
  const repoRoot = path.resolve(__dirname, '..');
  const dataDir = arg('--data-dir') || process.env.SECONDBRAIN_DATA_DIR;
  if (!dataDir) throw new Error('Explicit runtime data directory is required.');
  const sourceRoot = arg('--source-root') || undefined;
  const result = collectCategoryProof({ dataDir, repoRoot, sourceRoot, category: arg('--category') });
  console.log(JSON.stringify(result));
  return result.status === 'green' ? 0 : 1;
}
if (require.main === module) { try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { main };
