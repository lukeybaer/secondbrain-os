'use strict';

function textContainsExactSpan(text, span) {
  const source = String(text || '');
  const exact = String(span || '').trim();
  return Boolean(exact) && source.toLowerCase().includes(exact.toLowerCase());
}

function authorizeInvocation({ turn, descriptor, arguments: args = {}, evidence = {}, decision } = {}) {
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
    if (
      decision?.kind !== 'external_send_authorized' ||
      decision?.subject_ref !== args.draft_id ||
      decision?.answer !== 'yes'
    ) {
      return { decision: 'deny', reason: 'draft_specific_send_authorization_required' };
    }
    return {
      decision: 'allow',
      basis: 'draft_specific_external_send_authorized',
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

  if (!textContainsExactSpan(turn.text, evidence.dispatch_span)) {
    return { decision: 'deny', reason: 'missing_external_effect_evidence' };
  }
  return {
    decision: 'allow',
    basis: 'owner_current_turn_dispatch',
    evidence_refs: [turn.turn_id],
  };
}

module.exports = { authorizeInvocation, textContainsExactSpan };
