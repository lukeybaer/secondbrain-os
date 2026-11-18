'use strict';
//
// ship-review.js -- the peer-review judgment `scripts/ship.js` applies before a
// production deploy (S-8, owner decision).
//
// Before S-8 this logic lived inside the two-bot-gate hook, which parsed shell
// text to guess that a command was a deploy and then searched for a receipt
// tied to whatever checkout HEAD it could resolve from that text. On
// 2026-11-10 it counted an scp as a deploy and bound a receipt to the wrong
// checkout. Ship knows exactly which commit it deploys, so it asks this module
// one question: does an approving `ec2-deploy` receipt bind THIS sha?
//
// The verdict rule is unchanged from the gate (memory/feedback_when_to_call_codex.md):
//   - approve unlocks, unless its own structured FINDINGS names a critical/high;
//   - changes-required unlocks ec2-deploy only when it names at least one
//     finding and no critical/high lands inside the reviewed diff
//     (diff-anchored, judged from the receipt's immutable diffScope);
//   - a degraded (Codex-unreachable) receipt counts only when it is labeled
//     claude-self-pass and names the Codex failure it stands in for.
// Out-of-diff and remaining findings go to the audit-only open-findings ledger.

const path = require('node:path');
const fs = require('node:fs');
const { parseVerdict, parseFindings } = require('./codex-verdict.js');
const { scopeFindings } = require('./diff-anchored-findings.js');
const { sharedCheckoutRoots } = require('./shared-checkout-root.js');
const { appendCanonicalJsonl } = require('./canonical-audit-log.js');
const { NON_RUNTIME_PREFIXES } = require('./land-deploy-review.js');

const DEPLOY_GATE = 'ec2-deploy';
const NO_HIGH_GATE_IDS = new Set([DEPLOY_GATE]);
const DEFAULT_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const RECEIPTS_RELATIVE = path.join('data', 'agent', 'codex-peer-review-results.jsonl');
const OPEN_FINDINGS_RELATIVE = path.join('data', 'agent', 'codex-review-open-findings.jsonl');
const SHA_RE = /^[0-9a-f]{40}$/i;

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      /* a torn line never takes the judgment down */
    }
  }
  return rows;
}

/** Receipts from the current tree and every shared checkout root. */
function loadReceipts({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.SHIP_RECEIPTS_FILE) return readJsonl(env.SHIP_RECEIPTS_FILE);
  const roots = sharedCheckoutRoots({ cwd, env, extraRoots: [path.resolve(__dirname, '..', '..')] });
  return roots.flatMap((root) => readJsonl(path.join(root, RECEIPTS_RELATIVE)));
}

function degradedReceiptOk(receipt) {
  const flagged = receipt && (receipt.degraded === true || receipt.reviewer === 'claude-self-pass');
  if (!flagged) return true;
  return (
    receipt.degraded === true &&
    receipt.reviewer === 'claude-self-pass' &&
    Boolean(String(receipt.codexFailure || '').trim())
  );
}

const isBlocking = (f) => f.severity === 'critical' || f.severity === 'high';

/**
 * @returns {{ok:boolean, verdict:string, findings:object[], outOfDiff?:object[], diffScoped?:boolean}}
 */
function verdictOutcome(receipt, gate = DEPLOY_GATE, { repoRoot = null } = {}) {
  const gateId = typeof gate === 'object' && gate ? gate.id : gate;
  const verdict = parseVerdict(receipt && receipt.review);
  const result = parseFindings(receipt && receipt.review);
  if (verdict === 'approve') {
    if (result.status === 'invalid') return { ok: false, verdict, findings: [] };
    if (result.status === 'absent') return { ok: true, verdict, findings: [] };
    return { ok: !result.findings.some(isBlocking), verdict, findings: result.findings };
  }
  if (verdict === 'changes-required' && NO_HIGH_GATE_IDS.has(gateId)) {
    if (result.status !== 'ok' || result.findings.length === 0) return { ok: false, verdict, findings: [] };
    const scoped = scopeFindings(result.findings, receipt && receipt.diffScope, { repoRoot });
    return {
      ok: !scoped.inDiff.some(isBlocking),
      verdict,
      findings: result.findings,
      outOfDiff: scoped.outOfDiff,
      diffScoped: scoped.scoped,
    };
  }
  return { ok: false, verdict, findings: [] };
}

