'use strict';

// scripts/self-heal/briefing-repair-ledger.js
//
// PHASE 4a, item 1 + 2 + 3: the PER-DEFECT REPAIR LEDGER for one briefing day.
//
// Distinct from scripts/self-heal/attempt-ledger.js (which is per-CARD, keyed by
// heal-LADDER rung option, and persists across nights to compute true ladder
// exhaustion). THIS ledger is the per-DEFECT, per-briefing-day reconciler log: one
// row per defect repair attempt, written to
//   <dataDir>/agent/briefing-repair-ledger/briefing-YYYY-MM-DD.jsonl
// so the run can answer three questions deterministically:
//   1. what did I try for THIS exact defect (card_id:defect_type) this run,
//   2. did the SAME tactic + SAME input already fail on the prior attempt(s)
//      (no-repeat: escalate instead of looping the same input), and
//   3. which defects are still OPEN (no successful clear) so the Blockers card is
//      ledger-derived and always matches reality.
//
// A row's schema (item 1):
//   { defect, attempt, tactic, tacticInputHash, fix, qcResult, reflection,
//     deployedHash, ts }
// where `defect` is the canonical "card_id:defect_type" key.
//
// dataDir is EC2-first (/opt/secondbrain/data) so the ledger lives where the
// always-on heal loop runs; falls back to the desktop spine store, then the repo.
// An injectable opts.dataDir keeps tests pure.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { appendReportEvent } = require('../lib/overnight-report-event-ledger.js');
const { previousDateKey } = require('../lib/briefing-run-window.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAX_PROCESS_CYCLES = 8;
// ExampleCo, 2026-08-17: "There is no limit for the supervised mid-day refreshes and
// fixes. Fix that guardrail for mid-day (that's the overnight process)."
//
// Supervised runs get their own, far larger budget rather than no budget at all.
// Removing the ceiling outright looked right and was wrong: the per-card healer
// loop uses cycle-cap-exhausted as its TERMINATOR, so an uncapped supervised run
// spins forever. That is not theoretical; it hung the controller test suite until
// this was measured.
//
// Three full heal sessions per card per day is effectively unlimited for a watched
// repair, while still guaranteeing the loop ends.
const SUPERVISED_MAX_PROCESS_CYCLES = 24;

function defaultDataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain/data'))
    return '/opt/secondbrain/data';
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'secondbrain', 'data');
  return path.join(REPO_ROOT, 'data');
}

function ledgerDir(opts = {}) {
  return path.join(opts.dataDir || defaultDataDir(), 'agent', 'briefing-repair-ledger');
}

