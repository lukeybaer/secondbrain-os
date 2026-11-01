'use strict';

function inspectVoiceRelaySseLine(line) {
  const match = String(line || '').match(/^data:\s*(\{.*\})\s*$/);
  if (!match) return { content: '', hasToolCall: false };
  try {
    const choice = JSON.parse(match[1]).choices?.[0] || {};
    const content = typeof choice.delta?.content === 'string' ? choice.delta.content : '';
    const hasToolCall =
      (Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.length > 0) ||
      choice.finish_reason === 'tool_calls';
    return { content, hasToolCall };
  } catch {
    return { content: '', hasToolCall: false };
  }
}

function createVoiceRelayJudge() {
  let buffer = '';
  return {
    feed(chunk, { final = false } = {}) {
      buffer += String(chunk || '');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (final && buffer) {
        lines.push(buffer);
        buffer = '';
      }
      let content = '';
      let hasToolCall = false;
      for (const line of lines) {
        const frame = inspectVoiceRelaySseLine(line);
        content += frame.content;
        hasToolCall = hasToolCall || frame.hasToolCall;
      }
      return { content, hasToolCall };
    },
  };
}

module.exports = { createVoiceRelayJudge, inspectVoiceRelaySseLine };
