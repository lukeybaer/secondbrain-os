'use strict';

// scripts/self-heal/card-blocker-lessons.js
//
// STRUCTURED LESSON CAPTURE (ExampleCo dispatch 2026-07-12 evening): "Every time a
// card can't update, it has a blocker, that needs to be a lesson where this
// engineered workflow can learn from that, harden the pipes, fix them, and
// fail less often in the future. Make sure that's happening."
//
// This is the defect-to-lesson-to-hardening loop:
//   1. THIS module captures the lesson: one row per (date, card, defectKind)
//      still blocked at the end of a run, appended to
//      <dataDir>/agent/card-blocker-lessons.jsonl.
//   2. scripts/agentic-healer-driver.js reads the last 3 lessons for each
//      target card back INTO its mission prompt (lastLessonsForCard /
//      lastLessonsByCard) so the healer starts from prior root-cause
//      knowledge instead of rediscovering it every night.
//   3. scripts/self-heal/hardening-backlog-sync.js promotes a defect that
//      recurs on 2+ distinct dates within a 14-day window into a scored
//      FEATURE BACKLOG entry (findRecurringDefects), so recurrence becomes
//      visible work instead of ambient pain.
//   4. scripts/self-heal/card-blocker-lessons-rollup.js formats a weekly
//      digest (rollupForWindow / formatRollupMarkdown) appended to
//      dev-plans/core/briefing.LESSONS.md.
//
// Wired into the SINGLE chokepoint scripts/agentic-healer-driver.js's
// feedSelfHealHealth, which runs at the tail of BOTH
// scripts/ec2-morning-briefing-run.sh paths (legacy full-build and
// card-controller authority), so lesson capture fires on every morning run
// without a second wiring point that could silently go stale.
//
// Row schema:
//   { date, card, defectKind, qcMessage, rootCauseHypothesis, tacticsTried,
//     outcome, hardeningItem, ts }
//
// Dedupe: one row per (date, card, defectKind); a re-run the same day for the
// same defect signature does not inflate the count.

const fs = require('node:fs');
const path = require('node:path');
const ledger = require('./briefing-repair-ledger.js');

const LESSONS_REL = path.join('agent', 'card-blocker-lessons.jsonl');

// Readers never scan more than this many tail bytes (Codex review 2026-07-15:
// the jsonl is append-only forever; an unbounded synchronous full-file scan
// would slowly turn lesson capture and prompt seeding into a morning-run
// cost). ~400 bytes/row and a handful of rows per day means 1 MiB of tail is
// years of history, and the read path stays O(1) in file age.
const MAX_READ_BYTES = 1024 * 1024;

function defaultDataDir() {
  return ledger.defaultDataDir();
}

function lessonsPath(opts = {}) {
  return path.join(opts.dataDir || defaultDataDir(), LESSONS_REL);
}

function appendJsonl(absPath, row) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.appendFileSync(absPath, JSON.stringify(row) + '\n');
  return row;
}

function isValidDateStr(s) {
  return (
    typeof s === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(`${s}T00:00:00Z`))
  );
}

// Schema gate for rows read back from disk (Codex review 2026-07-15): a
// parsed-but-malformed row must be SKIPPED, never repaired. Repairing (e.g.
// coercing a bad date to today via safeDate) lets one corrupt line poison
// today's dedupe key or fake a recurrence, silently suppressing a real lesson
// or promoting a false backlog item.
function isValidLessonRow(row) {
  return (
    !!row &&
    typeof row === 'object' &&
    !Array.isArray(row) &&
    isValidDateStr(row.date) &&
    typeof row.card === 'string' &&
    row.card.trim() !== '' &&
    typeof row.defectKind === 'string'
  );
}

// Tail-bounded read: at most the last MAX_READ_BYTES of the file. When the
// read starts mid-file the first (partial) line is dropped.
function readTailUtf8(p, maxBytes) {
  const stat = fs.statSync(p);
  if (stat.size <= maxBytes) return { text: fs.readFileSync(p, 'utf8'), truncated: false };
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    return { text: buf.toString('utf8'), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

function readLessonRows(opts = {}) {
  const p = lessonsPath(opts);
  if (!fs.existsSync(p)) return [];
  const { text, truncated } = readTailUtf8(p, opts.maxReadBytes || MAX_READ_BYTES);
  const lines = text.split('\n');
  if (truncated) lines.shift(); // first line is almost certainly partial
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (isValidLessonRow(row)) out.push(row);
      // schema-malformed rows are skipped, same as corrupt ones: never repaired
    } catch {
      // a corrupt line is skipped, never fatal: the lesson log must never wedge the healer
    }
  }
  return out;
}

