'use strict';

const CT_ZONE = 'America/Chicago';

function ctDateAndHour(value) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CT_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${byType.year}-${byType.month}-${byType.day}`, hour: Number(byType.hour) };
}

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86400000).toISOString().slice(0, 10);
}

// The night for briefing date D is launched from 22:00 CT on D-1. A
// post-midnight restart continues to own D. Every producer and consumer of
// the watcher outcome key must use this one boundary.
function briefingDateForLaunch(value = Date.now()) {
  const ct = ctDateAndHour(value);
  if (!ct) return '';
  return ct.hour < 22 ? ct.date : addDays(ct.date, 1);
}

// The briefing date a non-overnight run is allowed to write into right now:
// the America/Chicago calendar date at `nowMs`, advanced one day once the CT
// hour reaches 23. This is the CLI's own closed-date boundary (one hour later
// than briefingDateForLaunch's 22:00 watcher-launch boundary above) and must
// not be folded into that function -- the watcher owns when the night LAUNCHES,
// this owns when a midday/button run must stop targeting yesterday.
function openBriefingDate(nowMs = Date.now()) {
  const ct = ctDateAndHour(nowMs);
  if (!ct) return '';
  return ct.hour >= 23 ? addDays(ct.date, 1) : ct.date;
}

// Pure refusal decision for card-controller.js's CLI main path. Overnight mode
// owns date rollover and is always exempt. Any other mode asked to write a
// --date earlier than the currently open briefing date is refused -- that is
// exactly the 2026-09-14 23:17 CT race (a midday run for the closing date
// publishing after the new day's overnight run already landed). A missing date
// is ignored unless the caller sets resolveMissingDate, which judges the CT
// calendar date runCardController falls back to; a malformed date is ignored.
function closedBriefingDateRefusal({ mode, date, nowMs = Date.now(), resolveMissingDate = false } = {}) {
  if (String(mode || '').trim().toLowerCase() === 'overnight') return null;
  const effectiveDate = !date && resolveMissingDate ? ctDateAndHour(nowMs)?.date || '' : date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveDate || ''))) return null;
  const openDate = openBriefingDate(nowMs);
  if (!openDate || String(effectiveDate) >= openDate) return null;
  return {
    refused: true,
    reason: 'closed-briefing-date',
    mode: String(mode || ''),
    date: String(effectiveDate),
    openDate,
    message: `card-controller refused: --date ${effectiveDate} is closed (open briefing date is ${openDate}); reason closed-briefing-date`,
  };
}

module.exports = {
  CT_ZONE,
  addDays,
  briefingDateForLaunch,
  ctDateAndHour,
  openBriefingDate,
  closedBriefingDateRefusal,
};
