'use strict';

// owner decision, five cuts Q2: "When a producer fails, may the card show
// yesterday's content in amber, saying when it went stale and why?" Yes.
//
// One rule, read from the status each card artifact records, never from the
// card's wording (S-4, owner decision). A card that is not recorded clean and
// holds no content of its own (nothing, or the one line a failed or unfinished
// refresh leaves) shows the newest earlier copy of itself that was recorded
// clean: amber, labeled with when that copy was produced and why today's did
// not replace it, not counted red, green again the moment a refresh lands. A
// card that is not clean but has content of its own is today's card with a
// real defect and stays red. So does a card its producer recorded clean,
// whatever live QC recorded over it: today's refresh produced it (review
// 9e0fb7f0d9f6). So does a card with no clean copy in the MAX_LOOKBACK_DAYS
// days before its board.

const { normalizeCardStatus } = require('./card-status.js');

// Weather: yesterday's forecast is not today's weather, so it stays red.
const INELIGIBLE_CARD_IDS = new Set(['blockers', 'system_health', 'ExampleCo_weather']);
const MAX_LOOKBACK_DAYS = 3;

// The card controller's placeholder while a refresh is in progress.
const PENDING_SHELL_SOURCE_MODE = 'scoped-bootstrap-target';

// A section with no artifact has no recorded status: never carried, no carry.
const recordedStatus = (s) => (s && s.artifact ? normalizeCardStatus(s.artifact.status) : '');

// Lines of content the card's own artifact holds under its title, read from
// what the artifact records (review 2026-11-15). The controller's pending shell
// holds none, whatever a later step appends to it. A line the artifact records
// as its own failure (its blocked reason or a QC failure, such as the
// LIVE-VERIFY-UNKNOWN line refresh-card appends when live QC could not read the
// board) is verification metadata, not content.
function ownLines(s) {
  const artifact = s && s.artifact;
  if (!artifact || !String(artifact.markdown || '').trim()) return 0;
  if (artifact.source && artifact.source.mode === PENDING_SHELL_SOURCE_MODE) return 0;
  const failures = artifact.qc && Array.isArray(artifact.qc.failures) ? artifact.qc.failures : [];
  const recorded = new Set(
    [artifact.blockedReason, ...failures].map((text) => String(text || '').trim()).filter(Boolean),
  );
  return String(s.body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !recorded.has(line)).length;
}

// Parsers report a dead source at the top level ({ blocked }) or one level
// down ({ kind, data: { blocked } }, the AWS shape). Read both (deploy review
// 4d4ebf4e0cf3 R1: a blocked AWS copy slipped past a top-level-only check).
function isParsedSourceDead(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  const inner = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  return Boolean(parsed.blocked || parsed.fallbackExpired || inner.blocked || inner.fallbackExpired);
}

const isFallbackExpired = (s) => Boolean(s && s.data && s.data.fallbackExpired);

// Live QC replaces a card's status with its verdict and keeps the producer's
// in source.producerStatus; a card no verdict touched has only its own.
const producerStatus = (s) =>
  normalizeCardStatus((s.artifact.source && s.artifact.source.producerStatus) || s.artifact.status);

function needsCarry(s) {
  const status = recordedStatus(s);
  return (
    isFallbackExpired(s) ||
    (Boolean(status) && status !== 'clean' && producerStatus(s) !== 'clean' && ownLines(s) < 2)
  );
}

const isCleanCopy = (p) =>
  recordedStatus(p) === 'clean' && ownLines(p) > 0 && !isParsedSourceDead(p.data);

// When the copy was produced. One the board loader rebuilt from a day's
// markdown is stamped with the time it was read: only its board date is known.
function producedAt(artifact) {
  const source = artifact.source || {};
  const rebuiltAtRead = source.mode === 'markdown-fallback' || source.replacedMarkdownFallback;
  return rebuiltAtRead ? '' : String(artifact.generatedAt || '');
}

