'use strict';

// auth-voice-paid-fallback (memory/AMY_AUTHORIZATIONS.md, 2026-08-16).
//
// The OpenAI API may serve Amy's LIVE VOICE CALLS, and nothing else. The
// legacy desktop fallback requires proven Codex exhaustion. A separately
// authenticated, owner-selected phone primary may pass paidPrimary. No other
// environment flag, restored credential, spend headroom, or deploy state may
// arm this ledger.
//
// ExampleCo set the caps on 2026-08-16: $15 of reservation headroom and 500
// reserved calls per rolling 24 hours. $0.03 is a conservative admission unit,
// not a claim about provider-billed cost; the provider usage record settles
// separately. Reserve before contact, never after, so a crash cannot create an
// unrecorded paid attempt.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {withStateLock} = require('./controller-conflict-leases.js');

const SCHEMA = 'amy.voice-paid-fallback.v1';
const MAX_CAP_USD = 15;
const MAX_CALLS = 500;
const RESERVATION_USD = 0.03;
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Verified against the OpenAI GPT-5.6 Luna model page on 2026-09-07:
// $0.20 / 1M uncached input and $1.20 / 1M output. This explicit table
// prevents a model override from silently invalidating the reservation cap.
const PAID_VOICE_MODEL = 'gpt-5.6-luna';
const PAID_VOICE_INPUT_USD_PER_MILLION = 0.2;
const PAID_VOICE_OUTPUT_USD_PER_MILLION = 1.2;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_COMPLETION_TOKENS = 2200;

// Voice only. Any other consumer is a scope violation, not a configuration
// choice, so the allowed set is a constant rather than an argument default.
const ALLOWED_SCOPES = Object.freeze(['voice-call']);

function defaultDataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'secondbrain', 'data');
  return path.join(process.cwd(), 'data');
}

function ledgerPath(opts = {}) {
  if (opts.ledgerPath) return opts.ledgerPath;
  return path.join(opts.dataDir || defaultDataDir(), 'agent', 'voice-paid-fallback-ledger.jsonl');
}

function reservationLockPath(opts = {}) {
  return `${ledgerPath(opts)}.lock`;
}

function withReservationLock(opts, worker, denied) {
  try {
    return withStateLock({root:path.dirname(ledgerPath(opts)),lock:reservationLockPath(opts)},worker,{waitMs:200,lockStaleMs:15000,...opts.lockOptions});
  } catch (error) {
    if(error.code !== 'CONFLICT_STATE_LOCKED') throw error;
    return denied;
  }
}

function readReservations(opts = {}, nowMs) {
  const file = ledgerPath(opts);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const cutoff = nowMs - WINDOW_MS;
  const rows = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      // A corrupt line must not silently shrink the spend total, because that
      // would read as extra headroom. Count it at full reservation cost.
      rows.push({ reservedUsd: RESERVATION_USD, at: new Date(nowMs).toISOString(), corrupt: true });
      continue;
    }
    const at = Date.parse(row?.at || '');
    if (!Number.isFinite(at)) {
      rows.push({reservedUsd: RESERVATION_USD, at: new Date(nowMs).toISOString(), corrupt:true});
      continue;
    }
    if (at < cutoff) continue;
    rows.push(row);
  }
  return rows;
}

function windowUsage(opts = {}, nowMs) {
  const rows = readReservations(opts, nowMs).filter((row) => !row?.kind || row.kind === 'reservation');
  let usd = 0;
  for (const row of rows) {
    const amount = Number(row?.reservedUsd);
    usd += Number.isFinite(amount) && amount > 0 ? amount : RESERVATION_USD;
  }
  return { calls: rows.length, usd: Math.round(usd * 100) / 100 };
}


function roundUsd(value) {
  return Math.round(Number(value || 0) * 1e9) / 1e9;
}

function estimateVoiceCostUsd({
  model = PAID_VOICE_MODEL,
  promptTokens = 0,
  completionTokens = 0,
} = {}) {
  if (String(model) !== PAID_VOICE_MODEL) return null;
  const input = Number(promptTokens);
  const output = Number(completionTokens);
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return null;
  return roundUsd(
    (input * PAID_VOICE_INPUT_USD_PER_MILLION + output * PAID_VOICE_OUTPUT_USD_PER_MILLION) / 1e6,
  );
}

function maximumVoiceRequestCostUsd({
  model = PAID_VOICE_MODEL,
  promptBytes = 0,
  maxCompletionTokens = MAX_COMPLETION_TOKENS,
} = {}) {
  const bytes = Number(promptBytes);
  const output = Number(maxCompletionTokens);
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_PROMPT_BYTES) return null;
  // One UTF-8 byte per token is deliberately more conservative than normal
  // text tokenization, so this caps cost even for adversarial caller content.
  return estimateVoiceCostUsd({ model, promptTokens: bytes, completionTokens: output });
}