function runtimeFiles(files) {
  return (files || [])
    .map((f) => String(f || '').replace(/\\/g, '/'))
    .filter((f) => f && !NON_RUNTIME_PREFIXES.some((p) => f.startsWith(p)));
}

/**
 * The newest receipt that authorizes deploying `sha`, or null.
 * A receipt on a reviewed ancestor binds only when every file changed since is
 * non-runtime (memory/, dev-plans/, docs/), via changedFilesSince(reviewed, sha).
 * A receipt on another commit binds when sameChange(reviewed, sha) is true: the
 * same reviewed change rebased onto a moved master (ship.js decides that from
 * the runtime trees and patch ids; owner decision, middle-ground ship).
 */
function bindingReceipt(receipts, sha, options = {}) {
  const want = String(sha || '').trim().toLowerCase();
  if (!SHA_RE.test(want)) return null;
  const gate = options.gate || DEPLOY_GATE;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const candidates = (receipts || []).filter((r) => {
    if (!r || String(r.gate || '').trim().toLowerCase() !== gate) return false;
    const ts = Date.parse(r.ts || '');
    if (!Number.isFinite(ts) || nowMs - ts > maxAgeMs || ts - nowMs > CLOCK_SKEW_MS) return false;
    if (!degradedReceiptOk(r)) return false;
    const reviewed = String(r.sourceSha || '').trim().toLowerCase();
    if (!SHA_RE.test(reviewed)) return false;
    if (reviewed !== want) {
      const since = typeof options.changedFilesSince === 'function' ? options.changedFilesSince(reviewed, want) : null;
      const viaAncestor = Array.isArray(since) && runtimeFiles(since).length === 0;
      const viaSameChange = !viaAncestor && typeof options.sameChange === 'function' && options.sameChange(reviewed, want) === true;
      if (!viaAncestor && !viaSameChange) return false;
    }
    return verdictOutcome(r, gate, { repoRoot: options.repoRoot || null }).ok;
  });
  candidates.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return candidates[0] || null;
}

function findingHashOf(text) {
  return require('node:crypto').createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12);
}

/**
 * Audit-only ledger of the findings a deploy shipped with (same row shape and
 * dedupe key the two-bot gate wrote before S-8). Returns false when any row
 * failed to reach the canonical shared root; ship then refuses the deploy.
 */
function recordOpenFindings({ receipt, sha, findings, gate = DEPLOY_GATE }, { cwd = process.cwd(), resolveSharedCheckout } = {}) {
  const dedupeKey = (r) => `${r.receiptId}|${r.gate}|${r.sha}|${r.severity}|${r.findingHash}`;
  for (const finding of findings || []) {
    const row = {
      ts: new Date().toISOString(),
      receiptId: (receipt && receipt.id) || null,
      gate,
      sha: sha || null,
      severity: finding.severity,
      text: finding.text,
      findingHash: findingHashOf(finding.text),
      phase: 'authorization',
      source: 'scripts/ship.js',
      ...(finding.outOfDiff ? { outOfDiff: true } : {}),
      ...(finding.preExisting ? { preExisting: true } : {}),
    };
    const ok = appendCanonicalJsonl({
      cwd,
      relativePath: OPEN_FINDINGS_RELATIVE,
      row,
      dedupeKey,
      ...(resolveSharedCheckout ? { resolveSharedCheckout } : {}),
    });
    if (!ok) return false;
  }
  return true;
}

/** Findings a changes-required unlock leaves behind, out-of-diff ones annotated. */
function openFindingsOf(receipt, { repoRoot = null } = {}) {
  const out = verdictOutcome(receipt, DEPLOY_GATE, { repoRoot });
  if (out.verdict !== 'changes-required') return [];
  const byText = new Map((out.outOfDiff || []).map((f) => [f.text, f]));
  return (out.findings || []).map((f) => byText.get(f.text) || f);
}

module.exports = {
  DEPLOY_GATE,
  DEFAULT_MAX_AGE_MS,
  RECEIPTS_RELATIVE,
  OPEN_FINDINGS_RELATIVE,
  bindingReceipt,
  degradedReceiptOk,
  loadReceipts,
  openFindingsOf,
  recordOpenFindings,
  runtimeFiles,
  verdictOutcome,
};