function attempt(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// "Mon, Nov 9, 5:12 AM CT" when the copy carries a time, else "Mon, Nov 9".
function formatStaleSince(iso, fromDate) {
  const ms = Date.parse(String(iso || ''));
  if (Number.isFinite(ms)) {
    const text = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
    return `${text.replace(/ at /, ', ')} CT`;
  }
  const dayMs = Date.parse(`${fromDate}T12:00:00Z`);
  if (!Number.isFinite(dayMs)) return String(fromDate || 'an earlier board');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(dayMs));
}

// sections: today's parsed sections, each with its card artifact (mutated in
// place and returned). cardIdForTitle(title) -> manifest card id or ''.
// priorDates: board dates in any order; only the MAX_LOOKBACK_DAYS days before
// `date` are read, newest first. loadPriorSections(date) -> that board's
// sections. isUsablePrior(prior, { cardId, date }) -> optional host check (the
// dashboard re-parses the copy as of its own board and rejects one whose
// source was already expired or blocked there).
function applyStaleProducerCarryForward(
  sections,
  { date, cardIdForTitle, priorDates = [], loadPriorSections, isUsablePrior } = {},
) {
  const list = Array.isArray(sections) ? sections : [];
  if (typeof cardIdForTitle !== 'function' || typeof loadPriorSections !== 'function') return list;
  const targets = list.filter((s) => {
    const id = s && cardIdForTitle(s.title);
    return id && !INELIGIBLE_CARD_IDS.has(id) && needsCarry(s);
  });
  if (!targets.length) return list;
  const day = String(date || '');
  const floorMs = Date.parse(`${day}T00:00:00Z`) - MAX_LOOKBACK_DAYS * 86400000;
  const oldest = Number.isFinite(floorMs) ? new Date(floorMs).toISOString().slice(0, 10) : day;
  const lookback = [...new Set(priorDates.map(String))]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < day && d >= oldest)
    .sort()
    .reverse();
  const boards = new Map();
  const priorBoard = (d) => {
    if (!boards.has(d)) {
      const loaded = attempt(() => loadPriorSections(d));
      boards.set(d, Array.isArray(loaded) ? loaded : []);
    }
    return boards.get(d);
  };
  const hostAccepts = (p, id, d) =>
    typeof isUsablePrior !== 'function' ||
    attempt(() => isUsablePrior(p, { cardId: id, date: d })) === true;
  for (const s of targets) {
    const id = cardIdForTitle(s.title);
    for (const d of lookback) {
      const prior = priorBoard(d).find(
        (p) => p && cardIdForTitle(p.title) === id && isCleanCopy(p) && hostAccepts(p, id, d),
      );
      if (!prior) continue;
      const refreshedAt = producedAt(prior.artifact);
      s.staleProducer = {
        since: formatStaleSince(refreshedAt, d),
        reason: isFallbackExpired(s)
          ? 'its newest source set is more than 24 hours old'
          : "today's refresh has not produced a card",
        fromDate: d,
      };
      s.body = prior.body;
      // The tile's refresh label must agree with the banner, never show the
      // time of today's failed card over the earlier copy.
      s.refreshedAt = refreshedAt || s.staleProducer.since;
      break;
    }
  }
  return list;
}

function staleProducerBannerText(staleProducer) {
  if (!staleProducer) return '';
  return `Stale since ${staleProducer.since} because ${staleProducer.reason}. Showing the last good card.`;
}

// A carried card is amber end to end. Specialized renderers pick their own
// headline colors from the old numbers (AWS paints its dollar figures green),
// so every metric color class on a carried card becomes amber (review R4).
const METRIC_COLOR_RE = /\bmetric-(?:green|red|amber|warn|neutral)\b/g;
function amberMetricClasses(html) {
  return String(html || '').replace(METRIC_COLOR_RE, 'metric-yellow');
}

module.exports = {
  INELIGIBLE_CARD_IDS,
  MAX_LOOKBACK_DAYS,
  amberMetricClasses,
  isParsedSourceDead,
  formatStaleSince,
  applyStaleProducerCarryForward,
  staleProducerBannerText,
};