function safeDate(date) {
  const d = String(date || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
}

function ledgerPath(date, opts = {}) {
  return path.join(ledgerDir(opts), `briefing-${safeDate(date)}.jsonl`);
}

// Canonical defect key. Accepts either a string ("card_id:defect_type") or a
// canonical-defect record { card_id, defect_type, key }. Always lower-cased and
// whitespace-normalized so the same defect is one identity across attempts.
// The canonical defect key. card_id is lower-cased (the orchestrator's renderQcCardId
// already yields lower-case ids) while defect_type keeps its UPPER-CASE canonical form
// (renderQcDefectType yields e.g. NEWS-PROSE), so the stored key reads like the live QC
// defect "us_news:NEWS-PROSE". Comparison across attempts is case-insensitive via
// normDefectKey, so a string supplied in any case still matches the same defect.
function defectKey(defect) {
  if (defect && typeof defect === 'object' && !Array.isArray(defect)) {
    if (defect.key) {
      const k = String(defect.key).trim();
      const [card, ...rest] = k.split(':');
      return rest.length ? `${card.toLowerCase()}:${rest.join(':')}` : k.toLowerCase();
    }
    const card = String(defect.card_id || defect.cardId || 'dashboard').toLowerCase();
    const type = String(defect.defect_type || defect.defectType || 'RENDER-QC');
    return `${card}:${type}`.trim();
  }
  const s = String(defect == null ? '' : defect).trim();
  const [card, ...rest] = s.split(':');
  return rest.length ? `${card.toLowerCase()}:${rest.join(':')}` : s.toLowerCase();
}

// Case-insensitive identity for comparing two defect keys across attempts.
function normDefectKey(defect) {
  return defectKey(defect).toLowerCase();
}

// A stable hash of whatever input drove the tactic (the evidence/prompt/payload).
// Two attempts with the SAME tactic AND the SAME input hash are "the same move";
// the no-repeat guard rejects a re-run of that exact move. Objects are stably
// stringified by sorted keys so key order never changes the hash.
function hashTacticInput(input) {
  let text;
  if (input == null) text = '';
  else if (typeof input === 'string') text = input;
  else text = stableStringify(input);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

const VOLATILE_FAILURE_KEYS = new Set([
  'ts',
  'time',
  'timestamp',
  'startedat',
  'finishedat',
  'generatedat',
  'observedat',
  'runid',
  'attemptid',
  'cycleid',
  'requestid',
  'pid',
  'nonce',
]);

// Keys whose value IS the identity of the attempt and must survive the generic
// scrubs below. `implementationDigest` is a sha256 hex, so the 32-64 hex-digest
// scrub used to collapse it to `[digest]` -- which meant two attempts made
// BEFORE and AFTER a landed code fix produced the identical failure
// fingerprint, and the no-repeat guard refused to publish a genuine same-day
// fix. Landed code is changed evidence; the fingerprint has to see it.
const IDENTITY_FAILURE_KEYS = new Set(['implementationdigest', 'codedigest']);

function normalizeFailureEvidence(value, key = '') {
  if (VOLATILE_FAILURE_KEYS.has(String(key).toLowerCase())) return '[volatile]';
  if (IDENTITY_FAILURE_KEYS.has(String(key).toLowerCase())) return value;
  if (Array.isArray(value)) return value.map((item) => normalizeFailureEvidence(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((childKey) => [childKey, normalizeFailureEvidence(value[childKey], childKey)]),
    );
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gi, '[timestamp]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '[uuid]',
    )
    .replace(/\b[0-9a-f]{32,64}\b/gi, '[digest]')
    .replace(
      /(?:[A-Z]:\\|\/)(?:[^\s"']*[\\/])?(?:tmp|temp|sb-sessions)[\\/][^\s"']+/gi,
      '[runtime-path]',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function failureFingerprint(evidence) {
  const normalized = stableStringify(normalizeFailureEvidence(evidence));
  return crypto
    .createHash('sha256')
    .update(normalized == null ? '' : String(normalized))
    .digest('hex')
    .slice(0, 16);
}

function tacticLabel(tactic) {
  return String(tactic == null ? '' : tactic).trim();
}

function tacticKey(tactic) {
  return tacticLabel(tactic).toLowerCase().replace(/\s+/g, ' ').replace(/[`'"]/g, '').trim();
}

function normalizeCardIds(value) {
  const parts = [];
  const push = (item) => {
    if (Array.isArray(item)) {
      for (const child of item) push(child);
      return;
    }
    for (const part of String(item == null ? '' : item).split(',')) {
      const id = part.trim().toLowerCase();
      if (/^[a-z][a-z0-9_]*$/.test(id) && !parts.includes(id)) parts.push(id);
    }
  };
  push(value);
  return parts;
}

function normalizeWorkUnitIds(value) {
  const parts = [];
  const push = (item) => {
    if (Array.isArray(item)) {
      for (const child of item) push(child);
      return;
    }
    for (const part of String(item == null ? '' : item).split(',')) {
      const id = part.trim().toLowerCase();
      if (/^[a-z][a-z0-9_]*:[a-z0-9][a-z0-9_-]*$/.test(id) && !parts.includes(id)) {
        parts.push(id);
      }
    }
  };
  push(value);
  return parts;
}

function append(date, row, opts = {}) {
  const dir = ledgerDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ledgerPath(date, opts), JSON.stringify(row) + '\n');
  return row;
}

function processOwnerId({ cardId, workUnitId } = {}) {
  const exact = String(workUnitId || '')
    .trim()
    .toLowerCase();
  if (exact.includes(':')) return exact;
  return String(cardId || exact || 'unknown')
    .trim()
    .toLowerCase();
}

function processKey({ date, ownerId } = {}) {
  const owner = String(ownerId || 'unknown')
    .trim()
    .toLowerCase();
  // The ceiling belongs to one exact owner on one briefing date. An explicit
  // owner action may unlock a new tactic, but it must not mint another eight
  // refresh/QC/heal cycles for the same process.
  return `${safeDate(date)}:${owner}`;
}

function processCycleRows(date, ownerId, opts = {}) {
  const wanted = processKey({
    date,
    ownerId,
  });
  return readRows(date, opts).filter(
    (row) => row && row.type === 'process-cycle' && String(row.processKey || '') === wanted,
  );
}

function withCycleLedgerLock(date, opts, fn) {
  const lock = `${ledgerPath(date, opts)}.cycle.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      // Short bounded cross-process wait. The critical section is one read and
      // one append; a stale lock is reclaimed after 30 seconds.
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > 30_000) fs.unlinkSync(lock);
      } catch {
        // Another owner may have released it between stat and unlink.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (fd == null) throw new Error('process-cycle ledger lock unavailable');
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } finally {
      try {
        fs.unlinkSync(lock);
      } catch {
        // The lock is best-effort cleanup after the critical section.
      }
    }
  }
}

function reserveProcessCycle(date, entry = {}, opts = {}) {
  const ownerId = processOwnerId(entry);
  const key =
    String(entry.processKey || '').trim() ||
    processKey({
      date,
      ownerId,
    });
  const cycleId = String(
    entry.cycleId || `${entry.runId || 'run'}:${ownerId}:${entry.phase || 'refresh-qc-heal'}`,
  );
  return withCycleLedgerLock(date, opts, () => {
    const rows = readRows(date, opts).filter(
      (row) => row && row.type === 'process-cycle' && row.processKey === key,
    );
    const existing = rows.find(
      (row) => row.phase === 'started' && String(row.cycleId || '') === cycleId,
    );
    if (existing) {
      return {
        accepted: true,
        duplicate: true,
        cycle: Number(existing.cycle),
        maxCycles: MAX_PROCESS_CYCLES,
        processKey: key,
        ownerId,
        cycleId,
        row: existing,
      };
    }
    const refundedCycleIds = new Set(
      rows.filter((row) => row.phase === 'refunded').map((row) => String(row.cycleId || '')),
    );
    const allStarted = rows.filter((row) => row.phase === 'started');
    const started = allStarted.filter(
      (row) => row.phase === 'started' && !refundedCycleIds.has(String(row.cycleId || '')),
    );
    // ExampleCo, 2026-08-17: "There is no limit for the supervised mid-day refreshes
    // and fixes. Fix that guardrail for mid-day (that's the overnight process)."
    //
    // The eight-cycle ceiling exists so an UNATTENDED overnight loop cannot grind
    // all night on one card. A supervised mid-day run is the opposite case: ExampleCo
    // is watching, he has usually just landed and deployed a fix, and he wants
    // that card repaired now. Charging it the overnight budget meant that once
    // the night had spent eight cycles, NO mid-day repair could run for the rest
    // of the day regardless of what code shipped since. That is what left every
    // red card unhealable through the afternoon of 2026-08-17.
    //
    // A supervised run is bounded by ExampleCo stopping it, not by a budget written
    // for an unwatched night. The cycle row is still written, so the audit trail,
    // the no-repeat tactic gate, and the cycle numbering are unchanged, and an
    // unattended run afterwards is still refused.
    const supervised = entry.supervised === true || opts.supervised === true;
    const unattendedStarted = started.filter((row) => row.supervised !== true);
    const effectiveMax = supervised ? SUPERVISED_MAX_PROCESS_CYCLES : MAX_PROCESS_CYCLES;
    const countedStarted = supervised ? started : unattendedStarted;
    if (countedStarted.length >= effectiveMax) {
      return {
        accepted: false,
        duplicate: false,
        cycle: countedStarted.length,
        maxCycles: effectiveMax,
        processKey: key,
        ownerId,
        cycleId,
        reason: 'cycle-cap-exhausted',
      };
    }
    const row = append(
      date,
      {
        type: 'process-cycle',
        schema: 'briefing-process-cycle@1',
        processKey: key,
        processOwnerId: ownerId,
        cycleId,
        cycle: allStarted.length + 1,
        maxCycles: effectiveMax,
        phase: 'started',
        // Marks a watched run so the audit trail distinguishes an overnight cycle
        // from a supervised mid-day repair, and so a later unattended run can
        // still be refused on the overnight count.
        ...(supervised ? { supervised: true } : {}),
        runId: String(entry.runId || ''),
        cardId: String(entry.cardId || ''),
        workUnitId: String(entry.workUnitId || ''),
        startedAt: entry.startedAt || new Date().toISOString(),
        ts: entry.startedAt || new Date().toISOString(),
      },
      opts,
    );
    return {
      accepted: true,
      duplicate: false,
      cycle: row.cycle,
      maxCycles: effectiveMax,
      ...(supervised ? { supervised: true } : {}),
      processKey: key,
      ownerId,
      cycleId,
      row,
    };
  });
}

function finishProcessCycle(date, reservation, outcome, opts = {}) {
  if (!reservation || !reservation.accepted || !reservation.cycleId) return null;
  return withCycleLedgerLock(date, opts, () => {
    const rows = readRows(date, opts).filter(
      (row) =>
        row &&
        row.type === 'process-cycle' &&
        row.processKey === reservation.processKey &&
        row.cycleId === reservation.cycleId,
    );
    const existing = rows.find((row) => row.phase === 'finished');
    if (existing) return existing;
    return append(
      date,
      {
        type: 'process-cycle',
        schema: 'briefing-process-cycle@1',
        processKey: reservation.processKey,
        processOwnerId: reservation.ownerId,
        cycleId: reservation.cycleId,
        cycle: reservation.cycle,
        maxCycles: MAX_PROCESS_CYCLES,
        phase: 'finished',
        runId: String((reservation.row && reservation.row.runId) || ''),
        cardId: String((reservation.row && reservation.row.cardId) || ''),
        workUnitId: String((reservation.row && reservation.row.workUnitId) || ''),
        startedAt: (reservation.row && reservation.row.startedAt) || '',
        finishedAt: new Date().toISOString(),
        outcome: String(outcome || 'unknown').slice(0, 160),
        ts: new Date().toISOString(),
      },
      opts,
    );
  });
}

// An infrastructure refusal before live proof is not another repair tactic and
// must not consume the card's bounded process budget. Keep the started row for
// audit, then add an immutable refund row that future reservations exclude
// from the ceiling. Deploy failure remains the backwards-compatible default;
// callers that prove another infrastructure class name it in opts.outcome.
function refundProcessCycle(date, reservation, reason, opts = {}) {
  if (!reservation || !reservation.accepted || !reservation.cycleId) return null;
  return withCycleLedgerLock(date, opts, () => {
    const rows = readRows(date, opts).filter(
      (row) =>
        row &&
        row.type === 'process-cycle' &&
        row.processKey === reservation.processKey &&
        row.cycleId === reservation.cycleId,
    );
    const existing = rows.find((row) => row.phase === 'refunded');
    if (existing) return existing;
    return append(
      date,
      {
        type: 'process-cycle',
        schema: 'briefing-process-cycle@1',
        processKey: reservation.processKey,
        processOwnerId: reservation.ownerId,
        cycleId: reservation.cycleId,
        cycle: reservation.cycle,
        maxCycles: reservation.maxCycles || MAX_PROCESS_CYCLES,
        phase: 'refunded',
        runId: String((reservation.row && reservation.row.runId) || ''),
        cardId: String((reservation.row && reservation.row.cardId) || ''),
        workUnitId: String((reservation.row && reservation.row.workUnitId) || ''),
        startedAt: (reservation.row && reservation.row.startedAt) || '',
        refundedAt: new Date().toISOString(),
        outcome: String(opts.outcome || 'deploy-executor-failure').slice(0, 160),
        reason: String(reason || 'deploy executor failed before live proof').slice(0, 300),
        attemptCharge: 0,
        fingerprintRecorded: false,
        ts: new Date().toISOString(),
      },
      opts,
    );
  });
}

// Record ONE defect repair attempt (item 1). qcResult is the post-attempt verdict
// for THIS defect: 'cleared' means the defect dropped from authenticated live QC;
// anything else ('failed', 'survived', 'escalated', 'partial') leaves the defect OPEN.
function recordAttempt(date, entry, opts = {}) {
  const e = entry || {};
  const key = defectKey(e.defect);
  const attempt =
    Number.isFinite(Number(e.attempt)) && Number(e.attempt) > 0
      ? Math.floor(Number(e.attempt))
      : attemptsForDefect(date, key, opts).length + 1;
  const fingerprint = String(
    e.failureFingerprint ||
      failureFingerprint(e.failureEvidence ?? e.tacticInput ?? e.tacticInputHash),
  );
  const priorState = repeatedFailureState(date, key, fingerprint, e.tactic, opts);
  const row = append(
    date,
    {
      type: 'attempt',
      defect: key,
      attempt,
      tactic: tacticLabel(e.tactic),
      tacticKey: tacticKey(e.tactic),
      tacticInputHash:
        e.tacticInputHash != null ? String(e.tacticInputHash) : hashTacticInput(e.tacticInput),
      failureFingerprint: fingerprint,
      diagnosisRequired: priorState.repeated,
      diagnosis: e.diagnosis ? String(e.diagnosis).slice(0, 2000) : '',
      component: e.component ? String(e.component).slice(0, 160) : '',
      priorAttemptId: priorState.priorAttempt ? Number(priorState.priorAttempt.attempt) : null,
      transactionState: e.transactionState ? String(e.transactionState) : '',
      repairImplementationDigest: e.repairImplementationDigest
        ? String(e.repairImplementationDigest)
        : '',
      attempted: e.attempted === true,
      ownerCardId: normalizeCardIds(e.ownerCardId)[0] || '',
      workUnitIds: normalizeWorkUnitIds(e.workUnitIds),
      affectedCardIds: normalizeCardIds(e.affectedCardIds),
      dependentCardIds: normalizeCardIds(e.dependentCardIds),
      sourceHashes: e.sourceHashes && typeof e.sourceHashes === 'object' ? e.sourceHashes : {},
      qcScope: normalizeCardIds(e.qcScope || e.affectedCardIds),
      fix: e.fix ? String(e.fix).slice(0, 2000) : '',
      qcResult: e.qcResult ? String(e.qcResult) : 'failed',
      reflection: e.reflection ? String(e.reflection).slice(0, 2000) : '',
      ...(typeof e.repairCandidatePresent === 'boolean'
        ? { repairCandidatePresent: e.repairCandidatePresent }
        : {}),
      deployedHash: e.deployedHash ? String(e.deployedHash) : '',
      ts: e.ts || new Date().toISOString(),
    },
    opts,
  );
  // The repair ledger retains full attempt history. The report event ledger is
  // the authoritative typed current-state view consumed by the morning report.
  // A mirror failure must never wedge the repair loop itself.
  try {
    const result = String(row.qcResult || '').toLowerCase();
    const outcome = CLEARED_OUTCOMES.has(result)
      ? 'cleared'
      : /block|exhaust|needs-owner|needs-human/.test(result)
        ? 'blocked'
        : /stale|superseded/.test(result)
          ? 'stale'
          : 'failed';
    appendReportEvent({
      dataDir: opts.dataDir || defaultDataDir(),
      date,
      kind: 'repair-outcome',
      subjectType: 'briefing-defect',
      subjectId: key,
      state: row.qcResult,
      outcome,
      terminal: true,
      countsAsDefect: outcome !== 'cleared',
      sourceComponent: 'briefing-repair-ledger',
      sourceRunId: row.repairImplementationDigest || `attempt-${row.attempt}`,
      evidenceHash: row.tacticInputHash,
      ts: row.ts,
      content: {
        attempt: row.attempt,
        tactic: row.tactic,
        fix: row.fix,
        reflection: row.reflection,
        deployedHash: row.deployedHash,
      },
    });
  } catch {
    // Typed reporting is additive proof, not permission to lose a repair row.
  }
  return row;
}

function readRows(date, opts = {}) {
  const p = ledgerPath(date, opts);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // a corrupt line is skipped, not fatal: the ledger must never wedge the loop
    }
  }
  return out;
}

function attemptRows(date, opts = {}) {
  return readRows(date, opts).filter((r) => r && r.type === 'attempt');
}

// All attempt rows for ONE defect, in append order (case-insensitive identity).
function attemptsForDefect(date, defect, opts = {}) {
  const key = normDefectKey(defect);
  return attemptRows(date, opts).filter((r) => normDefectKey(r.defect) === key);
}

const CLEARED_OUTCOMES = new Set(['cleared', 'deployed-verified', 'resolved']);

function isClearedRow(row) {
  return !!row && CLEARED_OUTCOMES.has(String(row.qcResult || '').toLowerCase());
}

// NO-REPEAT TACTIC (item 2). Returns true when the SAME tactic + SAME input hash
// already FAILED at any point since the last clear for this defect, so the loop must
// NOT re-dispatch that identical move and should escalate "tactic exhausted". This is
// the canonical "no repeat without changed input" rule: an identical tactic+input is
// deterministic, so re-running it just reproduces the failure. A DIFFERENT tactic, a
// CHANGED input (new tacticInputHash), or a prior CLEAR all let the defect through;
// only the exact failed tactic+input is blocked. When every tactic+input is exhausted
// the defect escalates to a blocker (the caller increments escalated, never silently
// drops). A clear in between resets the memory (we stop at the first cleared row).
function tacticAlreadyFailed(date, defect, tactic, tacticInputHash, opts = {}) {
  const attempts = attemptsForDefect(date, defect, opts);
  if (!attempts.length) return false;
  const tKey = tacticKey(tactic);
  const hash = tacticInputHash != null ? String(tacticInputHash) : '';
  const fingerprint = String(opts.failureFingerprint || '');
  // Walk newest-first: stop at the first cleared row (memory resets on a clear).
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const row = attempts[i];
    if (isClearedRow(row)) return false;
    if (
      String(row.tacticKey || tacticKey(row.tactic)) === tKey &&
      (String(row.tacticInputHash || '') === hash ||
        (fingerprint && String(row.failureFingerprint || '') === fingerprint))
    ) {
      return true;
    }
  }
  return false;
}

function repeatedFailureState(date, defect, fingerprint, tactic = '', opts = {}) {
  const wanted = String(fingerprint || '');
  if (!wanted) {
    return { repeated: false, sameTacticFailed: false, priorAttempt: null, componentHistory: [] };
  }
  const tKey = tacticKey(tactic);
  const history = [];
  for (const row of attemptsForDefect(date, defect, opts)) {
    if (isClearedRow(row)) history.length = 0;
    else if (String(row.failureFingerprint || '') === wanted) history.push(row);
  }
  const priorAttempt = history.at(-1) || null;
  return {
    repeated: history.length > 0,
    sameTacticFailed: history.some(
      (row) => String(row.tacticKey || tacticKey(row.tactic)) === tKey,
    ),
    priorAttempt,
    componentHistory: history.map((row) => ({
      attempt: row.attempt,
      tactic: row.tactic,
      component: row.component || '',
      diagnosis: row.diagnosis || '',
      qcResult: row.qcResult,
      reflection: row.reflection || '',
    })),
  };
}

// The "tactic exhausted" escalation reason for the no-repeat guard.
function tacticExhaustedReason(defect, tactic) {
  return `tactic exhausted: "${tacticLabel(tactic)}" with the same input already failed for ${defectKey(
    defect,
  )} on the prior attempt; not repeating the same move.`;
}

// OPEN DEFECTS FROM LEDGER (item 3). A defect is OPEN when its most recent attempt
// A candidate the coordinator refused because its affected tests failed has no
// landed or committed SHA, so nothing can ever resume it. Counting it as a held
// candidate froze Amy Projects and LinkedIn as "integration pending" all day on
// 2026-09-29: every run skipped the source refresh and the driver found nothing
// to resume. Legacy rows recorded repairCandidatePresent true for that refusal.
function rowHoldsRepairCandidate(row = {}) {
  if (/^(?:repaired[-_]pending[-_](?:land|deploy)|integration[-_]pending)$/i.test(String(row.qcResult || ''))) {
    return true;
  }
  if (row.repairCandidatePresent !== true) return false;
  return !/\baffected tests failed\b/i.test(String(row.reflection || ''));
}

// did NOT clear it (no successful clear after the last attempt). Returns one entry
// per still-open defect with its attempt history, so the Blockers card is generated
// from reality and shrinks the moment a defect's latest attempt clears.
function openDefects(date, opts = {}) {
  const byDefect = new Map();
  for (const row of attemptRows(date, opts)) {
    const key = normDefectKey(row.defect); // merge case variants of the same defect
    const list = byDefect.get(key) || [];
    list.push(row);
    byDefect.set(key, list);
  }
  const out = [];
  for (const rows of byDefect.values()) {
    const latest = rows[rows.length - 1];
    if (isClearedRow(latest)) continue; // a successful clear closes the defect
    out.push({
      defect: defectKey(latest.defect), // the canonical stored key for display
      attempts: rows.length,
      lastTactic: latest.tactic || '',
      lastQcResult: latest.qcResult || 'failed',
      lastReflection: latest.reflection || '',
      lastTs: latest.ts || '',
      // Preserve the latest ownership scope. Controller integration recovery
      // consumes openDefects(), and dropping these fields widened one exact
      // System Health repair into a card-wide pending integration that blocked
      // every sibling metric from refreshing.
      ownerCardId: latest.ownerCardId || '',
      workUnitIds: Array.isArray(latest.workUnitIds) ? latest.workUnitIds : [],
      affectedCardIds: Array.isArray(latest.affectedCardIds) ? latest.affectedCardIds : [],
      triedTactics: [...new Set(rows.map((r) => r.tactic).filter(Boolean))],
      // Whether the latest attempt produced a repair to integrate, and whether
      // any earlier attempt on this defect still holds one. The controller
      // unfreezes a card only when neither is true (2026-09-27).
      ...(typeof latest.repairCandidatePresent === 'boolean'
        ? {
            repairCandidatePresent:
              latest.repairCandidatePresent === true && rowHoldsRepairCandidate(latest),
          }
        : {}),
      // Only attempts after the most recent clear can still hold a candidate.
      priorCandidatePending: rows
        .slice(rows.map((r) => isClearedRow(r)).lastIndexOf(true) + 1, -1)
        .some(rowHoldsRepairCandidate),
    });
  }
  return out;
}

// Render OPEN ledger rows into the Blockers card content (item 3). Each open defect
// becomes one numbered blocker whose evidence names the tried tactics and the latest
// QC result, so the list is ledger-derived and matches reality. When nothing is open
// the Blockers card is clean.
function blockersFromLedger(date, opts = {}) {
  const open = openDefects(date, opts);
  return open.map((d, i) => ({
    index: i + 1,
    title: `Open repair defect ${d.defect}`,
    requirement: 'The authenticated live dashboard must pass canonical render and prose QC.',
    evidence: `${d.attempts} repair attempt(s); latest QC result ${d.lastQcResult}. Tried: ${
      d.triedTactics.slice(0, 6).join('; ') || 'none recorded'
    }.${d.lastReflection ? ` Latest reflection: ${d.lastReflection.slice(0, 200)}` : ''}`,
    repair:
      'Pick a NOT-yet-tried tactic for this defect (the no-repeat guard rejects a re-run of a failed tactic with the same input), or escalate honestly if no untried tactic remains.',
    owner: 'Amy',
    need: 'Nothing.',
    source: 'briefing-repair-ledger',
    defectKey: d.defect,
    attempts: d.attempts,
    triedTactics: d.triedTactics,
  }));
}

// CHRONIC-YIELD (packet E2 item 3). A defect whose LAST non-cleared attempt
// carried the same failure fingerprint on the two calendar days before this
// one, and now carries that identical fingerprint again today, is chronic:
// the same root cause has survived three consecutive owned days. Grinding an
// agentic cycle against it a fourth time is masking, not repair (the same
// spirit as invariant 10's 3-day masking guard). The unit still gets exactly
// one more MECHANICAL attempt today -- deterministic tactics are cheap and a
// fresh mechanical pass can still clear a since-fixed dependency -- then it
// yields: honest red, full history retained, no further cycle spent today.
//
// "Last non-cleared attempt" mirrors openDefects(): the most recent attempt
// row for that date, counted only when that latest row did not clear the
// defect. A cleared latest row means the defect was actually fixed that day,
// which breaks the chronic streak regardless of earlier failures that day. A
// date with ZERO attempt rows is not evidence of anything -- it neither
// extends nor breaks a streak on its own -- so it simply fails to match and
// the unit is not chronic; only real, matching failure evidence counts.
function lastNonClearedAttemptOnDate(date, defect, opts) {
  const rows = attemptsForDefect(date, defect, opts);
  if (!rows.length) return { hasAttempts: false, row: null };
  const latest = rows[rows.length - 1];
  return { hasAttempts: true, row: isClearedRow(latest) ? null : latest };
}

function chronicYieldState(date, defect, fingerprint, opts = {}) {
  const wanted = String(fingerprint || '');
  const day = safeDate(date);
  const priorDates = [previousDateKey(day), previousDateKey(previousDateKey(day))];
  const priorEvidence = priorDates.map((priorDate) => {
    const { hasAttempts, row } = lastNonClearedAttemptOnDate(priorDate, defect, opts);
    return {
      date: priorDate,
      hasAttempts,
      matchesFingerprint:
        hasAttempts && !!row && !!wanted && String(row.failureFingerprint || '') === wanted,
    };
  });
  const chronic = Boolean(wanted) && priorEvidence.every((entry) => entry.matchesFingerprint);
  if (!chronic) {
    return {
      chronic: false,
      mechanicalAttemptRemaining: true,
      outcome: null,
      reason: wanted ? 'not-chronic' : 'no-fingerprint',
      priorDates,
      priorEvidence,
    };
  }
  // Today's own history decides whether the one mechanical attempt this
  // chronic streak still owes has already been spent. Mirror the prior-day
  // check exactly: only the LAST non-cleared attempt today counts. A clear
  // today resolves the streak (it is not evidence of a spent, still-failing
  // attempt), and an intervening clear before a later same-day re-failure
  // must not be masked by an earlier same-fingerprint row.
  const { row: todaysRow } = lastNonClearedAttemptOnDate(day, defect, opts);
  const todaysMatch = !!todaysRow && String(todaysRow.failureFingerprint || '') === wanted;
  return {
    chronic: true,
    mechanicalAttemptRemaining: !todaysMatch,
    outcome: todaysMatch ? 'chronic-yield' : null,
    reason: todaysMatch
      ? 'chronic-yield-mechanical-attempt-spent'
      : 'chronic-mechanical-attempt-available',
    priorDates,
    priorEvidence,
  };
}

module.exports = {
  rowHoldsRepairCandidate,
  defaultDataDir,
  safeDate,
  ledgerDir,
  ledgerPath,
  defectKey,
  normDefectKey,
  hashTacticInput,
  normalizeFailureEvidence,
  failureFingerprint,
  tacticKey,
  tacticLabel,
  normalizeCardIds,
  MAX_PROCESS_CYCLES,
  SUPERVISED_MAX_PROCESS_CYCLES,
  processOwnerId,
  processKey,
  processCycleRows,
  reserveProcessCycle,
  finishProcessCycle,
  refundProcessCycle,
  recordAttempt,
  readRows,
  attemptRows,
  attemptsForDefect,
  isClearedRow,
  tacticAlreadyFailed,
  repeatedFailureState,
  tacticExhaustedReason,
  openDefects,
  blockersFromLedger,
  chronicYieldState,
};
