'use strict';

// Life of a draft-specific send approval ("yes, send it"), one place for the
// session store (which writes the ledger) and the policy gate (which spends
// it). State machine audit finding #4 (Owner decision,
// https://claude.ai/artifact/8wKEsESFcNyAEzGz1CJEFC): a yes had no expiry, no
// consumed state and no content hash, so one yes could authorize a later send
// of the same draft id after its text changed.
//
//   open -> yes | no | expired        the owner has SEND_DECISION_TTL_MS to answer
//   yes  -> consumed | expired        a yes can be spent once, within the TTL
//
// The state is derived from facts in the ledger (asked_at, answer,
// resolved_at, consumed_at) and the clock, never stored as free text, so an
// expiry needs no writer to notice it.

const crypto = require('node:crypto');
const { defineStateMachine } = require('./ledger-state-machine');
const { BARE_REPLY_WINDOW_MS, DEFAULT_TTL_MS, answerFromLiteral } = require('./owner-approval-states');

const SEND_DECISION_KIND = 'external_send_authorized';

// Same 15 minutes owner-approval-store gives a pending owner approval
// (DEFAULT_TTL_MS). One chat yes is spoken in the same breath as the ask
// and spent in the same turn, so a quarter hour covers a slow model turn and a
// busy phone without leaving a yes lying around for the next draft.
const SEND_DECISION_TTL_MS = DEFAULT_TTL_MS;

// BARE_REPLY_WINDOW_MS (30 minutes) lives with the owner-approval vocabulary so
// a bare PII YES and a bare send YES share one rule.

const DECISION_MACHINE = defineStateMachine({
  name: 'send-decision',
  transitions: {
    '': ['open'],
    open: ['yes', 'no', 'expired'],
    yes: ['consumed', 'expired'],
  },
  terminal: ['no', 'consumed', 'expired'],
  inFlight: {
    open: { ttlMs: SEND_DECISION_TTL_MS },
    yes: { ttlMs: SEND_DECISION_TTL_MS },
  },
});

// Every send content hash carries this tag. A hash without it was taken under
// the older binding (attachments by name, type and size only), so it cannot
// prove which bytes the owner approved and the yes needs asking again.
const SEND_CONTENT_HASH_VERSION = 'mime-v2';

/**
 * Hash exactly what a send would put in front of the recipient: the complete
 * RFC 2822 message (every header and recipient, subject, both body parts and
 * every attachment byte) plus the thread it joins. `raw` is the message as
 * Gmail returns it (base64url) or its bytes.
 */
function hashSendContent({ raw = '', threadId = '' } = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'base64url');
  if (!bytes.length) throw new Error('hashSendContent needs the complete raw message');
  const digest = crypto
    .createHash('sha256')
    .update(`${SEND_CONTENT_HASH_VERSION}\nthread:${String(threadId || '')}\n`)
    .update(bytes)
    .digest('hex');
  return `${SEND_CONTENT_HASH_VERSION}:${digest}`;
}

/**
 * Where a decision stands now. Only send decisions expire: no other kind can
 * authorize anything, and an unrelated question may be answered late.
 * `decision` carries asked_at, answer, resolved_at and consumed_at.
 */
function decisionState(decision, nowMs = Date.now()) {
  if (!decision) return '';
  if (decision.consumed_at) return 'consumed';
  const expires = decision.kind === SEND_DECISION_KIND;
  if (decision.answer) {
    // Any answer other than yes is not an authorization.
    if (!isYes(decision.answer)) return 'no';
    if (expires && DECISION_MACHINE.isExpired('yes', decision.resolved_at, nowMs)) return 'expired';
    return 'yes';
  }
  if (expires && DECISION_MACHINE.isExpired('open', decision.asked_at, nowMs)) return 'expired';
  return 'open';
}

// A session stores the spoken word. Only the exact word "yes" is an approval;
// the shared vocabulary reads it as approved, and every other word as not.
function isYes(answer) {
  return answerFromLiteral(answer) === 'approved';
}

function deny(reason) {
  return { ok: false, reason };
}

/**
 * May this resolved decision authorize sending this draft right now?
 * Shared by the policy gate (looks) and the store's consume (spends), so the
 * two can never disagree. `consuming` refuses the replay allowance.
 */
function evaluateSendDecision(
  decision,
  { draftId, contentHash, nowMs = Date.now(), invocationKey = null, consuming = false } = {},
) {
  if (
    !decision ||
    !draftId ||
    decision.kind !== SEND_DECISION_KIND ||
    decision.subject_ref !== draftId ||
    !isYes(decision.answer)
  ) {
    return deny('draft_specific_send_authorization_required');
  }
  const state = decisionState(decision, nowMs);
  if (state === 'consumed') {
    // The very invocation that spent this yes may be replayed (the broker then
    // returns its recorded result); any other caller may not.
    if (!consuming && invocationKey && decision.consumed_invocation_key === invocationKey) {
      return { ok: true, state, replay: true };
    }
    return deny('send_authorization_consumed');
  }
  if (state === 'expired') return deny('send_authorization_expired');
  if (state !== 'yes') return deny('draft_specific_send_authorization_required');
  // A yes recorded before content hashes existed cannot prove what it approved.
  if (!decision.content_hash) return deny('send_authorization_unbound');
  // Nor can a yes bound under the older name/type/size attachment hash.
  if (!String(decision.content_hash).startsWith(`${SEND_CONTENT_HASH_VERSION}:`)) {
    return deny('send_authorization_unbound');
  }
  if (!contentHash || contentHash !== decision.content_hash) return deny('send_content_changed');
  return { ok: true, state };
}

module.exports = {
  BARE_REPLY_WINDOW_MS,
  DECISION_MACHINE,
  SEND_CONTENT_HASH_VERSION,
  SEND_DECISION_KIND,
  SEND_DECISION_TTL_MS,
  decisionState,
  evaluateSendDecision,
  hashSendContent,
};
