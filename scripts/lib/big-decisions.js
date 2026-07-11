// scripts/lib/big-decisions.js
//
// Append-only ledger of big decisions Amy made on ExampleCo's behalf: rule
// supersessions, policy adoptions, architecture calls. ExampleCo's dispatch
// (2026-07-11, answer 19): a Big Decisions surface, newest first, 1 to 2
// sentences per entry, normally at most 5 per day and never more than 10,
// history never deleted. Every rule supersession MUST land here in the same
// commit that archives the superseded rule (memory/AMY_AUTHORIZATIONS.md,
// tiebreaker section).
//
// State ownership: data/agent/big-decisions.jsonl is git-tracked curated
// state. It is written by whichever session makes the decision, lands via
// the land gate, and EC2 reads its deployed copy. Do not write it from
// scheduled cloud jobs directly; decisions come from interactive sessions.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const DEFAULT_LEDGER = path.join(REPO, 'data', 'agent', 'big-decisions.jsonl');

const MAX_SUMMARY_CHARS = 300;
const MAX_PER_DAY = 10;
const CATEGORIES = new Set(['rule-supersession', 'policy', 'architecture', 'spend', 'other']);

function ledgerPath(opts) {
  return (opts && opts.ledgerFile) || process.env.BIG_DECISIONS_FILE || DEFAULT_LEDGER;
}

function readAll(opts) {
  const file = ledgerPath(opts);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A torn line must not hide the rest of the history.
    }
  }
  return rows;
}

// The CT date (yyyy-mm-dd) to measure the window from: opts.now as a yyyy-mm-dd
// string or Date, else the current America/Chicago day.
function refDateString(now) {
  if (typeof now === 'string' && /^\d{4}-\d{2}-\d{2}/.test(now)) return now.slice(0, 10);
  const d = now instanceof Date ? now : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
}

// yyyy-mm-dd shifted by deltaDays (string arithmetic on the calendar date).
function shiftDateString(day, deltaDays) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

// Newest first. `days` is a TRUE calendar cutoff ending at the reference day
// (opts.now, default the current CT day): entries dated within the last `days`
// calendar days are kept. It is NOT "the N most recent dates that have
// entries" (that older reading resurfaced weeks-old decisions as current
// during a sparse period, bug found 2026-07-11 building the briefing card).
function readBigDecisions(opts) {
  const rows = readAll(opts);
  const days = opts && opts.days;
  const sorted = rows
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.seq || 0) - (a.seq || 0));
  if (!days) return sorted;
  const cutoff = shiftDateString(refDateString(opts && opts.now), -(days - 1));
  return sorted.filter((r) => String(r.date) >= cutoff);
}

function appendBigDecision(entry, opts) {
  const e = entry || {};
  const problems = [];
  if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date))
    problems.push('date (yyyy-mm-dd, CT) required');
  if (!e.summary || typeof e.summary !== 'string') problems.push('summary required');
  else if (e.summary.length > MAX_SUMMARY_CHARS)
    problems.push(`summary over ${MAX_SUMMARY_CHARS} chars (1 to 2 sentences, ExampleCo's rule)`);
  if (!e.category || !CATEGORIES.has(e.category))
    problems.push(`category must be one of: ${[...CATEGORIES].join(', ')}`);
  if (!e.source) problems.push('source required (dispatch, session, or call that authorized this)');
  if (problems.length) throw new Error('big-decisions: invalid entry: ' + problems.join('; '));

  const existing = readAll(opts).filter((r) => r.date === e.date);
  if (existing.length >= MAX_PER_DAY) {
    throw new Error(
      `big-decisions: ${MAX_PER_DAY} entries already logged for ${e.date}. ` +
        'ExampleCo caps big-decision notifications at 10 per day (5 typical). ' +
        'If this is genuinely a big decision, consolidate or reclassify a lesser entry first.',
    );
  }

  const row = {
    date: e.date,
    seq: existing.length + 1,
    summary: e.summary.trim(),
    category: e.category,
    source: e.source,
    ...(e.supersedes ? { supersedes: e.supersedes } : {}),
    loggedAt: e.loggedAt || new Date().toISOString(),
  };
  const file = ledgerPath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

module.exports = {
  appendBigDecision,
  readBigDecisions,
  MAX_PER_DAY,
  MAX_SUMMARY_CHARS,
  DEFAULT_LEDGER,
};
