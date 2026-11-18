'use strict';

// Owner-approved delivery fix, 2026-11-16.
//
// A message to another Claude session addressed by its session ID waits until
// the recipient's turn ends. On Sunday 2026-11-15, 30 of the 33 messages sent
// that way arrived over 15 minutes late (median 2 h, worst 9 h); all 58 sent by
// session name or reply address arrived within a minute. This guard refuses the
// session-ID form and points the sender at the name.
//
// In scope: SendMessage / CrossSessionMessage whose `to` is a session ID, and
// the session-management send_message tool, which only takes a session ID.
// Out of scope: in-process subagent IDs (short hex), names, and reply addresses.

const POLICY_MARKER = '[session-message-address-guard]';

const NAME_TOOLS = /^(?:SendMessage|CrossSessionMessage)$/;
const ID_ONLY_TOOLS = /^mcp__ccd_session_mgmt__send_message$/;
const SESSION_ID_RE =
  /^(?:local_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^local_[A-Za-z0-9_-]+$/i;

const ADVICE =
  'Messages to another session addressed by session ID wait until its turn ends (30 of 33 ran over 15 minutes late on 2026-11-15). ' +
  "Send by the session's name instead: ListAgents shows it; use SendMessage with to set to that exact name, or the reply address its own message gave you.";

function isSessionId(value) {
  return SESSION_ID_RE.test(String(value || '').trim());
}

function evaluateSessionMessage({ toolName = '', toolInput = {} } = {}) {
  const name = String(toolName || '');
  if (ID_ONLY_TOOLS.test(name)) {
    return { blocked: true, reason: `${name} addresses a session by ID. ${ADVICE}` };
  }
  if (NAME_TOOLS.test(name)) {
    const to = toolInput && (toolInput.to ?? toolInput.recipient ?? toolInput.session_id);
    if (isSessionId(to)) {
      return { blocked: true, reason: `"${String(to).trim()}" is a session ID. ${ADVICE}` };
    }
  }
  return { blocked: false, reason: '' };
}

module.exports = { POLICY_MARKER, evaluateSessionMessage, isSessionId };
