'use strict';

const crypto = require('node:crypto');
const { resolveDataArtifact } = require('./data-root.js');
const { systemHealthChipStatus, isAdvisorySystemHealthItem } = require('./system-health-face-status.js');
const { isOwnerPausedVideoWork } = require('./video-work-policy.js');

function exactEvidenceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Life Archive backfill coverage metrics.
 *
 * ExampleCo, 2026-09-08: Life coverage rows are yellow advisories until proven
 * green. They stay visible in the denominator and never enter the red total
 * or the repair frontier. Current ingestion failures retain their own probes.
 */
const DEFERRED_BACKFILL_MEASUREMENT_PREFIXES = ['system_health:life-'];

function isDeferredBackfillMeasurement(id) {
  const key = String(id || '').toLowerCase();
  return DEFERRED_BACKFILL_MEASUREMENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// The permanent metric row set. The board-truth reader is the last boundary
// before a count reaches ExampleCo, so the denominator is the registry, never
// whatever rows one night's artifact happened to carry.
const { registeredLedgerIds } = require('./system-health-ledger.js');

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
 * CANONICAL COUNT DEFINITION: every non-System-Health source card is one unit
 * and every exact System Health measurement is one unit. The Blockers and
 * System Health containers count as zero. A source card represented by exact
 * System Health rows also counts as zero, so the visible metrics cannot be
 * duplicated through their parent. Never count raw defect strings or re-parse
 * markdown to invent another denominator.
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
// 'defect'. This mirrors dev-plans/core/briefing.md's clean/defect/blocked
// three-state contract at the per-card level.
function cardStatusFromDefects(defects) {
  const list = Array.isArray(defects) ? defects : [];
  if (!list.length) return 'clean';
  if (list.some((d) => /^BLOCKED-(?:CARD|TILE):/i.test(String(d || '')))) return 'blocked';
  return 'defect';
}

// Stable slug for a build-known blocker entry so a blocker with no manifest
// card id still produces a distinct, deduplicated card row. Pure + deterministic
// (title-derived) so the same blocker always maps to the same synthetic id.
function blockerCardId(blocker) {
  const explicit = blocker && (blocker.id || blocker.cardId);
  if (explicit) return String(explicit);
  const title = String((blocker && blocker.title) || '').toLowerCase();
  const slug = title
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return slug ? `blocker_${slug}` : 'blocker_unnamed';
}

// The canonical count and the visible Blockers list MUST derive from ONE truth
// (ExampleCo 2026-07-07 paradigm hot button): it is never acceptable for the markdown
// to list N blockers while defectiveCardCount reads 0. The render-QC catches
// cards that render broken on the LIVE page; but when the live page is briefly
// unreachable (ran:false, retry:true) the render-QC has nothing to say, while the
// BUILD still knows real blockers (recorded test failures, a non-green Dev Ops
// probe). Those build-known blockers are the same truth the Blockers section
// lists, so they must seed the canonical cards too -- otherwise the artifact
// falsely reads 0 while the markdown lists 1. This helper turns each build
// blocker into a defective card entry.
function blockersToCards(blockers, ts, options = {}) {
  const list = Array.isArray(blockers) ? blockers : [];
  const byId = new Map();
  for (const b of list) {
    if (!b || !b.title) continue;
    // Synthetic build blockers predate stable card IDs. Keep the one canonical
    // title fail-closed so a stale title-only row cannot re-red the paused card.
    const exactPausedVideoTitle = /^Video approval queue has unresolved rejected work$/i.test(
      String(b.title || '').trim(),
    );
    const id = exactPausedVideoTitle ? 'video_approval_queue' : blockerCardId(b);
    if (isOwnerPausedVideoWork(id, options) ||
        (exactPausedVideoTitle && isOwnerPausedVideoWork('video_approval_queue', options))) continue;
    if (byId.has(id)) continue; // one card per distinct blocker
    const kind = classifyDefectKind(b.category || b.title || '');
    byId.set(id, {
      id,
      title: String(b.title),
      status: 'defect',
      defectKinds: [kind],
      defectEvidenceHash: exactEvidenceHash({
        id,
        title: String(b.title),
        category: String(b.category || ''),
        blocker: String(b.blocker || b.evidence || ''),
      }),
      asOf: ts,
    });
  }
  return [...byId.values()];
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
//
// `blockers` (optional) is the build's own named-blocker list (the same entries
// the Blockers markdown section renders). It SEEDS the cards ONLY when the live
// render-QC did not itself produce a defective-card verdict: when render-QC
// could not run (ran:false, retry) or ran and found zero defective cards, the
// artifact would otherwise falsely read 0 defective cards while the build's
// Blockers section legitimately lists blockers (recorded test failures, a
// non-green Dev Ops probe) it knows about independent of the live page. In that
// case the build blockers become the canonical defective cards so the count and
// the Blockers list share ONE truth (ExampleCo 2026-07-07). When render-QC RAN and
// found defective cards, its live-render verdict is authoritative and complete
// (it already saw every rendered tile, including any blocked ones), so the
// build blockers are NOT additively merged -- that would double-count the same
// underlying defect whenever the pre-render blocker title differs from the
// rendered tile title.
function buildLiveBoardArtifact({
  dashQc,
  date,
  cardTitles = {},
  blockers = [],
  ownerPaused,
  now = () => new Date(),
} = {}) {
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
      ...(Array.isArray(c.dependsOn) && c.dependsOn.length ? { dependsOn: c.dependsOn } : {}),
      defectEvidenceHash: exactEvidenceHash({
        id: c.id,
        defects: defects.map(String),
      }),
      asOf: ts,
    };
  });
  // Seed build-known blockers only when the live render-QC did not produce its
  // own defective-card verdict (see the doc comment above). A render-QC card
  // already covering the same card id or normalized title still wins.
  const renderFoundDefectiveCards = cards.some((c) => c.status !== 'clean');
  const buildBlockerCards = blockersToCards(blockers, ts, { ownerPaused });
  if (!renderFoundDefectiveCards) {
    const haveTitles = new Set(cards.map((c) => normalizeCardTitle(c.title)));
    for (const bc of buildBlockerCards) {
      const existingIndex = cards.findIndex((card) => String(card.id) === bc.id);
      if (existingIndex >= 0) {
        if (bc.id === 'video_approval_queue') {
          cards[existingIndex] = { ...bc, title: cards[existingIndex].title || bc.title };
        }
        haveTitles.add(normalizeCardTitle(cards[existingIndex].title));
        continue;
      }
      if (haveTitles.has(normalizeCardTitle(bc.title))) continue;
      cards.push(bc);
    }
  } else {
    // This exact build-known queue blocker is independent of unrelated render
    // defects. Upgrade only its stale-clean row; other build blockers remain
    // non-additive while live render-QC already has red cards.
    for (const bc of buildBlockerCards.filter((row) => row.id === 'video_approval_queue')) {
      const existingIndex = cards.findIndex((card) => String(card.id) === bc.id);
      if (existingIndex >= 0 && cards[existingIndex].status === 'clean') {
        cards[existingIndex] = { ...bc, title: cards[existingIndex].title || bc.title };
      } else if (existingIndex < 0) {
        cards.push(bc);
      }
    }
  }
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

