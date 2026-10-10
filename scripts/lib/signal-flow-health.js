'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  peopleInputFingerprint,
  peopleReceiptFile,
  peopleReceiptIsCurrent,
  peopleReceiptIsStaged,
} = require('./signal-people-project.js');
const { readJson } = require('./signal-ingest.js');
const { receiverJournalRows } = require('./signal-message-completeness.js');
const { graphitiIngestionAdmission } = require('./graphiti-ingestion-policy.js');

const WINDOW_HOURS = 24;
const LISTENER_FRESH_MS = 5 * 60 * 1000;
const LISTENER_FUTURE_SKEW_MS = 5 * 1000;
const METRICS = Object.freeze([
  { id: 'signal-flow-message-completeness', label: 'Signal flow / message completeness' },
  { id: 'signal-flow-capture', label: 'Signal flow / capture' },
  { id: 'signal-flow-archive', label: 'Signal flow / archive' },
  { id: 'signal-flow-linked-context', label: 'Signal flow / linked context' },
  { id: 'signal-flow-graphiti', label: 'Signal flow / Graphiti' },
  { id: 'signal-flow-people-knowledge', label: 'Signal flow / People knowledge' },
]);

function eventRows(stateRoot) {
  const root = path.join(stateRoot, 'events');
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'normalized.json') {
        const normalized = readJson(full);
        const status = readJson(path.join(dir, 'status.json'), {});
        if (normalized?.id && normalized?.referenceTime) out.push({ dir, normalized, status });
      }
    }
  };
  walk(root);
  return out;
}

function inWindow(row, nowMs) {
  const at = Date.parse(String(row.normalized.referenceTime || ''));
  return Number.isFinite(at) && at > nowMs - WINDOW_HOURS * 60 * 60 * 1000 && at <= nowMs + 5 * 60 * 1000;
}

function journalInWindow(row, nowMs) {
  const at = Date.parse(String(row.referenceTime || ''));
  return Number.isFinite(at) && at > nowMs - WINDOW_HOURS * 60 * 60 * 1000 && at <= nowMs + 5 * 60 * 1000;
}

function stageComplete(row, stage) {
  return row.status?.stages?.[stage]?.status === 'complete';
}

function linkContext(row) {
  const persisted = row.status.linkContext || {};
  const local = readJson(path.join(row.dir, 'links', 'context.json'), {});
  return {
    ...persisted,
    ...local,
    archive: persisted.archive || local.archive || null,
    links: Array.isArray(local.links) ? local.links : persisted.links || [],
  };
}

function archiveReceiptVerified(receipt) {
  return Boolean(
    receipt &&
      /^s3:\/\/[^/]+\/.+/.test(String(receipt.s3Uri || '')) &&
      /^[a-f0-9]{64}$/i.test(String(receipt.sha256 || '')) &&
      typeof receipt.checksumSha256 === 'string' &&
      receipt.checksumSha256.length > 0 &&
      Number.isFinite(Number(receipt.bytes)) &&
      Number(receipt.bytes) >= 0,
  );
}

function eventArchiveVerified(row) {
  const archive = row.status.s3;
  if (!stageComplete(row, 'archive') || archive?.status !== 'verified') return false;
  const attachments = Array.isArray(archive.attachments) ? archive.attachments : [];
  return (
    archiveReceiptVerified(archive.raw) &&
    archiveReceiptVerified(archive.normalized) &&
    attachments.every(archiveReceiptVerified) &&
    Number(row.status.stages.archive.objects || 0) === 2 + attachments.length
  );
}

