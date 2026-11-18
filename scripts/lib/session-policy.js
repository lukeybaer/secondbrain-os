'use strict';

const { evaluateSendDecision } = require('./decision-state');

// The start of a tool's error when a never-list rule refused it. The chat
// checker accepts a never-list stop on this, and on no other refusal.
const NEVER_LIST_REFUSAL = 'never_list:';

function textContainsExactSpan(text, span) {
  const source = String(text || '');
  const exact = String(span || '').trim();
  return Boolean(exact) && source.toLowerCase().includes(exact.toLowerCase());
}

// A text goes out only when the owner's whole message is one affirmative send
// command, read here from the owner's own words and never from spans a model
// supplies. The message may open with a greeting or "please", then must be
// "text <recipient>" (or "send a text to <recipient>") followed by the body in
// quotes, or after a colon or "saying" on the same line. Anything else in the
// message (a negation, a question, a condition, a second instruction, quoted
// content under another verb) means it is not a send command, so no text goes
// out: the owner can always resend the bare command.
const QUO_SEND_PREFIX = String.raw`^\s*(?:(?:#amy|hashtag amy|hey amy|hi amy|amy|ok|okay|yes|yep|please|go ahead and)\b[\s,:;!.-]*)*`;
const QUO_SEND_VERB = String.raw`(?:text|sms|send (?:this |a |an )?(?:quo )?(?:text message|text|sms|message) to)`;
const QUO_SEND_RECIPIENT = String.raw`(\+[1-9]\d{7,14}|[a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,3}?)`;
const QUO_SEND_QUOTED = new RegExp(`${QUO_SEND_PREFIX}${QUO_SEND_VERB}\\s+${QUO_SEND_RECIPIENT}\\s*(?:,|:|\\s+saying|\\s+that says)?\\s*(?:"(.+)"|“(.+)”|'(.+)'|‘(.+)’)\\s*[.!]?\\s*$`, 'i');
const QUO_SEND_PLAIN = new RegExp(`${QUO_SEND_PREFIX}${QUO_SEND_VERB}\\s+${QUO_SEND_RECIPIENT}\\s*(?::|\\s+saying\\s)\\s*([^\\s"'“‘][^\\n]*?)\\s*$`, 'i');

function parseQuoSendDispatch(text) {
  const source = String(text || '');
  if (!source.trim() || source.length > 2000) return null;
  const quoted = source.match(QUO_SEND_QUOTED);
  if (quoted) {
    const [, recipient, straightDouble, curlyDouble, straightSingle, curlySingle] = quoted;
    const body = (straightDouble ?? curlyDouble ?? straightSingle ?? curlySingle ?? '').trim();
    // A second quote mark inside the body (an apostrophe within a word is fine)
    // means the message quotes more than one thing, such as two texts in one
    // line, so it is not read as one send command.
    const stray = straightDouble !== undefined ? /"/
      : curlyDouble !== undefined ? /[“”]/
        : straightSingle !== undefined ? /'\s|\s'/
          : /‘|’\s|\s’/;
    if (body && !/[\r\n]/.test(body) && !stray.test(body)) return { recipient: recipient.trim(), body };
    return null;
  }
  const plain = source.match(QUO_SEND_PLAIN);
  if (plain && plain[2].trim()) return { recipient: plain[1].trim(), body: plain[2].trim() };
  return null;
}

function sameRecipient(left, right) {
  const norm = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return Boolean(norm(left)) && norm(left) === norm(right);
}

// `contentHash`, `invocationKey` and `nowMs` come from the broker, never from the
// caller's arguments or evidence, so a model cannot supply its own proof.
function authorizeInvocation({
  turn,
  descriptor,
  arguments: args = {},
  evidence = {},
  decision,
  contentHash = null,
  invocationKey = null,
  nowMs = Date.now(),
} = {}) {
  if (!turn || turn.actor?.auth_level !== 'owner_verified') {
    return { decision: 'deny', reason: 'owner_verification_required' };
  }
  if (!descriptor?.name || !descriptor?.effect) {
    return { decision: 'deny', reason: 'invalid_capability_descriptor' };
  }
  if (descriptor.effect === 'read') {
    return {
      decision: 'allow',
      basis: 'owner_verified_read',
      evidence_refs: [turn.turn_id],
    };
  }
  if (descriptor.effect === 'internal_write') {
    return {
      decision: 'allow',
      basis: 'owner_verified_internal_write',
      evidence_refs: [turn.turn_id],
    };
  }
  if (descriptor.effect !== 'external_side_effect') {
    return { decision: 'deny', reason: 'unknown_effect_class' };
  }
  if (evidence.turn_id !== turn.turn_id) {
    return { decision: 'deny', reason: 'missing_external_effect_evidence' };
  }

  if (descriptor.authorization_policy === 'new_human_email_send') {
    // A yes authorizes one send of this draft as it was when asked: unexpired,
    // unspent, and the content hash still matches what would go out now.
    const verdict = evaluateSendDecision(decision, {
      draftId: args.draft_id,
      contentHash,
      nowMs,
      invocationKey,
    });
    if (!verdict.ok) return { decision: 'deny', reason: verdict.reason };
    return {
      decision: 'allow',
      basis: verdict.replay
        ? 'draft_specific_external_send_replay'
        : 'draft_specific_external_send_authorized',
      evidence_refs: [turn.turn_id, decision.decision_id],
    };
  }

  if (descriptor.authorization_policy === 'owner_current_turn_call') {
    if (
      !args.recipient ||
      !args.objective ||
      !textContainsExactSpan(turn.text, evidence.recipient_span) ||
      !textContainsExactSpan(turn.text, evidence.objective_span)
    ) {
      return { decision: 'deny', reason: 'missing_external_effect_evidence' };
    }
    return {
      decision: 'allow',
      basis: 'owner_current_turn_call',
      evidence_refs: [turn.turn_id],
    };
  }

  if (descriptor.authorization_policy === 'owner_current_turn_quo_send') {
    const dispatch = parseQuoSendDispatch(turn.text);
    if (
      !dispatch ||
      !sameRecipient(args.recipient, dispatch.recipient) ||
      String(args.body || '').trim() !== dispatch.body
    ) {
      return { decision: 'deny', reason: 'missing_exact_quo_send_evidence' };
    }
    return {
      decision: 'allow',
      basis: 'owner_current_turn_quo_send',
      evidence_refs: [turn.turn_id],
    };
  }

  if (!textContainsExactSpan(turn.text, evidence.dispatch_span)) {
    return { decision: 'deny', reason: 'missing_external_effect_evidence' };
  }
  return {
    decision: 'allow',
    basis: 'owner_current_turn_dispatch',
    evidence_refs: [turn.turn_id],
  };
}

module.exports = { NEVER_LIST_REFUSAL, authorizeInvocation, parseQuoSendDispatch, textContainsExactSpan };