// The executive briefing denominator is not a card count. Every source card
// other than the derived Blockers and System Health containers contributes one
// unit, and every exact System Health measurement contributes one unit. Both
// containers contribute zero so defects cannot be double-counted through a
// summary parent. Informational measurements stay visible in the denominator
// but are neither green nor red.
// A self_heal_health card that only mirrors failures of other cards which are
// themselves non-clean on this board is not an independent red unit (it would
// double count them). Fail closed: no dependsOn, or any dependency that is
// absent from the board or clean, keeps the card its own unit.
// The one red-unit rule for a board card: anything not clean is red unless the
// owner paused it (yellow). Mirroring and unit counts share it.
function boardCardIsRed(card, options = {}) {
  if (!card || !card.id) return false;
  return card.status !== 'clean' && !isOwnerPausedVideoWork(card.id, options);
}

function isMirroredSummaryCard(card, artifact, options = {}) {
  if (!card || card.id !== 'self_heal_health') return false;
  const deps = Array.isArray(card.dependsOn) ? card.dependsOn.map((id) => String(id)) : [];
  if (!deps.length) return false;
  const cards = (artifact && artifact.cards) || [];
  return deps.every((id) =>
    cards.some((c) => c && String(c.id) === id && c.id !== card.id && boardCardIsRed(c, options)),
  );
}

