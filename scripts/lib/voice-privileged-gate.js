// voice-privileged-gate.js
//
// E2 (Amy overhaul, 2026-06-12): pure decision layer for privileged voice
// tools, sitting AFTER scripts/lib/voice-tool-policy.js in executeVapiTool.
//
//   policy  (voice-tool-policy):  may this caller TIER use this tool at all?
//   gate    (this module):        execute NOW, or detour to Telegram approval?
//
// Rules:
//  - Non-privileged tools always execute (the gate is a no-op).
//  - A voiceprint-VERIFIED speaker (an enrolled household member matched by audio, cached for
//    the call) executes privileged tools immediately: no friction.
//  - Everyone else, including owner-by-phone-number and keyword-upgraded
//    callers, detours to a Telegram YES/NO approval. A voiceprint
//    false-reject therefore degrades to the approval challenge, never a
//    dead end and never silent execution.
//  - Speaker IDENTIFICATION (context signal, e.g. "sounds like PRIVATE_NAME") is
//    deliberately IGNORED here: identification is never the sole authorizer.
//    Only the verification cache (written exclusively on an above-threshold
//    voiceprint match) unlocks execution.
//
// Also: the ExampleCo-caller access-keyword upgrade gets a mechanical attempt
// limit (3 per call AND per phone per 10 minutes) built on the proven
// isRateLimited sliding window from briefing-auth.js.

const { isRateLimited } = require('./briefing-auth');

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const KEYWORD_MAX_ATTEMPTS = 3;
const KEYWORD_WINDOW_MS = 10 * 60 * 1000;

// Pure: decide what happens to a privileged tool call right now.
// { privileged, preApproved, voiceprintVerifiedName, speakerIdentifiedName }
// -> { action: 'execute' | 'needs-approval', reason }
// speakerIdentifiedName is accepted and IGNORED on purpose (sole-authorizer
// guard): passing an identification must never flip the gate.
function decidePrivilegedVoiceExecution({
  privileged = false,
  preApproved = false,
  voiceprintVerifiedName = null,
  speakerIdentifiedName = null, // eslint-disable-line no-unused-vars
} = {}) {
  if (!privileged) return { action: 'execute', reason: 'not-privileged' };
  if (preApproved) return { action: 'execute', reason: 'owner-approved-via-telegram' };
  if (voiceprintVerifiedName) {
    return { action: 'execute', reason: 'voiceprint-verified:' + voiceprintVerifiedName };
  }
  return { action: 'needs-approval', reason: 'no-voiceprint-verification' };
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

// Telegram approval line for a privileged voice action. Kept here so the
// format is unit-testable and consistent.
function formatPrivilegedApprovalMessage({ callerPhone, toolName, summary, approvalId }) {
  return (
    'Caller ' +
    (callerPhone || 'ExampleCo number') +
    ' asks: ' +
    toolName +
    (summary ? ' (' + summary + ')' : '') +
    '\n\nReply YES ' +
    approvalId +
    ' to run it, NO ' +
    approvalId +
    ' to refuse. Expires in 10 minutes.'
  );
}

module.exports = {
  decidePrivilegedVoiceExecution,
  checkKeywordAttempt,
  formatPrivilegedApprovalMessage,
  APPROVAL_TTL_MS,
  KEYWORD_MAX_ATTEMPTS,
  KEYWORD_WINDOW_MS,
};
