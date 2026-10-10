'use strict';

const { CARDS } = require('./briefing-card-manifest.js');
const { briefingRunWindow } = require('./briefing-run-window.js');

const GOOD_DAY_END_TO_END_TARGET_MS = 30 * 60 * 1000;

function parsedMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function expectedPrimaryCardIds() {
  return CARDS.map((card) => card.id).filter((id) => id !== 'blockers');
}

function buildControllerPerformance(receipt, { nowMs = Date.now() } = {}) {
  const row = receipt && typeof receipt === 'object' ? receipt : {};
  const startedMs = parsedMs(row.startedAt);
  const finishedMs = parsedMs(row.finishedAt);
  const asOfMs = finishedMs || (Number.isFinite(nowMs) ? nowMs : Date.now());
  const sourceRows = Array.isArray(row.sourceFamilies) ? row.sourceFamilies : [];
  const sourceReadyMs = sourceRows
    .map((source) => parsedMs(source && source.readyAt))
    .filter(Number.isFinite);
  const firstSourceReadyMs = sourceReadyMs.length ? Math.min(...sourceReadyMs) : null;
  const lastSourceReadyMs = sourceReadyMs.length ? Math.max(...sourceReadyMs) : null;
  const plannedCards = Array.isArray(row.plannedCards) ? row.plannedCards : [];
  const cardRows = Array.isArray(row.cards) ? row.cards : [];
  const healerRows = Array.isArray(row.healers) ? row.healers : [];
  const modelWorkRows = healerRows
    .map((healer) => healer && healer.modelWork)
    .filter((work) => work && typeof work === 'object');
  const expectedCards = expectedPrimaryCardIds();
  const fullBoardRun =
    row.mode === 'overnight' &&
    row.shadow !== true &&
    plannedCards.length === expectedCards.length &&
    expectedCards.every((cardId) => plannedCards.includes(cardId));

  return {
    scope: 'single-controller-batch',
    provesWholeNight: false,
    diagnostic:
      'This receipt measures one controller batch only. It cannot prove whole-night refresh or delivery timing.',
    startedAt: startedMs == null ? null : new Date(startedMs).toISOString(),
    finishedAt: finishedMs == null ? null : new Date(finishedMs).toISOString(),
    elapsedMs: startedMs == null ? null : Math.max(0, asOfMs - startedMs),
    firstSourceReadyAt:
      firstSourceReadyMs == null ? null : new Date(firstSourceReadyMs).toISOString(),
    lastSourceReadyAt: lastSourceReadyMs == null ? null : new Date(lastSourceReadyMs).toISOString(),
    settleAfterInputsReadyMs:
      lastSourceReadyMs == null ? null : Math.max(0, asOfMs - lastSourceReadyMs),
    fullBoardRun,
    firstPass: row.firstPass && typeof row.firstPass === 'object' ? row.firstPass : null,
    work: {
      sourceFamilies: sourceRows.length,
      plannedCards: plannedCards.length,
      completedCards: cardRows.length,
      healerJobs: healerRows.length,
      modelSessions: modelWorkRows.reduce((total, work) => total + (Number(work.sessions) || 0), 0),
      promptBytes: modelWorkRows.reduce(
        (total, work) => total + (Number(work.promptBytes) || 0),
        0,
      ),
      outputBytes: modelWorkRows.reduce(
        (total, work) => total + (Number(work.outputBytes) || 0),
        0,
      ),
      exactTokensAvailable: false,
      byteAccounting:
        'UTF-8 prompt and model-output bytes are measured because subscription CLIs do not expose comparable exact token usage.',
    },
  };
}