function briefingUnitCounts(artifact, options = {}) {
  if (!artifact || !Array.isArray(artifact.cards) || artifact.cards.length === 0) {
    return null;
  }
  const otherCards = artifact.cards.filter(
    (card) => card && card.id !== 'blockers' &&
      card.id !== 'system_health' &&
      !card.representedBy &&
      !isMirroredSummaryCard(card, artifact, options),
  );
  const systemHealthCardPresent = artifact.cards.some(
    (card) => card && card.id === 'system_health',
  );
  const rawMeasurements = Array.isArray(artifact.systemHealthMeasurements)
    ? artifact.systemHealthMeasurements
    : [];
  const measurementsById = new Map();
  rawMeasurements.forEach((unit, index) => {
    if (!unit) return;
    const id = String(unit.id || unit.name || `system_health:measurement-${index + 1}`).trim();
    if (!id) return;
    const prior = measurementsById.get(id);
    measurementsById.set(
      id,
      prior && prior.status !== unit.status
        ? { ...unit, id, status: 'unverified' }
        : { ...unit, id },
    );
  });
  const measurements = [...measurementsById.values()];
  const otherCardUnits = otherCards.map((card) => ({
    id: String(card.id || card.title || 'unknown'),
    title: String(card.title || card.id || 'Unknown card'),
    status: isOwnerPausedVideoWork(card.id, options)
      ? 'yellow'
      : card.status === 'clean'
        ? 'green'
        : 'red',
    kind: 'card',
    // Every source card is repairable by the unattended night. Only metric
    // rows carry an ownership gate.
    actionable: !isOwnerPausedVideoWork(card.id, options),
  }));
  // Operational rows stay red until proven green. Life coverage, owner-disabled
  // services, lifetime catch-up and release bookkeeping are the owner-specified
  // yellow advisory exceptions, including older red artifacts.
  const measurementUnits = measurements.map((unit) => {
    const id = String(unit.id);
    const status = systemHealthChipStatus(unit, options);
    return {
      id,
      title: String(unit.name || unit.id || 'System Health measurement'),
      status,
      kind: 'system-health-measurement',
      // OWNERSHIP IS NOT COLOR (ExampleCo, 2026-09-07). An immutable or other
      // non-plannable red row is honest, but the unattended night can never repair it, so
      // it must not sit in the repair frontier forever and block the early
      // research handoff. The ledger projection is the authority; a row from a
      // producer that predates the projection defaults to actionable.
      actionable: status === 'red' && unit.actionable !== false,
    };
  });
  const units = [...otherCardUnits, ...measurementUnits];
  const redUnits = units.filter((unit) => unit.status === 'red');
  const actionableRedUnits = redUnits.filter((unit) => unit.actionable !== false);
  const yellowUnits = units.filter((unit) => unit.status === 'yellow');
  const informationalUnits = units.filter((unit) => unit.status === 'informational');
  const greenUnits = units.filter((unit) => unit.status === 'green');
  return {
    total: units.length,
    green: greenUnits.length,
    red: redUnits.length,
    yellow: yellowUnits.length,
    informational: informationalUnits.length,
    otherCardTotal: otherCardUnits.length,
    otherCardGreen: otherCardUnits.filter((unit) => unit.status === 'green').length,
    otherCardRed: otherCardUnits.filter((unit) => unit.status === 'red').length,
    systemHealthMetricTotal: measurementUnits.length,
    systemHealthMetricGreen: measurementUnits.filter((unit) => unit.status === 'green').length,
    systemHealthMetricRed: measurementUnits.filter((unit) => unit.status === 'red').length,
    systemHealthMetricYellow: measurementUnits.filter((unit) => unit.status === 'yellow').length,
    systemHealthMetricInformational: informationalUnits.length,
    // The ledger's row set is the denominator: the board is complete only when
    // every registered metric id is present. A missing or partial artifact can
    // no longer shrink the board and still look whole.
    complete:
      !systemHealthCardPresent || registeredLedgerIds().every((id) => measurementsById.has(id)),
    systemHealthMetricRedActionable: measurementUnits.filter(
      (unit) => unit.status === 'red' && unit.actionable !== false,
    ).length,
    units,
    greenUnits,
    redUnits,
    actionableRedUnits,
    yellowUnits,
    informationalUnits,
  };
}