function linkContextSettlement(row) {
  const context = linkContext(row);
  const links = Array.isArray(context?.links) ? context.links : [];
  if (
    !stageComplete(row, 'linked_context') ||
    context?.status !== 'verified' ||
    Number(row.status.stages.linked_context.links || 0) !== links.length ||
    !archiveReceiptVerified(row.status.stages.linked_context.manifest || context.archive?.manifest)
  ) {
    return { settled: false, contentVerifiedLinks: 0, terminalSourceLimitations: 0 };
  }
  let contentVerifiedLinks = 0;
  let terminalSourceLimitations = 0;
  for (const link of links) {
    if (!link?.id || !link?.url) {
      return { settled: false, contentVerifiedLinks, terminalSourceLimitations };
    }
    const receipts = link.archive || {};
    const pageOk = archiveReceiptVerified(receipts.page);
    const mediaReceipts = [receipts.mediaMetadata, receipts.media, receipts.transcript].filter(Boolean);
    const mediaOk = mediaReceipts.length === 3 && mediaReceipts.every(archiveReceiptVerified);
    const sourceLimitationOk =
      link.sourceLimitation?.terminal === true &&
      link.sourceLimitation?.code === 'SIGNAL_LINK_SOURCE_LIMITATION' &&
      Boolean(String(link.sourceLimitation?.reason || '').trim());
    if (!pageOk && !mediaOk && !sourceLimitationOk) {
      return { settled: false, contentVerifiedLinks, terminalSourceLimitations };
    }
    if (pageOk || mediaOk) contentVerifiedLinks += 1;
    if (sourceLimitationOk) terminalSourceLimitations += 1;
  }
  return { settled: true, contentVerifiedLinks, terminalSourceLimitations };
}

function linkContextSettled(row) {
  return linkContextSettlement(row).settled;
}

function graphitiVerified(row) {
  // Settlement permits independent People progress but is not graph proof.
  if (row.status?.stages?.graphiti?.disposition === 'disabled_by_owner') return false;
  if (!stageComplete(row, 'graphiti') || row.status?.graphiti?.message?.status !== 'accepted') {
    return false;
  }
  const expectedIds = new Set((linkContext(row)?.links || []).map((link) => String(link.id || '')));
  if (expectedIds.has('')) return false;
  const acceptedIds = new Set(
    (row.status?.graphiti?.citations || [])
      .filter((receipt) => receipt?.status === 'accepted' && receipt.linkId)
      .map((receipt) => String(receipt.linkId)),
  );
  return (
    Number(row.status.stages.graphiti.citations || 0) === expectedIds.size &&
    expectedIds.size === acceptedIds.size &&
    [...expectedIds].every((id) => acceptedIds.has(id))
  );
}

function currentPeopleReceipt(stateRoot, row) {
  const context = linkContext(row);
  const fingerprint = peopleInputFingerprint(row.normalized, context);
  const receipt = readJson(peopleReceiptFile(stateRoot, row.normalized.id), null);
  // A staged receipt (queued for the daily noon People batch) closes the intake
  // stage; the noon batch replaces it with a complete or skipped receipt.
  const current =
    peopleReceiptIsCurrent(receipt, fingerprint) || peopleReceiptIsStaged(receipt, fingerprint);
  return { current, receipt, fingerprint };
}

function metricRow(definition, cohort, completeRows, extraProblems = [], now = new Date()) {
  const admitted = cohort.length;
  const complete = completeRows.length;
  const problems = [...extraProblems];
  if (complete !== admitted) problems.push(`${admitted - complete} admitted event(s) lack this receipt`);
  const oldestOpenMinutes = cohort
    .filter((row) => !completeRows.includes(row))
    .map((row) => Math.max(0, Math.round((now.getTime() - Date.parse(row.normalized.referenceTime)) / 60_000)))
    .sort((a, b) => b - a)[0] ?? 0;
  return {
    ...definition,
    status: problems.length ? 'red' : 'green',
    complete,
    admitted,
    pending: admitted - complete,
    oldestOpenMinutes,
    problems,
    detail: `${complete}/${admitted} admitted Signal event(s) in the past 24h have verified ${definition.label
      .replace(/^Signal flow \/ /, '')
      .toLowerCase()} proof; ${admitted - complete} pending${oldestOpenMinutes ? `, oldest ${oldestOpenMinutes}m` : ''}; measured ${now.toISOString()}.`,
  };
}

