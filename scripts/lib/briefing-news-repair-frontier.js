'use strict';

const crypto = require('node:crypto');

const {
  CARDS,
  getCardById,
  getNewsMinimum,
  getNewsTarget,
  isNewsCard,
} = require('./briefing-card-manifest.js');
const { qcCard } = require('./briefing-card-qc.js');
const { newsTitleLooksJumbled } = require('../verify-dashboard-cards-live.js');

const DELIVERY_CRITICAL_NEWS_CARD_IDS = Object.freeze([
  'ai_tech_news',
  'us_news',
  'world_news',
]);
const DELIVERY_CRITICAL_NEWS_CARD_SET = new Set(DELIVERY_CRITICAL_NEWS_CARD_IDS);
// Derive the complete news owner from the manifest so the overnight graph cannot
// silently fall back to a copied three-card list. The employer card is
// mention-or-zero; it shares publication/QC but does not need summary preparation.
const SUMMARY_BACKED_NEWS_CARD_IDS = Object.freeze(
  CARDS.filter((card) => isNewsCard(card) && Number.isFinite(getNewsTarget(card))).map(
    (card) => card.id,
  ),
);
// Every manifest news card. Repair-quality ranking and the per-card legacy
// straight-line script still cover the employer card by exact id.
const NEWS_CARD_IDS = Object.freeze(
  CARDS.filter((card) => isNewsCard(card)).map((card) => card.id),
);
const NEWS_CARD_SET = new Set(NEWS_CARD_IDS);
// The cards the controller routes to the straight-line news owner, the global
// Jev pipeline. That owner implements only fixed-target news cards and has no
// spec for the mention-or-zero employer card, so from Sep 20 to Sep 24 2026 it
// silently dropped that card red every night. The card-local deterministic
// builder owns it instead, at night exactly as in the daytime.
const STRAIGHT_LINE_NEWS_CARD_IDS = Object.freeze(
  CARDS.filter((card) => isNewsCard(card) && card.mentionOrZero !== true).map((card) => card.id),
);
const STRAIGHT_LINE_NEWS_CARD_SET = new Set(STRAIGHT_LINE_NEWS_CARD_IDS);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function artifactBody(artifact = {}) {
  const markdown = String(artifact?.markdown || '').replace(/\r\n/g, '\n');
  const lines = markdown.split('\n');
  if (lines.length && /^(?:##\s+)?[^\n]+:\s*$/.test(lines[0].trim())) lines.shift();
  return lines.join('\n').trim();
}

function newsRowsFromArtifact(artifact = {}) {
  const body = artifactBody(artifact);
  const starts = [];
  const lines = body.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*(\d+)\.\s+(.+?)\s*$/);
    if (match) starts.push({ index, title: match[2].trim() });
  }
  return starts.map((start, rowIndex) => {
    const end = rowIndex + 1 < starts.length ? starts[rowIndex + 1].index : lines.length;
    const block = lines.slice(start.index, end).join('\n');
    const url = String((block.match(/^\s*Source:\s*(https?:\/\/\S+)/im) || [])[1] || '');
    return { title: start.title, url, block };
  });
}

function blockerSeverity(failure) {
  const value = String(failure || '').toUpperCase();
  if (/PII|SAFETY|DENYLIST|SECRET|FABRICAT/.test(value)) return 3;
  if (/FRESHNESS|CARRY-FORWARD|SOURCE|SUMMARY|PROSE|DUPLICATE|COUNT/.test(value)) return 2;
  if (/TITLE|CHROME|ARTICLE-META|FORMAT|FIELD/.test(value)) return 1;
  return value ? 2 : 0;
}

function newsRepairQualityVector(artifact = {}) {
  const card = getCardById(artifact.id);
  const rows = newsRowsFromArtifact(artifact);
  const uniqueRows = [];
  const seen = new Set();
  for (const row of rows) {
    const identity = String(row.url || row.title).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    uniqueRows.push(row);
  }
  const title = String(artifact.title || (card && card.id) || 'NEWS');
  const qc = card
    ? qcCard({ id: card.id, title, body: artifactBody(artifact) }, { surface: 'repair-frontier' })
    : { ok: false, failures: ['unknown news card'] };
  const failures = Array.isArray(qc.failures) ? qc.failures.map(String) : [];
  const jumbledTitleCount = uniqueRows.filter((row) =>
    newsTitleLooksJumbled(row.title, row.url),
  ).length;
  if (jumbledTitleCount) failures.push(`NEWS-TITLE-JUMBLE ${jumbledTitleCount}`);
  const carryForwardCount = Math.max(
    0,
    Number(
      artifact.source?.carryForwardCount ??
        artifact.source?.carriedForwardCount ??
        (String(artifact.markdown || '').match(/\bcarried forward\b/gi) || []).length,
    ) || 0,
  );
  const evidenceTimeMs = Math.max(
    0,
    Date.parse(
      artifact.source?.evidenceAt ||
        artifact.source?.publishedAt ||
        artifact.generatedAt ||
        artifact.generated_at ||
        '',
    ) || 0,
  );
  const minimum = card ? getNewsMinimum(card) : null;
  return {
    // Green is binary. A candidate with zero blockers that meets the card's
    // manifest clean minimum is a finished repair, so a larger red incumbent
    // cannot hold it out of Gate B (2026-10-01 SCIENCE: clean 2-row repairs were
    // superseded by a 5-row card with one rejected title, all day).
    // At least one row: a zero-minimum card (ExampleCo) never lets an empty
    // clean rescan outrank real stories on this rank.
    meetsCleanContract:
      failures.length === 0 && Number.isFinite(minimum) && uniqueRows.length >= Math.max(1, minimum),
    validUniqueFreshRows: uniqueRows.length,
    worstBlockerSeverity: failures.reduce(
      (worst, failure) => Math.max(worst, blockerSeverity(failure)),
      0,
    ),
    carryForwardCount,
    fieldViolationCount: failures.length,
    jumbledTitleCount,
    evidenceTimeMs,
    generationTieBreak: sha256(JSON.stringify({
      id: artifact.id || '',
      markdown: artifact.markdown || '',
      source: artifact.source || {},
    })),
    failures: [...new Set(failures)],
  };
}

