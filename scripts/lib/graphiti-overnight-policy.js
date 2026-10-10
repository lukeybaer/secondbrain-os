'use strict';

const path = require('node:path');
const { graphitiIngestionAdmission } = require('./graphiti-ingestion-policy.js');
const { briefingRunWindow, dateKeyInCt, nextDateKey } = require('./briefing-run-window.js');
const { readTerminalState } = require('./briefing-terminal-state.js');

const HIGH_VALUE_WORK_PRODUCTS = new Set([
  'linkedin-comms',
  'relationship-comms',
  'advice',
  'strategic-backlog',
  'overnight-report-recommendations',
]);

function briefingDateForInstant(nowMs = Date.now()) {
  const ctDate = dateKeyInCt(nowMs);
  const nextDate = nextDateKey(ctDate);
  const nextWindow = briefingRunWindow(nextDate);
  return Number(nowMs) >= nextWindow.inputStartMs ? nextDate : ctDate;
}

function graphitiEnrichmentAdmission({
  nowMs = Date.now(),
  dataDir = process.env.SECONDBRAIN_DATA_DIR || path.resolve(__dirname, '..', '..', 'data'),
  date,
  testIngestionPolicyPath,
} = {}) {
  const ingestion = graphitiIngestionAdmission(
    process.env.NODE_ENV === 'test' && testIngestionPolicyPath
      ? { policyPath: testIngestionPolicyPath } : {},
  );
  if (!ingestion.allowed) return ingestion;
  const day = date || briefingDateForInstant(nowMs);
  const window = briefingRunWindow(day);
  const insideCriticalWindow =
    Number(nowMs) >= window.inputStartMs && Number(nowMs) < window.deliveryDeadlineMs;
  const terminal = readTerminalState({ dataDir, date: day });
  // Delivery releases enrichment early. The fixed 05:30 boundary releases it
  // even when terminal proof is missing, so a failed briefing cannot wedge a
  // desktop or cloud Graphiti spool for the rest of the day. The missing proof
  // remains explicit in the admission reason and briefing health.
  if (insideCriticalWindow && terminal?.state !== 'delivered') {
    return {
      allowed: false,
      deferred: true,
      reason: 'graphiti-enrichment-deferred-until-briefing-delivery',
      date: day,
      resumeAfter: new Date(window.deliveryDeadlineMs).toISOString(),
    };
  }
  return {
    allowed: true,
    deferred: false,
    reason:
      terminal?.state === 'delivered'
        ? 'graphiti-enrichment-admitted-after-briefing-delivery'
        : Number(nowMs) >= window.deliveryDeadlineMs
          ? 'graphiti-enrichment-admitted-after-fixed-overnight-boundary'
          : 'graphiti-enrichment-admitted-outside-overnight-window',
    date: day,
  };
}

function graphitiRecallAdmission({ workProduct, priorQueries = 0 } = {}) {
  const normalized = String(workProduct || '').trim().toLowerCase();
  if (!HIGH_VALUE_WORK_PRODUCTS.has(normalized)) {
    return { allowed: false, reason: 'graphiti-recall-not-high-value-work-product' };
  }
  if (Number(priorQueries) >= 1) {
    return { allowed: false, reason: 'graphiti-recall-work-product-query-already-used' };
  }
  return { allowed: true, reason: 'graphiti-recall-single-high-value-query' };
}

module.exports = {
  HIGH_VALUE_WORK_PRODUCTS,
  briefingDateForInstant,
  graphitiEnrichmentAdmission,
  graphitiRecallAdmission,
};
