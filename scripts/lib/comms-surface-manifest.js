'use strict';

// Declared comms-surface manifest for law g20 (operation provenance).
//
// Amy's comms run through exactly these ingress/egress chokepoints:
//   telegram-in      ec2-server.js logTelegramEvent (direction 'in'; pollTelegram entry)
//   telegram-out     ec2-server.js logTelegramEvent (direction 'out'; every sendMessage)
//   vapi-webhook     ec2-server.js /vapi/webhook POST handler
//   otter-ingest     scripts/otter-ingest-watch.js appendHeartbeat (per poll cycle)
//   gmail-out        ec2-server.js sendGmailReply (dashboard send + dispatch)
//   gmail-scan       scripts/gmail-amy-scan.js processMessages heartbeat
//   briefing-notify  scripts/lib/briefing-notify.js (briefing.published / briefing.sent)
//
// g20 coverage contract: for a CT date, every REQUIRED surface must have at
// least one operation-provenance event that day. A genuinely quiet surface
// satisfies it with one explicit comms.idle marker written by recordCommsCycle,
// deduped by a marker file so cron and PM2 restarts never flood the ledger.
// A surface with zero events is a coverage hole and blocks g20 COMPLIANT.
// Events carry a content hash reference only, never payload content; raw
// archival stays where it already happens.

const fs = require('node:fs');
const path = require('node:path');
const { provenancePaths, recordOperationEvent } = require('./operation-provenance.js');

const COMMS_IDLE_EVENT_TYPE = 'comms.idle';

const REQUIRED_COMMS_SURFACES = Object.freeze([
  'telegram-in',
  'telegram-out',
  'vapi-webhook',
  'otter-ingest',
  'gmail-out',
  'gmail-scan',
  'briefing-notify',
]);

// briefing-notify records at ~5:30 CT, at or after the morning gravity probe,
// so at probe time its freshest possible proof can be the prior CT date's
// event. Grace is per-surface and exactly one day; a surface silent for both
// dates is still a coverage hole.
const PRIOR_DAY_GRACE_SURFACES = Object.freeze(['briefing-notify']);

function ctDateKey(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function priorCtDateKey(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return '';
  return new Date(Date.UTC(year, month - 1, day - 1, 12)).toISOString().slice(0, 10);
}

function missingCommsSurfaces(dayEvents = [], priorDayEvents = []) {
  const sameDay = new Set(dayEvents.map((event) => String((event && event.surface) || '')));
  const priorDay = new Set(priorDayEvents.map((event) => String((event && event.surface) || '')));
  return REQUIRED_COMMS_SURFACES.filter(
    (surface) =>
      !sameDay.has(surface) &&
      !(PRIOR_DAY_GRACE_SURFACES.includes(surface) && priorDay.has(surface)),
  );
}

// One call per traffic item or per poll cycle at a wired chokepoint.
// count > 0 records a comms.<direction> event; count === 0 records at most one
// comms.idle marker per surface per CT day. Never throws: provenance must not
// break the comms path it observes.
function recordCommsCycle({
  surface,
  direction = 'in',
  count = 0,
  contentSha256 = '',
  details = {},
  dataDir,
  now = new Date(),
  record = recordOperationEvent,
} = {}) {
  try {
    if (!surface) return { recorded: false, error: 'missing surface' };
    const day = ctDateKey(now);
    const input = {
      surface,
      sessionId: `${surface}-${day}`,
      details: { ...details, direction, content_sha256: String(contentSha256 || ''), count },
    };
    if (count > 0) {
      const { event } = record({ ...input, eventType: `comms.${direction}` }, { dataDir, now });
      return { recorded: true, idle: false, event };
    }
    const markerPath = path.join(provenancePaths(dataDir).root, `idle-${surface}.json`);
    let marker = null;
    try {
      marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
      marker = null;
    }
    if (marker && marker.date === day) return { recorded: false, idle: true };
    const { event } = record({ ...input, eventType: COMMS_IDLE_EVENT_TYPE }, { dataDir, now });
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({ surface, date: day })}\n`);
    return { recorded: true, idle: true, event };
  } catch (error) {
    return { recorded: false, error: String((error && error.message) || error) };
  }
}

module.exports = {
  COMMS_IDLE_EVENT_TYPE,
  PRIOR_DAY_GRACE_SURFACES,
  REQUIRED_COMMS_SURFACES,
  ctDateKey,
  missingCommsSurfaces,
  priorCtDateKey,
  recordCommsCycle,
};
