'use strict';
// backlog-run-receipt.js
//
// Output contract for the nightly feature-backlog research loop (ExampleCo wave 3a,
// 2026-07-12, D8). On 2026-07-12 the nightly run (commit ab8440c3) studied 5
// repos and rewrote data/agent/feature-backlog.json, but nothing recorded
// whether the run emitted scored approval asks, so when the FEATURE BACKLOG
// card showed no asks the healer could not tell "the loop produced nothing"
// from "the consumer read a stale copy" from "legitimately no proposals".
//
// The contract: every backlog save writes this receipt next to the backlog it
// saved. The receipt EITHER ExampleCos scored asks (scoredAskCount > 0 plus the
// top asks) OR an explicit no-proposals marker (noProposals: true with a
// reason). The card renders honestly from either state; QC fails only on a
// CONTRACT VIOLATION (no scored asks rendered and no receipt-backed
// no-proposals marker).
//
// Receipt file: data/agent/backlog-research-receipt.json (same dir family as
// feature-backlog.json). Schema locked by
// scripts/__tests__/backlog-run-receipt-contract.test.js.

const fs = require('fs');
const path = require('path');

const BACKLOG_RECEIPT_SCHEMA = 'backlog-research-receipt@1';
const BACKLOG_RECEIPT_BASENAME = 'backlog-research-receipt.json';
const MAX_RECEIPT_ASKS = 30;

function activeFeatures(backlog) {
  const primary = Array.isArray(backlog && backlog.features) ? backlog.features : [];
  const fallback = Array.isArray(backlog && backlog.items) ? backlog.items : [];
  const rows = primary.length ? primary : fallback;
  return rows.filter(
    (item) =>
      item && !item.approved_at && !/done|complete|shipped/i.test(String(item.status || '')),
  );
}

// Derive the receipt mechanically from the backlog being saved, so the loop
// cannot claim asks it did not write and cannot go silent without a marker.
function deriveBacklogReceipt(backlog, { now = new Date(), reason } = {}) {
  const active = activeFeatures(backlog).filter((item) =>
    Number.isFinite(Number(item.priority_score ?? item.score ?? item.strategic_impact)),
  );
  const asks = active
    .map((item) => ({
      id: String(item.id || '').slice(0, 120),
      title: String(item.title || item.summary || '').slice(0, 160),
      score: Math.round(Number(item.priority_score ?? item.score ?? item.strategic_impact ?? 0)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RECEIPT_ASKS);
  const scoredAskCount = active.length;
  return {
    schema: BACKLOG_RECEIPT_SCHEMA,
    ranAt: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    scoredAskCount,
    asks,
    noProposals: scoredAskCount === 0,
    reason:
      scoredAskCount === 0
        ? String(
            reason ||
              'the research run completed but every backlog item is approved, shipped, or archived below the cutoff',
          ).slice(0, 300)
        : '',
  };
}

function validateBacklogReceipt(receipt) {
  const failures = [];
  if (!receipt || typeof receipt !== 'object') {
    return { ok: false, failures: ['receipt missing or not an object'] };
  }
  if (receipt.schema !== BACKLOG_RECEIPT_SCHEMA) {
    failures.push(`schema must be ${BACKLOG_RECEIPT_SCHEMA}`);
  }
  if (!receipt.ranAt || Number.isNaN(new Date(receipt.ranAt).getTime())) {
    failures.push('ranAt must be a valid ISO timestamp');
  }
  const count = Number(receipt.scoredAskCount);
  if (!Number.isFinite(count) || count < 0) {
    failures.push('scoredAskCount must be a non-negative number');
  }
  if (!Array.isArray(receipt.asks)) failures.push('asks must be an array');
  if (count > 0 && receipt.noProposals) {
    failures.push('noProposals cannot be true when scoredAskCount > 0');
  }
  if (count === 0 && !receipt.noProposals) {
    failures.push('a zero-ask receipt must set the explicit noProposals marker');
  }
  if (count === 0 && !String(receipt.reason || '').trim()) {
    failures.push('a no-proposals receipt must carry a reason');
  }
  return { ok: failures.length === 0, failures };
}

// A no-proposals receipt may only excuse an empty backlog while it is CURRENT
// (Codex review, wave 3a): the nightly loop runs daily, so a receipt older
// than one briefing cycle cannot vouch for today's empty card; a stale marker
// masking a missing feature-backlog.json is exactly the D8 silence class.
const BACKLOG_RECEIPT_FRESH_MS = 26 * 3600 * 1000;

function isBacklogReceiptFresh(receipt, nowMs = Date.now(), windowMs = BACKLOG_RECEIPT_FRESH_MS) {
  if (!receipt || !receipt.ranAt) return false;
  const t = new Date(receipt.ranAt).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t <= windowMs;
}

function receiptPathFor(agentDir) {
  return path.join(agentDir, BACKLOG_RECEIPT_BASENAME);
}

// Write the receipt next to the backlog file that was just saved.
function writeBacklogReceipt(agentDir, receipt) {
  fs.mkdirSync(agentDir, { recursive: true });
  const file = receiptPathFor(agentDir);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
  return file;
}

// Read the freshest valid receipt across the candidate agent dirs (build data
// dir first, then repo, then the EC2 runtime dir). Returns null when none
// validates; the caller treats that as the contract violation.
function readFreshestBacklogReceipt({ dataDir, repoRoot } = {}) {
  const candidates = [];
  if (dataDir) candidates.push(path.join(dataDir, 'agent'));
  const repo = repoRoot || path.resolve(__dirname, '..', '..');
  candidates.push(path.join(repo, 'data', 'agent'));
  if (process.platform === 'linux') candidates.push('/opt/secondbrain/data/agent');
  let best = null;
  const seen = new Set();
  for (const dir of candidates) {
    const file = path.resolve(receiptPathFor(dir));
    if (seen.has(file)) continue;
    seen.add(file);
    let json = null;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    if (!validateBacklogReceipt(json).ok) continue;
    const t = new Date(json.ranAt).getTime();
    if (!best || t > best.t) best = { receipt: json, path: file, t };
  }
  return best ? { ...best.receipt, receiptPath: best.path } : null;
}

module.exports = {
  BACKLOG_RECEIPT_SCHEMA,
  BACKLOG_RECEIPT_BASENAME,
  BACKLOG_RECEIPT_FRESH_MS,
  activeFeatures,
  deriveBacklogReceipt,
  validateBacklogReceipt,
  writeBacklogReceipt,
  readFreshestBacklogReceipt,
  isBacklogReceiptFresh,
  receiptPathFor,
};
