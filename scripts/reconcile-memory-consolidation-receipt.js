'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readReceipt(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lastRunMs = Date.parse(String(value.last_run_iso || ''));
  if (!Number.isFinite(lastRunMs)) throw new Error(`invalid last_run_iso in ${file}`);
  return { value, lastRunMs };
}

function reconcileReceipt(source, target) {
  const incoming = readReceipt(source);
  let current = null;
  try {
    current = readReceipt(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current && current.lastRunMs >= incoming.lastRunMs) return 'kept-current';

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(incoming.value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, target);
  return 'promoted-incoming';
}

// The scheduled run lands the receipt to Git, but the MEMORY HYGIENE card
// reads the runtime data root, which previously refreshed only on deploy. On
// 2026-09-22 a successful consolidation stayed invisible until the deploy
// reconciler was run by hand. Promote it right after a successful land.
function promoteLandedReceipt({ skillName, worktreeRoot, dataDir }) {
  if (skillName !== 'memory-consolidation') return 'not-applicable';
  const rel = ['data', 'agent', 'memory-consolidation-state.json'];
  const source = path.join(worktreeRoot, ...rel);
  const target = path.join(dataDir, 'agent', 'memory-consolidation-state.json');
  if (path.resolve(source) === path.resolve(target)) return 'same-file';
  return reconcileReceipt(source, target);
}

if (require.main === module) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target) throw new Error('usage: reconcile-memory-consolidation-receipt.js <source> <target>');
  process.stdout.write(`${reconcileReceipt(source, target)}\n`);
}

module.exports = { readReceipt, reconcileReceipt, promoteLandedReceipt };