function lessonKey({ date, card, defectKind }) {
  return `${ledger.safeDate(date)}::${String(card || '').toLowerCase()}::${String(
    defectKind || '',
  ).toLowerCase()}`;
}

// Parse the card id out of a raw render-QC defect string. Observed shapes:
// "TYPE: card_id (evidence)", "TYPE: card_id broken", "... -> card_id (evidence)".
function extractCardIdFromDefect(defectText) {
  const text = String(defectText || '');
  let m = text.match(/^[A-Z0-9_-]+:\s*([a-z][a-z0-9_]*)\b/i);
  if (m) return m[1].toLowerCase();
  m = text.match(/->\s*([a-z][a-z0-9_]*)\s*\(/i);
  if (m) return m[1].toLowerCase();
  return '';
}

// The raw defect string (truncated) naming this card, first match wins. Falls
// back to a generic message built from the card's defectKinds when no raw
// defect string names this card explicitly (never blank).
function qcMessageForCard(cardId, rawDefects, fallbackKinds = []) {
  const id = String(cardId || '').toLowerCase();
  const list = Array.isArray(rawDefects) ? rawDefects : [];
  for (const d of list) {
    if (extractCardIdFromDefect(d) === id) return String(d).slice(0, 300);
  }
  const kinds = (fallbackKinds || []).filter(Boolean);
  return kinds.length
    ? `card "${cardId}" still defective: ${kinds.join(', ')}`
    : `card "${cardId}" still defective (no raw defect text recorded)`;
}

function buildHardeningItem({ card, defectKind, qcMessage }) {
  return `Harden the ${card} pipeline for "${defectKind}" defects: add a mechanical pre-check, a per-card heal entry, or a root-cause code fix so this stops reaching a live-QC blocker. Latest QC: ${String(
    qcMessage || '',
  ).slice(0, 160)}`;
}

function existingKeysForDate(date, opts) {
  const keys = new Set();
  for (const row of readLessonRows(opts)) {
    // rows from readLessonRows are schema-validated: row.date is already a
    // real YYYY-MM-DD, so it is compared verbatim (never coerced to today).
    if (!row || row.date !== ledger.safeDate(date)) continue;
    keys.add(lessonKey({ date: row.date, card: row.card, defectKind: row.defectKind }));
  }
  return keys;
}

// Record one lesson row per (date, card, defectKind) still blocked. `cards`
// is [{ card, defectKinds, qcMessage, rootCauseHypothesis, tacticsTried,
// outcome, hardeningItem }] -- only `card` is required, everything else is
// derived with an honest default. Returns the rows actually written (dedupe
// silently skips an already-recorded date+card+defectKind key).
function recordLessons({ date, cards, opts = {} } = {}) {
  const d = ledger.safeDate(date);
  const seen = existingKeysForDate(d, opts);
  const written = [];
  for (const c of cards || []) {
    const card = String((c && c.card) || '').toLowerCase();
    if (!card) continue;
    const kinds =
      Array.isArray(c.defectKinds) && c.defectKinds.length ? c.defectKinds : ['unspecified'];
    for (const defectKind of kinds) {
      const key = lessonKey({ date: d, card, defectKind });
      if (seen.has(key)) continue;
      const qcMessage = c.qcMessage || `card "${card}" still defective: ${defectKind}`;
      const row = {
        date: d,
        card,
        defectKind: String(defectKind),
        qcMessage: String(qcMessage).slice(0, 300),
        rootCauseHypothesis:
          String(c.rootCauseHypothesis || '').slice(0, 500) ||
          'not yet known: no healer session reflection recorded for this defect this run',
        tacticsTried: Array.isArray(c.tacticsTried) ? [...new Set(c.tacticsTried.map(String))] : [],
        outcome: String(c.outcome || 'blocked'),
        hardeningItem: c.hardeningItem || buildHardeningItem({ card, defectKind, qcMessage }),
        ts: new Date().toISOString(),
      };
      appendJsonl(lessonsPath(opts), row);
      written.push(row);
      seen.add(key);
    }
  }
  return written;
}

// Build lesson rows directly from an agentic-healer-driver.js receipt: any
// receipt.perDefect entry whose outcome is NOT 'cleared' is still blocked.
// `artifact` is the fresh live-board artifact (raw defect text + per-card
// defectKinds); `tacticRows` is the self-heal-tactics.jsonl rows (feeds
// tacticsTried). Both optional -- missing input degrades to a thinner but
// still honest lesson row, never a crash.
function recordFromAgenticHealerReceipt({ receipt, artifact, tacticRows = [], opts = {} } = {}) {
  if (!receipt || !Array.isArray(receipt.perDefect) || !receipt.perDefect.length) return [];
  const rawDefects = artifact && Array.isArray(artifact.defects) ? artifact.defects : [];
  const artifactCards = artifact && Array.isArray(artifact.cards) ? artifact.cards : [];
  const beforeCards =
    receipt.defectsBefore && Array.isArray(receipt.defectsBefore.cards)
      ? receipt.defectsBefore.cards
      : [];
  const cardsInput = [];
  for (const o of receipt.perDefect) {
    if (!o || o.outcome === 'cleared') continue;
    const cardId = String(o.cardId || (o.card && o.card.id) || '').toLowerCase();
    if (!cardId) continue;
    const beforeCard = beforeCards.find((c) => String(c.id).toLowerCase() === cardId);
    const artifactCard = artifactCards.find((c) => String(c.id).toLowerCase() === cardId);
    const defectKinds =
      artifactCard && artifactCard.defectKinds && artifactCard.defectKinds.length
        ? artifactCard.defectKinds
        : beforeCard && beforeCard.defectKinds && beforeCard.defectKinds.length
          ? beforeCard.defectKinds
          : ['unspecified'];
    const qcMessage = qcMessageForCard(cardId, rawDefects, defectKinds);
    const defectKey = o.defect || `${cardId}:LIVE-BOARD-DEFECT`;
    const tactics = (tacticRows || [])
      .filter((t) => t && ledger.normDefectKey(t.defect) === ledger.normDefectKey(defectKey))
      .map((t) => t.tactic)
      .filter(Boolean);
    const sessionReflection =
      receipt.session && receipt.session.reflection ? String(receipt.session.reflection) : '';
    const rootCauseHypothesis = sessionReflection
      ? sessionReflection.slice(0, 400)
      : String(o.reason || '').slice(0, 400);
    cardsInput.push({
      card: cardId,
      defectKinds,
      qcMessage,
      rootCauseHypothesis,
      tacticsTried: [...new Set(tactics)],
      outcome: o.outcome,
    });
  }
  return recordLessons({ date: receipt.date, cards: cardsInput, opts });
}

// FALLBACK RECORDER (Codex review 2026-07-12: BRIEFING_SKIP_AGENTIC_HEALER=1
// makes the healer never run, so its receipt-based recorder above never
// fires). This reads the live board artifact DIRECTLY -- no healer receipt
// required -- and records one lesson row per still-defective card, so "the
// healer did not run this cycle" can never silently mean "no lesson was
// captured." Used only when the artifact is KNOWN FRESH (this run's own
// build/publish just wrote it); a missing or stale artifact is intentionally
// NOT covered here (recording a card-level lesson from data we do not trust
// would be fabrication, not a lesson -- feedback_no_fabrication_in_briefings).
function recordFromLiveBoardArtifact({
  date,
  artifact,
  tacticRows = [],
  reasonNote,
  opts = {},
} = {}) {
  if (!artifact || !Array.isArray(artifact.cards)) return [];
  const rawDefects = Array.isArray(artifact.defects) ? artifact.defects : [];
  const defectiveCards = artifact.cards.filter((c) => c && c.status !== 'clean');
  const cardsInput = defectiveCards.map((c) => {
    const cardId = String(c.id || '').toLowerCase();
    const defectKinds = c.defectKinds && c.defectKinds.length ? c.defectKinds : ['unspecified'];
    const qcMessage = qcMessageForCard(cardId, rawDefects, defectKinds);
    const defectKey = `${cardId}:LIVE-BOARD-DEFECT`;
    const tactics = (tacticRows || [])
      .filter((t) => t && ledger.normDefectKey(t.defect) === ledger.normDefectKey(defectKey))
      .map((t) => t.tactic)
      .filter(Boolean);
    return {
      card: cardId,
      defectKinds,
      qcMessage,
      rootCauseHypothesis:
        reasonNote || 'no healer session ran this cycle; recorded from the live board directly',
      tacticsTried: [...new Set(tactics)],
      outcome: 'blocked-no-healer-run',
    };
  });
  return recordLessons({ date: date || artifact.date, cards: cardsInput, opts });
}

// PROMPT FEED (item 2): the last N lesson rows for one card, newest first.
//
// STALENESS + RELEVANCE GUARD (Codex review 2026-07-15): a lesson from an
// old or already-fixed defect on the same card must not be injected as
// authoritative guidance for a different current defect. So:
//   - only rows within `maxAgeDays` of `nowDate` qualify (default 14 days,
//     the same window findRecurringDefects uses: one consistent notion of
//     "recent" across the loop);
//   - when the caller passes the card's CURRENT `defectKinds`, rows matching
//     one of those kinds are preferred; other recent rows only fill leftover
//     slots (context, ranked below the relevant ones).
function selectPromptRows(rows, { limit = 3, maxAgeDays = 14, nowDate, defectKinds } = {}) {
  const today = ledger.safeDate(nowDate);
  const recent = rows
    .filter((r) => withinWindow(r.date, today, maxAgeDays))
    .sort((a, b) => String(b.ts || b.date).localeCompare(String(a.ts || a.date))); // newest first
  const kinds = new Set(
    (Array.isArray(defectKinds) ? defectKinds : []).map((k) => String(k || '').toLowerCase()),
  );
  if (!kinds.size) return recent.slice(0, limit);
  const matching = recent.filter((r) => kinds.has(String(r.defectKind || '').toLowerCase()));
  const rest = recent.filter((r) => !kinds.has(String(r.defectKind || '').toLowerCase()));
  return [...matching, ...rest].slice(0, limit);
}

function lastLessonsForCard(cardId, opts = {}, limit = 3, filter = {}) {
  const id = String(cardId || '').toLowerCase();
  const rows = readLessonRows(opts).filter((r) => String(r.card || '').toLowerCase() === id);
  return selectPromptRows(rows, { ...filter, limit });
}

// `kindsByCard` (optional): { <cardId>: [current defectKinds] } so each
// card's feed prefers lessons about the defect actually on the board today.
function lastLessonsByCard(cardIds, opts = {}, limit = 3, filter = {}) {
  const rows = readLessonRows(opts);
  const kindsByCard = filter.kindsByCard || {};
  const out = {};
  for (const cardId of cardIds || []) {
    const id = String(cardId || '').toLowerCase();
    const cardRows = rows.filter((r) => String(r.card || '').toLowerCase() === id);
    out[cardId] = selectPromptRows(cardRows, {
      ...filter,
      limit,
      defectKinds: kindsByCard[cardId] || kindsByCard[id] || filter.defectKinds,
    });
  }
  return out;
}

// RECURRENCE (item 3): group all lesson rows by (card, defectKind). Pure over
// already-read rows so both the sync script and its tests can call it without
// touching the filesystem directly.
function groupByCardDefect(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    if (!r || !r.card) continue;
    const key = `${String(r.card).toLowerCase()}::${String(r.defectKind || '').toLowerCase()}`;
    const g = byKey.get(key) || {
      card: String(r.card).toLowerCase(),
      defectKind: String(r.defectKind || ''),
      rows: [],
    };
    g.rows.push(r);
    byKey.set(key, g);
  }
  return [...byKey.values()];
}

