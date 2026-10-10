'use strict';

// One model session per repair unit per evidence fingerprint per night.
//
// On 2026-09-23 the overnight healer dispatched promptEnvelopeHash 50d5f906
// four times on otter_speaker_pareto over the same defect artifact, because
// nothing remembered that the same evidence had already been handed to a
// model by an earlier run. This ledger is that memory. The fingerprint names
// the unit, the briefing date, the unit's own evidence (volatile timestamps
// and ages normalized out) and the stable contract (skill learnings left
// out). It deliberately leaves out per-run identity (worktree path, branch,
// runId, budget) and the attempt history, so a session that adds an attempt
// row or a metric learning does not unlock an identical retry of itself.
//
// Scope: the unattended overnight owner only (AMY_NIGHT_OWNER=single, set by
// amy-night-run.js for the production controller). A supervised,
// heal-the-healer, button or other human-action repair exists precisely to
// retry what the night could not close, so it neither reads nor writes this
// ledger.
//
// Only model-side outcomes consume a fingerprint: a session the watchdog
// killed for a model-side reason (budget, pre-integration output budget,
// contract miss, session turn cap), a session that returned no candidate, and
// a session that returned a candidate (whose coordinator tests, land or proof then decide
// the rest; a committed candidate is resumed, not re-derived). An executor or
// provider fault (spawn, auth, provider, first-byte hang, idle hang, context
// ceiling handoff, nested background task kill) never consumes, matching the
// answered-only suppression rule in briefing-model-context.js: on 2026-09-23
// a timed-out call that suppressed its own retry kept the Psychology card red
// all day. A claim left unsettled because its driver process died (an
// infrastructure crash the night supervisor restarts) is settled as a
// crash-restart and admits one retry instead of zeroing the rest of the night.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FINGERPRINT_SCHEMA_VERSION = 1;
const EXECUTOR_FAULT = 'executor-fault';
// Tactic-row outcomes that prove the unit itself changed after a dispatch: a
// candidate reached the live release (implementation-changed) or the unit
// cleared. Either one makes the next session a new question, not a repeat.
const RELEASING_TACTIC_OUTCOMES = new Set(['implementation-changed', 'cleared']);
// Watchdog kills that end a session for what the MODEL did with the evidence.
// Every other kill (first-byte hang, idle hang, context-ceiling handoff,
// nested background task, or a kind this list does not know) is an executor
// or provider fault and leaves the fingerprint open.
// A turn-capped session (heal-executor TURN_CAP_WATCHDOG_KIND) spent its whole
// turn allowance on this evidence, so it is an attempted tactic, not a fault.
const MODEL_SIDE_WATCHDOG_KINDS = new Set([
  'budget',
  'pre-integration-output-budget',
  'contract-miss',
  'turn-cap',
]);
// A dead driver's unsettled claim admits this many crash-restart retries per
// fingerprint per night; a further crash on the same evidence consumes it.
const MAX_CRASH_RESTART_RETRIES = 1;
// One token per driver process, so a claim whose pid was reused by a later
// process is recognised as dead rather than in flight.
const PROCESS_CLAIM_TOKEN = crypto.randomBytes(12).toString('hex');

