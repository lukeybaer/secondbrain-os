'use strict';

// scripts/lib/life-archive-freshness.js
//
// ONE freshness rule for the life-archive health snapshot, shared by both
// readers. Codex gate 05a8e5b45303 finding 1: the per-card producer
// (briefing-card-artifacts.js) checked generated_at, but the LIVE 5:30 builder
// (cloud-morning-briefing.js buildFullLifeBackupCard) checked only that
// `sources` was a non-empty array. So the same 42-day-old snapshot was a
// defect on one path and published as real on the other, and the path that
// reaches ExampleCo every morning was the permissive one.
//
// Two readers with two rules is the same class of bug as the aws-cost-section
// BOM split, where one reader stripped it and the other did not. The rule
// lives here so a future edit cannot move one path without the other.
//
// A snapshot older than this cannot describe "the last 24h" for any source,
// so presenting its numbers as today's backup coverage is fabrication
// (law G13, feedback_no_fabrication_in_briefings.md).
const LIFE_ARCHIVE_MAX_SNAPSHOT_AGE_MS = 36 * 60 * 60 * 1000;

// Returns a verdict rather than a boolean so both callers can render the same
// facts without recomputing them, and so "undated" stays distinguishable from
// "old". Undated is treated as stale: an age we cannot prove is not fresh.
function lifeArchiveSnapshotFreshness(snapshot, now = new Date()) {
  const generatedAt = String((snapshot && snapshot.generated_at) || '').trim();
  const generatedMs = Date.parse(generatedAt);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const ageMs = Number.isFinite(generatedMs) ? nowMs - generatedMs : null;
  const sources = Array.isArray(snapshot && snapshot.sources) ? snapshot.sources : [];
  const dbPath = String((snapshot && snapshot.db_path) || '');
  return {
    generatedAt,
    ageMs,
    ageDays: ageMs == null ? null : Math.round(ageMs / 86400000),
    sourceCount: sources.length,
    // A Windows path on a Linux host proves the snapshot was ExampleCod over from
    // a desktop rather than generated where it is read.
    foreignHost: /^[A-Za-z]:\\/.test(dbPath) && process.platform !== 'win32',
    dbPath,
    hasSources: sources.length > 0,
    fresh: ageMs != null && ageMs <= LIFE_ARCHIVE_MAX_SNAPSHOT_AGE_MS,
  };
}

// The single predicate a caller needs to decide whether it may report numbers.
// Non-empty sources is necessary but NEVER sufficient; that was the bug.
function lifeArchiveSnapshotIsReportable(snapshot, now = new Date()) {
  const f = lifeArchiveSnapshotFreshness(snapshot, now);
  return f.fresh && f.hasSources;
}

module.exports = {
  LIFE_ARCHIVE_MAX_SNAPSHOT_AGE_MS,
  lifeArchiveSnapshotFreshness,
  lifeArchiveSnapshotIsReportable,
};
