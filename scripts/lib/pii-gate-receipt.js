'use strict';
// Layer 3 PII gate receipts (top-15 item 12, 2026-10-05).
//
// The LLM gate takes minutes, so running it inside the 120 s push hook timed
// out on most pushes. It now runs at land time (scripts/pii-gate-land.js) and
// leaves a receipt bound to the tested content: the git tree of the tested
// commit (a rebase or amend that keeps the tree keeps the receipt valid; any
// content change invalidates it) and the simulated public payload digest. The
// push hook only verifies a receipt; with no receipt it still runs the full
// gate exactly as before, so nothing is weakened.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'pii-gate-receipt@1';
const KEY_RE = /^(tree|payload)-[a-f0-9]{40,64}$/;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

// Receipts live in the shared git directory so a land from a worktree and a
// later push from anywhere in the repo agree on one directory, without leaving
// untracked files in the shared checkout's working tree.
function receiptDir(repoRoot) {
  if (process.env.SB_MAIN_CHECKOUT) return path.join(process.env.SB_MAIN_CHECKOUT, 'data', 'agent', 'pii-gate-receipts');
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot);
  // Fail closed: never fall back into the (possibly shared) working tree.
  if (!common) throw new Error('pii-gate-receipt: cannot resolve the git common dir; refusing to store receipts in the working tree');
  return path.join(common, 'pii-gate-receipts');
}

// The main checkout (where shared node_modules live), from any worktree.
function mainCheckout(repoRoot) {
  if (process.env.SB_MAIN_CHECKOUT) return process.env.SB_MAIN_CHECKOUT;
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot);
  return common && path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : repoRoot;
}

function receiptFile(dir, kind, id) {
  const key = `${kind}-${String(id || '').toLowerCase()}`;
  if (!KEY_RE.test(key)) throw new Error(`invalid receipt key: ${key}`);
  return path.join(dir, `${key}.json`);
}

function hasReceipt(dir, kind, id) {
  try {
    const rec = JSON.parse(fs.readFileSync(receiptFile(dir, kind, id), 'utf8'));
    return rec && rec.schema === SCHEMA && rec.result === 'pass';
  } catch {
    return false;
  }
}

function writeReceipt(dir, kind, id, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const rec = { schema: SCHEMA, result: 'pass', kind, id: String(id).toLowerCase(), ts: new Date().toISOString(), ...extra };
  fs.writeFileSync(receiptFile(dir, kind, id), JSON.stringify(rec, null, 2));
  return rec;
}

function headTree(repoRoot) {
  return git(['rev-parse', 'HEAD^{tree}'], repoRoot);
}

// Same relevance rule the push hook has always used: public-sync prose only.
const PRIVATE_PREFIX = /^(memory\/|data\/|content-review\/|scheduled-tasks\/|\.tmp\/|\.claude\/)/;
function relevantProse(repoRoot, range) {
  const out = git(['diff', '--name-only', range], repoRoot);
  return out.split(/\r?\n/).filter((f) => /\.(md|txt)$/.test(f) && !PRIVATE_PREFIX.test(f));
}

function changedFiles(repoRoot, range) {
  return git(['diff', '--name-only', range], repoRoot).split(/\r?\n/).filter(Boolean);
}

function listFiles(root, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

module.exports = { mainCheckout, changedFiles, listFiles, SCHEMA, receiptDir, hasReceipt, writeReceipt, headTree, relevantProse };
