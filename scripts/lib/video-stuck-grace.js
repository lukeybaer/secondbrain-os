// video-stuck-grace.js
//
// One shared answer to "has this queued video been stuck long enough that ExampleCo
// should see it as a defect?"
//
// 2026-08-24 ExampleCo defect: "Hard training in the mountains of Dagestan" sat in
// VIDEO APPROVAL QUEUE for two days with status build_failed, no final mp4, no
// rejection history, and no retry -- while the card graded CLEAN and the tile
// painted green. The producer recorded stuck=1 but its acceptance test only
// ever failed on manifest drift, so the real user-visible failure (a queued
// video that nothing owns) passed as clean. The card must grade the outcome
// ExampleCo cares about, so the age of the stuck state is a first-class, shared,
// testable predicate instead of an opinion inside one renderer.
//
// Grace exists because a build that failed minutes ago is normal pipeline
// noise; the same failure still sitting there a day later is an unowned defect.

const DEFAULT_GRACE_HOURS = 24;

// Every field the video pipeline writes when it last changed this row's state.
// The LATEST of them is the honest "stuck since": a row that was retried an
// hour ago is inside grace even if it first failed a week back.
const STUCK_SINCE_FIELDS = [
  'mtimeMs',
  // Manifest producers use generated_at when generated_date is not materialized.
  // Treat it as the row's original state stamp so old missing-final rows can
  // enter the reversible virtual-hold path instead of remaining red forever.
  'generated_at',
  'build_failed_at',
  'regen_failed_at',
  'regen_completed_at',
  'regen_started_at',
  'video_rejected_at',
  'thumbnail_rejected_at',
  'rejected_at',
  'updated_at',
  'synced_at',
  'created_at',
];

function parseMs(value) {
  if (!value) return NaN;
  // Drift rows (orphan pending media with no manifest row) carry a numeric
  // filesystem mtime, not an ISO string. Codex 2026-08-24: without this a
  // freshly written orphan file was "undatable" and went instantly beyond
  // grace, which would have red-flagged a file created seconds ago.
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  // A bare YYYY-MM-DD is a date, not an instant; anchor it at UTC midnight.
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T00:00:00Z`) : Date.parse(raw);
  return Number.isFinite(ms) ? ms : NaN;
}

function videoStuckSinceMs(video) {
  if (!video || typeof video !== 'object') return NaN;
  let latest = NaN;
  for (const field of STUCK_SINCE_FIELDS) {
    const ms = parseMs(video[field]);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(latest) || ms > latest) latest = ms;
  }
  if (Number.isFinite(latest)) return latest;
  return parseMs(video.generated_date);
}

function videoStuckAgeHours(video, now = Date.now()) {
  const since = videoStuckSinceMs(video);
  if (!Number.isFinite(since)) return NaN;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return NaN;
  return (nowMs - since) / 3.6e6;
}

// Fail loud, not silent: a queued row carrying no usable timestamp at all is
// undatable work sitting in ExampleCo's queue, which is exactly the silence this
// defect class is about. Treat it as beyond grace so it surfaces with a named
// reason rather than passing as clean.
function videoStuckBeyondGrace(video, options = {}) {
  const { now = Date.now(), graceHours = DEFAULT_GRACE_HOURS } = options;
  if (!video || typeof video !== 'object') return false;
  const ageHours = videoStuckAgeHours(video, now);
  if (!Number.isFinite(ageHours)) return true;
  return ageHours > graceHours;
}

function describeStuckAge(video, options = {}) {
  const { now = Date.now() } = options;
  const ageHours = videoStuckAgeHours(video, now);
  if (!Number.isFinite(ageHours)) {
    return 'for an unknown length of time (no dated state on the row)';
  }
  if (ageHours < 1) return 'for under an hour';
  if (ageHours < 48) {
    const hours = Math.floor(ageHours);
    return `for ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.floor(ageHours / 24);
  return `for ${days} day${days === 1 ? '' : 's'}`;
}

// The machine-readable marker the live tile prints and the live render-QC
// grades. Same contract as Memory Hygiene's STALE:/MISSING: -- the QC must red
// the card on this marker regardless of the tile's own styling, so the tile can
// never paint itself green over a real stuck item.
const STUCK_BEYOND_GRACE_MARKER = 'STUCK BEYOND GRACE';

// Returns a PREFIX for the card's existing queue-attention sentence, never a
// competing sentence: the tile renders only its first banner message, so a
// separate message would have silently replaced the reason ExampleCo needs to read.
// The prefix carries the marker plus the age; the sentence it prefixes already
// carries the named blocker reason (and its path redaction).
// The single row the beyond-grace face is about. Callers MUST derive the named
// blocker reason from this same row: Codex 2026-08-24 caught the banner naming
// the oldest row's title next to the first row's reason once more than one
// video was stuck.
function oldestStuckBeyondGrace(rows, options = {}) {
  const { now = Date.now(), graceHours = DEFAULT_GRACE_HOURS } = options;
  const beyond = (Array.isArray(rows) ? rows : []).filter((row) =>
    videoStuckBeyondGrace(row, { now, graceHours }),
  );
  if (!beyond.length) return null;
  return beyond.slice().sort((a, b) => {
    const aMs = videoStuckSinceMs(a);
    const bMs = videoStuckSinceMs(b);
    if (!Number.isFinite(aMs)) return -1;
    if (!Number.isFinite(bMs)) return 1;
    return aMs - bMs;
  })[0];
}

function stuckBeyondGracePrefix(rows, options = {}) {
  const { now = Date.now(), graceHours = DEFAULT_GRACE_HOURS } = options;
  const oldest = oldestStuckBeyondGrace(rows, { now, graceHours });
  if (!oldest) return '';
  const title = String(oldest.title || oldest.id || oldest.file || 'untitled')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  // Wording is exactly what the data proves: the row has not reached a clean
  // state inside the window. It does NOT claim zero attempts were ever made,
  // which the row cannot show (Codex 2026-08-24).
  return (
    `${STUCK_BEYOND_GRACE_MARKER}: "${title}" has been stuck ${describeStuckAge(oldest, { now })}, ` +
    `past the ${graceHours}h grace window, with no repair landing inside it. `
  );
}

module.exports = {
  DEFAULT_GRACE_HOURS,
  STUCK_BEYOND_GRACE_MARKER,
  STUCK_SINCE_FIELDS,
  describeStuckAge,
  oldestStuckBeyondGrace,
  stuckBeyondGracePrefix,
  videoStuckAgeHours,
  videoStuckBeyondGrace,
  videoStuckSinceMs,
};
