// voice-privileged-gate.js
//
// E2 (Amy overhaul, 2026-06-12): pure decision layer for privileged voice
// tools, sitting AFTER scripts/lib/voice-tool-policy.js in executeVapiTool.
//
//   policy  (voice-tool-policy):  may this caller TIER use this tool at all?
//   gate    (this module):        execute NOW, or hold for approval elsewhere?
//
// Rules:
//  - Non-privileged tools always execute (the gate is a no-op).
//  - A voiceprint-VERIFIED speaker (an enrolled household member matched by audio, cached for
//    the call) executes privileged tools immediately: no friction.
//  - A verified OWNER PHONE (ExampleCo/PRIVATE_NAME caller id) also executes immediately
//    (2026-07-18): voiceprint verification only exists at end-of-call (Vapi
//    exposes no mid-call audio), so the voiceprint-only gate structurally
//    denied every privileged tool for every caller on every live call,
//    owners included. Owner-phone unlock restores capability; downstream
//    guards (per-tool owner gates, outbound-send-guard identity rules,
//    security-event audit, end-of-call voiceprint audit) still hold.
//  - Everyone else, including keyword-upgraded callers, needs approval
//    outside the call. Telegram is not a proactive approval channel;
//    false-rejects therefore deny the privileged action rather than silently
//    executing or buzzing ExampleCo.
//  - Speaker IDENTIFICATION (context signal, e.g. "sounds like PRIVATE_NAME") is
//    deliberately IGNORED here: identification is never the sole authorizer.
//
// Also: the ExampleCo-caller access-keyword upgrade gets a mechanical attempt
// limit (3 per call AND per phone per 10 minutes) built on the proven
// isRateLimited sliding window from briefing-auth.js.

const { isRateLimited } = require('./briefing-auth');

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const KEYWORD_MAX_ATTEMPTS = 3;
const KEYWORD_WINDOW_MS = 10 * 60 * 1000;

// Pure: decide what happens to a privileged tool call right now.
// { privileged, preApproved, voiceprintVerifiedName, ownerPhoneVerified,
//   speakerIdentifiedName }
// -> { action: 'execute' | 'needs-approval', reason }
// speakerIdentifiedName is accepted and IGNORED on purpose (sole-authorizer
// guard): passing an identification must never flip the gate.
function decidePrivilegedVoiceExecution({
  privileged = false,
  preApproved = false,
  voiceprintVerifiedName = null,
  ownerPhoneVerified = false,
  speakerIdentifiedName = null, // eslint-disable-line no-unused-vars
} = {}) {
  if (!privileged) return { action: 'execute', reason: 'not-privileged' };
  if (preApproved) return { action: 'execute', reason: 'owner-approved-via-approval-surface' };
  if (voiceprintVerifiedName) {
    return { action: 'execute', reason: 'voiceprint-verified:' + voiceprintVerifiedName };
  }
  if (ownerPhoneVerified) {
    return { action: 'execute', reason: 'owner-phone-verified' };
  }
  return { action: 'needs-approval', reason: 'no-voiceprint-verification' };
}

// Owner-phone unlock eligibility (2026-07-18, Codex-reviewed): phone trust
// may only unlock privileged execution when the webhook itself proved
// authenticity (x-vapi-secret matched: signatureReason 'secret-match'), the
// caller is owner TIER, and the number is not a synthetic self-test
// principal. Fail-open signature modes ('no-secret-configured-warn') never
// unlock: a forged public POST carrying an owner number must not execute
// privileged tools.
function isOwnerPhoneUnlockEligible({
  callerTier = '',
  signatureReason = '',
  selfTestPhone = false,
} = {}) {
  return callerTier === 'owner' && signatureReason === 'secret-match' && !selfTestPhone;
}

// Keyword attempt limiter. stateMap is a Map<key, number[]> shared across
// calls (the same shape isRateLimited uses). Limits BOTH per-call and
// per-phone so a caller cannot reset the counter by redialing.
// Returns { locked, scope } where scope names which window tripped.
function checkKeywordAttempt(
  stateMap,
  { phone = '', callId = '' } = {},
  now = Date.now(),
  opts = {},
) {
  const { max = KEYWORD_MAX_ATTEMPTS, windowMs = KEYWORD_WINDOW_MS } = opts;
  const phoneKey = 'kw-phone:' + (phone || 'ExampleCo');
  const callKey = 'kw-call:' + (callId || 'ExampleCo');
  const phoneLimited = isRateLimited(stateMap, phoneKey, now, { max, windowMs });
  const callLimited = isRateLimited(stateMap, callKey, now, { max, windowMs });
  if (phoneLimited || callLimited) {
    return { locked: true, scope: phoneLimited ? 'phone' : 'call' };
  }
  return { locked: false, scope: null };
}

// Audit/dashboard approval line for a privileged voice action. Kept here so
// the format is unit-testable and consistent without creating a Telegram ping.
function formatPrivilegedApprovalMessage({ callerPhone, toolName, summary, approvalId }) {
  return (
    'Caller ' +
    (callerPhone || 'ExampleCo number') +
    ' asks: ' +
    toolName +
    (summary ? ' (' + summary + ')' : '') +
    '\n\nApproval id ' +
    approvalId +
    '. Held for dashboard review; no proactive Telegram approval prompt was sent.'
  );
}

module.exports = {
  decidePrivilegedVoiceExecution,
  isOwnerPhoneUnlockEligible,
  checkKeywordAttempt,
  formatPrivilegedApprovalMessage,
  APPROVAL_TTL_MS,
  KEYWORD_MAX_ATTEMPTS,
  KEYWORD_WINDOW_MS,
};
