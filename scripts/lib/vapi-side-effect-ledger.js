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
]);

const COMPLETION_VERBS =
  /\b(created|scheduled|booked|sent|emailed|texted|messaged|added|made|put|placed|filed|submitted)\b/i;

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

function normalizeEffectKind(effectKind) {
  const value = String(effectKind || '').trim().toLowerCase();
  return EFFECT_KINDS.includes(value) ? value : 'task';
}

function buildEffectReceipt(input = {}, opts = {}) {
  return {
    ts: input.ts || (typeof opts.nowIso === 'function' ? opts.nowIso() : new Date().toISOString()),
    call_id: input.callId || input.call_id || 'ExampleCo',
    tool_call_id: input.toolCallId || input.tool_call_id || '',
    tool_name: input.toolName || input.tool_name || '',
    effect_kind: normalizeEffectKind(input.effectKind || input.effect_kind),
    status: normalizeStatus(input.status),
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

function detectEffectKind(text) {
  const value = String(text || '').toLowerCase();
  if (!COMPLETION_VERBS.test(value)) return null;
  if (/\b(calendar|appointment|meeting|event)\b/.test(value)) return 'calendar_event';
  if (/\b(email|telegram|text|sms|message)\b/.test(value)) return 'message';
  if (/\b(task|todo|to-do|project task)\b/.test(value)) return 'task';
  if (/\b(code|claude code|deploy|bug|fix)\b/.test(value)) return 'code_dispatch';
  return null;
}

function extractCompletedSideEffectClaims(transcript) {
  if (!transcript || typeof transcript !== 'string') return [];
  const claims = [];
  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^AI:\s*/i.test(line)) continue;
    const text = line.replace(/^AI:\s*/i, '').trim();
    const effectKind = detectEffectKind(text);
    if (!effectKind) continue;
    claims.push({ effect_kind: effectKind, text });
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
  extractCompletedSideEffectClaims,
  formatEffectToolResult,
  readEffectReceipts,
  recordEffectReceipt,
};
