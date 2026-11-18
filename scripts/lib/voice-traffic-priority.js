'use strict';

// Synchronous dashboard rendering must yield while the shared HTTP process
// serves a call. Signed lifecycle events refresh the bounded activity lease.
function createVoiceTrafficPriority({ now = Date.now, ttlMs = 90000 } = {}) {
  const calls = new Map();
  return {
    observe(callId, ended = false) {
      if (!callId) return;
      if (ended) calls.delete(callId);
      else calls.set(callId, now());
    },
    busy() {
      for (const [id, at] of calls) if (now() - at >= ttlMs) calls.delete(id);
      return calls.size > 0;
    },
  };
}
module.exports = { createVoiceTrafficPriority };
