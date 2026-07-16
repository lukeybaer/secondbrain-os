'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const PROOF_MAX_AGE_MS = 15 * 60 * 1000;
const HEALTHY_REFRESH_MS = 5 * 60 * 1000;
const INCONCLUSIVE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

function defaultClaudeHealthStatePath() {
  if (process.env.CLAUDE_HEALTH_STATE_PATH) return process.env.CLAUDE_HEALTH_STATE_PATH;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'secondbrain', 'data', 'agent', 'claude-max-health.json');
}

function readClaudeHealthState(file = defaultClaudeHealthStatePath()) {
  try {
    const row = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return row && row.schemaVersion === SCHEMA_VERSION && row.provider === 'claude-max'
      ? row
      : null;
  } catch {
    return null;
  }
}

function writeClaudeHealthState(file = defaultClaudeHealthStatePath(), state) {
  if (!state || typeof state !== 'object') throw new Error('Claude health state is required');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function classifyCanaryFailureOutput(text) {
  const raw = String(text || '');
  if (/invalid_ExampleCo/i.test(raw)) {
    return { verdict: 'owner_action_required', code: 'invalid_ExampleCo' };
  }
  if (
    /not logged in|please run\s+\/?login|access token expired|oauth[^\n]*(?:expired|invalid|rejected)|authentication failed|unauthorized/i.test(
      raw,
    )
  ) {
    return { verdict: 'owner_action_required', code: 'auth_failure' };
  }
  if (/model[^\n]*(?:not found|does not exist|unsupported)|not_found_error/i.test(raw)) {
    return { verdict: 'inconclusive', code: 'provider_configuration' };
  }
  return { verdict: 'inconclusive', code: 'provider_failure' };
}

function nextHealthState(previous, event, { nowMs = Date.now() } = {}) {
  const prior = previous && typeof previous === 'object' ? previous : {};
  const verdict = ['ok', 'owner_action_required', 'inconclusive'].includes(event?.verdict)
    ? event.verdict
    : 'inconclusive';
  const fingerprint = String(event?.credentialFingerprint || '');
  const sameCredential = fingerprint && fingerprint === prior.credentialFingerprint;
  const priorInconclusive = sameCredential ? Number(prior.consecutiveInconclusive || 0) : 0;
  const consecutiveInconclusive = verdict === 'inconclusive' ? priorInconclusive + 1 : 0;
  const backoffMs = Math.min(
    MAX_BACKOFF_MS,
    INCONCLUSIVE_BACKOFF_MS * 2 ** Math.max(0, consecutiveInconclusive - 1),
  );
  const nowIso = new Date(nowMs).toISOString();
  const success = verdict === 'ok';
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: 'claude-max',
    state: success ? 'healthy' : verdict,
    code: String(event?.code || (success ? 'live_proof' : verdict)),
    detail: String(event?.detail || ''),
    credentialFingerprint: fingerprint,
    updatedAt: nowIso,
    lastAttemptAt: nowIso,
    lastSuccessAt: success ? nowIso : sameCredential ? prior.lastSuccessAt || null : null,
    lastSuccessSource: success
      ? String(event?.source || 'live-canary')
      : sameCredential
        ? prior.lastSuccessSource || null
        : null,
    consecutiveInconclusive,
    nextProbeAt:
      verdict === 'owner_action_required'
        ? null
        : new Date(nowMs + (success ? HEALTHY_REFRESH_MS : backoffMs)).toISOString(),
  };
}

function classifyClaudeHealth({
  state,
  tokenAuth,
  nowMs = Date.now(),
  proofMaxAgeMs = PROOF_MAX_AGE_MS,
} = {}) {
  const token = tokenAuth || { ok: false, fingerprint: '', reason: 'token status unavailable' };
  if (!token.ok) {
    return {
      ok: false,
      state: 'owner_action_required',
      code: 'token_unavailable',
      reason: token.reason || 'Claude credentials are unavailable.',
      ownerAction: 'Run claude /login, then refresh the Claude token.',
      proofAt: null,
      proofSource: null,
    };
  }

  const row = state && typeof state === 'object' ? state : null;
  const sameCredential = row && String(row.credentialFingerprint || '') === String(token.fingerprint || '');
  if (row?.state === 'owner_action_required' && sameCredential) {
    return {
      ok: false,
      state: 'owner_action_required',
      code: row.code || 'auth_failure',
      reason: row.detail || 'Claude rejected the current credentials.',
      ownerAction: 'Run claude /login, then refresh the Claude token.',
      proofAt: row.lastSuccessAt || null,
      proofSource: row.lastSuccessSource || null,
    };
  }

  const proofMs = sameCredential ? Date.parse(row?.lastSuccessAt || '') : NaN;
  const proofAgeMs = Number.isFinite(proofMs) ? Math.max(0, nowMs - proofMs) : Infinity;
  if (proofAgeMs <= proofMaxAgeMs) {
    return {
      ok: true,
      state: 'healthy',
      code: 'live_proof',
      reason: `Recent ${row.lastSuccessSource || 'live'} proof succeeded.`,
      ownerAction: null,
      proofAt: row.lastSuccessAt,
      proofSource: row.lastSuccessSource || 'live-canary',
      proofAgeMs,
    };
  }

  if (row?.state === 'inconclusive' && sameCredential) {
    return {
      ok: false,
      state: 'inconclusive',
      code: row.code || 'inconclusive',
      reason: row.detail || 'The live canary was inconclusive.',
      ownerAction: null,
      proofAt: row.lastSuccessAt || null,
      proofSource: row.lastSuccessSource || null,
      proofAgeMs,
    };
  }
  if (Number.isFinite(proofMs)) {
    return {
      ok: false,
      state: 'stale',
      code: 'proof_stale',
      reason: `Last live proof is ${Math.round(proofAgeMs / 1000)} seconds old.`,
      ownerAction: null,
      proofAt: row.lastSuccessAt,
      proofSource: row.lastSuccessSource || null,
      proofAgeMs,
    };
  }
  return {
    ok: false,
    state: 'ExampleCo',
    code: 'live_proof_missing',
    reason: 'Claude token is present but no recent live canary or stream proof exists.',
    ownerAction: null,
    proofAt: null,
    proofSource: null,
  };
}

function shouldRunCanary({ state, tokenAuth, nowMs = Date.now() } = {}) {
  if (!tokenAuth?.ok) return false;
  const row = state && typeof state === 'object' ? state : null;
  const sameCredential = row &&
    String(row.credentialFingerprint || '') === String(tokenAuth.fingerprint || '');
  if (row?.state === 'owner_action_required' && sameCredential) return false;
  if (!sameCredential) return true;
  const nextProbeMs = Date.parse(row.nextProbeAt || '');
  return !Number.isFinite(nextProbeMs) || nowMs >= nextProbeMs;
}

module.exports = {
  HEALTHY_REFRESH_MS,
  INCONCLUSIVE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  PROOF_MAX_AGE_MS,
  SCHEMA_VERSION,
  classifyCanaryFailureOutput,
  classifyClaudeHealth,
  defaultClaudeHealthStatePath,
  nextHealthState,
  readClaudeHealthState,
  shouldRunCanary,
  writeClaudeHealthState,
};
