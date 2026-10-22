'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const EFFECT_KINDS = Object.freeze([
  'calendar_event',
  'task',
  'message',
  'code_dispatch',
  'approval',
  'reputation_flag',
  // Its own kind on purpose: a generic `task` receipt must never be able to
  // satisfy "I did that on your PC", the same way a task receipt never
  // satisfies a calendar_event claim.
  'desktop_task',
]);

const COMPLETION_VERBS =
  /\b(created|scheduled|booked|sent|emailed|texted|messaged|added|made|put|placed|filed|submitted|completed|finished|opened|handled|done)\b/i;

// "It has not been done" and "I could not finish it" are the honest sentences
// this system now produces on purpose. Without a negation guard the widened verb
// list would flag Amy's own truthful reporting as an unsupported completion
// claim, which trains everyone to ignore the audit.
const CLAIM_NEGATION =
  /\b(not|never|no|nothing|cannot|can'?t|won'?t|couldn'?t|hasn'?t|haven'?t|didn'?t|isn'?t|unable|pending|queued|unconfirmed|expired|blocked)\b/i;

function defaultLedgerPath(env = process.env) {
  if (env.VAPI_SIDE_EFFECT_LEDGER) return env.VAPI_SIDE_EFFECT_LEDGER;
  if (env.SECONDBRAIN_DATA_DIR) return path.join(env.SECONDBRAIN_DATA_DIR, 'agent', 'vapi-side-effects.jsonl');
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain')) {
    return '/opt/secondbrain/data/agent/vapi-side-effects.jsonl';
  }
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'secondbrain', 'data', 'agent', 'vapi-side-effects.jsonl');
}

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['succeeded', 'failed', 'queued'].includes(value)) return value;
  return 'failed';
}

// A tool result may carry the machine-checkable completion flags instead of a
// literal status string. Honour them rather than falling through to `failed`:
// "queued" and "failed" are different facts, and an off-box request that is
// genuinely still pending must not be ledgered as a failure.
function resolveEffectStatus(input = {}) {
  const declared = String(input.status || '').trim().toLowerCase();
  if (['succeeded', 'failed', 'queued'].includes(declared)) return declared;
  if (input.completed === true) return 'succeeded';
  if (input.queued === true) return 'queued';
  return 'failed';
}

function normalizeEffectKind(effectKind) {
  const value = String(effectKind || '').trim().toLowerCase();
  return EFFECT_KINDS.includes(value) ? value : 'task';
}

function buildEffectReceipt(input = {}, opts = {}) {
  return {
    ts: input.ts || (typeof opts.nowIso === 'function' ? opts.nowIso() : new Date().toISOString()),
    call_id: input.callId || input.call_id || 'unknown',
    tool_call_id: input.toolCallId || input.tool_call_id || '',
    tool_name: input.toolName || input.tool_name || '',
    effect_kind: normalizeEffectKind(input.effectKind || input.effect_kind),
    status: resolveEffectStatus(input),
    summary: String(input.summary || input.message || '').trim(),
    artifact_id: String(input.artifactId || input.artifact_id || '').trim(),
    error: String(input.error || '').trim(),
  };
}

function recordEffectReceipt(input = {}, opts = {}) {
  const receipt = buildEffectReceipt(input, opts);
  const ledgerPath = opts.ledgerPath || defaultLedgerPath(opts.env || process.env);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(receipt) + '\n', 'utf8');
  return receipt;
}

function readEffectReceipts(opts = {}) {
  const ledgerPath = opts.ledgerPath || defaultLedgerPath(opts.env || process.env);
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((row) => !opts.callId || row.call_id === opts.callId);
}

function canClaimCompletedEffect(receipts, effectKind) {
  const kind = normalizeEffectKind(effectKind);
  return (receipts || []).some((row) => row.effect_kind === kind && row.status === 'succeeded');
}

function categoriseClaim(value) {
  if (/\b(calendar|appointment|meeting|event)\b/.test(value)) return 'calendar_event';
  if (/\b(email|telegram|text|sms|message)\b/.test(value)) return 'message';
  // Before the desktop branch existed, "I opened that on your PC" matched
  // nothing and the audit could not see the claim at all.
  if (/\b(pc|desktop|computer|laptop|browser|chrome|your machine)\b/.test(value)) {
    return 'desktop_task';
  }
  if (/\b(task|todo|to-do|project task)\b/.test(value)) return 'task';
  if (/\b(code|claude code|deploy|bug|fix)\b/.test(value)) return 'code_dispatch';
  return null;
}

// Negation binds to its CLAUSE, not to the whole utterance. Suppressing an
// entire sentence let "No problem, I opened that on your PC" and "I couldn't send
// the email, but I opened the report on your PC" walk past the audit (Codex
// review 81d624d56856). Split first, then judge each clause on its own.
function claimClauses(value) {
  return String(value || '')
    .split(/\s*(?:[,;:]|\bbut\b|\bhowever\b|\byet\b|\balthough\b|\bthough\b|\band then\b|\band\b|\bso\b)\s*/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

// EVERY clause-level claim, and each category resolved strictly INSIDE the
// clause that makes it. The old version returned only the first claim, so
// "I sent the email, and I opened the report on your PC" audited as a message
// claim alone; and its whole-utterance fallback let a NEGATED clause borrow a
// category, so "I submitted it, but I could not open Chrome" audited as a
// desktop claim (Codex review e4c1259ce531). A category may not be borrowed
// across a clause boundary, because that is exactly how negation leaks.
function detectEffectKinds(text) {
  const value = String(text || '').toLowerCase();
  if (!COMPLETION_VERBS.test(value)) return [];
  const kinds = [];
  for (const clause of claimClauses(value)) {
    if (!COMPLETION_VERBS.test(clause) || CLAIM_NEGATION.test(clause)) continue;
    const kind = categoriseClaim(clause);
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function detectEffectKind(text) {
  return detectEffectKinds(text)[0] || null;
}

function extractCompletedSideEffectClaims(transcript) {
  if (!transcript || typeof transcript !== 'string') return [];
  const claims = [];
  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^AI:\s*/i.test(line)) continue;
    const text = line.replace(/^AI:\s*/i, '').trim();
    // One claim per DISTINCT effect kind in the line: a single sentence can
    // promise two different completed effects, and each needs its own receipt.
    for (const effectKind of detectEffectKinds(text)) {
      claims.push({ effect_kind: effectKind, text });
    }
  }
  return claims;
}

function auditCompletedSideEffectClaims({ transcript = '', receipts = [] } = {}) {
  const claims = extractCompletedSideEffectClaims(transcript);
  const unsupported = claims.filter((claim) => !canClaimCompletedEffect(receipts, claim.effect_kind));
  return {
    ok: unsupported.length === 0,
    claims,
    unsupported,
  };
}

function formatEffectToolResult(receipt) {
  const status = normalizeStatus(receipt.status);
  const summary = String(receipt.summary || '').trim();
  if (status === 'succeeded') return summary || 'Done.';
  if (status === 'queued') {
    return summary || 'Request queued. It has not been completed yet.';
  }
  return summary || 'The requested action failed. I did not complete it.';
}

module.exports = {
  EFFECT_KINDS,
  auditCompletedSideEffectClaims,
  buildEffectReceipt,
  canClaimCompletedEffect,
  defaultLedgerPath,
  detectEffectKind,
  detectEffectKinds,
  extractCompletedSideEffectClaims,
  formatEffectToolResult,
  readEffectReceipts,
  recordEffectReceipt,
};