function safeDate(date) {
  const value = String(date || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : 'unknown-date';
}

// The gate belongs to the unattended overnight owner. Attended repairs
// (supervised, heal-the-healer, a verified button or other human action)
// bypass it entirely, and so does any run that is not the night owner.
function evidenceGateScope({
  supervised = false,
  healTheHealer = false,
  humanActionToken = '',
  env = process.env,
} = {}) {
  if (supervised === true) return { active: false, reason: 'attended-supervised' };
  if (healTheHealer === true) return { active: false, reason: 'attended-heal-the-healer' };
  if (String(humanActionToken || '').trim()) return { active: false, reason: 'attended-human-action' };
  if (String((env && env.AMY_NIGHT_OWNER) || '') !== 'single') {
    return { active: false, reason: 'not-the-overnight-owner' };
  }
  return { active: true, reason: 'unattended-overnight-owner' };
}

// Replace per-refresh volatility in a unit's evidence text: ISO timestamps,
// clock times, epoch milliseconds, and relative ages ("proof 2m old", "5
// minutes ago"). Counts, ids, statuses and every other word stay, so a new
// failing call or a changed ledger count still changes the fingerprint.
const AGE_UNIT = '(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)';
const VOLATILE_PATTERNS = [
  [
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    '<timestamp>',
  ],
  [/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?(?:\s?(?:CT|CDT|CST|UTC|Z))?\b/gi, '<time>'],
  [/\b1\d{12}\b/g, '<epoch-ms>'],
  [
    new RegExp(
      `\\b(?:\\d+(?:\\.\\d+)?\\s?${AGE_UNIT}\\b[\\s,]*)+(?=(?:old|ago|stale)\\b)`,
      'gi',
    ),
    '<age> ',
  ],
  [new RegExp(`\\b(aged?)(\\s*[:=]?\\s*)\\d+(?:\\.\\d+)?\\s?${AGE_UNIT}\\b`, 'gi'), '$1$2<age>'],
];

function normalizeVolatileEvidenceText(value) {
  let text = String(value == null ? '' : value);
  for (const [pattern, replacement] of VOLATILE_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

// The stable contract without its skill LEARNINGS blocks. Learnings are
// attempt history: appendTacticRow writes a metric learning naming the runId
// after every System Health session, so hashing them gave every later run a
// new fingerprint (698706460f then f428ffa4b2 on identical SLA evidence).
const LEARNINGS_BLOCK = /^----- LAST \d+ LEARNINGS \(.*\) -----$[\s\S]*?(?=^===== END )/gm;

function stableContextFingerprintHash(stableContext) {
  const text = String(stableContext || '').replace(
    LEARNINGS_BLOCK,
    '----- LEARNINGS (attempt history, not evidence) -----\n',
  );
  return crypto.createHash('sha256').update(text).digest('hex');
}

function healerEvidenceFingerprint({ date, surface, inputHash, stableHash } = {}) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: FINGERPRINT_SCHEMA_VERSION,
        date: safeDate(date),
        surface: String(surface || ''),
        inputHash: String(inputHash || ''),
        stableHash: String(stableHash || ''),
      }),
    )
    .digest('hex');
}

function fingerprintLedgerPath(dataDir, date) {
  return path.join(dataDir, 'agent', 'healer-evidence-fingerprints', `${safeDate(date)}.jsonl`);
}

