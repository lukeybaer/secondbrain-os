'use strict';
// land-gate-receipt.js
//
// D9 (ExampleCo wave 3a, 2026-07-12): the System Health "Automated regression
// suite" row had no runtime proof on the cloud build, so it rendered the bare
// informational line and one morning failed QC outright. The land gate
// (scripts/land.js) already runs the scoped test suite green on EVERY land, so
// it is the natural canonical receipt: land.js writes this small JSON after
// the scoped run (green or red) and again after the push, and the System
// Health row reads the freshest copy and renders a factual, timestamped
// status. deploy-ec2-server.sh ships the desktop copy to /opt/secondbrain so
// the cloud row sees the same proof.
//
// Receipt file: data/agent/land-gate-receipt.json.
// Schema locked by scripts/__tests__/land-gate-receipt.test.js.

const fs = require('fs');
const path = require('path');

const LAND_GATE_RECEIPT_SCHEMA = 'land-gate-receipt@1';
const LAND_GATE_RECEIPT_BASENAME = 'land-gate-receipt.json';
// A land older than this is still shown, but as dated context, not a live
// green claim. 7 days: ExampleCo lands most days; a week-stale gate means the
// pipeline itself needs attention.
const LAND_GATE_FRESH_MS = 7 * 24 * 3600 * 1000;

function buildLandGateReceipt({
  status,
  branch,
  commit,
  changedFileCount,
  scopedTestFileCount,
  landed = false,
  now = new Date(),
} = {}) {
  return {
    schema: LAND_GATE_RECEIPT_SCHEMA,
    ranAt: now.toISOString(),
    status: status === 'green' ? 'green' : 'red',
    branch: String(branch || '').slice(0, 120),
    commit: String(commit || '').slice(0, 40),
    changedFileCount: Number(changedFileCount) || 0,
    scopedTestFileCount: Number(scopedTestFileCount) || 0,
    landed: Boolean(landed),
  };
}

function validateLandGateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (receipt.schema !== LAND_GATE_RECEIPT_SCHEMA) return false;
  if (!receipt.ranAt || Number.isNaN(new Date(receipt.ranAt).getTime())) return false;
  if (receipt.status !== 'green' && receipt.status !== 'red') return false;
  return true;
}

// Write the receipt into every writable target dir (repo data/agent plus the
// runtime data dir when set). Never throws: a receipt failure must not fail a
// land.
function writeLandGateReceipt(receipt, { repoRoot, dataDir } = {}) {
  const targets = [];
  if (repoRoot) targets.push(path.join(repoRoot, 'data', 'agent'));
  if (dataDir) targets.push(path.join(dataDir, 'agent'));
  const written = [];
  for (const dir of [...new Set(targets.map((d) => path.resolve(d)))]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, LAND_GATE_RECEIPT_BASENAME);
      fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
      written.push(file);
    } catch {
      /* best effort; the land itself must not fail on receipt IO */
    }
  }
  return written;
}

// Freshest valid receipt across the standard candidates (runtime data dir,
// repo data/agent, EC2 runtime dir). Returns null when none validates.
function readFreshestLandGateReceipt({ dataDir, repoRoot } = {}) {
  const repo = repoRoot || path.resolve(__dirname, '..', '..');
  const candidates = [
    dataDir ? path.join(dataDir, 'agent', LAND_GATE_RECEIPT_BASENAME) : null,
    path.join(repo, 'data', 'agent', LAND_GATE_RECEIPT_BASENAME),
    process.platform === 'linux'
      ? path.join('/opt/secondbrain/data/agent', LAND_GATE_RECEIPT_BASENAME)
      : null,
  ].filter(Boolean);
  let best = null;
  const seen = new Set();
  for (const file of candidates) {
    const full = path.resolve(file);
    if (seen.has(full)) continue;
    seen.add(full);
    let json = null;
    try {
      json = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    if (!validateLandGateReceipt(json)) continue;
    const t = new Date(json.ranAt).getTime();
    if (!best || t > best.t) best = { receipt: json, t, path: full };
  }
  return best ? { ...best.receipt, receiptPath: best.path } : null;
}

function isLandGateReceiptFresh(receipt, now = Date.now()) {
  if (!validateLandGateReceipt(receipt)) return false;
  return now - new Date(receipt.ranAt).getTime() <= LAND_GATE_FRESH_MS;
}

module.exports = {
  LAND_GATE_RECEIPT_SCHEMA,
  LAND_GATE_RECEIPT_BASENAME,
  LAND_GATE_FRESH_MS,
  buildLandGateReceipt,
  validateLandGateReceipt,
  writeLandGateReceipt,
  readFreshestLandGateReceipt,
  isLandGateReceiptFresh,
};
