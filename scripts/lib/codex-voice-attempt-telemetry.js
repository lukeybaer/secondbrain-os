'use strict';

function createCodexVoiceAttemptTelemetryRecorder({
  startTelemetry,
  openaiBody,
  headers,
  prompt,
  correlation,
} = {}) {
  if (typeof startTelemetry !== 'function') throw new Error('startTelemetry is required');
  const active = new Map();
  return (event) => {
    if (event?.event === 'started') {
      if (active.has(event.attemptId)) return;
      active.set(
        event.attemptId,
        startTelemetry({
          openaiBody,
          headers,
          prompt,
          correlation,
          processName: event.processName || (event.label === 'claude-cli'
            ? 'vapi-voice-claude-cli-attempt'
            : 'vapi-voice-app-server-attempt'),
          trigger: event.trigger || `voice-${event.label}`,
          model: event.model || (event.label === 'claude-cli' ? 'claude-subscription' : 'gpt-5.6-terra'),
          effort: 'low',
          returnCondition: 'one schema-valid voice decision without tools',
        }),
      );
      return;
    }
    if (event?.event !== 'settled') return;
    const attempt = active.get(event.attemptId);
    if (!attempt) return;
    active.delete(event.attemptId);
    attempt.settle(event.outcome, event.outputBytes, event.usage);
  };
}

module.exports = { createCodexVoiceAttemptTelemetryRecorder };
