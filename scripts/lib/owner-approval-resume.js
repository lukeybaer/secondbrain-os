'use strict';

function approvalResumeMessage(approval, resolution) {
  const answer = resolution.answer === 'approved' ? 'approved' : 'denied';
  const instruction =
    answer === 'approved'
      ? 'Continue the exact held request now. Use only the approved data category and purpose; do not expand the scope.'
      : 'Do not disclose the held information or perform the held action. Tell the participant that approval was declined.';
  return [
    'OWNER_APPROVAL_RESOLVED',
    `approval_id=${approval.approval_id}`,
    `decision=${answer}`,
    `request_type=${approval.request_type}`,
    `data_category=${approval.data_category || 'unspecified'}`,
    `scope=${approval.description}`,
    instruction,
  ].join('\n');
}

async function resumeOwnerApproval({ store, resolution, addMessageToCall, isCallActive } = {}) {
  if (!store || !resolution?.ok || !resolution.approval) {
    return { ok: false, reason: 'valid_resolution_required' };
  }
  const approval = resolution.approval;
  const surface = String(approval.origin?.surface || '').toLowerCase();

  // A running Codex, Claude, Electron, Gmail, or Telegram surface owns its own
  // correlated wait/continuation. The durable resume remains queued until that
  // exact surface consumes it, so a generic background worker cannot leak the
  // decision into Telegram or another conversation.
  if (surface !== 'vapi' && surface !== 'voice') {
    return { ok: true, delivered: false, waiting_for_origin: true, surface };
  }

  const callId = approval.origin?.call_id;
  if (
    !callId ||
    typeof addMessageToCall !== 'function' ||
    (typeof isCallActive === 'function' && !isCallActive(callId))
  ) {
    return { ok: false, delivered: false, reason: 'origin_surface_unavailable', surface };
  }

  const claim = store.claimResume(approval.approval_id, { consumer: `vapi:${callId}` });
  if (!claim.ok) return { ...claim, delivered: false, surface };
  let delivered = false;
  try {
    delivered = await addMessageToCall(
      callId,
      approvalResumeMessage(approval, resolution.resolution || approval.resolution),
      true,
    );
  } catch {
    delivered = false;
  }
  if (!delivered) {
    store.failResume(approval.approval_id, claim.lease_token, {
      reason: 'origin_surface_unavailable',
      retryable: true,
    });
    return { ok: false, delivered: false, reason: 'origin_surface_unavailable', surface };
  }
  store.completeResume(approval.approval_id, claim.lease_token, {
    surface: 'vapi',
    call_id: callId,
  });
  return { ok: true, delivered: true, surface, approval_id: approval.approval_id };
}

module.exports = { approvalResumeMessage, resumeOwnerApproval };