function buildNightCyclePerformance({
  dayManifest,
  controllerReceipts = [],
  finalizedAtMs = Date.now(),
  deliveryMarker = null,
  date = '',
} = {}) {
  const marker = deliveryMarker && typeof deliveryMarker === 'object' ? deliveryMarker : {};
  const deliveredReportMs =
    parsedMs(marker.reportFreezeProof && marker.reportFreezeProof.frozenAt) ||
    parsedMs(marker.fullyDeliveredAt);
  // An attended owner rewrite happens after the morning pointer was delivered.
  // Preserve that original operating-cycle endpoint instead of pretending a
  // later repair/report rewrite was part of the overnight run.
  const endpointMs =
    deliveredReportMs ||
    (Number.isFinite(finalizedAtMs) ? finalizedAtMs : Date.now());
  const controllerRows = Array.isArray(controllerReceipts) ? controllerReceipts : [];
  const controllerCardEvidence = new Map();
  for (const row of controllerRows) {
    for (const card of Array.isArray(row && row.cards) ? row.cards : []) {
      const cardId = String(card && card.cardId ? card.cardId : '');
      if (!cardId) continue;
      const settledMs =
        parsedMs(card.finishedAt || card.controllerAdvancedAt) ||
        parsedMs(row && row.finishedAt);
      if (settledMs == null || settledMs > endpointMs) continue;
      const prior = controllerCardEvidence.get(cardId);
      if (!prior || settledMs > prior.generatedMs) {
        controllerCardEvidence.set(cardId, {
          generatedMs: settledMs,
          status: String(
            card.statusAfter ||
              (card.outcome === 'cleared' ? 'clean' : '') ||
              'missing',
          ),
        });
      }
    }
  }
  const manifestCards =
    dayManifest && dayManifest.cards && typeof dayManifest.cards === 'object'
      ? dayManifest.cards
      : {};
  const expectedCards = expectedPrimaryCardIds();
  const cardGenerations = expectedCards.map((cardId) => {
    const card = manifestCards[cardId];
    const manifestGeneratedMs = parsedMs(card && card.generatedAt);
    const manifestEvidenceIsCurrent =
      manifestGeneratedMs != null && manifestGeneratedMs <= endpointMs;
    const controllerEvidence = controllerCardEvidence.get(cardId);
    const generatedMs = manifestEvidenceIsCurrent
      ? manifestGeneratedMs
      : controllerEvidence?.generatedMs || null;
    return {
      cardId,
      status: manifestEvidenceIsCurrent
        ? String((card && card.status) || 'missing')
        : String(controllerEvidence?.status || (card && card.status) || 'missing'),
      generatedAt: generatedMs == null ? null : new Date(generatedMs).toISOString(),
      generatedMs,
    };
  });
  const present = cardGenerations.filter((card) => card.generatedMs != null);
  const missingCards = cardGenerations
    .filter((card) => card.generatedMs == null)
    .map((card) => card.cardId);
  const nonCleanCards = cardGenerations
    .filter((card) => card.status !== 'clean')
    .map((card) => card.cardId);
  const controllerStartMs = controllerRows
    .map((row) => parsedMs(row && row.startedAt))
    .filter((ms) => ms != null && ms <= endpointMs);
  const controllerFinishMs = controllerRows
    .filter((row) => Array.isArray(row && row.cards) && row.cards.length > 0)
    .map((row) => parsedMs(row && row.finishedAt))
    .filter((ms) => ms != null && ms <= endpointMs);
  const firstCardMs = present.length ? Math.min(...present.map((card) => card.generatedMs)) : null;
  const lastManifestCardMs = present.length
    ? Math.max(...present.map((card) => card.generatedMs))
    : null;
  const lastControllerCardMs = controllerFinishMs.length ? Math.max(...controllerFinishMs) : null;
  const lastCardMs = [lastManifestCardMs, lastControllerCardMs]
    .filter((ms) => ms != null)
    .reduce((max, ms) => (max == null || ms > max ? ms : max), null);
  const firstControllerMs = controllerStartMs.length ? Math.min(...controllerStartMs) : null;
  const cycleStartMs = [firstCardMs, firstControllerMs]
    .filter((ms) => ms != null)
    .reduce((min, ms) => (min == null || ms < min ? ms : min), null);
  const complete = missingCards.length === 0 && nonCleanCards.length === 0;
  const endToEndMs = cycleStartMs == null ? null : Math.max(0, endpointMs - cycleStartMs);
  const firstChannelDeliveryMs = parsedMs(
    marker.firstChannelSentAt || marker.firstSentAt || marker.previous?.sentAt,
  );
  const fullyDeliveredMs = parsedMs(
    marker.fullyDeliveredAt || (marker.status === 'sent' ? marker.sentAt : null),
  );
  // ExampleCo's goal (2026-09-24): total runtime from the 23:00 CT input start to
  // the first delivered report, 30 minutes or less. It is graded even on a red
  // board; completeness stays a separate fact (complete, nonCleanCards).
  const briefingDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '').slice(0, 10))
    ? String(date).slice(0, 10)
    : String(marker.date || (dayManifest && dayManifest.date) || '').slice(0, 10);
  const inputStartMs = /^\d{4}-\d{2}-\d{2}$/.test(briefingDate)
    ? briefingRunWindow(briefingDate).inputStartMs
    : null;
  const channelSentMs = [
    firstChannelDeliveryMs,
    parsedMs(marker.email && marker.email.sentAt),
    parsedMs(marker.telegram && marker.telegram.sentAt),
  ].filter((ms) => ms != null);
  const firstReportDeliveredMs = channelSentMs.length ? Math.min(...channelSentMs) : null;
  const runtimeToReportMs =
    inputStartMs == null || firstReportDeliveredMs == null
      ? null
      : Math.max(0, firstReportDeliveredMs - inputStartMs);

  return {
    scope: 'whole-night-card-generation-to-report',
    targetMs: GOOD_DAY_END_TO_END_TARGET_MS,
    targetDefinition:
      'from the first controller/card activity through strategic report finalization, with every required card present and clean',
    reportFinalizedAt: new Date(endpointMs).toISOString(),
    cycleStartedAt: cycleStartMs == null ? null : new Date(cycleStartMs).toISOString(),
    firstControllerStartedAt:
      firstControllerMs == null ? null : new Date(firstControllerMs).toISOString(),
    firstRequiredCardGeneratedAt: firstCardMs == null ? null : new Date(firstCardMs).toISOString(),
    lastRequiredCardGeneratedAt: lastCardMs == null ? null : new Date(lastCardMs).toISOString(),
    cardGenerationSpanMs:
      firstCardMs == null || lastCardMs == null ? null : Math.max(0, lastCardMs - firstCardMs),
    reportAfterLastCardMs: lastCardMs == null ? null : Math.max(0, endpointMs - lastCardMs),
    endToEndMs,
    requiredCards: expectedCards.length,
    cardsPresentAtFinalization: present.length,
    missingCards,
    nonCleanCards,
    complete,
    targetMet: complete && endToEndMs != null ? endToEndMs <= GOOD_DAY_END_TO_END_TARGET_MS : null,
    firstChannelSentAt:
      firstChannelDeliveryMs == null ? null : new Date(firstChannelDeliveryMs).toISOString(),
    fullyDeliveredAt: fullyDeliveredMs == null ? null : new Date(fullyDeliveredMs).toISOString(),
    inputStartedAt: inputStartMs == null ? null : new Date(inputStartMs).toISOString(),
    runtimeToReportMs,
    runtimeTargetMet:
      runtimeToReportMs == null ? null : runtimeToReportMs <= GOOD_DAY_END_TO_END_TARGET_MS,
    cardGenerations: cardGenerations.map(({ generatedMs: _generatedMs, ...card }) => card),
  };
}

module.exports = {
  GOOD_DAY_END_TO_END_TARGET_MS,
  buildControllerPerformance,
  buildNightCyclePerformance,
  expectedPrimaryCardIds,
};
