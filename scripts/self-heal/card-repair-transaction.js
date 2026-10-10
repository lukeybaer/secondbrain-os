'use strict';

// scripts/self-heal/card-repair-transaction.js
//
// Card Repair Transaction state machine.
//
// Wraps the existing briefing-repair-ledger with an enforced transaction
// boundary that owns a card repair from defect detection through refresh,
// scoped QC, and closure. Each transition appends a JSONL row; no transition
// can be skipped; closure requires scoped QC; failure states are terminal.
//
// Piloted on video_approval_queue per the 2026-07-08 recommendation.
// Pure + DI-able (injectable dataDir), no network, no spawn.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATES = {
  DETECTED: 'detected',
  CLASSIFIED: 'classified',
  PLANNED: 'planned',
  REPAIRED: 'repaired',
  REFRESHED: 'refreshed',
  TARGET_QC: 'target_qc',
  SCOPE_QC: 'scope_qc',
  CLOSED: 'closed',
  DUPLICATE_TACTIC_BLOCKED: 'duplicate_tactic_blocked',
  EXECUTOR_UNAVAILABLE: 'executor_unavailable',
  BLOCKED_EXTERNAL: 'blocked_external',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  REGRESSION_DETECTED: 'regression_detected',
  PAUSED_HUMAN: 'paused_human',
};

const HAPPY_PATH = [
  STATES.DETECTED,
  STATES.CLASSIFIED,
  STATES.PLANNED,
  STATES.REPAIRED,
  STATES.REFRESHED,
  STATES.TARGET_QC,
  STATES.SCOPE_QC,
  STATES.CLOSED,
];

const TERMINAL_STATES = new Set([
  STATES.CLOSED,
  STATES.DUPLICATE_TACTIC_BLOCKED,
  STATES.EXECUTOR_UNAVAILABLE,
  STATES.BLOCKED_EXTERNAL,
  STATES.BUDGET_EXHAUSTED,
  STATES.REGRESSION_DETECTED,
  STATES.PAUSED_HUMAN,
]);

const FAILURE_STATES = new Set([
  STATES.DUPLICATE_TACTIC_BLOCKED,
  STATES.EXECUTOR_UNAVAILABLE,
  STATES.BLOCKED_EXTERNAL,
  STATES.BUDGET_EXHAUSTED,
  STATES.REGRESSION_DETECTED,
  STATES.PAUSED_HUMAN,
]);

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function defaultDataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain/data'))
    return '/opt/secondbrain/data';
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'secondbrain', 'data');
  return path.join(REPO_ROOT, 'data');
}

function txDir(opts) {
  return path.join((opts && opts.dataDir) || defaultDataDir(), 'agent', 'card-repair-transactions');
}

function safeDate(date) {
  const d = String(date || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
}

function txPath(date, opts) {
  return path.join(txDir(opts), `transactions-${safeDate(date)}.jsonl`);
}

function appendRow(date, row, opts) {
  const dir = txDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(txPath(date, opts), JSON.stringify(row) + '\n');
  return row;
}

function readAllRows(date, opts) {
  const p = txPath(date, opts);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // corrupt line skipped, never wedge the loop
    }
  }
  return out;
}

