'use strict';

// The dashboard is served by the same Node process as live voice. Reading a
// few hundred People files synchronously made a dashboard warm hold that event
// loop long enough to delay an already-arriving call. Keep the last verified
// index for render-time consumers and refresh it through asynchronous I/O.
function createBriefingPeopleIndexCache({
  load,
  now = Date.now,
  refreshMs = 60_000,
  log = () => {},
} = {}) {
  if (typeof load !== 'function') throw new Error('briefing people index cache requires load');

  let people = [];
  let refreshedAt = 0;
  let nextRefreshAt = 0;
  let inFlight = null;

  function refresh(reason = 'interval', { force = false } = {}) {
    const at = now();
    if (inFlight) return inFlight;
    if (!force && at < nextRefreshAt) return Promise.resolve(people);
    // Set this before starting I/O so every render during a slow filesystem
    // read receives the last snapshot instead of creating another scan.
    nextRefreshAt = at + refreshMs;
    inFlight = Promise.resolve()
      .then(load)
      .then((next) => {
        if (!Array.isArray(next)) throw new Error('people index loader returned a non-array');
        people = next;
        refreshedAt = now();
        return people;
      })
      .catch((error) => {
        log(`[briefing-dashboard] people index refresh failed (${reason}): ${String(error?.message || error)}`);
        return people;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function get() {
    // Intentionally do not await: dashboard rendering must only read the last
    // evidence and must never perform a filesystem sweep on the voice process.
    void refresh('read');
    return people;
  }

  return {
    get,
    refresh,
    status: () => ({ count: people.length, refreshedAt, refreshing: Boolean(inFlight) }),
  };
}

module.exports = { createBriefingPeopleIndexCache };
