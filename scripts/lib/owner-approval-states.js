'use strict';

// One vocabulary for owner approvals (state machine audit finding #20, the owner,
// 2026-11-03, https://claude.ai/artifact/8wKEsESFcNyAEzGz1CJEFC). Before this
// file the owner-approval store said `denied`, the approval inbox and ledger
// said `rejected`, and chat sessions stored `yes`/`no`, so a reader of one
// spelling silently misread another (a `denied` row counted as NaN in the
// inbox, was ignored by the ledger, and a bare YES could resolve any prompted
// approval however old).
//
// This module is a leaf (no project imports) so the store, the client, the
// resume path, the session decision gate, the ledger and the desktop inbox can
// all import it without a cycle.
//
//   approval:  pending -> approved | denied | expired
//   resume:    queued -> claimed -> delivered
//              queued | claimed -> expired | cancelled   (nobody is left to receive it)
//
// Aliases map spellings already on disk onto the canonical word. An unknown
// spelling stays as-is, so it is never pending and never approved.

const { defineStateMachine } = require('./ledger-state-machine');

// A pending approval lives this long unless the caller asks for less.
const DEFAULT_TTL_MS = 15 * 60 * 1000;

// A bare "YES" names no prompt, so only a recently asked question can be what
// it answers. Same window as the chat session decisions
// (scripts/lib/decision-state.js, batch 1). A reply that quotes the prompt, or
// names the approval id, is anchored and does not need this window.
const BARE_REPLY_WINDOW_MS = 30 * 60 * 1000;

// A resolved approval waits to be handed back to the surface that asked. A live
// call is dead 30 minutes after its last event (ACTIVE_CALL_TTL_MS in
// ec2-server.js), so a call resume still queued after that has no one to
// receive it. Other surfaces consume their own resume, so they get a day.
const CALL_RESUME_TTL_MS = 30 * 60 * 1000;
const RESUME_QUEUED_TTL_MS = 24 * 60 * 60 * 1000;

const CALL_SURFACES = Object.freeze(['vapi', 'voice']);

const APPROVAL_MACHINE = defineStateMachine({
  name: 'owner-approval',
  transitions: {
    '': ['pending'],
    pending: ['approved', 'denied', 'expired'],
  },
  terminal: ['approved', 'denied', 'expired'],
  aliases: {
    rejected: 'denied',
    timed_out: 'expired',
  },
});

const RESUME_MACHINE = defineStateMachine({
  name: 'owner-approval-resume',
  transitions: {
    '': ['none'],
    none: ['queued'],
    queued: ['claimed', 'expired', 'cancelled'],
    claimed: ['delivered', 'queued', 'expired', 'cancelled'],
  },
  terminal: ['delivered', 'expired', 'cancelled'],
  inFlight: {
    queued: { ttlMs: RESUME_QUEUED_TTL_MS },
  },
});

// The only words that turn an utterance into an answer. Exact, whole-message,
// case-insensitive: "yes please", "sure" and "ok" are not answers. Session
// stores keep the spoken word, so this table is how a session `yes` is read.
const LITERAL_ANSWERS = Object.freeze({ yes: 'approved', no: 'denied' });

function answerFromLiteral(word) {
  const key = String(word ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LITERAL_ANSWERS, key) ? LITERAL_ANSWERS[key] : null;
}

// Canonical spelling of a stored decision or status field. Only aliases are
// applied: `yes` is never read from a status field, and an unknown word stays
// unknown.
function normalizeDecision(value) {
  return APPROVAL_MACHINE.normalize(value);
}

// What a stored decision from any source says: a session `yes`, a store
// `denied`, an inbox `rejected`. Unknown stays as typed and is never a go.
function decisionOf(value) {
  return answerFromLiteral(value) || normalizeDecision(value);
}

function isApproved(value) {
  return decisionOf(value) === 'approved';
}

function isDenied(value) {
  return decisionOf(value) === 'denied';
}

function isPending(value) {
  return normalizeDecision(value) === 'pending';
}

// approved or denied: someone answered.
function isAnswered(value) {
  const decision = decisionOf(value);
  return decision === 'approved' || decision === 'denied';
}

function isCallSurface(surface) {
  return CALL_SURFACES.includes(String(surface || '').toLowerCase());
}

// A queued resume is dead once its TTL passes, counted from when it was queued
// (a failed delivery retry does not restart the clock).
function resumeExpired(origin, queuedAt, nowMs = Date.now()) {
  if (RESUME_MACHINE.isExpired('queued', queuedAt, nowMs)) return true;
  if (!isCallSurface(origin?.surface)) return false;
  const t = Date.parse(queuedAt || '');
  return !Number.isFinite(t) || nowMs - t > CALL_RESUME_TTL_MS;
}

// Request types that have somewhere to be asked. Chat may carry only the
// daily briefing plus security, PII and reputation alerts, so a PII approval
// is the one approval it prompts. `operator_relay` means no prompt is sent:
// the attended operator who opened it shows the owner the id and he answers
// `YES <id>` (the catch-up briefing, which an SSH session cannot authorize
// alone). Any other type would open a row nobody is ever asked about.
const PROMPT_CHANNELS = Object.freeze({
  share_pii: 'telegram_pii_prompt',
  briefing_catch_up: 'operator_relay',
});

class NoPromptChannelError extends Error {
  constructor(requestType) {
    super(
      `owner approval refused: request type "${requestType}" has no prompt channel, so nobody ` +
        'would ever be asked. Chat prompts only PII approvals (share_pii). No approval ' +
        'was opened; the action stays held. Do not proceed.',
    );
    this.name = 'NoPromptChannelError';
    this.code = 'OWNER_APPROVAL_NO_PROMPT_CHANNEL';
    this.request_type = requestType;
  }
}

function promptChannelFor(requestType) {
  const key = String(requestType ?? '').trim();
  return Object.prototype.hasOwnProperty.call(PROMPT_CHANNELS, key) ? PROMPT_CHANNELS[key] : null;
}

function assertPromptChannel(requestType) {
  const channel = promptChannelFor(requestType);
  if (!channel) throw new NoPromptChannelError(String(requestType ?? '').trim());
  return channel;
}

module.exports = {
  APPROVAL_MACHINE,
  BARE_REPLY_WINDOW_MS,
  CALL_RESUME_TTL_MS,
  DEFAULT_TTL_MS,
  LITERAL_ANSWERS,
  NoPromptChannelError,
  PROMPT_CHANNELS,
  RESUME_MACHINE,
  RESUME_QUEUED_TTL_MS,
  answerFromLiteral,
  assertPromptChannel,
  decisionOf,
  isAnswered,
  isApproved,
  isCallSurface,
  isDenied,
  isPending,
  normalizeDecision,
  promptChannelFor,
  resumeExpired,
};