function withinWindow(dateStr, nowDate, windowDays) {
  const d = Date.parse(`${dateStr}T00:00:00Z`);
  const now = Date.parse(`${nowDate}T00:00:00Z`);
  if (!Number.isFinite(d) || !Number.isFinite(now)) return false;
  const days = (now - d) / (24 * 3600 * 1000);
  return days >= 0 && days <= windowDays;
}

// A defect that recorded a lesson on 2+ DISTINCT dates within the trailing
// `windowDays` (default 14) is recurring: the pipeline keeps hitting the same
// wall instead of the fix sticking. Returns groups meeting the threshold,
// sorted by recurrence depth.
function findRecurringDefects({ opts = {}, nowDate, windowDays = 14, minDistinctDates = 2 } = {}) {
  const today = ledger.safeDate(nowDate);
  const rows = readLessonRows(opts);
  const groups = groupByCardDefect(rows);
  const out = [];
  for (const g of groups) {
    const distinctDates = [
      ...new Set(
        g.rows
          .map((r) => ledger.safeDate(r.date))
          .filter((d) => withinWindow(d, today, windowDays)),
      ),
    ].sort();
    if (distinctDates.length < minDistinctDates) continue;
    const latest = g.rows[g.rows.length - 1];
    out.push({
      card: g.card,
      defectKind: g.defectKind,
      distinctDates,
      occurrences: g.rows.length,
      latestQcMessage: latest ? latest.qcMessage : '',
      latestRootCause: latest ? latest.rootCauseHypothesis : '',
      hardeningItem:
        latest && latest.hardeningItem
          ? latest.hardeningItem
          : buildHardeningItem({ card: g.card, defectKind: g.defectKind, qcMessage: '' }),
    });
  }
  return out.sort((a, b) => b.distinctDates.length - a.distinctDates.length);
}

