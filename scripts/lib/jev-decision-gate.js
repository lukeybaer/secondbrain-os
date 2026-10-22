'use strict';

// Shared Jev decision boundary. Exact facts and authority remain in code.
// Jev only evaluates compact semantic state and returns typed probabilities.

const { jevSystemOne, estimateTokens, JEV_MODEL } = require('./jev-client.js');
const { admitJevSpend, recordJevSpend } = require('./jev-budget.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIDENCE = 0.9;

function choiceProbability(answer, choice) {
  if (!answer || answer.type !== 'choice') return 0;
  return Number(answer.probabilities?.[choice] || 0);
}

function reverseChoiceCriteria(question) {
  if (!question || question.type !== 'choice' || !question.criteria) return question;
  return { ...question, criteria: Object.fromEntries(Object.entries(question.criteria).reverse()) };
}

function reversedQuestions(questions) {
  return Object.fromEntries(
    Object.entries(questions || {}).map(([key, question]) => [key, reverseChoiceCriteria(question)]),
  );
}

function recordJevDecision({ kind = 'ensemble', surface, state, choice, agreement, minProbability, threshold, accepted, now = new Date() }) {
  const dataDir = process.env.SECONDBRAIN_DATA_DIR || (process.platform === 'win32'
    ? path.resolve(__dirname, '..', '..', 'data')
    : '/opt/secondbrain/data');
  const file = path.join(dataDir, 'agent', 'jev-decisions.jsonl');
  const row = {
    ts: now.toISOString(), kind, surface, choice, agreement, minProbability, threshold, accepted,
    stateSha256: crypto.createHash('sha256').update(JSON.stringify(state || {})).digest('hex'),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
  return row;
}

async function oneDecision({ state, questions, surface, lane = 'decision-control', deps = {} }) {
  const testOverrides = process.env.VITEST === 'true';
  const system = testOverrides && deps.jevSystemOne ? deps.jevSystemOne : jevSystemOne;
  const admit = testOverrides && deps.admitJevSpend ? deps.admitJevSpend : admitJevSpend;
  const record = testOverrides && deps.recordJevSpend ? deps.recordJevSpend : recordJevSpend;
  // Backend rollout is enforced by the typed control-plane facade, not this
  // shared primitive. Existing Jev consumers such as news keep their own
  // independent rollout contract and must not be disabled by this switch.
  const estimatedTokens = estimateTokens({ state, questions });
  const admission = admit({ estimatedTokens, lane, surface });
  if (!admission.ok) {
    const error = new Error(`Jev decision refused: ${admission.reason}`);
    error.code = 'budget';
    throw error;
  }
  try {
    const result = await system({ state, questions, signal: deps.signal, timeoutMs: deps.timeoutMs, retries: deps.retries });
    record({
      surface,
      inputTokens: Number(result.usage?.input_tokens || estimatedTokens),
      latencyMs: result.latencyMs,
      outcome: 'answered',
      model: JEV_MODEL,
    });
    const decisionRecorder = testOverrides && deps.recordJevDecision === false
      ? null
      : (testOverrides && deps.recordJevDecision ? deps.recordJevDecision : recordJevDecision);
    try {
      if (decisionRecorder) {
        const answerSummary = Object.fromEntries(Object.entries(result.answers || {}).map(([key, answer]) => [
          key,
          answer?.type === 'score' ? Number(answer.score) : String(answer?.choice || ''),
        ]));
        decisionRecorder({ kind: 'provider_pass', surface, state, choice: JSON.stringify(answerSummary), agreement: null, minProbability: null, threshold: null, accepted: null });
      }
    } catch {
      // Spend remains recorded even if the provenance ledger is unavailable.
    }
    return result;
  } catch (error) {
    record({
      surface,
      inputTokens: 0,
      latencyMs: null,
      outcome: `failed:${error.code || 'jev_error'}`,
      model: JEV_MODEL,
      error,
    });
    throw error;
  }
}

// Important decisions run twice with reversed Choice option order. Agreement
// is required; probability concentration alone is not treated as correctness.
async function orderEnsemble({
  state,
  questions,
  decisionKey,
  confidence = DEFAULT_CONFIDENCE,
  surface = 'jev-decision-gate',
  lane = 'decision-control',
  deps = {},
}) {
  const first = await oneDecision({ state, questions, surface, lane, deps });
  const second = await oneDecision({
    state,
    questions: reversedQuestions(questions),
    surface: `${surface}:reversed`,
    lane,
    deps,
  });
  const a = first.answers?.[decisionKey];
  const b = second.answers?.[decisionKey];
  const choice = a?.choice || '';
  const agreement = Boolean(choice && choice === b?.choice);
  const minProbability = agreement
    ? Math.min(choiceProbability(a, choice), choiceProbability(b, choice))
    : 0;
  const outcome = {
    accepted: agreement && minProbability >= confidence,
    choice,
    agreement,
    minProbability,
    threshold: confidence,
    first,
    second,
  };
  const recorder = process.env.VITEST === 'true' && deps.recordJevDecision === false
    ? null
    : (process.env.VITEST === 'true' && deps.recordJevDecision ? deps.recordJevDecision : recordJevDecision);
  try {
    if (recorder) recorder({ kind: 'ensemble', surface, state, choice, agreement, minProbability, threshold: confidence, accepted: outcome.accepted });
  } catch (error) {
    if (String(surface || '').startsWith('external-outreach-approval')) {
      error.code = error.code || 'decision_receipt_failed';
      throw error;
    }
    // A receipt write defect is observable through the spend ledger but must
    // not turn an already-paid semantic answer into a different decision.
  }
  return outcome;
}

module.exports = {
  DEFAULT_CONFIDENCE,
  choiceProbability,
  reverseChoiceCriteria,
  reversedQuestions,
  oneDecision,
  orderEnsemble,
  recordJevDecision,
};