function messageCompletenessMetric({ cohort, journalCohort, heartbeat, listenerOk, now }) {
  const coverageStartedMs = Date.parse(String(heartbeat?.coverageStartedAt || ''));
  const windowStartMs = now.getTime() - WINDOW_HOURS * 60 * 60 * 1000;
  const fullWindowCoverage = Number.isFinite(coverageStartedMs) && coverageStartedMs <= windowStartMs;
  const subscriptionOk =
    listenerOk && heartbeat?.receiveMode === 'manual' && heartbeat?.subscriptionActive === true;
  const admittedIds = new Set(cohort.map((row) => row.normalized.id));
  const journalIds = new Set(journalCohort.filter((row) => row.eventId).map((row) => row.eventId));
  const journalCounts = new Map();
  for (const row of journalCohort) {
    if (row.eventId) journalCounts.set(row.eventId, Number(journalCounts.get(row.eventId) || 0) + 1);
  }
  const duplicateJournalRecords = [...journalCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const matchedIds = new Set([...journalIds].filter((id) => admittedIds.has(id)));
  const unidentifiedJournalRecords = journalCohort.filter((row) => !row.eventId).length;
  const missingAdmissionIds = new Set([...journalIds].filter((id) => !admittedIds.has(id)));
  const missingJournalIds = new Set([...admittedIds].filter((id) => !journalIds.has(id)));
  const expected =
    matchedIds.size + missingAdmissionIds.size + missingJournalIds.size + unidentifiedJournalRecords;
  const pending = expected - matchedIds.size;
  const problems = [];
  if (!subscriptionOk) problems.push('Manual Signal receive subscription is missing or stale');
  if (!fullWindowCoverage) {
    problems.push(
      Number.isFinite(coverageStartedMs)
        ? `Independent receiver-journal coverage began ${new Date(coverageStartedMs).toISOString()} and has not reached 24 hours`
        : 'Independent receiver-journal coverage has not started',
    );
  }
  if (missingAdmissionIds.size || unidentifiedJournalRecords) {
    problems.push(
      `${missingAdmissionIds.size + unidentifiedJournalRecords} receiver-journal message(s) lack an admitted event`,
    );
  }
  if (missingJournalIds.size) {
    problems.push(`${missingJournalIds.size} admitted event(s) lack a receiver-journal source record`);
  }
  if (duplicateJournalRecords) {
    problems.push(`${duplicateJournalRecords} duplicate receiver-journal record(s) violate one-to-one identity`);
  }
  return {
    ...METRICS[0],
    status: problems.length ? 'red' : 'green',
    complete: matchedIds.size,
    admitted: cohort.length,
    expected,
    receiverJournalMessages: journalCohort.length,
    pending,
    duplicateJournalRecords,
    oldestOpenMinutes: 0,
    problems,
    detail: `${matchedIds.size}/${expected} Signal message(s) received or admitted in the past 24h have one-to-one receiver-journal and admission proof; ${cohort.length} admitted, ${journalCohort.length} journaled, ${pending} pending; measured ${now.toISOString()}.`,
  };
}

function readSignalFlowHealth({ stateRoot, now = new Date(), listenerFreshMs = LISTENER_FRESH_MS, graphitiAdmission = graphitiIngestionAdmission } = {}) {
  if (!stateRoot) {
    stateRoot = process.env.SIGNAL_INGEST_ROOT || '/opt/secondbrain-durable/signal-ingest';
  }
  const exactNow = now instanceof Date ? now : new Date(now);
  const cohort = eventRows(stateRoot).filter((row) => inWindow(row, exactNow.getTime()));
  const heartbeat = readJson(path.join(stateRoot, 'listener-heartbeat.json'), null);
  const heartbeatAt = Date.parse(String(heartbeat?.at || ''));
  const listenerAgeMs = Number.isFinite(heartbeatAt) ? exactNow.getTime() - heartbeatAt : Infinity;
  // The listener writes independently from this probe. A heartbeat can land just
  // after the caller captured `now`, so allow only a small bounded lead while
  // continuing to reject materially future-dated evidence.
  const listenerOk =
    heartbeat?.connected === true &&
    listenerAgeMs >= -LISTENER_FUTURE_SKEW_MS &&
    listenerAgeMs <= listenerFreshMs;
  const journalCohort = receiverJournalRows(stateRoot).filter(
    (row) => row.invalid || journalInWindow(row, exactNow.getTime()),
  );

  const captured = cohort.filter((row) => stageComplete(row, 'capture'));
  const archived = cohort.filter(eventArchiveVerified);
  const contextualized = cohort.filter(linkContextSettled);
  const contextSettlements = cohort.map(linkContextSettlement);
  const graphed = cohort.filter(graphitiVerified);
  const admission = graphitiAdmission();
  const graphitiMetric = metricRow(METRICS[4], cohort, graphed, [], exactNow);
  if (admission.ownerDisabled === true) {
    graphitiMetric.status = 'yellow';
    graphitiMetric.advisoryReason = 'graphiti-disabled-by-owner';
    graphitiMetric.problems = [];
    graphitiMetric.detail = `Graphiti ingestion is disabled by owner policy; graph projection is unavailable. ${graphed.length}/${cohort.length} admitted Signal event(s) have accepted graph receipts; ${cohort.length - graphed.length} remain ungraphed. Archive and People progress independently; measured ${exactNow.toISOString()}.`;
  } else if (!admission.allowed) {
    graphitiMetric.status = 'red';
    graphitiMetric.problems.push('Graphiti runtime policy is missing or invalid; no owner-disabled advisory is proven');
    graphitiMetric.detail = `${graphitiMetric.problems.join('; ')}. ${graphitiMetric.detail}`;
  }
  const people = cohort.filter((row) => currentPeopleReceipt(stateRoot, row).current);

  const linkedContextMetric = metricRow(METRICS[3], cohort, contextualized, [], exactNow);
  linkedContextMetric.terminalSourceLimitations = contextSettlements.reduce(
    (sum, settlement) => sum + Number(settlement.terminalSourceLimitations || 0),
    0,
  );
  linkedContextMetric.contentVerifiedLinks = contextSettlements.reduce(
    (sum, settlement) => sum + Number(settlement.contentVerifiedLinks || 0),
    0,
  );
  linkedContextMetric.detail = linkedContextMetric.detail.replace(
    'verified linked context proof',
    'settled linked-context proof',
  );
  linkedContextMetric.detail += ` ${linkedContextMetric.contentVerifiedLinks} link(s) have archived content; ${linkedContextMetric.terminalSourceLimitations} link(s) settled with an explicit terminal source limitation.`;
  const metrics = [
    messageCompletenessMetric({ cohort, journalCohort, heartbeat, listenerOk, now: exactNow }),
    metricRow(METRICS[1], cohort, captured, [], exactNow),
    metricRow(METRICS[2], cohort, archived, [], exactNow),
    linkedContextMetric,
    graphitiMetric,
    metricRow(METRICS[5], cohort, people, [], exactNow),
  ];
  return {
    schema: 'amy.signal.flow-health.v1',
    ok: metrics.every((row) => row.status === 'green' || row.advisoryReason === 'graphiti-disabled-by-owner'),
    checkedAt: exactNow.toISOString(),
    windowHours: WINDOW_HOURS,
    stateRoot,
    listener: {
      ok: listenerOk,
      heartbeatAt: Number.isFinite(heartbeatAt) ? new Date(heartbeatAt).toISOString() : null,
      ageSeconds: Number.isFinite(listenerAgeMs) ? Math.max(0, Math.round(listenerAgeMs / 1000)) : null,
      receiveMode: heartbeat?.receiveMode || null,
      subscriptionActive: heartbeat?.subscriptionActive === true,
      subscriptionId: Number.isInteger(heartbeat?.subscriptionId) ? heartbeat.subscriptionId : null,
      coverageStartedAt: heartbeat?.coverageStartedAt || null,
    },
    admitted: cohort.length,
    receiverJournalMessages: journalCohort.length,
    metrics,
    openEventIds: cohort
      .filter(
        (row) =>
          !captured.includes(row) ||
          !people.includes(row) ||
          (!admission.ownerDisabled && !graphed.includes(row)) ||
          !contextualized.includes(row) ||
          !archived.includes(row),
      )
      .map((row) => row.normalized.id)
      .concat(
        journalCohort
          .filter((row) => !row.eventId || !cohort.some((event) => event.normalized.id === row.eventId))
          .map((row) => `receiver-journal:${row.journalId}`),
      ),
  };
}

module.exports = {
  LISTENER_FRESH_MS,
  METRICS,
  WINDOW_HOURS,
  currentPeopleReceipt,
  eventRows,
  eventArchiveVerified,
  graphitiVerified,
  linkContextSettled,
  linkContextSettlement,
  messageCompletenessMetric,
  readSignalFlowHealth,
};
