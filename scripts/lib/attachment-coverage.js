'use strict';

// Attachment coverage (owner decision): "are there metrics that check
// historically if all attachments/screenshots/etc in emails, signal, chat,
// etc are scanned/parsed/described/searchable?" One report, every source, a
// recent window and the whole history, measured against what exists at the
// source rather than what Amy already pulled down.
//
// Each unit (an attachment, or for Gmail a message with attachments, because
// the mailbox can only be counted by message) moves through four stages:
//   exists     it is at the source (mailbox count, secure chat event, chat update)
//   saved      its original is in Amy's raw archive
//   read       its understanding record is settled
//   searchable its text is a Life Archive row
// A unit is covered when its original is saved and it is searchable, or was
// skipped on purpose (an icon-sized image, an unsupported type). A read that
// gave up after retries is counted as failed, a PDF read only in part is not
// searchable, and a source file that is gone is lost: none of them is covered.
//
// Honesty rules, borrowed from lib/gmail-attachment-coverage.js: an unknown
// denominator is red, never a fabricated 100%; pending work is never coverage.

const SCHEMA = 'amy.attachment-coverage.v1';
const RECENT_DAYS = 30;
const GREEN_RATE = 0.99;
const YELLOW_RATE = 0.9;
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyStage() {
  return { exists: 0, saved: 0, read: 0, searchable: 0, settled: 0, failed: 0, lost: 0, covered: 0 };
}

// unit: { date: 'YYYY-MM-DD...', saved, read, searchable, settled, failed, lost }
function isCovered(unit) {
  return unit.saved !== false && !unit.lost && Boolean(unit.searchable || unit.settled);
}

function addUnit(stage, unit) {
  stage.exists += 1;
  if (unit.saved) stage.saved += 1;
  if (unit.read) stage.read += 1;
  if (unit.searchable) stage.searchable += 1;
  if (unit.settled) stage.settled += 1;
  if (unit.failed) stage.failed += 1;
  if (unit.lost) stage.lost += 1;
  if (isCovered(unit)) stage.covered += 1;
}

// existsOverride: undefined uses the units found; null means the source count
// is unknown.
function grade(stage, existsOverride) {
  const exists = existsOverride !== undefined ? existsOverride : stage.exists;
  const out = { ...stage, exists };
  if (!Number.isFinite(exists) || exists < 0) {
    return { ...out, exists: null, rate: null, status: 'red', reason: 'source count unknown' };
  }
  if (exists === 0) return { ...out, rate: null, status: 'green', reason: 'nothing at the source' };
  const rate = Math.min(1, stage.covered / exists);
  const status = rate >= GREEN_RATE ? 'green' : rate >= YELLOW_RATE ? 'yellow' : 'red';
  return { ...out, rate: Math.round(rate * 10000) / 10000, status };
}

// sourceCounts (optional): what the source itself holds, { recent, lifetime,
// byYear: { YYYY: n } }. Without it the units Amy found are the denominator,
// which is exact only for sources Amy captures whole (Signal, chat).
function summarizeSource(units, { now = Date.now(), recentDays = RECENT_DAYS, sourceCounts = null, unit = 'attachment' } = {}) {
  const cutoff = new Date(now - recentDays * DAY_MS).toISOString().slice(0, 10);
  const recent = emptyStage();
  const lifetime = emptyStage();
  const years = {};
  for (const u of units) {
    const day = String(u.date || '').slice(0, 10);
    addUnit(lifetime, u);
    if (day && day >= cutoff) addUnit(recent, u);
    const year = day.slice(0, 4) || 'unknown';
    if (!years[year]) years[year] = emptyStage();
    addUnit(years[year], u);
  }
  const counted = sourceCounts && typeof sourceCounts === 'object';
  const byYear = {};
  const allYears = new Set([...Object.keys(years), ...Object.keys((counted && sourceCounts.byYear) || {})]);
  for (const year of [...allYears].sort()) {
    const atSource = counted && sourceCounts.byYear ? sourceCounts.byYear[year] : undefined;
    byYear[year] = grade(years[year] || emptyStage(), counted ? (atSource != null ? Math.max(atSource, (years[year] || {}).exists || 0) : undefined) : undefined);
  }
  const atLeast = (count, stage) => (count == null ? null : Math.max(Number(count), stage.exists));
  return {
    unit,
    denominator: counted ? 'source' : 'archive',
    recent: grade(recent, counted ? atLeast(sourceCounts.recent, recent) : undefined),
    lifetime: grade(lifetime, counted ? atLeast(sourceCounts.lifetime, lifetime) : undefined),
    byYear,
  };
}

function worst(statuses) {
  if (statuses.includes('red')) return 'red';
  if (statuses.includes('yellow')) return 'yellow';
  return 'green';
}

function buildReport(sources, { now = Date.now(), recentDays = RECENT_DAYS } = {}) {
  const names = Object.keys(sources);
  return {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    recentDays,
    recentStatus: worst(names.map((n) => sources[n].recent.status)),
    lifetimeStatus: worst(names.map((n) => sources[n].lifetime.status)),
    sources,
  };
}

// A source whose own record could not be read at all (no state root, no
// inventory): every window is red with the reason, never "nothing at the source".
function unknownSource(reason, unit = 'attachment') {
  const unknown = { ...grade(emptyStage(), null), reason };
  return { unit, denominator: 'unknown', recent: unknown, lifetime: unknown, byYear: {}, reason };
}

module.exports = { SCHEMA, RECENT_DAYS, GREEN_RATE, YELLOW_RATE, summarizeSource, buildReport, grade, isCovered, unknownSource };
