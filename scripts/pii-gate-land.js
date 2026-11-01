#!/usr/bin/env node
'use strict';
// Run the Layer 3 PII LLM gate against the simulated public payload and leave
// a receipt (see scripts/lib/pii-gate-receipt.js). Called by scripts/land.js
// at land time and by the push hook.
//
//   node scripts/pii-gate-land.js --range origin/master..HEAD   run (or reuse receipt)
//   node scripts/pii-gate-land.js --check                       exit 0 only if HEAD's tree has a receipt
//
// Exit: 0 pass or not relevant, 1 gate flagged, 2 setup/fail-closed, 3 --check miss.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('./lib/pii-gate-receipt.js');

const REPO = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// A fresh worktree has no node_modules; the main checkout's dependencies are the
// same ones the scoped tests already borrow.
function childEnv() {
  const main = R.mainCheckout(REPO);
  const nm = path.join(main, 'node_modules');
  const parts = [process.env.NODE_PATH, nm].filter(Boolean);
  return { ...process.env, NODE_PATH: parts.join(path.delimiter) };
}

function run() {
  const dir = R.receiptDir(REPO);
  const tree = R.headTree(REPO);
  if (!tree) { console.error('[pii-gate-land] cannot resolve HEAD tree; failing closed.'); return 2; }
  if (flag('--check')) return R.hasReceipt(dir, 'tree', tree) ? 0 : 3;

  const range = val('--range', 'origin/master..HEAD');
  if (!flag('--always') && R.relevantProse(REPO, range).length === 0) {
    console.error('[pii-gate-land] no public-sync prose changed; no PII receipt needed.');
    return 0;
  }
  if (R.hasReceipt(dir, 'tree', tree)) {
    console.error(`[pii-gate-land] receipt present for tree ${tree.slice(0, 12)}; gate already passed at land time.`);
    return 0;
  }
  const sim = spawnSync(process.execPath, ['scripts/simulate-public-sync.js', '--quiet'], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 600000, env: childEnv(),
  });
  const payload = String(sim.stdout || '').trim();
  if (sim.status !== 0 || !payload) {
    console.error('[pii-gate-land] simulate-public-sync.js failed; cannot stage the public payload. Failing closed.');
    return 2;
  }
  // The full payload is ~62,000 prose windows (about two hours of LLM time),
  // which is why the gate could never fit a 120 s hook. Layer 3 judges only
  // payload files whose source path changed in this range; every other file
  // was judged when it last changed, and Layers 1 and 2 (denylist, NER) still
  // cover the whole payload in CI and at publish.
  const changed = new Set(R.changedFiles(REPO, range));
  const subset = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-changed-'));
  let copied = 0;
  for (const rel of R.listFiles(payload)) {
    if (!changed.has(rel)) continue;
    const dest = path.join(subset, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(payload, rel), dest);
    copied++;
  }
  if (copied > 0) {
    console.error(`[pii-gate-land] running pii-llm-gate.js on ${copied} changed payload file(s) (layer 3, fail-closed)...`);
    const gate = spawnSync(process.execPath, ['scripts/pii-llm-gate.js', subset], {
      cwd: REPO, stdio: 'inherit', windowsHide: true, timeout: 3600000, env: childEnv(),
    });
    if (gate.status !== 0) return gate.status === 1 ? 1 : 2;
    // An override (PII_GATE_OVERRIDE) has its own ledger; it never mints a pass receipt.
    if (process.env.PII_GATE_OVERRIDE === '1') return 0;
  } else {
    console.error('[pii-gate-land] no changed file ships in the public payload; nothing for layer 3 to judge.');
  }
  R.writeReceipt(dir, 'tree', tree, { scope: 'changed-files', files: copied, sourceSha: sha() });
  console.error(`[pii-gate-land] passed; receipt bound to tree ${tree.slice(0, 12)}.`);
  return 0;
}

function sha() {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true }).stdout.trim();
}

if (require.main === module) {
  let code;
  try { code = run(); } catch (e) { console.error(`[pii-gate-land] ${e.message}; failing closed.`); code = 2; }
  process.exit(code);
}
module.exports = { run };