// A digest of one repair unit's OWN board row. Terminal repair proof is bound
// to the board ts it was assembled on, and any sibling write re-stamps that ts
// (2026-09-24: the otter SLA proof went stale four seconds after it landed).
// This lets the same proof survive a sibling-only write while any change to
// the unit's own verdict, defect evidence, or attempt reopens it. Timestamp-
// only prose such as "proof 2m old" and asOf stamps are deliberately excluded.
// Returns '' when the unit is not on the board.
function unitEvidenceDigest(artifact, unitId) {
  const id = String(unitId || '')
    .trim()
    .toLowerCase();
  if (!id || !artifact) return '';
  const matches = (row) =>
    String((row && row.id) || '')
      .trim()
      .toLowerCase() === id;
  const measurement = (
    Array.isArray(artifact.systemHealthMeasurements) ? artifact.systemHealthMeasurements : []
  ).find(matches);
  if (measurement) {
    return exactEvidenceHash({
      kind: 'system-health-measurement',
      id,
      status: measurement.status || null,
      actionable: measurement.actionable !== false,
      attemptOutcome: measurement.attemptOutcome || null,
      attemptFinishedAt: measurement.attemptFinishedAt || null,
      provenAt: measurement.provenAt || null,
    });
  }
  const card = (Array.isArray(artifact.cards) ? artifact.cards : []).find(matches);
  if (!card) return '';
  return exactEvidenceHash({
    kind: 'card',
    id,
    status: card.status || null,
    defectKinds: [...(Array.isArray(card.defectKinds) ? card.defectKinds : [])].map(String).sort(),
    defectEvidenceHash: card.defectEvidenceHash || null,
  });
}

