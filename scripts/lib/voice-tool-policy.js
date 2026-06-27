// voice-tool-policy.js
//
// Least-privilege gate for Vapi voice tools (E0 workstream A, 2026-06-11).
// executeVapiTool in ec2-server.js runs tools for whoever is on the call.
// run_claude_code already had an owner-phone gate; the other mutating or
// sending tools (send_message, manage_task, create_calendar_event,
// web_search, queue_coding_task) did not, so an ExampleCo inbound caller could
// ask Amy to text ExampleCo arbitrary content or mutate the task store.
//
// Tiers: 'owner' (verified owner phone), 'known' (matched contact, still not
// trusted with side effects), 'ExampleCo' (everyone else). Only the owner may
// run privileged tools. Read-only informational tools (weather, calendar
// lookups, knowledge queries) stay available to every caller; the system
// prompt handles what Amy is willing to SAY to a non-owner.
//
// Deliberately NOT privileged:
//  - bridge_in_owner / bridge_in_ExampleCo: exists FOR non-owner callers to reach ExampleCo.
//  - request_approval: side effects are held for non-Telegram approval surfaces.
//  - flag_reputation_risk: must fire during sketchy calls from strangers.
//
// Owner-only read tools are not privileged because they should not trigger the
// voiceprint approval queue for ExampleCo, but ExampleCo callers still cannot run them.

const PRIVILEGED_TOOLS = [
  'run_claude_code',
  'queue_coding_task',
  'send_message',
  'manage_task',
  'create_calendar_event',
  'web_search',
  'start_agent_session',
  'callback_commitment',
];

const OWNER_ONLY_READ_TOOLS = ['read_briefing_news'];

const REFUSAL =
  'I can only do that for ExampleCo. I can take a message or have him get back to you, ' +
  'but I am not able to run that action on this call.';

// Pure decision: may a caller of this tier execute this tool?
// Returns { allowed, privileged, refusal } where refusal is the polite
// string to return as the tool result when allowed is false.
function isToolAllowedForCaller(toolName, callerTier) {
  const name = String(toolName || '');
  const privileged = PRIVILEGED_TOOLS.includes(name);
  if (!privileged) {
    if (OWNER_ONLY_READ_TOOLS.includes(name) && callerTier !== 'owner') {
      return { allowed: false, privileged: false, refusal: REFUSAL };
    }
    return { allowed: true, privileged: false, refusal: null };
  }
  if (callerTier === 'owner') {
    return { allowed: true, privileged: true, refusal: null };
  }
  return { allowed: false, privileged: true, refusal: REFUSAL };
}

module.exports = { isToolAllowedForCaller, PRIVILEGED_TOOLS, OWNER_ONLY_READ_TOOLS, REFUSAL };
