'use strict';

// Durable "this slot already fired today" markers. ec2-server.js kept them only
// in the in-memory schedulerFlags Map, so a PM2 restart inside a slot's window
// forgot the slot had fired and fired it again, and the YouTube slot uploaded a
// second video (state machine audit finding #25, owner decision).
//
// One JSON object, { "<slot>-<YYYY-MM-DD CT>": "<ISO fired at>" }, so a marker
// is the slot plus its date and yesterday's marker never blocks today. Writes
// are a locked, atomic read-modify-write (ledger-state-machine.js). A corrupt
// file throws rather than reading as empty: an empty read would let every slot
// fire again.

const { readJsonStrict, updateJsonLocked } = require('./ledger-state-machine');

const KEEP_MS = 3 * 24 * 60 * 60 * 1000;

function asMarkers(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** True when the slot key (name plus date) was marked fired, by any process. */
function isSlotFired(file, key) {
  return Object.prototype.hasOwnProperty.call(asMarkers(readJsonStrict(file, {})), key);
}

/** Mark the slot key fired. Idempotent; also drops markers older than three days. */
function markSlotFired(file, key, nowMs = Date.now()) {
  updateJsonLocked(file, (current) => {
    const markers = asMarkers(current);
    if (Object.prototype.hasOwnProperty.call(markers, key)) return updateJsonLocked.SKIP;
    for (const [oldKey, firedAt] of Object.entries(markers)) {
      const t = Date.parse(firedAt);
      if (!Number.isFinite(t) || nowMs - t > KEEP_MS) delete markers[oldKey];
    }
    markers[key] = new Date(nowMs).toISOString();
    return markers;
  }, { fallback: {} });
}

module.exports = { isSlotFired, markSlotFired };
