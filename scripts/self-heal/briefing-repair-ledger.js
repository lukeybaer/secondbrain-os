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

const REPO_ROOT = path.resolve(__dirname, '..', '..');

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

function tacticLabel(tactic) {
  return String(tactic == null ? '' : tactic).trim();
}

function tacticKey(tactic) {
  return tacticLabel(tactic).toLowerCase().replace(/\s+/g, ' ').replace(/[`'"]/g, '').trim();
}

function append(date, row, opts = {}) {
  const dir = ledgerDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ledgerPath(date, opts), JSON.stringify(row) + '\n');
  return row;
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
  return append(
    date,
    {
      type: 'attempt',
      defect: key,
      attempt,
      tactic: tacticLabel(e.tactic),
      tacticKey: tacticKey(e.tactic),
      tacticInputHash:
        e.tacticInputHash != null ? String(e.tacticInputHash) : hashTacticInput(e.tacticInput),
      fix: e.fix ? String(e.fix).slice(0, 2000) : '',
      qcResult: e.qcResult ? String(e.qcResult) : 'failed',
      reflection: e.reflection ? String(e.reflection).slice(0, 2000) : '',
      deployedHash: e.deployedHash ? String(e.deployedHash) : '',
      ts: e.ts || new Date().toISOString(),
    },
    opts,
  );
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
  // Walk newest-first: stop at the first cleared row (memory resets on a clear).
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const row = attempts[i];
    if (isClearedRow(row)) return false;
    if (
      String(row.tacticKey || tacticKey(row.tactic)) === tKey &&
      String(row.tacticInputHash || '') === hash
    ) {
      return true;
    }
  }
  return false;
}

// The "tactic exhausted" escalation reason for the no-repeat guard.
function tacticExhaustedReason(defect, tactic) {
  return `tactic exhausted: "${tacticLabel(tactic)}" with the same input already failed for ${defectKey(
    defect,
  )} on the prior attempt; not repeating the same move.`;
}

// OPEN DEFECTS FROM LEDGER (item 3). A defect is OPEN when its most recent attempt
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
      triedTactics: [...new Set(rows.map((r) => r.tactic).filter(Boolean))],
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

module.exports = {
  defaultDataDir,
  ledgerDir,
  ledgerPath,
  defectKey,
  normDefectKey,
  hashTacticInput,
  tacticKey,
  tacticLabel,
  recordAttempt,
  readRows,
  attemptRows,
  attemptsForDefect,
  isClearedRow,
  tacticAlreadyFailed,
  tacticExhaustedReason,
  openDefects,
  blockersFromLedger,
};
