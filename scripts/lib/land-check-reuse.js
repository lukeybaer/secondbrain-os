'use strict';
// land-check-reuse.js
//
// The owner approved 2026-10-20: `land.js --apply` reuses a green `--check` instead
// of rerunning the scoped tests and the category gate. A green check leaves a
// receipt bound to the tested git tree and the base sha it ran against, in the
// shared git directory (same pattern as the PII gate receipt). --apply reuses
// it when:
//   - the tree is identical and master has not moved (rebase is a no-op), or
//   - master moved but the upstream commits touched none of this land's
//     changed files nor its scoped test files (rebase retry, fail safe: any
//     doubt, unreadable receipt, or git failure means rerun everything).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'land-check-receipt@1';
const TREE_RE = /^[a-f0-9]{40,64}$/;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}

function receiptDir(repoRoot) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot);
  if (!common) return null;
  return path.join(common, 'land-check-receipts');
}

function writeCheckReceipt(dir, { tree, baseSha, changedFiles = [], scopeFiles = [], scopedTestFileCount = 0 }) {
  if (!dir || !TREE_RE.test(String(tree || ''))) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      schema: SCHEMA, tree, baseSha: String(baseSha || ''), ts: new Date().toISOString(),
      changedFiles, scopeFiles, scopedTestFileCount,
    };
    fs.writeFileSync(path.join(dir, `${tree}.json`), JSON.stringify(rec, null, 2));
    return rec;
  } catch {
    return null;
  }
}

function readCheckReceipt(dir, tree) {
  if (!dir || !TREE_RE.test(String(tree || ''))) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, `${tree}.json`), 'utf8'));
    return rec && rec.schema === SCHEMA && rec.tree === tree ? rec : null;
  } catch {
    return null;
  }
}

const norm = (f) => String(f).split(String.fromCharCode(92)).join('/');

// Decide whether a receipt for the pre-rebase tree can stand in for the test
// run. `upstreamFiles(oldBase, newBase)` returns the files master changed, or
// null when unknown (then: rerun).
function decideReuse({ receipt, newBaseSha, upstreamFiles }) {
  if (!receipt) return { reuse: false, reason: 'no green --check receipt for this tree' };
  if (!receipt.baseSha || !newBaseSha) return { reuse: false, reason: 'base sha unknown' };
  if (receipt.baseSha === newBaseSha) return { reuse: true, reason: 'identical tree and base sha' };
  let up;
  try { up = upstreamFiles(receipt.baseSha, newBaseSha); } catch { up = null; }
  if (!Array.isArray(up)) return { reuse: false, reason: 'could not list upstream changes' };
  const mine = new Set([...(receipt.changedFiles || []), ...(receipt.scopeFiles || [])].map(norm));
  const overlap = up.map(norm).filter((f) => mine.has(f));
  if (overlap.length) return { reuse: false, reason: `upstream touched ${overlap.length} file(s) in this land's diff or test scope: ${overlap.slice(0, 3).join(', ')}` };
  return { reuse: true, reason: `master moved but upstream (${up.length} file(s)) touched nothing in this land's diff or test scope` };
}

function upstreamFilesViaGit(cwd) {
  return (oldBase, newBase) => {
    const out = git(['diff', '--name-only', '--no-renames', `${oldBase}..${newBase}`], cwd);
    return out === null ? null : out.split(/\r?\n/).filter(Boolean);
  };
}

module.exports = { SCHEMA, receiptDir, writeCheckReceipt, readCheckReceipt, decideReuse, upstreamFilesViaGit };