// WEEKLY ROLLUP (item 4): aggregate lesson rows by card for [sinceDate,
// untilDate] (both inclusive, YYYY-MM-DD strings). Pure, no I/O beyond the
// read.
function rollupForWindow({ opts = {}, sinceDate, untilDate } = {}) {
  const rows = readLessonRows(opts).filter((r) => r && r.date >= sinceDate && r.date <= untilDate);
  const byCard = new Map();
  for (const r of rows) {
    const card = String(r.card || '').toLowerCase();
    const g = byCard.get(card) || { card, count: 0, kinds: new Map(), outcomes: new Map() };
    g.count += 1;
    g.kinds.set(r.defectKind, (g.kinds.get(r.defectKind) || 0) + 1);
    const outcome = String(r.outcome || 'blocked');
    g.outcomes.set(outcome, (g.outcomes.get(outcome) || 0) + 1);
    byCard.set(card, g);
  }
  return [...byCard.values()].sort((a, b) => b.count - a.count);
}

// Format the rollup as one dated markdown entry matching the existing
// dev-plans/core/*.LESSONS.md `## <heading>` convention.
function formatRollupMarkdown({ opts = {}, sinceDate, untilDate } = {}) {
  const cards = rollupForWindow({ opts, sinceDate, untilDate });
  const header = `## Card-blocker lessons weekly digest: ${sinceDate} to ${untilDate}`;
  if (!cards.length) {
    return [
      header,
      '',
      'No card-blocker lessons recorded this week: every card cleared before a lesson was captured, or nothing blocked.',
      '',
    ].join('\n');
  }
  const lines = [
    header,
    '',
    `**What happened:** ${cards.length} card(s) recorded at least one blocker lesson this week.`,
    '',
  ];
  for (const c of cards) {
    const kindsList = [...c.kinds.entries()].map(([k, n]) => `${k} x${n}`).join(', ');
    const outcomesList = [...c.outcomes.entries()].map(([k, n]) => `${k} x${n}`).join(', ');
    lines.push(
      `- **${c.card}**: ${c.count} lesson(s) across ${c.kinds.size} defect kind(s) [${kindsList}] -- outcomes: ${outcomesList}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  LESSONS_REL,
  MAX_READ_BYTES,
  defaultDataDir,
  lessonsPath,
  isValidDateStr,
  isValidLessonRow,
  readLessonRows,
  selectPromptRows,
  lessonKey,
  extractCardIdFromDefect,
  qcMessageForCard,
  buildHardeningItem,
  recordLessons,
  recordFromAgenticHealerReceipt,
  recordFromLiveBoardArtifact,
  lastLessonsForCard,
  lastLessonsByCard,
  groupByCardDefect,
  findRecurringDefects,
  rollupForWindow,
  formatRollupMarkdown,
};