function appendFingerprintRow(dataDir, date, row) {
  if (!dataDir) return null;
  const file = fingerprintLedgerPath(dataDir, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { schemaVersion: FINGERPRINT_SCHEMA_VERSION, date: safeDate(date), ...row };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

function readFingerprintRows(dataDir, date) {
  if (!dataDir) return [];
  let text = '';
  try {
    text = fs.readFileSync(fingerprintLedgerPath(dataDir, date), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      // A torn final line from a killed writer is skipped, never fatal.
    }
  }
  return rows;
}

// Classify one returned session. Only a model-side watchdog kill consumes;
// every other kill and every executor fault is infrastructure and stays
// retryable.
// heal-executor fills this placeholder when a contract escalates without
// escalation_reason or summary; that is a contract miss, not an answer.
const GENERIC_ESCALATION_RE = /^(?:session reported escalated)?$/i;

function hasNamedFinding(session) {
  const reason = String(
    (session && (session.workerEscalationReason || session.escalationReason)) || '',
  ).trim();
  return !GENERIC_ESCALATION_RE.test(reason);
}

function sessionFingerprintSettlement(session) {
  if (!session || typeof session !== 'object') {
    return { consumes: false, disposition: EXECUTOR_FAULT };
  }
  const watchdog = session.watchdog || null;
  if (watchdog && watchdog.killed) {
    const kind = String(watchdog.kind || 'watchdog');
    return MODEL_SIDE_WATCHDOG_KINDS.has(kind)
      ? { consumes: true, disposition: `killed:${kind}` }
      : { consumes: false, disposition: `${EXECUTOR_FAULT}:${kind}` };
  }
  if (String(session.category || '') === EXECUTOR_FAULT) {
    // A parsed terminal contract in which the worker itself escalated is the
    // model's answer (its finding), not an executor fault: it consumes the
    // evidence for the night (ExampleCo, 2026-10-07). Only a parsed contract
    // carries a defects array; CLI, spawn, and parse faults never do.
    if (
      String(session.status || '') === 'escalated' &&
      Array.isArray(session.defects) &&
      hasNamedFinding(session)
    ) {
      return { consumes: true, disposition: 'no-candidate' };
    }
    return { consumes: false, disposition: EXECUTOR_FAULT };
  }
  if (['repaired', 'ready_for_validation'].includes(String(session.status || ''))) {
    return { consumes: true, disposition: 'candidate' };
  }
  return { consumes: true, disposition: 'no-candidate' };
}

function recordFingerprintDispatch({
  dataDir,
  date,
  surface,
  fingerprint,
  runId,
  workerRunId,
  tactic,
  nowMs = Date.now(),
} = {}) {
  return appendFingerprintRow(dataDir, date, {
    event: 'dispatched',
    ts: new Date(nowMs).toISOString(),
    surface: String(surface || ''),
    fingerprint: String(fingerprint || ''),
    runId: String(runId || ''),
    workerRunId: String(workerRunId || ''),
    tactic: String(tactic || ''),
    host: os.hostname(),
    pid: process.pid,
    processToken: PROCESS_CLAIM_TOKEN,
  });
}

function recordFingerprintSettlement({
  dataDir,
  date,
  surface,
  fingerprint,
  runId,
  workerRunId,
  session,
  nowMs = Date.now(),
} = {}) {
  const settlement = sessionFingerprintSettlement(session);
  return appendFingerprintRow(dataDir, date, {
    event: 'settled',
    ts: new Date(nowMs).toISOString(),
    surface: String(surface || ''),
    fingerprint: String(fingerprint || ''),
    runId: String(runId || ''),
    workerRunId: String(workerRunId || ''),
    ...settlement,
  });
}

// Is the process that wrote an unsettled claim still running? true: the
// session is in flight. false: the driver died without settling. null: this
// host cannot tell (another host, or a claim with no process identity).
function defaultClaimAlive(row) {
  if (!row || !Number.isInteger(Number(row.pid)) || Number(row.pid) <= 0) return null;
  if (!row.host || row.host !== os.hostname()) return null;
  if (row.processToken && row.processToken === PROCESS_CLAIM_TOKEN) return true;
  if (Number(row.pid) === process.pid) return false;
  try {
    process.kill(Number(row.pid), 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

function matchingRows(dataDir, date, surface, fingerprint) {
  return readFingerprintRows(dataDir, date).filter(
    (row) =>
      row.surface === String(surface || '') && row.fingerprint === String(fingerprint || ''),
  );
}

// Settle every claim another run left behind when its driver process died.
// The first crash on a fingerprint is infrastructure (the night supervisor
// restarts a crashed controller), so it is settled as a non-consuming
// crash-restart and the unit gets one retry. A further crash on the same
// evidence consumes it as crash-restart-repeated. Returns the rows written.
function settleOrphanedClaims({
  dataDir,
  date,
  surface,
  fingerprint,
  runId,
  isClaimAlive = defaultClaimAlive,
  nowMs = Date.now(),
} = {}) {
  const rows = matchingRows(dataDir, date, surface, fingerprint);
  const settled = new Set(
    rows.filter((row) => row.event === 'settled' && row.workerRunId).map((row) => row.workerRunId),
  );
  let crashRestarts = rows.filter(
    (row) => row.event === 'settled' && row.disposition === 'crash-restart',
  ).length;
  const written = [];
  for (const dispatch of rows.filter((row) => row.event === 'dispatched')) {
    if (runId && dispatch.runId === String(runId)) continue;
    if (!dispatch.workerRunId || settled.has(dispatch.workerRunId)) continue;
    if (isClaimAlive(dispatch) !== false) continue;
    const firstCrash = crashRestarts < MAX_CRASH_RESTART_RETRIES;
    const row = appendFingerprintRow(dataDir, date, {
      event: 'settled',
      ts: new Date(nowMs).toISOString(),
      surface: String(surface || ''),
      fingerprint: String(fingerprint || ''),
      runId: String(dispatch.runId || ''),
      workerRunId: String(dispatch.workerRunId),
      consumes: !firstCrash,
      disposition: firstCrash ? 'crash-restart' : 'crash-restart-repeated',
      settledByRunId: String(runId || ''),
      reason: `driver pid ${dispatch.pid} on ${dispatch.host} died before settling this claim`,
    });
    if (firstCrash) crashRestarts += 1;
    settled.add(dispatch.workerRunId);
    written.push(row);
  }
  return written;
}

// The newest dispatch from ANOTHER run that still consumes this fingerprint,
// or null. Dispatches from the current run are left to the ladder's own
// no-repeat and fallthrough rules. A dispatch with no settlement row whose
// driver is still running is in flight and blocks a duplicate; one whose
// driver cannot be checked from this host counts as killed, because the
// model ran (settleOrphanedClaims settles the ones this host can prove dead).
// A releasing tactic row for the same unit newer than the dispatch (its
// candidate went live, or the unit cleared) releases it.
function consumingPriorDispatch({
  dataDir,
  date,
  surface,
  fingerprint,
  runId,
  tacticRows = [],
  defectMatches = () => false,
  isClaimAlive = defaultClaimAlive,
} = {}) {
  const rows = matchingRows(dataDir, date, surface, fingerprint);
  const settlements = new Map();
  for (const row of rows) {
    if (row.event === 'settled' && row.workerRunId) settlements.set(row.workerRunId, row);
  }
  const releaseMs = (tacticRows || [])
    .filter(
      (row) =>
        row &&
        RELEASING_TACTIC_OUTCOMES.has(String(row.outcome || '')) &&
        defectMatches(row),
    )
    .map((row) => Date.parse(row.ts))
    .filter(Number.isFinite);
  const dispatches = rows.filter((row) => row.event === 'dispatched').reverse();
  for (const dispatch of dispatches) {
    if (runId && dispatch.runId === String(runId)) continue;
    const settled = settlements.get(dispatch.workerRunId) || null;
    if (settled && settled.consumes === false) continue;
    const dispatchedMs = Date.parse(dispatch.ts);
    if (releaseMs.some((ms) => !Number.isFinite(dispatchedMs) || ms >= dispatchedMs)) continue;
    return {
      runId: dispatch.runId,
      workerRunId: dispatch.workerRunId,
      tactic: dispatch.tactic,
      dispatchedAt: dispatch.ts,
      disposition: settled
        ? settled.disposition
        : isClaimAlive(dispatch) === true
          ? 'in-flight'
          : 'unsettled-killed',
    };
  }
  return null;
}

module.exports = {
  FINGERPRINT_SCHEMA_VERSION,
  RELEASING_TACTIC_OUTCOMES,
  MODEL_SIDE_WATCHDOG_KINDS,
  MAX_CRASH_RESTART_RETRIES,
  evidenceGateScope,
  normalizeVolatileEvidenceText,
  stableContextFingerprintHash,
  healerEvidenceFingerprint,
  fingerprintLedgerPath,
  readFingerprintRows,
  sessionFingerprintSettlement,
  recordFingerprintDispatch,
  recordFingerprintSettlement,
  defaultClaimAlive,
  settleOrphanedClaims,
  consumingPriorDispatch,
};