function compareNewsRepairQuality(candidate, incumbent) {
  const left = newsRepairQualityVector(candidate);
  const right = newsRepairQualityVector(incumbent);
  const comparisons = [
    Number(left.meetsCleanContract) - Number(right.meetsCleanContract),
    left.validUniqueFreshRows - right.validUniqueFreshRows,
    right.worstBlockerSeverity - left.worstBlockerSeverity,
    right.carryForwardCount - left.carryForwardCount,
    right.fieldViolationCount - left.fieldViolationCount,
    left.evidenceTimeMs - right.evidenceTimeMs,
    left.generationTieBreak.localeCompare(right.generationTieBreak),
  ];
  const first = comparisons.find((value) => value !== 0) || 0;
  return { comparison: Math.sign(first), candidate: left, incumbent: right };
}

function shouldKeepIncumbentNewsGeneration({ candidate, incumbent, date } = {}) {
  if (!candidate || !incumbent) return { keep: false, reason: 'frontier-side-missing' };
  const cardId = String(candidate.id || '');
  if (!NEWS_CARD_SET.has(cardId) || incumbent.id !== cardId) {
    return { keep: false, reason: 'not-straight-line-news' };
  }
  if (String(candidate.date || '') !== String(date || '') || String(incumbent.date || '') !== String(date || '')) {
    return { keep: false, reason: 'not-same-target-date' };
  }
  if (!isNewsCard(getCardById(cardId))) return { keep: false, reason: 'not-news' };
  const ranked = compareNewsRepairQuality(candidate, incumbent);
  return {
    keep: ranked.comparison < 0,
    reason: ranked.comparison < 0 ? 'candidate-regresses-repair-frontier' : 'candidate-advances-frontier',
    ...ranked,
  };
}

function classifyNewsRepairLane(receipt = {}) {
  const cardId = String(receipt.cardId || '').trim().toLowerCase();
  if (!NEWS_CARD_SET.has(cardId)) return 'not-applicable';
  const defects = (Array.isArray(receipt.defectsAfter) ? receipt.defectsAfter : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const provenCodeEvidence = receipt.provenCodeDefectEvidence;
  if (
    receipt.provenCodeDefect === true &&
    provenCodeEvidence &&
    provenCodeEvidence.source === 'controller-implementation-digest' &&
    /^[a-f0-9]{64}$/.test(String(provenCodeEvidence.digest || ''))
  ) {
    return 'agentic-code';
  }
  if (
    defects.some((value) =>
      /\b(?:NEWS-(?:COUNT|SOURCE|FRESHNESS|CARRY-FORWARD)|source-failed|sources-exhausted|source-link|source-body|freshness|shortfall)\b/i.test(
        value,
      ),
    )
  ) {
    return 'source';
  }
  if (
    defects.some((value) =>
      /\b(?:NEWS-(?:TITLE|PROSE|DUPLICATE|CHROME|ARTICLE-META)|display-title|three-paragraph-summary|summary-|package|publisher)\b/i.test(
        value,
      ),
    )
  ) {
    return 'package';
  }
  const outcome = String(receipt.outcome || '').trim();
  if (
    receipt.infrastructureFailure === true ||
    /^(?:source-capacity-deferred|stage-capacity-deferred|kept-unverified-live-unreachable|LIVE-QC-RETRY|LIVE-VERIFY-UNKNOWN)$/i.test(
      outcome,
    ) ||
    /^(?:ECONNREFUSED|ETIMEDOUT|host-work-deferred|lease-)/i.test(outcome)
  ) {
    return 'infrastructure';
  }
  if (/^(?:source-failed|sources-exhausted|source-shortfall)$/i.test(outcome)) return 'source';
  // A news card with no proven code failure remains content repair. Unknown
  // does not become permission to open a worktree and edit production code.
  return 'package';
}

module.exports = {
  DELIVERY_CRITICAL_NEWS_CARD_IDS,
  DELIVERY_CRITICAL_NEWS_CARD_SET,
  SUMMARY_BACKED_NEWS_CARD_IDS,
  NEWS_CARD_IDS,
  NEWS_CARD_SET,
  STRAIGHT_LINE_NEWS_CARD_IDS,
  STRAIGHT_LINE_NEWS_CARD_SET,
  artifactBody,
  newsRowsFromArtifact,
  newsRepairQualityVector,
  compareNewsRepairQuality,
  shouldKeepIncumbentNewsGeneration,
  classifyNewsRepairLane,
};
