'use strict';

// scripts/lib/big-decisions-card.js
//
// Renders the BIG DECISIONS briefing card from the big-decisions ledger
// (scripts/lib/big-decisions.js, data/agent/big-decisions.jsonl). ExampleCo's
// dispatch (2026-07-11, answer 19, W11): a Big Decisions surface, newest
// first, 1 to 2 sentences per entry, FYI voice, placed right after
// COMMUNICATION COACHING in dashboard order.
//
// ONE shared formatter, both briefing generators (scripts/cloud-morning-
// briefing.js, scripts/manual-briefing-v3.js) call it, so the markdown/Gmail-
// draft copy is byte-identical regardless of which generator produced it --
// there is no second, independently-drifting rendering of the same ledger
// data. This is the intended reading of "the drift lints enforce parity" for
// a card this simple: one function, two call sites, guaranteed identical
// output, rather than hand-duplicated prose in each generator.
//
// LIVE-TILE FOLLOW-UP (out of scope for this change; see
// skills/cards/big_decisions/SKILL.md "Known failure modes"): the polished
// interactive dashboard tile with per-decision click-to-focus (data-item)
// needs a bespoke ec2-server.js reader that loads data/agent/big-
// decisions.jsonl directly and renders `kind: 'bigDecisions'`, mirroring the
// existing COMMUNICATION COACHING pattern (ec2-server.js reads its dated JSON
// snapshot directly and builds `data: { kind: 'commCoaching', ...snap }`,
// bypassing the markdown body for the live tile the same way -- see the
// comment above that injector). Until that lands, BIG DECISIONS renders
// through the generic markdown fallback (`{ kind: 'raw', text: body }` in
// ec2-server.js's parseSectionData) -- a real, honest, readable tile, just
// without the polished per-row click-to-focus. The `key` this module computes
// per decision (bigDecisionItemKey) is exactly the id a future tile reader
// should reuse for its `data-item` attribute, so the two never drift onto
// different id schemes for the same entry.

const { readBigDecisions } = require('./big-decisions');

const TITLE = 'BIG DECISIONS';
const WINDOW_DAYS = 7;
const EMPTY_PLACEHOLDER = 'No big decisions in the last 7 days.';

// America/Chicago calendar date as YYYY-MM-DD (matches ctDateKey in
// scripts/comm-coaching-card.js -- "times in CT, never UTC").
function ctDateKey(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// The CT calendar date `days` days before `now`, as a YYYY-MM-DD string.
function daysAgoCtDateKey(days, now) {
  const base = now instanceof Date ? now : new Date();
  return ctDateKey(new Date(base.getTime() - days * 24 * 60 * 60 * 1000));
}

// Stable per-decision key (date + the per-day sequence appendBigDecision
// already assigns). Exported so a future ec2-server.js tile reader and this
// module's own tests agree on one derivation.
function bigDecisionItemKey(entry) {
  return `bd-${entry.date}-${entry.seq}`;
}

// The per-decision "why it matters" is the entry's OWN summary text, never a
// generic per-category blurb (feedback_per_item_why_it_matters.md). ExampleCo's
// ledger rule caps every summary at 1-2 sentences and requires it to already
// state the concrete consequence, not just the category (see the worked
// entries in data/agent/big-decisions.jsonl: "...per-call ExampleCo approval
// retired for that floor", "...Gmail-draft-as-delivery retired from the
// spec"). Reusing it verbatim is the honest choice: a separately-authored
// "why" line would either duplicate that same sentence or invent commentary
// the ledger entry never recorded. A semicolon-split heuristic was
// considered and rejected -- several real entries (e.g. the PRIVATE_NAME-authority
// decision) are a single clause with no natural split, which would have
// produced a broken sentence fragment for those rows.
function whyItMatters(entry) {
  return entry.summary;
}

function decisionLine(entry) {
  const key = bigDecisionItemKey(entry);
  const supersedesNote = entry.supersedes ? ` Supersedes: ${entry.supersedes}.` : '';
  return `- [${key}] ${entry.date} (${entry.category}): ${entry.summary}${supersedesNote}`;
}

// Enriched per-decision record for consumers that want structure instead of
// the flat markdown line (tests, and the future ec2-server.js tile reader).
function enrichDecision(entry) {
  return {
    key: bigDecisionItemKey(entry),
    date: entry.date,
    seq: entry.seq,
    category: entry.category,
    summary: entry.summary,
    supersedes: entry.supersedes || null,
    whyItMatters: whyItMatters(entry),
  };
}

// Build the card's data: the last `days` CALENDAR days of decisions (newest
// first), the crisp face line (last-7-days count + the newest decision's
// one-liner, per ExampleCo's spec), and the full body text. Never throws for a
// missing or torn ledger (readBigDecisions's readAll already treats ENOENT as
// [] and silently skips unparseable lines -- a torn line must not fail the
// card). `ok: false` is reserved for a genuinely unexpected failure so a
// caller's never-drop manifest loop can fall back to an honest blocker
// instead of a fabricated card.
//
// Deliberately does NOT pass `days` to readBigDecisions(): that helper's own
// `days` option keeps the most recent N DISTINCT WRITE-DATES found in the
// ledger, not a true last-N-calendar-days-from-now cutoff. During a
// genuinely sparse period (no big decisions for weeks) that would resurface
// old entries as if they were current -- exactly the silent-stale-card class
// this card must not produce. Reading the FULL history and filtering by a
// real CT calendar cutoff here is what makes a truly empty week render the
// honest placeholder instead of ancient history.
function buildBigDecisionsSection(opts = {}) {
  const days = Number.isFinite(opts.days) ? opts.days : WINDOW_DAYS;
  let allRows;
  try {
    allRows = readBigDecisions({ ledgerFile: opts.ledgerFile });
  } catch (err) {
    return {
      ok: false,
      reason: `big-decisions ledger unreadable: ${(err && err.message) || err}`,
    };
  }
  // Inclusive N-day window ending TODAY: today counts as day 1, so the cutoff
  // is (days - 1) days back, not `days` back (which would make an 8-day
  // window for days=7 -- an off-by-one that would let one extra stale day
  // slip in).
  const cutoff = daysAgoCtDateKey(Math.max(days - 1, 0), opts.now);
  const rows = allRows.filter((r) => String(r.date) >= cutoff);
  const decisions = rows.map(enrichDecision);
  const count = decisions.length;
  // Empty week: an explicit placeholder, never a silently dropped card.
  const face =
    count === 0
      ? EMPTY_PLACEHOLDER
      : `${count} big decision${count === 1 ? '' : 's'} in the last ${days} days. Newest: ${decisions[0].summary}`;
  const bodyLines = count === 0 ? [EMPTY_PLACEHOLDER] : decisions.map(decisionLine);
  return {
    ok: true,
    count,
    days,
    face,
    decisions,
    bodyText: [face, '', ...bodyLines].join('\n'),
  };
}

// The exact "TITLE:\n\nBODY" shape scripts/cloud-morning-briefing.js's local
// legacySection() produces -- reimplemented here (not required from that
// file, which is not a library module) so this shared module has no
// dependency on either generator, and both generators call the SAME function
// for byte-identical output.
function renderBigDecisionsMarkdown(section) {
  if (!section || !section.ok) return null;
  return `${TITLE}:\n\n${section.bodyText}`;
}

module.exports = {
  TITLE,
  WINDOW_DAYS,
  EMPTY_PLACEHOLDER,
  ctDateKey,
  daysAgoCtDateKey,
  bigDecisionItemKey,
  whyItMatters,
  buildBigDecisionsSection,
  renderBigDecisionsMarkdown,
};
