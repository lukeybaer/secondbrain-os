'use strict';

const { resolveDataArtifact } = require('./data-root.js');

/**
 * live-board-truth.js
 *
 * ExampleCo's shared-paradigm fix (2026-07-06): QC judges the FINAL PRODUCT (the
 * live rendered dashboard), and the defect count ExampleCo sees must be the ONLY
 * count anywhere. Before this file, three different numbers could legitimately
 * disagree on the same morning: the dashboard tile ("11 hard blockers", built by
 * ec2-server.js buildDashboardSyntheticBlockers from parsed markdown), the
 * markdown BLOCKERS "At a glance" count (built from renderQcBlockers's raw
 * defect-string list, filtered), and whatever a chat/self-heal report quoted
 * from dashQc.defects.length. All three were real numbers computed from real
 * data, but from three DIFFERENT derivations of the same underlying fact.
 *
 * This module is the single schema + reader for the one artifact
 * (`agent/dashboard-qc-result.json`, written by
 * scripts/cloud-morning-briefing.js writeDashboardQcArtifact) that every
 * consumer -- the dashboard tile, the markdown At-a-glance line, chat reports,
 * and self-heal -- must read through. Nobody re-derives the count; everybody
 * calls defectiveCardCount(readLiveBoardArtifact(...).artifact).
 *
 * CANONICAL COUNT DEFINITION: the number of DISTINCT CARDS whose live-rendered
 * status is defect or blocked (never the raw defect-string count, which
 * over-counts a single card with several failing checks, and never a
 * synthetic re-derivation from parsed markdown, which is what produced the
 * "11 vs 9 vs 8" split). This matches verify-dashboard-cards-live.js's own
 * internal `distinctDefectiveCards` accounting (the BLOCKERS-FLOOR/COUNT
 * checks already use this basis; this module promotes it to the durable,
 * shared artifact schema so every OTHER consumer uses the same basis too).
 *
 * SCHEMA (the artifact written by buildLiveBoardArtifact / writeDashboardQcArtifact):
 *   {
 *     ts:                 ISO timestamp of this QC run (asOf for the whole artifact)
 *     date:               YYYY-MM-DD briefing date
 *     ran:                bool, whether the render QC actually executed
 *     ok:                 bool|null, whether the run found zero defects
 *     retry:              bool, true when the run could not verify (transient)
 *     defectiveCardCount: int, canonical count -- cards.filter(c => c.status
 *                         !== 'clean').length. THE number every consumer reads.
 *     cards: [
 *       {
 *         id:          stable manifest card id (scripts/lib/briefing-card-manifest.js)
 *         title:       rendered tile title when known, else the id
 *         status:      'clean' | 'defect' | 'blocked'
 *         defectKinds: [string, ...] deduped category labels (see
 *                      classifyDefectKind), empty when status is 'clean'
 *         asOf:        ISO timestamp this card's status was last verified
 *                      (same as the artifact ts; kept per-card so a future
 *                      partial/targeted refresh can update one card's asOf
 *                      without a whole-artifact rewrite)
 *       }, ...
 *     ]
 *   }
 *
 * STALENESS: an artifact older than STALE_AFTER_MS (one briefing cycle, 24h)
 * is too old to trust as "the live count right now." Consumers must call
 * isStale() and render an honest staleness note rather than a possibly-wrong
 * number (feedback_live_board_is_the_only_count.md).
 */

const ARTIFACT_REL_PATH = 'agent/dashboard-qc-result.json';

// One briefing cycle. The build runs once per day (5:30 AM CT); an artifact
// older than 24h predates the current cycle and must not be presented as "the
// current count" without saying so.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Category classifier for a raw render-QC defect string. Ported from
// cloud-morning-briefing.js renderQcDefectCategory so this module is the one
// place both the artifact writer and any future consumer read the mapping
// from -- renderQcDefectCategory now delegates here (see that file) rather
// than keeping a second copy that could drift.
function classifyDefectKind(defect) {
  const text = String(defect || '');
  if (/^NEWS-(?:PROSE|STUB):/i.test(text)) return 'content/prose';
  if (/^BUILDER-COUNT:|^RENDER-COUNT:/i.test(text)) return 'count/render';
  if (/^BLOCKERS-NAMED-CARD:/i.test(text)) return 'blocked card';
  if (/^BLOCKED-CARD:/i.test(text)) return 'blocked card';
  if (/^MISSING:|^CARD-DUPLICATE:/i.test(text)) return 'card presence';
  if (/^STALE-|stale|older event date/i.test(text)) return 'stale data';
  if (/^BLOCKERS-COUNT:/i.test(text)) return 'blocker accounting';
  if (/^BLOCKED-TILE:/i.test(text)) return 'system/data health';
  return 'render quality';
}

// A card is 'blocked' (proven un-curable, heal loop exhausted) vs plain
// 'defect' (still being retried) when its defects carry the BLOCKED-CARD /
// BLOCKED-TILE markers verify-dashboard-cards-live.js already emits for a
// card the render itself renders red or self-narrates as blocked. Everything
// else that failed a hard check but is not yet proven un-curable stays
// 'defect'. This mirrors dev-plans/core/briefing-qc.md's clean/defect/blocked
// three-state contract at the per-card level.
function cardStatusFromDefects(defects) {
  const list = Array.isArray(defects) ? defects : [];
  if (!list.length) return 'clean';
  if (list.some((d) => /^BLOCKED-(?:CARD|TILE):/i.test(String(d || '')))) return 'blocked';
  return 'defect';
}

