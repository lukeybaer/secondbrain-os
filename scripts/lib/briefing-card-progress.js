'use strict';

// Productive-progress proof for the first three hourly overnight checkpoints.
// Liveness is intentionally absent from this contract. A moving heartbeat,
// receipt mtime, or stage label cannot satisfy an exact-card checkpoint.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readLiveBoardArtifact, briefingUnitCounts } = require('./live-board-truth.js');
const { controllerRunDir, nightWallClockMs } = require('./briefing-run-window.js');

const CARD_PROGRESS_CLASS = 'CARD-PROGRESS';
const CARD_PROGRESS_CHECKPOINTS_CT = Object.freeze([
  '00:00',
  '01:00',
  '02:00',
  '03:00',
  '03:30',
  '04:00',
  '04:30',
]);
const TAKEOVER_SCHEMA = 'briefing-controller-takeover@1';

function readJson(file, fallback = null) {
  try {
    return JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return file;
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function checkpointDir(dataDir, date) {
  return path.join(dataDir, 'agent', 'card-progress-checkpoints', date);
}

function checkpointPath(dataDir, date, checkpointCt) {
  return path.join(checkpointDir(dataDir, date), `${checkpointCt.replace(':', '')}.json`);
}

function checkpointHistoryDir(dataDir, date, checkpointCt) {
  return path.join(checkpointDir(dataDir, date), 'history', checkpointCt.replace(':', ''));
}

function takeoverPath(dataDir, date) {
  return path.join(dataDir, 'agent', 'card-controller-control', `${date}.json`);
}

function checkpointForNow({ date, nowMs, dataDir }) {
  const rows = CARD_PROGRESS_CHECKPOINTS_CT.map((checkpointCt) => {
    const [hour, minute] = checkpointCt.split(':').map(Number);
    return { checkpointCt, epochMs: nightWallClockMs(date, hour, minute, { dataDir }) };
  }).filter((row) => nowMs >= row.epochMs);
  return rows.length ? rows[rows.length - 1] : null;
}

function sourceIsSubstantive(source) {
  if (!source || source.ok !== true) return false;
  const before = String(source.beforeEvidence?.digest || '');
  const after = String(source.afterEvidence?.digest || '');
  if (!after) return false;
  const commands = Array.isArray(source.commands) ? source.commands : [];
  if (
    commands.some(
      (row) =>
        row &&
        (row.ok === false ||
          row.timedOut === true ||
          (row.exitCode != null && Number(row.exitCode) !== 0)),
    )
  ) {
    return false;
  }
  if (
    commands.some(
      (row) => Number.isFinite(Number(row.declaredBound)) && Number(row.observedCount) <= 0,
    )
  ) {
    return false;
  }
  return source.skipped !== true && before !== after;
}

function rowTimeMs(value) {
  return Math.max(
    Date.parse(value?.finishedAt || '') || 0,
    Date.parse(value?.readyAt || '') || 0,
    Date.parse(value?.startedAt || '') || 0,
  );
}

function controllerRows({ dataDir, date }) {
  const dir = controllerRunDir(dataDir, date);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((name) => readJson(path.join(dir, name), null))
    .filter((row) => row && row.date === date)
    .sort((a, b) => rowTimeMs(a) - rowTimeMs(b));
}

function exactFailureKey(source) {
  if (!source) return '';
  const failure = String(source.failureFingerprint || '');
  const tactic = String(source.tacticInputHash || source.tactic || '');
  const implementation = String(source.implementationDigest || '');
  return failure && tactic ? `${failure}:${tactic}:${implementation}` : '';
}

function normalizeExactWorkUnitId(value, { cardId = '', kind = '' } = {}) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (id === 'system_health') return id;
  if (id.startsWith('system_health:')) {
    const metricId = id.slice('system_health:'.length).trim();
    return metricId ? `system_health:${metricId}` : '';
  }
  if (cardId === 'system_health' || kind === 'system-health-measurement') {
    return `system_health:${id}`;
  }
  return id;
}

function evidenceTargetsUnit(row, unitId) {
  const rowCardIds = [...(Array.isArray(row?.cardIds) ? row.cardIds : []), row?.cardId]
    .filter(Boolean)
    .map((value) => String(value).trim());
  const cardId =
    rowCardIds.includes('system_health') ||
    String(unitId || '')
      .trim()
      .startsWith('system_health:')
      ? 'system_health'
      : '';
  const id = normalizeExactWorkUnitId(unitId, { cardId });
  if (!id) return false;
  const exactTargets = [
    ...(Array.isArray(row?.refreshTargetIds) ? row.refreshTargetIds : []),
    ...(Array.isArray(row?.workUnitIds) ? row.workUnitIds : []),
  ]
    .map((target) => normalizeExactWorkUnitId(target, { cardId }))
    .filter(Boolean);
  if (exactTargets.length > 0) return exactTargets.includes(id);
  return rowCardIds.some((target) => normalizeExactWorkUnitId(target) === id);
}

function boundedEvidenceRows(rows, startMs, endMs) {
  const sources = [];
  const cards = [];
  for (const run of rows) {
    for (const source of Array.isArray(run.sourceFamilies) ? run.sourceFamilies : []) {
      const at = rowTimeMs(source) || rowTimeMs(run);
      if (at >= startMs && at <= endMs) sources.push({ ...source, runId: run.runId || null, at });
    }
    for (const card of Array.isArray(run.cards) ? run.cards : []) {
      const at = rowTimeMs(card) || rowTimeMs(run);
      if (at >= startMs && at <= endMs) cards.push({ ...card, runId: run.runId || null, at });
    }
  }
  return { sources, cards };
}

function summarizeProgressEvidence({
  dataDir,
  date,
  nowMs = Date.now(),
  writeReceipt = true,
} = {}) {
  const checkpoint = checkpointForNow({ date, nowMs, dataDir });
  if (!checkpoint || nowMs >= nightWallClockMs(date, 5, 0, { dataDir })) {
    return {
      schema: 'briefing-card-progress-checkpoint@1',
      date,
      evaluated: false,
      satisfied: true,
      reason: checkpoint ? 'after-04:30-progress-contract' : 'before-midnight-progress-contract',
      checkpointCt: checkpoint?.checkpointCt || null,
    };
  }
  const priorCheckpointCt =
    checkpoint.checkpointCt === '00:00'
      ? null
      : CARD_PROGRESS_CHECKPOINTS_CT[
          CARD_PROGRESS_CHECKPOINTS_CT.indexOf(checkpoint.checkpointCt) - 1
        ];
  const priorCheckpoint = priorCheckpointCt
    ? checkpointForNow({
        date,
        nowMs: checkpoint.epochMs - 1,
        dataDir,
      })
    : null;
  const intervalStartMs = priorCheckpoint?.epochMs || checkpoint.epochMs - 60 * 60 * 1000;
  const prior = priorCheckpointCt
    ? readJson(checkpointPath(dataDir, date, priorCheckpointCt), null)
    : null;
  const live = readLiveBoardArtifact({ dataDir, nowMs });
  const counts = briefingUnitCounts(live.artifact);
  const redUnitCount = Number.isFinite(Number(counts?.red)) ? Number(counts.red) : null;
  const redUnitIds = Array.isArray(counts?.redUnits)
    ? counts.redUnits
        .map((unit) => normalizeExactWorkUnitId(unit.id, { kind: unit.kind }))
        .filter(Boolean)
    : [];
  const priorRedUnitCount = Number.isFinite(Number(prior?.redUnitCount))
    ? Number(prior.redUnitCount)
    : null;
  const evidence = boundedEvidenceRows(controllerRows({ dataDir, date }), intervalStartMs, nowMs);
  const cleared = evidence.cards.filter(
    (row) =>
      row.outcome === 'cleared' &&
      (row.statusAfter === 'clean' || row.reportEvidence?.status === 'green'),
  );
  const substantive = evidence.sources.filter(sourceIsSubstantive);
  const failures = evidence.sources.filter((row) => row.ok === false || Boolean(row.error));
  const retries = evidence.sources.filter(
    (row) =>
      row.ok === true && Boolean(row.implementationDigest) && Boolean(row.failureFingerprint),
  );
  const failureKeys = new Map();
  for (const row of evidence.sources) {
    const key = exactFailureKey(row);
    if (key) failureKeys.set(key, (failureKeys.get(key) || 0) + 1);
  }
  const noSpin = evidence.cards.filter((row) =>
    ['source-no-progress', 'source-no-spin-skip', 'no-spin-skip', 'cycle-cap-exhausted'].includes(
      row.outcome,
    ),
  );
  // A controller card receipt with outcome:'stage-failed' is a direct,
  // exact-unit failure signal from the controller itself. It must count as
  // cycling/failure evidence on its own -- the live-board redUnitCount can
  // lag behind it by a checkpoint or more, and unrelated substantive source
  // output in the same hourly window must never be allowed to mask it.
  const stageFailed = evidence.cards.filter((row) => row.outcome === 'stage-failed');
  const stageFailedCardIds = [
    ...new Set(
      stageFailed
        .map((row) =>
          normalizeExactWorkUnitId(row.cardId || row.cardIds?.[0] || '', { kind: row.kind }),
        )
        .filter(Boolean),
    ),
  ];
  const repeatedFailures = [...failureKeys.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
  const redDelta =
    Number.isFinite(priorRedUnitCount) && Number.isFinite(redUnitCount)
      ? redUnitCount - priorRedUnitCount
      : null;
  const proofChanged = cleared.length > 0 || substantive.length > 0 || retries.length > 0;
  const cycling = noSpin.length > 0 || repeatedFailures.length > 0 || stageFailed.length > 0;
  const stalledUnitIds = redUnitIds.filter(
    (unitId) =>
      !substantive.some((row) => evidenceTargetsUnit(row, unitId)) &&
      !retries.some((row) => evidenceTargetsUnit(row, unitId)),
  );
  const boardTrustworthy =
    live.artifact?.date === date && live.artifact?.ran === true && live.stale !== true;
  let satisfied = false;
  let reason = 'no-substantive-hourly-output';
  if (!boardTrustworthy) reason = 'same-date-live-board-not-trustworthy';
  // A stage-failed controller card is checked ahead of the live-board
  // redUnitCount shortcut on purpose: the live board can still read
  // all-green for a checkpoint or more after the controller has already
  // recorded a stage-failed outcome for one of its cards, and no amount of
  // unrelated substantive proof in the same window may stand in for it.
  else if (stageFailed.length > 0) reason = 'exact-work-stage-failed-without-new-proof';
  else if (redUnitCount === 0) {
    satisfied = true;
    reason = 'all-exact-briefing-units-green';
  } else if (cycling) reason = 'exact-work-cycling-without-new-proof';
  else if (stalledUnitIds.length > 0) reason = 'open-exact-units-lacked-progress';
  else if (Number.isFinite(redDelta) && redDelta < 0) {
    satisfied = true;
    reason = 'red-unit-count-decreased';
  } else if (cleared.length > 0) {
    satisfied = true;
    reason = 'exact-card-green-conversion-proven';
  } else if (substantive.length > 0 && failures.length === 0) {
    satisfied = true;
    reason = 'substantial-source-output-proven';
  } else if (retries.length > 0 && failures.length > 0) {
    satisfied = true;
    reason = 'error-fix-retry-chain-proven';
  }
  const fingerprint = sha256(
    JSON.stringify({
      checkpointCt: checkpoint.checkpointCt,
      redUnitCount,
      redDelta,
      cleared: cleared.map((row) => [row.runId, row.cardId, row.finishedAt]),
      substantive: substantive.map((row) => [row.runId, row.family, row.afterEvidence?.digest]),
      failures: failures.map((row) => [row.runId, row.family, exactFailureKey(row)]),
      retries: retries.map((row) => [row.runId, row.family, row.implementationDigest]),
      noSpin: noSpin.map((row) => [row.runId, row.cardId, row.outcome]),
      stageFailed: stageFailed.map((row) => [row.runId, row.cardId, row.outcome]),
    }),
  );
  const priorHead = readJson(checkpointPath(dataDir, date, checkpoint.checkpointCt), null);
  const predecessorReceiptHash =
    priorHead?.receiptHash || prior?.receiptHash || prior?.fingerprint || null;
  const resultWithoutHash = {
    schema: 'briefing-card-progress-checkpoint@1',
    date,
    checkpointCt: checkpoint.checkpointCt,
    evaluated: true,
    satisfied,
    reason,
    checkedAt: new Date(nowMs).toISOString(),
    intervalStartedAt: new Date(intervalStartMs).toISOString(),
    boardTrustworthy,
    redUnitCount,
    priorRedUnitCount,
    redDelta,
    greenConversions: cleared.length,
    substantiveSourceOutputs: substantive.length,
    sourceErrors: failures.length,
    fixRetries: retries.length,
    cyclingUnits: noSpin.length + repeatedFailures.length + stageFailed.length,
    stageFailedCount: stageFailed.length,
    stageFailedCardIds: stageFailedCardIds.slice(0, 24),
    stalledUnitCount: stalledUnitIds.length,
    stalledUnitIds: stalledUnitIds.slice(0, 24),
    proofChanged,
    fingerprint,
    predecessorReceiptHash,
  };
  const receiptHash = sha256(JSON.stringify(resultWithoutHash));
  const result = { ...resultWithoutHash, receiptHash };
  if (writeReceipt) {
    const historyDir = checkpointHistoryDir(dataDir, date, checkpoint.checkpointCt);
    fs.mkdirSync(historyDir, { recursive: true });
    const stamp = String(result.checkedAt).replace(/[^0-9]/g, '');
    const historyFile = path.join(historyDir, `${stamp}-${receiptHash.slice(0, 16)}.json`);
    try {
      fs.writeFileSync(historyFile, `${JSON.stringify(result, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readJson(historyFile, null);
      if (existing?.receiptHash !== receiptHash) {
        throw new Error(`card progress history collision at ${historyFile}`);
      }
    }
    writeJsonAtomic(checkpointPath(dataDir, date, checkpoint.checkpointCt), result);
  }
  return result;
}

function classifyCardProgress(options = {}) {
  const evidence = summarizeProgressEvidence({
    ...options,
    date: options.date || options.briefingDate,
    writeReceipt: options.writeReceipt !== false,
  });
  return {
    class: CARD_PROGRESS_CLASS,
    evaluated: evidence.evaluated === true,
    triggered: evidence.evaluated === true && evidence.satisfied !== true,
    reason: evidence.reason,
    checkpointCt: evidence.checkpointCt || null,
    redUnitCount: evidence.redUnitCount ?? null,
    redDelta: evidence.redDelta ?? null,
    greenConversions: evidence.greenConversions || 0,
    substantiveSourceOutputs: evidence.substantiveSourceOutputs || 0,
    sourceErrors: evidence.sourceErrors || 0,
    fixRetries: evidence.fixRetries || 0,
    cyclingUnits: evidence.cyclingUnits || 0,
    stageFailedCount: evidence.stageFailedCount || 0,
    stageFailedCardIds: Array.isArray(evidence.stageFailedCardIds)
      ? evidence.stageFailedCardIds
      : [],
    stalledUnitCount: evidence.stalledUnitCount || 0,
    stalledUnitIds: Array.isArray(evidence.stalledUnitIds) ? evidence.stalledUnitIds : [],
    progressFingerprint: evidence.fingerprint || null,
  };
}

function requestControllerTakeover({ dataDir, date, finding, nowMs = Date.now() } = {}) {
  const file = takeoverPath(dataDir, date);
  const prior = readJson(file, null);
  if (
    prior?.schema === TAKEOVER_SCHEMA &&
    prior.date === date &&
    ['takeover-requested', 'handoff-acknowledged', 'takeover-active'].includes(prior.state)
  ) {
    return { started: true, requestId: prior.requestId, state: prior.state, file, reused: true };
  }
  const requestId = `cloud-progress-${date}-${crypto.randomUUID()}`;
  const receipt = {
    schema: TAKEOVER_SCHEMA,
    date,
    requestId,
    state: 'takeover-requested',
    requestedAt: new Date(nowMs).toISOString(),
    requestedBy: 'deterministic-cloud-supervisor',
    requestedRunId: finding?.runId || null,
    reason: finding?.reason || 'hourly-card-progress-unsatisfied',
    checkpointCt: finding?.checkpointCt || null,
    evidenceFingerprint: finding?.progressFingerprint || null,
  };
  writeJsonAtomic(file, receipt);
  return { started: true, requestId, state: receipt.state, file, reused: false };
}

function readControllerTakeover(dataDir, date) {
  const receipt = readJson(takeoverPath(dataDir, date), null);
  return receipt?.schema === TAKEOVER_SCHEMA && receipt.date === date ? receipt : null;
}

function updateControllerTakeover({
  dataDir,
  date,
  requestId,
  state,
  details = {},
  nowMs = Date.now(),
} = {}) {
  const file = takeoverPath(dataDir, date);
  const prior = readJson(file, null);
  if (prior?.schema !== TAKEOVER_SCHEMA || prior.date !== date || prior.requestId !== requestId) {
    return { updated: false, reason: 'takeover-request-mismatch', file };
  }
  const receipt = { ...prior, ...details, state, updatedAt: new Date(nowMs).toISOString() };
  writeJsonAtomic(file, receipt);
  return { updated: true, receipt, file };
}

module.exports = {
  CARD_PROGRESS_CLASS,
  CARD_PROGRESS_CHECKPOINTS_CT,
  TAKEOVER_SCHEMA,
  checkpointPath,
  checkpointHistoryDir,
  takeoverPath,
  checkpointForNow,
  sourceIsSubstantive,
  normalizeExactWorkUnitId,
  evidenceTargetsUnit,
  summarizeProgressEvidence,
  classifyCardProgress,
  requestControllerTakeover,
  readControllerTakeover,
  updateControllerTakeover,
};
