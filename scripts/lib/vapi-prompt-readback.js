'use strict';

// Voice provider assistant prompt read-back (2026-10-14 voice redesign, Phase 4).
// A deploy that changes the voice prompt builder must also push the saved
// assistant, and the push must prove voice provider stored what was sent. The cached
// assistant on EC2 is judged stale by content, not by a length heuristic.

const { FORBIDDEN_VOICE_PROMPT_RE } = require('./voice-brief');

// A line only the server-served news design carries. Its absence means the
// saved assistant predates the redesign.
const SERVER_NEWS_PROMPT_MARKER = 'The server reads news articles and handles news commands itself';

function storedSystemPrompt(assistant) {
  const messages = (assistant && assistant.model && assistant.model.messages) || [];
  const system = messages.find((m) => m && m.role === 'system');
  return String((system && system.content) || '');
}

function normalizePrompt(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

// Compare what was PATCHed with what voice provider returns on GET.
function verifyStoredPrompt(assistant, expectedPrompt) {
  const stored = normalizePrompt(storedSystemPrompt(assistant));
  const expected = normalizePrompt(expectedPrompt);
  if (!stored) return { ok: false, reason: 'Voice provider returned no system prompt.' };
  if (stored !== expected) {
    let at = 0;
    while (at < stored.length && stored[at] === expected[at]) at += 1;
    return {
      ok: false,
      reason: `Stored prompt differs from the pushed prompt at char ${at} (stored ${stored.length}, pushed ${expected.length}).`,
    };
  }
  return { ok: true, reason: '' };
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Compare the pushed turn-taking plans with what voice provider stored. Every pushed key
// must round-trip unchanged, and the stored start plan may not carry endpoint
// rules the push did not send (Voice provider refused one rule type and an
// assistant-request carrying rules never started the owner leg, Oct 14-18).
function verifyStoredSpeakingPlans(assistant, pushed) {
  const reasons = [];
  for (const planKey of ['startSpeakingPlan', 'stopSpeakingPlan']) {
    const sent = pushed && pushed[planKey];
    if (!sent) continue;
    const stored = (assistant && assistant[planKey]) || null;
    if (!stored) {
      reasons.push(`Voice provider returned no ${planKey}.`);
      continue;
    }
    for (const [key, value] of Object.entries(sent)) {
      if (!sameValue(stored[key], value)) reasons.push(`${planKey}.${key} stored ${JSON.stringify(stored[key])}, pushed ${JSON.stringify(value)}.`);
    }
    if (planKey === 'startSpeakingPlan' && !('customEndpointingRules' in sent)) {
      const rules = stored.customEndpointingRules;
      if (Array.isArray(rules) ? rules.length > 0 : rules != null) {
        reasons.push('startSpeakingPlan carries customEndpointingRules the push did not send.');
      }
    }
  }
  return { ok: reasons.length === 0, reason: reasons.join(' ') };
}

// Staleness by content: missing the server-news design or carrying an agent
// trailer means the saved assistant must be pushed again.
function staleAssistantPromptReasons(prompt) {
  const text = String(prompt || '');
  const reasons = [];
  if (!text.includes(SERVER_NEWS_PROMPT_MARKER)) reasons.push('missing server-served news rules');
  if (FORBIDDEN_VOICE_PROMPT_RE.test(text)) reasons.push('carries an agent trailer (TLDR, Graphiti impact, or adversarial review)');
  if (/Receive inbound calls naturally|thanks for calling back|\[object Object\]/i.test(text)) {
    reasons.push('carries a retired greeting');
  }
  return reasons;
}

module.exports = {
  SERVER_NEWS_PROMPT_MARKER,
  storedSystemPrompt,
  verifyStoredPrompt,
  verifyStoredSpeakingPlans,
  staleAssistantPromptReasons,
};
