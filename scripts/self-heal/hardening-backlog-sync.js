'use strict';

// scripts/self-heal/hardening-backlog-sync.js
//
// STRUCTURED LESSON CAPTURE, item 3 (ExampleCo dispatch 2026-07-12 evening):
// recurrence becomes visible work, not ambient pain. When the same
// card+defectKind shows up in data/agent/card-blocker-lessons.jsonl on 2+
// DISTINCT dates within a trailing 14-day window
// (scripts/self-heal/card-blocker-lessons.js findRecurringDefects), this
// promotes it into a scored FEATURE BACKLOG entry (category: 'hardening',
// evidence source: 'card-blocker-lessons') via scripts/feature-backlog.js. A
// repeat recurrence bumps the SAME entry's signal score (addPainEvent)
// instead of creating a duplicate: the entry id is deterministic from
// card+defectKind, so this sync is idempotent.
//
// Receipt-backed: scripts/feature-backlog.js saveBacklog() already writes
// data/agent/backlog-research-receipt.json on every save (the D8 contract,
// scripts/lib/backlog-run-receipt.js), so a save from this sync produces the
// same receipt proof any other backlog writer does. This module never saves
// (and so never touches the receipt) when there is nothing new to record: a
// no-op run must not overwrite today's research-loop receipt with an
// unrelated "nothing changed" claim.

const crypto = require('node:crypto');
const cardBlockerLessons = require('./card-blocker-lessons.js');

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// The id is deterministic from card+defectKind (idempotent upsert), but the
// human-readable slug alone is truncated and could collide for two distinct
// long defectKinds on the same card (Codex review 2026-07-12). The 8-char
// hash suffix is derived from the FULL, untruncated identity, so it stays
// distinct even when the slugs collide -- collision-safe by construction,
// not by truncation length.
function hardeningFeatureId(card, defectKind) {
  const identity = `${String(card || '').toLowerCase()}::${String(defectKind || '').toLowerCase()}`;
  const hash = crypto.createHash('sha1').update(identity).digest('hex').slice(0, 8);
  return `hardening-${slugify(card)}-${slugify(defectKind)}-${hash}`;
}

function buildProposal({
  card,
  defectKind,
  distinctDates,
  occurrences,
  latestQcMessage,
  latestRootCause,
  hardeningItem,
}) {
  const id = hardeningFeatureId(card, defectKind);
  const title = `Harden ${card}: recurring "${defectKind}" blocker`;
  const description = `${card} has hit a live-QC "${defectKind}" blocker on ${distinctDates.length} distinct day(s) in the last 14: ${distinctDates.join(', ')}.`;
  const problemStatement = `The ${card} card has recorded a "${defectKind}" blocker lesson on ${distinctDates.length} distinct dates (${distinctDates.join(', ')}), ${occurrences} occurrence(s) total, per data/agent/card-blocker-lessons.jsonl. Recurrence across multiple mornings means the healer is repeatedly re-discovering (or failing to clear) the same root cause instead of the pipeline being hardened against it. Latest root-cause hypothesis: ${String(latestRootCause || 'none recorded').slice(0, 200)}`;
  const evidence = distinctDates.map((d) => ({
    source: 'card-blocker-lessons',
    detail: `${d}: ${card} ${defectKind}`,
  }));
  const implementationPlan =
    hardeningItem ||
    `Add a mechanical pre-check or per-card heal entry for ${card} in scripts/self-heal/mechanical-runbook.js (or the heal field on scripts/lib/briefing-card-manifest.js), or root-cause the "${defectKind}" defect directly in the ${card} generator/renderer, so this stops reaching a live blocker. Latest QC: ${String(latestQcMessage || '').slice(0, 200)}`;
  return {
    id,
    title,
    description,
    category: 'hardening',
    initialScore: Math.min(60, 20 + occurrences * 8),
    strategicImpact: Math.min(80, 30 + distinctDates.length * 10),
    problemStatement,
    evidence,
    implementationPlan,
  };
}

// Sync recurring card-blocker lessons into the feature backlog. Idempotent:
// re-running with the same recurring set updates (never duplicates) the same
// deterministic-id entry. Never throws; a backlog I/O failure is the
// caller's problem to log, not this healer's crash.
function syncHardeningBacklog({
  opts = {},
  nowDate,
  windowDays = 14,
  minDistinctDates = 2,
  backlogModule,
} = {}) {
  const backlog = backlogModule || require('../feature-backlog.js');
  const recurring = cardBlockerLessons.findRecurringDefects({
    opts,
    nowDate,
    windowDays,
    minDistinctDates,
  });
  if (!recurring.length) return { added: 0, updated: 0, recurring: [] };

  const bl = backlog.loadBacklog();
  let added = 0;
  let updated = 0;
  for (const r of recurring) {
    const id = hardeningFeatureId(r.card, r.defectKind);
    const existing = bl.features.find((f) => f.id === id);
    if (existing) {
      backlog.addPainEvent(bl, id, {
        source: 'card-blocker-lessons',
        detail: `recurring ${r.defectKind} on ${r.card}: ${r.distinctDates.join(', ')}`,
        severity: 'recurring_rejection',
      });
      updated += 1;
    } else {
      backlog.createFeature(bl, buildProposal(r));
      added += 1;
    }
  }
  if (added || updated) {
    backlog.rankAndTrim(bl);
    backlog.saveBacklog(bl);
  }
  return { added, updated, recurring };
}

module.exports = {
  slugify,
  hardeningFeatureId,
  buildProposal,
  syncHardeningBacklog,
};