function settleVoicePaidCall({ reservationId, model, usage = {}, nowIso, ...opts } = {}) {
  const id = String(reservationId || '').trim();
  // A missing usage block is not zero billable usage. Keep its reservation in
  // the rolling cap rather than writing a deceptively settled $0 record.
  if (!Number.isFinite(Number(usage?.prompt_tokens)) || !Number.isFinite(Number(usage?.completion_tokens))) {
    return { settled: false, reason: 'missing-or-unknown-usage' };
  }
  const actualUsd = estimateVoiceCostUsd({
    model,
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
  });
  if (!id || actualUsd == null) return { settled: false, reason: 'missing-or-unknown-usage' };
  return withReservationLock(opts, () => {
    const file = ledgerPath(opts);
    const at = nowIso || new Date().toISOString();
    const row = {
      schema: SCHEMA,
      kind: 'settlement',
      reservationId: id,
      at,
      model: PAID_VOICE_MODEL,
      actualUsd,
      promptTokens: Number(usage?.prompt_tokens) || 0,
      completionTokens: Number(usage?.completion_tokens) || 0,
    };
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(row)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { settled: true, actualUsd, at };
  }, {settled:false,reason:'reservation-in-progress'});
}

// codexExhausted must be a proven observation from the caller, not a guess.
// Passing anything other than boolean true leaves the lane disarmed.
function voicePaidFallbackAllowed({
  codexExhausted,
  paidPrimary = false,
  scope = 'voice-call',
  nowIso,
  ...opts
} = {}) {
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  const deny = (reason) => ({ allowed: false, reason, schema: SCHEMA });
  if (!ALLOWED_SCOPES.includes(scope)) return deny('scope-not-voice');
  // The authenticated primary selector supplies paidPrimary. The original
  // Codex-exhaustion fallback remains intact for the desktop proxy.
  if (codexExhausted !== true && paidPrimary !== true) return deny('codex-not-exhausted');
  if (!Number.isFinite(nowMs)) return deny('invalid-clock');
  const usage = windowUsage(opts, nowMs);
  if (usage.calls >= MAX_CALLS) return deny('call-cap-reached');
  if (usage.usd + RESERVATION_USD > MAX_CAP_USD) return deny('spend-cap-reached');
  return {
    allowed: true,
    reason: paidPrimary === true ? 'paid-voice-primary' : 'codex-exhausted-voice-only',
    schema: SCHEMA,
    remainingCalls: MAX_CALLS - usage.calls,
    remainingUsd: Math.round((MAX_CAP_USD - usage.usd) * 100) / 100,
  };
}

function reserveVoicePaidCall({
  codexExhausted,
  paidPrimary = false,
  scope = 'voice-call',
  callId,
  nowIso,
  ...opts
} = {}) {
  // An exclusive sidecar lock makes the re-check and append one critical
  // section across EC2 workers. A busy ledger fails closed rather than letting
  // two callers both observe the same remaining budget.
  return withReservationLock(opts, () => {
    const verdict = voicePaidFallbackAllowed({
      codexExhausted,
      paidPrimary,
      scope,
      nowIso,
      ...opts,
    });
    if (!verdict.allowed) return verdict;
    const at = nowIso || new Date().toISOString();
    const file = ledgerPath(opts);
    const row = {
      schema: SCHEMA,
      kind: 'reservation',
      reservationId: crypto.randomUUID(),
      at,
      scope,
      callId: String(callId || ''),
      reservedUsd: RESERVATION_USD,
      authorization: 'auth-voice-paid-fallback',
      mode: paidPrimary === true ? 'primary' : 'fallback',
    };
    // Append and fsync before the caller is told it may spend. An unflushed
    // reservation is the same failure as no reservation.
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(row)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return {
      ...verdict,
      reserved: true,
      reservationId: row.reservationId,
      reservedUsd: RESERVATION_USD,
      at,
    };
  }, {allowed:false,reason:'reservation-in-progress',schema:SCHEMA});
}

module.exports = {
  SCHEMA,
  MAX_CAP_USD,
  MAX_CALLS,
  MAX_COMPLETION_TOKENS,
  MAX_PROMPT_BYTES,
  PAID_VOICE_INPUT_USD_PER_MILLION,
  PAID_VOICE_MODEL,
  PAID_VOICE_OUTPUT_USD_PER_MILLION,
  RESERVATION_USD,
  WINDOW_MS,
  defaultDataDir,
  estimateVoiceCostUsd,
  maximumVoiceRequestCostUsd,
  ledgerPath,
  reservationLockPath,
  reserveVoicePaidCall,
  settleVoicePaidCall,
  voicePaidFallbackAllowed,
  windowUsage,
};