// One canonical board rollup for every summary surface. The header and
// Blockers card may phrase the result differently, but neither may derive a
// second verdict from markdown, card copy, or raw defect strings.
function briefingAggregateStatus(artifact) {
  const count = defectiveCardCount(artifact);
  const units = briefingUnitCounts(artifact);
  if (count === null || !units) {
    return {
      status: 'unverified',
      defectiveCardCount: null,
      nonHealthDefectiveCardCount: null,
      systemHealthMeasurementFailureCount: null,
      redUnitCount: null,
      greenUnitCount: null,
      yellowUnitCount: null,
      informationalUnitCount: null,
      totalUnitCount: null,
    };
  }
  const cards = Array.isArray(artifact.cards) ? artifact.cards : [];
  const verified =
    artifact.ran === true &&
    artifact.retry !== true &&
    typeof artifact.ok === 'boolean' &&
    units.complete;
  return {
    status: verified ? (units.red > 0 ? 'blocked' : 'clean') : 'unverified',
    defectiveCardCount: count,
    nonHealthDefectiveCardCount: cards.filter(
      (card) =>
        card &&
        card.status !== 'clean' &&
        card.id !== 'blockers' &&
        card.id !== 'system_health' &&
        !card.representedBy &&
        !isMirroredSummaryCard(card, artifact),
    ).length,
    systemHealthMeasurementFailureCount: units.systemHealthMetricRed,
    redUnitCount: units.red,
    greenUnitCount: units.green,
    yellowUnitCount: units.yellow,
    informationalUnitCount: units.informational,
    totalUnitCount: units.total,
  };
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

// Lexical YYYY-MM-DD check. No calendar validation (parsing "2026-13-40" is
// not this guard's job) -- every caller already produces its date from
// ctDateAndHour or an operator --date flag matching this same shape, so the
// check exists only to keep a malformed or missing value from ever comparing
// as a false regression.
function isBoardDateLiteral(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// WRITE-SIDE guard, the counterpart to isStale's read-side check: every writer
// of the live board artifact calls this before it writes, so a lagging
// producer cannot clobber a newer date's board with an older one (the
// 2026-09-14 23:17 CT race: a midday run that started before 11pm rollover
// published after the next day's overnight run already landed, and the board
// carried the wrong date all night). Pure, no clock -- the caller supplies
// both dates. A missing, unreadable, or date-less existing board never blocks;
// there is nothing to regress against yet.
function assertBoardDateNotRegressing(existingBoard, nextDate) {
  const existingDate = existingBoard && existingBoard.date;
  if (!isBoardDateLiteral(existingDate) || !isBoardDateLiteral(nextDate)) return;
  if (nextDate < existingDate) {
    const error = new Error(
      `board date regression refused: on-disk board is dated ${existingDate}, incoming write is dated ${nextDate}`,
    );
    error.code = 'BOARD_DATE_REGRESSION';
    throw error;
  }
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

// THE Blockers-tile headline count (ExampleCo 2026-07-07 converge fix). The tile
// headline must be EXACTLY the canonical defectiveCardCount when a fresh artifact
// exists -- never a re-derivation from parsed markdown, and never Math.max(canonical,
// parsedRowCount). The old ec2-server.js used Math.max(liveCount, items.length),
// which let the count of PARSED blocker rows (10 rows on one morning, several
// collapsing onto the same card) override the canonical distinct-card count (8),
// re-creating the exact "two numbers for one fact" split
// feedback_live_board_is_the_only_count.md forbids. Rules, in order:
//   - fresh artifact  -> canonical defectiveCardCount (the one true number).
//   - stale/absent artifact -> fall back to the locally parsed row count
//     (`parsedRowCount`), which the caller must footnote as a fallback.
// The "a checkmark must never hide blockers" guarantee is preserved by the CALLER:
// it only reaches this helper past its own empty-set early returns, and when the
// fresh canonical is 0 while rows exist (a lagging artifact) this still returns 0 --
// so the caller keeps its defense-in-depth "rows present => show a number" note for
// that narrow lag window rather than folding it into the canonical count here.
function blockersTileHeadlineCount({ artifact, stale, parsedRowCount = 0 } = {}) {
  const canonical = defectiveCardCount(artifact);
  const haveFresh = canonical !== null && artifact && !stale;
  if (haveFresh) return canonical;
  return Number.isFinite(parsedRowCount) ? parsedRowCount : 0;
}

function normalizeIssueText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function blockerMatchesSystemHealthIssue(blocker, systemHealthIssueNames = []) {
  const title = normalizeIssueText(blocker && blocker.title);
  const cardId = normalizeIssueText(blocker && (blocker.cardId || blocker.id));
  const text = normalizeIssueText(
    [
      blocker && blocker.title,
      blocker && blocker.blocker,
      blocker && blocker.evidence,
      blocker && blocker.nextRepair,
      blocker && blocker.need,
    ]
      .filter(Boolean)
      .join(' '),
  );
  if (!text) return false;
  // The render catch-all historically emitted a generic `SYSTEM HEALTH is
  // red` row whose evidence was only `subsystems ok`. It named none of the
  // failed measurements, so name-based filtering could not recognize it and
  // Blockers repeated the entire System Health card as a separate issue.
  if (
    cardId === 'system health' ||
    /^system health(?: card)?(?: is)? (?:red|blocked|non green)$/.test(title) ||
    (title.startsWith('system health') && /\b(?:subsystems ok|system data health)\b/.test(text))
  ) {
    return true;
  }
  return (systemHealthIssueNames || []).some((name) => {
    const needle = normalizeIssueText(name);
    return needle && text.includes(needle);
  });
}

// Executive issue count for the BLOCKERS tile face. System Health measurements
// are first-class work units on their own card and never inflate or duplicate
// the general Blockers count. We still return their names so the renderer can
// explain how many were intentionally separated.
function blockerIssueSummary({ blockers = [], systemHealthIssueNames = [] } = {}) {
  const uniqueHealth = [];
  const seenHealth = new Set();
  for (const name of systemHealthIssueNames || []) {
    const clean = String(name || '').trim();
    const key = normalizeIssueText(clean);
    if (!clean || seenHealth.has(key)) continue;
    seenHealth.add(key);
    uniqueHealth.push(clean);
  }
  const nonHealthBlockers = (blockers || []).filter(
    (blocker) => !blockerMatchesSystemHealthIssue(blocker, uniqueHealth),
  );
  return {
    systemHealthIssueNames: uniqueHealth,
    systemHealthIssueCount: uniqueHealth.length,
    nonHealthBlockerCount: nonHealthBlockers.length,
    nonHealthBlockers,
    issueCount: nonHealthBlockers.length,
  };
}

function blockerCardIdentity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\brender\s+qc\s+defect\b|\bknown\s+blocker\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function isGeneralBlockerCard(card) {
  const id = blockerCardIdentity(card && card.id);
  const kind = blockerCardIdentity(card && card.kind);
  const title = blockerCardIdentity(card && card.title);
  const defects = [
    ...(Array.isArray(card && card.defects) ? card.defects : []),
    ...(Array.isArray(card && card.defectKinds) ? card.defectKinds : []),
  ];
  const hasActionableSystemHealthMeasurement =
    (Array.isArray(card && card.systemHealthMeasurementFailures) &&
      card.systemHealthMeasurementFailures.length > 0) ||
    defects.some((defect) =>
      /^SYSTEM-HEALTH-MEASUREMENT(?::|$)/i.test(String(defect || '').trim()),
    );
  return !(
    id === 'blockers' ||
    kind === 'blockers' ||
    title.startsWith('blockers') ||
    ((id === 'systemhealth' || kind === 'systemhealth' || title.startsWith('systemhealth')) &&
      !hasActionableSystemHealthMeasurement)
  );
}

function hasOnlyBlockersNamedCardDefects(card) {
  if (!card || card.status === 'clean') return false;
  const defects = Array.isArray(card.defects)
    ? card.defects
    : Array.isArray(card.defectKinds)
      ? card.defectKinds
      : [];
  const meaningful = defects
    .map((defect) => String(defect || '').trim())
    .filter(Boolean)
    .filter((defect) => !/^(?:defect|non-clean|nonclean)$/i.test(defect));
  if (!meaningful.length) return false;
  return meaningful.every((defect) => /^BLOCKERS-NAMED-CARD:/i.test(defect));
}

function blockerRowMatchesCard(row, card) {
  const cardAliases = [card && card.id, card && card.title, card && card.manifestTitle]
    .map(blockerCardIdentity)
    .filter((value) => value.length >= 5);
  const rowAliases = [row && row.id, row && row.cardId, row && row.title]
    .map(blockerCardIdentity)
    .filter(Boolean);
  if (
    rowAliases.some((left) =>
      cardAliases.some((right) => left === right || left.includes(right) || right.includes(left)),
    )
  ) {
    return true;
  }
  const rowText = blockerCardIdentity(
    [
      row && row.title,
      row && row.blocker,
      row && row.evidence,
      row && row.nextRepair,
      row && row.need,
    ]
      .filter(Boolean)
      .join(' '),
  );
  return cardAliases.some((alias) => rowText.includes(alias));
}

function genericCardHealthWrapper(row, card) {
  const title = normalizeIssueText(row && row.title);
  const evidence = normalizeIssueText(
    [row && row.blocker, row && row.evidence].filter(Boolean).join(' '),
  );
  const requirement = normalizeIssueText(row && row.requirement);
  const cardAliases = [card && card.id, card && card.title, card && card.manifestTitle]
    .map(normalizeIssueText)
    .filter(Boolean);
  const titleIsStatusShell =
    /(?:^| )is (?:red|blocked|non green)$/.test(title) &&
    cardAliases.some((alias) => title.includes(alias));
  const evidenceIsHealthShell =
    /\bblocked\b/.test(evidence) && /\b(?:system data health|render quality)\b/.test(evidence);
  const requirementIsCatchAll = /every red or blocked card must be named/.test(requirement);
  return titleIsStatusShell || evidenceIsHealthShell || requirementIsCatchAll;
}

function blockerSpecificity(row, card) {
  if (genericCardHealthWrapper(row, card)) return -1;
  return [row && row.blocker, row && row.evidence, row && row.nextRepair, row && row.need]
    .filter(Boolean)
    .join(' ').length;
}

function collapseRowsForCard(rows, card) {
  const specific = rows.filter((row) => !genericCardHealthWrapper(row, card));
  const candidates = specific.length ? specific : rows;
  const chosen = candidates
    .slice()
    .sort((a, b) => blockerSpecificity(b, card) - blockerSpecificity(a, card))[0];
  if (!chosen) return null;
  const evidence = [];
  const seen = new Set();
  for (const row of candidates) {
    const value = String((row && (row.blocker || row.evidence)) || '').trim();
    const key = normalizeIssueText(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    evidence.push(value);
  }
  return {
    ...chosen,
    cardId: (card && card.id) || chosen.cardId,
    blocker: evidence.join(' | ') || chosen.blocker || chosen.evidence || '',
  };
}

// One row collection for both the Blockers tile face and its drilldown. Parsed
// markdown owns the prose when it already identifies a card. Fresh live-board
// truth adds any missing non-clean card so the face count, clickable data-item,
// and detail body cannot disagree.
function reconcileBlockerRows({ blockers = [], liveCards = [] } = {}) {
  const sourceRows = (Array.isArray(blockers) ? blockers : []).map((row) => ({ ...row }));
  const allCards = (Array.isArray(liveCards) ? liveCards : []).filter(
    (card) => card && isGeneralBlockerCard(card),
  );
  const cards = allCards.filter(
    (card) => card.status !== 'clean' && !hasOnlyBlockersNamedCardDefects(card),
  );
  const groups = new Map();
  sourceRows.forEach((row, index) => {
    const card = allCards.find((candidate) => blockerRowMatchesCard(row, candidate));
    if (!card) return;
    const key = blockerCardIdentity(card.id || card.title);
    const group = groups.get(key) || { card, indexes: [], rows: [] };
    group.indexes.push(index);
    group.rows.push(row);
    groups.set(key, group);
  });
  const firstIndexForGroup = new Map(
    [...groups.entries()].map(([key, group]) => [group.indexes[0], key]),
  );
  const groupedIndexes = new Set([...groups.values()].flatMap((group) => group.indexes));
  const rows = [];
  sourceRows.forEach((row, index) => {
    const groupKey = firstIndexForGroup.get(index);
    if (groupKey) {
      const group = groups.get(groupKey);
      if (group.card.status === 'clean' || hasOnlyBlockersNamedCardDefects(group.card)) return;
      const collapsed = collapseRowsForCard(group.rows, group.card);
      if (collapsed) rows.push(collapsed);
      return;
    }
    if (groupedIndexes.has(index)) return;
    if (blockerMatchesSystemHealthIssue(row, [])) return;
    rows.push(row);
  });
  for (const card of cards) {
    if (rows.some((row) => blockerRowMatchesCard(row, card))) continue;
    const measurementFailures = Array.isArray(card.systemHealthMeasurementFailures)
      ? card.systemHealthMeasurementFailures
      : [];
    rows.push({
      id: card.id,
      title: card.title || card.id,
      blocker: measurementFailures.length
        ? `System Health has ${measurementFailures.length} actionable non-green measurement(s): ${measurementFailures
            .map((unit) => unit.name || unit.id)
            .filter(Boolean)
            .join(', ')}.`
        : (Array.isArray(card.defectKinds) ? card.defectKinds : []).join(', ') ||
          'Fresh live QC reports this card non-clean; the rendered Blockers body had no row.',
      nextRepair: measurementFailures.length
        ? 'Open System Health for exact evidence and repair the named measurement.'
        : 'Refresh this card source and republish through the controller.',
    });
  }
  return rows.map((row, index) => ({ ...row, n: index + 1 }));
}

// A private, generation-pinned Gate-A preview may replace accepted status for
// exactly the candidate card under review. This is a render-only projection:
// siblings stay accepted-board truth, and a non-clean candidate cannot erase
// its retained Blockers row. The loader has already authenticated the request
// and journal/hash-validated gateAPreview; re-check its loaded section binding
// here so missing or mismatched provenance fails closed.
function overlayExactPreviewTargetStatus({ liveCards = [], sections = [], gateAPreview = null } = {}) {
  const cards = Array.isArray(liveCards) ? liveCards : [];
  if (!gateAPreview) return cards;
  const cardId = String(gateAPreview.cardId || '').trim();
  const generationId = String(gateAPreview.generationId || '').trim();
  if (!cardId || !generationId || cardId === 'blockers' || cardId === 'system_health') {
    return cards;
  }
  const targetSection = (Array.isArray(sections) ? sections : []).find(
    (section) => String(section && section.artifact && section.artifact.id) === cardId,
  );
  const artifact = targetSection && targetSection.artifact;
  if (
    !artifact ||
    String(artifact.acceptedGenerationId || '') !== generationId
  ) {
    const error = new Error('exact preview target status lacks matching loaded provenance');
    error.code = 'BRIEFING_PREVIEW_BINDING_INVALID';
    throw error;
  }
  if (String(artifact.status || '').toLowerCase() !== 'clean') return cards;

  const target = {
    id: cardId,
    title: artifact.title || cardId,
    manifestTitle: artifact.title || '',
    status: 'clean',
    defectKinds: [],
  };
  let replaced = false;
  const effective = cards.map((card) => {
    if (String(card && card.id) !== cardId) return card;
    replaced = true;
    return { ...card, ...target };
  });
  if (!replaced) effective.push(target);
  return effective;
}

// The caller passes the LEDGER PROJECTION; this function never invents,
// recolors, adds, or drops a row.
function applySystemHealthMeasurementTruth(artifact, measurements) {
  const next = {
    ...(artifact || {}),
    cards: Array.isArray(artifact && artifact.cards)
      ? artifact.cards.map((card) => ({ ...card }))
      : [],
    defects: Array.isArray(artifact && artifact.defects) ? artifact.defects.slice() : [],
  };
  // Normalize advisories (Life coverage, owner-disabled services, lifetime
  // catch-up, release bookkeeping) so old snapshots cannot inflate current counts.
  const units = (Array.isArray(measurements) ? measurements : []).filter(Boolean)
    .map((unit) => isAdvisorySystemHealthItem(unit) ? { ...unit, status:systemHealthChipStatus(unit), actionable:false } : { ...unit });
  next.systemHealthMeasurements = units;
  const failed = units.filter((unit) => systemHealthChipStatus(unit) === 'red');
  if (failed.length) {
    let health = next.cards.find((card) => card && card.id === 'system_health');
    if (!health) {
      health = {
        id: 'system_health',
        title: 'SYSTEM HEALTH',
        status: 'defect',
        defectKinds: [],
        asOf: next.ts || new Date().toISOString(),
      };
      next.cards.push(health);
    }
    health.status = health.status === 'blocked' ? 'blocked' : 'defect';
    health.defectKinds = [
      ...new Set([
        ...(health.defectKinds || []),
        'system/data health',
        'SYSTEM-HEALTH-MEASUREMENT',
      ]),
    ];
    health.systemHealthMeasurementFailures = failed.map((unit) => ({
      id: unit.id || '',
      name: unit.name || unit.id || 'measurement',
      status: unit.status || 'unverified',
    }));
    // ONE aggregate defect, not one per row. The permanent ledger means a
    // fresh board legitimately carries dozens of red metric rows; pushing one
    // string each buried every other card's defect under the 200-entry cap and
    // made the defect list unreadable. The exact per-row truth already lives in
    // `systemHealthMeasurementFailures` above and in the ledger itself, which
    // is what the healer and the roster read.
    const named = failed.slice(0, 10).map((unit) => String(unit.id || unit.name || 'unknown'));
    const message = `SYSTEM-HEALTH-MEASUREMENT: system_health ${failed.length} metric row(s) not proven green: ${named.join(', ')}${
      failed.length > named.length ? `, +${failed.length - named.length} more` : ''
    }`;
    if (!next.defects.includes(message)) next.defects.push(message);
  }
  next.defects = next.defects.slice(0, 200);
  next.defectCount = next.defects.length;
  next.defectiveCardCount = next.cards.filter((card) => card && card.status !== 'clean').length;
  next.ok = next.defectiveCardCount === 0;
  return next;
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

// PER-CARD COMPLETION SUMMARY (ExampleCo wave 3a, 2026-07-12). The morning runner's
// completion line enumerates exact briefing-unit outcomes instead of a scalar
// verdict like "published-blocked". Every non-System-Health card is one unit;
// each System Health measurement is one unit; the System Health container is
// zero. Pure over the canonical artifact; consumed by cloud-morning-briefing.js main() and
// scripts/briefing-completion-line.js (the shell runner's reader).
function perCardCompletionSummary(artifact, nowMs = Date.now()) {
  const counts = briefingUnitCounts(artifact);
  if (!counts || !counts.complete) {
    return {
      published: 0,
      total: 0,
      held: [],
      informational: 0,
      line:
        counts && !counts.complete
          ? 'briefing-unit state unavailable: System Health measurement proof is missing.'
          : 'briefing-unit state unavailable: no live dashboard QC artifact for this run.',
    };
  }
  const held = counts.redUnits.map((unit) => unit.id);
  const yellow = counts.yellowUnits.map((unit) => unit.id);
  const staleNote = isStale(artifact, nowMs)
    ? ' (artifact stale; last live QC is older than one briefing cycle)'
    : '';
  const redText = held.length ? `[${held.join(', ')}]` : 'none';
  const yellowText = yellow.length ? `[${yellow.join(', ')}]` : 'none';
  const line = `published ${counts.green}/${counts.total} briefing units green; red: ${redText}; yellow: ${yellowText}; informational: ${counts.informational}${staleNote}`;
  return {
    published: counts.green,
    total: counts.total,
    held,
    yellow,
    informational: counts.informational,
    line,
  };
}

module.exports = {
  isDeferredBackfillMeasurement,
  ARTIFACT_REL_PATH,
  STALE_AFTER_MS,
  classifyDefectKind,
  cardStatusFromDefects,
  blockerCardId,
  blockersToCards,
  buildLiveBoardArtifact,
  defectiveCardCount,
  boardCardIsRed,
  briefingUnitCounts,
  briefingAggregateStatus,
  unitEvidenceDigest,
  isStale,
  assertBoardDateNotRegressing,
  readLiveBoardArtifact,
  normalizeCardTitle,
  findCardByTitle,
  cardDefectBadge,
  blockersTileHeadlineCount,
  blockerIssueSummary,
  isGeneralBlockerCard,
  hasOnlyBlockersNamedCardDefects,
  blockerRowMatchesCard,
  reconcileBlockerRows,
  overlayExactPreviewTargetStatus,
  applySystemHealthMeasurementTruth,
  blockerMatchesSystemHealthIssue,
  perCardCompletionSummary,
};
