'use strict';

// Voice provider writes this text as the tool result when the tool request never got an
// answer from Amy's server. On the Oct 15 call, steer_task got it in under a
// second, the webhook never saw the request, and Amy told the owner "I've added the
// request to the existing check." The model must read it as a failure.
const VAPI_NO_RESULT = /^\s*No result returned\b/i;

const FAILED_TOOL_TEXT =
  'TOOL FAILED: this request never reached Amy\'s server and nothing was saved or changed. ' +
  'Tell the owner plainly that it did not go through. Never say it was done, added, or started.';

function honestToolResultText(content) {
  const text = String(content == null ? '' : content);
  return VAPI_NO_RESULT.test(text) ? FAILED_TOOL_TEXT : text;
}

module.exports = { honestToolResultText, FAILED_TOOL_TEXT };