function genRunId() {
  return `txn-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

function isFailureState(state) {
  return FAILURE_STATES.has(state);
}

function happyIndex(state) {
  return HAPPY_PATH.indexOf(state);
}

function isValidTransition(from, to) {
  if (isTerminal(from)) return false;
  if (isFailureState(to)) return true;
  const fromIdx = happyIndex(from);
  const toIdx = happyIndex(to);
  if (fromIdx < 0 || toIdx < 0) return false;
  return toIdx === fromIdx + 1;
}

function create(date, defect, opts) {
  const d = defect || {};
  const runId = genRunId();
  const row = {
    type: 'transaction',
    runId,
    state: STATES.DETECTED,
    defectId: String(d.defectId || ''),
    cardId: String(d.cardId || ''),
    defectType: String(d.type || ''),
    source: String(d.source || ''),
    severity: String(d.severity || ''),
    owner: String(d.owner || ''),
    inputHash: String(d.inputHash || ''),
    receipt: {},
    ts: new Date().toISOString(),
  };
  appendRow(date, row, opts);
  return row;
}

function advance(date, runId, toState, receipt, opts) {
  const current = currentState(date, runId, opts);
  if (!current) throw new Error(`Transaction ${runId} not found`);
  if (isTerminal(current.state)) {
    throw new Error(`Cannot advance transaction ${runId}: state "${current.state}" is terminal`);
  }
  if (!isValidTransition(current.state, toState)) {
    throw new Error(`Invalid transition for ${runId}: "${current.state}" -> "${toState}"`);
  }
  const row = {
    type: 'transition',
    runId,
    fromState: current.state,
    state: toState,
    receipt: receipt && typeof receipt === 'object' ? receipt : {},
    ts: new Date().toISOString(),
  };
  appendRow(date, row, opts);
  return row;
}

function rowsForRun(date, runId, opts) {
  return readAllRows(date, opts).filter((r) => r.runId === runId);
}

function currentState(date, runId, opts) {
  const rows = rowsForRun(date, runId, opts);
  if (!rows.length) return null;
  return rows[rows.length - 1];
}

function readTransactions(date, opts) {
  return readAllRows(date, opts).filter((r) => r.type === 'transaction');
}

function allTransactionStates(date, opts) {
  const rows = readAllRows(date, opts);
  const byRun = new Map();
  for (const row of rows) {
    if (!row.runId) continue;
    byRun.set(row.runId, row);
  }
  return [...byRun.values()];
}

function openTransactions(date, opts) {
  return allTransactionStates(date, opts).filter((r) => !isTerminal(r.state));
}

function refreshCardsForTransaction(date, runId, opts) {
  const rows = rowsForRun(date, runId, opts);
  const refreshRow = rows.find((r) => r.state === STATES.REFRESHED);
  if (!refreshRow || !refreshRow.receipt) return [];
  const cards = new Set();
  const r = refreshRow.receipt;
  if (r.ownerCardId) cards.add(String(r.ownerCardId).toLowerCase());
  if (Array.isArray(r.affectedCardIds)) {
    for (const id of r.affectedCardIds) cards.add(String(id).toLowerCase());
  }
  if (Array.isArray(r.dependentCardIds)) {
    for (const id of r.dependentCardIds) cards.add(String(id).toLowerCase());
  }
  return [...cards].filter((id) => /^[a-z][a-z0-9_]*$/.test(id));
}

function blockersFromTransactions(date, opts) {
  const states = allTransactionStates(date, opts);
  return states
    .filter((r) => r.state !== STATES.CLOSED)
    .map((r) => {
      const rows = rowsForRun(date, r.runId, opts);
      const journey = rows.map((row) => row.state).filter(Boolean);
      const lastRow = rows[rows.length - 1] || {};
      const lastReceipt = lastRow.receipt || {};
      return {
        runId: r.runId,
        defectId: r.defectId || '',
        cardId: r.cardId || (r.defectId ? r.defectId.split(':')[0] : ''),
        state: lastRow.state || r.state,
        journey,
        stopReason: lastReceipt.reason || lastReceipt.stopReason || '',
        owner: r.owner || 'Amy',
      };
    });
}

module.exports = {
  STATES,
  HAPPY_PATH,
  TERMINAL_STATES,
  FAILURE_STATES,
  isTerminal,
  isFailureState,
  isValidTransition,
  create,
  advance,
  currentState,
  readTransactions,
  allTransactionStates,
  openTransactions,
  refreshCardsForTransaction,
  blockersFromTransactions,
  txDir,
  txPath,
  readAllRows,
};
