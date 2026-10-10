'use strict';

// The Vapi custom-LLM endpoint has one registered paid voice model alias. The
// selection is deliberately separate from provider credentials: callers still
// have to pass the authenticated EC2 boundary and reserve the existing voice
// budget before the alias can reach OpenAI.
const { VAPI_SUBSCRIPTION_VOICE_MODEL, VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL } = require('./vapi-call-correlation');
const fs = require('node:fs');
const path = require('node:path');

const VAPI_PAID_VOICE_MODEL = 'amy-openai-api-voice';
const VAPI_PAID_VOICE_PREFLIGHT_MODEL = 'amy-openai-api-voice-preflight';
const PAID_PRIMARY_MODE = 'paid-openai';

function defaultPolicyPath() {
  return path.resolve(__dirname, '..', '..', 'config', 'voice-runtime-policy.json');
}

function readVoiceRuntimePolicy({ policyPath = defaultPolicyPath() } = {}) {
  try {
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    return policy?.primary === PAID_PRIMARY_MODE ? PAID_PRIMARY_MODE : 'subscription';
  } catch {
    return 'subscription';
  }
}

function resolveVoicePrimary({ env = process.env, mode, policyPath, policy } = {}) {
  // A literal subscription override is the only environment control. It gives
  // every surface the same immediate rollback without turning an ambient paid
  // flag into a new authorization path.
  const requested = String(
    mode == null
      ? String(env.AMY_VOICE_PRIMARY || '').trim() && String(env.AMY_VOICE_PRIMARY).trim().toLowerCase() !== PAID_PRIMARY_MODE
        ? 'subscription'
        : (policy ? policy.primary === PAID_PRIMARY_MODE ? PAID_PRIMARY_MODE : 'subscription' : readVoiceRuntimePolicy({ policyPath }))
      : mode,
  ).trim().toLowerCase();
  if (requested === PAID_PRIMARY_MODE) {
    return Object.freeze({
      mode: PAID_PRIMARY_MODE,
      model: VAPI_PAID_VOICE_MODEL,
      preflightModel: VAPI_PAID_VOICE_PREFLIGHT_MODEL,
      paid: true,
    });
  }
  return Object.freeze({
    mode: 'subscription',
    model: VAPI_SUBSCRIPTION_VOICE_MODEL,
    preflightModel: VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL,
    paid: false,
  });
}

function isPaidVoicePrimary({ env = process.env, mode } = {}) {
  return resolveVoicePrimary({ env, mode }).paid;
}

function isPaidVoiceModel(model) {
  return [VAPI_PAID_VOICE_MODEL,VAPI_PAID_VOICE_PREFLIGHT_MODEL].includes(String(model || '').trim());
}

module.exports = {
  PAID_PRIMARY_MODE,
  VAPI_PAID_VOICE_MODEL,
  VAPI_PAID_VOICE_PREFLIGHT_MODEL,
  isPaidVoiceModel,
  isPaidVoicePrimary,
  readVoiceRuntimePolicy,
  resolveVoicePrimary,
};
