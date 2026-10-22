'use strict';
// The news self-call's synthetic caller speaks only what the proof driver puts
// on the wire through its control URL. Its own model turn fires on any pause in
// Amy's reading longer than its endpointing plan, and a prompt cannot be
// trusted to keep it quiet: told never to say the scripted lines, it said
// "Save that." on its own and cut Amy's answer to the question (one news self-call). The caller's prompt carries this marker and the server
// answers each of its own turns with an empty completion; no model is asked.
const SILENT_SYNTHETIC_CALLER_MARKER = 'AMY_SYNTHETIC_CALLER=silent';

function silentSyntheticCallerPrompt() {
  return `${SILENT_SYNTHETIC_CALLER_MARKER}\nYou are a synthetic test caller. A test harness speaks every line for you through this call's control URL and the server answers your own turns with silence. Say nothing.`;
}

// Only the authenticated system context decides (the single AMY_CALL_ID-marked
// system message). Caller speech or a tool result carrying the words is not it.
function isSilentSyntheticCallerTurn(trustedSystemContext) {
  return String(trustedSystemContext || '')
    .split(/\r?\n/)
    .some((line) => line.trim() === SILENT_SYNTHETIC_CALLER_MARKER);
}

module.exports = { SILENT_SYNTHETIC_CALLER_MARKER, silentSyntheticCallerPrompt, isSilentSyntheticCallerTurn };