// Build the canonical artifact object from the render-QC's raw result shape
// (`{ ran, ok, retry, defects, cardStatuses }`, as returned by
// runDashboardRenderQc in cloud-morning-briefing.js / verifyDashboard in
// verify-dashboard-cards-live.js). Pure function, no I/O, so it is directly
// unit-testable against a synthetic dashQc with no network/fetch.
//
// Each `cardStatuses[i]` entry may already carry its own rendered tile
// `title` (verify-dashboard-cards-live.js records the real tile name it
// matched); `cardTitles` (optional) is a card id -> title map the caller can
// pass INSTEAD when it does not have per-entry titles. Either way the schema
// field always falls back to the card id so it is never blank.
function buildLiveBoardArtifact({ dashQc, date, cardTitles = {}, now = () => new Date() } = {}) {
  const ts = now().toISOString();
  const rawCardStatuses = (dashQc && dashQc.cardStatuses) || [];
  const cards = rawCardStatuses.map((c) => {
    const defects = Array.isArray(c.defects) ? c.defects : [];
    const status = cardStatusFromDefects(defects);
    const defectKinds = [...new Set(defects.map(classifyDefectKind))];
    return {
      id: c.id,
      title: c.title || cardTitles[c.id] || c.id,
      status,
      defectKinds: status === 'clean' ? [] : defectKinds,
      asOf: ts,
    };
  });
  const defectiveCardCount = cards.filter((c) => c.status !== 'clean').length;
  return {
    ts,
    date: date || null,
    ran: !!(dashQc && dashQc.ran),
    ok: dashQc && dashQc.ran ? dashQc.ok !== false : null,
    retry: !!(dashQc && dashQc.retry),
    defectiveCardCount,
    cards,
  };
}

// The single accessor for "how many cards are defective right now." Every
// consumer (tile, markdown, chat, self-heal) calls this instead of
// re-deriving a count from raw defects, parsed markdown, or any other
// secondary source. Returns null when the artifact itself is missing/invalid
// so callers can distinguish "0 defects" from "no artifact to read."
function defectiveCardCount(artifact) {
  if (!artifact || !Array.isArray(artifact.cards)) return null;
  if (Number.isFinite(artifact.defectiveCardCount)) return artifact.defectiveCardCount;
  return artifact.cards.filter((c) => c && c.status !== 'clean').length;
}

// True when the artifact's own ts is older than STALE_AFTER_MS relative to
// `nowMs` (defaults to Date.now()). A missing artifact (ts absent/unparseable)
// counts as stale -- there is nothing fresh to trust.
function isStale(artifact, nowMs = Date.now(), staleAfterMs = STALE_AFTER_MS) {
  if (!artifact || !artifact.ts) return true;
  const ts = Date.parse(artifact.ts);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts > staleAfterMs;
}

// Read the canonical artifact through the shared two-root resolver (repo
// data/ + SECONDBRAIN_DATA_DIR), the same pattern every other card-builder
// reader/writer in this codebase uses (scripts/lib/data-root.js). Returns a
// normalized envelope so callers never touch fs/paths directly.
function readLiveBoardArtifact(opts = {}) {
  const { json, absPath, freshnessMs } = resolveDataArtifact(ARTIFACT_REL_PATH, opts);
  const nowMs = opts.nowMs || Date.now();
  const staleAfterMs = Number.isFinite(opts.staleAfterMs) ? opts.staleAfterMs : STALE_AFTER_MS;
  return {
    artifact: json,
    absPath,
    freshnessMs,
    stale: isStale(json, nowMs, staleAfterMs),
    ageMs:
      json && json.ts && Number.isFinite(Date.parse(json.ts)) ? nowMs - Date.parse(json.ts) : null,
  };
}

// Normalize a rendered card title for cross-source matching: strip a trailing
// "(N)"/"($X ...)" count suffix (titles change count between the QC run and a
// later render of the same card) and case-fold. Pure, exported so both
// ec2-server.js (tile badge lookup) and its regression tests share the exact
// same normalization -- a hand-copied regex in two places is exactly the kind
// of drift this whole fix exists to prevent.
function normalizeCardTitle(title) {
  return String(title || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toUpperCase();
}

// Find a card's live-board status by its rendered tile title (normalized).
// `cards` is the artifact's `cards` array. Returns null when there is no
// artifact/match.
function findCardByTitle(cards, title) {
  const list = Array.isArray(cards) ? cards : [];
  const key = normalizeCardTitle(title);
  return list.find((c) => normalizeCardTitle(c && c.title) === key) || null;
}

// Pure decision function for the per-card defect badge (ExampleCo 2026-07-06
// shared-paradigm fix): given the artifact envelope from readLiveBoardArtifact
// and a rendered section title, decide whether a badge should show and what
// it should say. Returns null when no badge is warranted (no artifact, no
// match, or the card is clean). ec2-server.js turns this into escaped HTML;
// keeping the decision here means the badge logic is unit-testable with no
// HTTP server / HTML parsing involved.
function cardDefectBadge(liveBoardEnvelope, sectionTitle) {
  const artifact = liveBoardEnvelope && liveBoardEnvelope.artifact;
  if (!artifact) return null;
  const card = findCardByTitle(artifact.cards, sectionTitle);
  if (!card || card.status === 'clean') return null;
  const kind = (card.defectKinds && card.defectKinds[0]) || 'render quality';
  const label = card.status === 'blocked' ? 'BLOCKED' : 'DEFECT';
  return {
    label,
    kind,
    stale: !!(liveBoardEnvelope && liveBoardEnvelope.stale),
  };
}

module.exports = {
  ARTIFACT_REL_PATH,
  STALE_AFTER_MS,
  classifyDefectKind,
  cardStatusFromDefects,
  buildLiveBoardArtifact,
  defectiveCardCount,
  isStale,
  readLiveBoardArtifact,
  normalizeCardTitle,
  findCardByTitle,
  cardDefectBadge,
};
