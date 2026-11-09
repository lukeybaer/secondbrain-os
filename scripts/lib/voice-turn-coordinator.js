'use strict';

// One in-flight response per authenticated logical turn. Exact speech retries
// may replay; a completed native tool handoff must never execute twice.
function createVoiceTurnCoordinator({ now = Date.now, ttlMs = 30000, maxEntries = 256 } = {}) {
  const active = new Map(), completed = new Map();
  function prune() {
    for (const [key, value] of completed) if (now() - value.at > ttlMs) completed.delete(key);
    while (completed.size > maxEntries) completed.delete(completed.keys().next().value);
  }
  function begin(correlation, cancel) {
    prune();
    const turnId = String(correlation?.workId || '').match(/^(voice-call:[^:]+:turn:\d+)/)?.[1];
    if (!turnId) return { complete() {}, release() {} };
    const previous = completed.get(turnId);
    if (previous?.workId === correlation.workId) return { replay: previous.frames, toolHandoff: previous.toolHandoff };
    active.get(turnId)?.cancel();
    const entry = { cancel };
    active.set(turnId, entry);
    const release = () => { if (active.get(turnId) === entry) active.delete(turnId); };
    return {
      release,
      complete(frames, toolHandoff) {
        if (active.get(turnId) !== entry) return;
        completed.set(turnId, { at: now(), workId: correlation.workId, frames, toolHandoff });
        release(); prune();
      },
    };
  }
  return { begin };
}
module.exports = { createVoiceTurnCoordinator };
