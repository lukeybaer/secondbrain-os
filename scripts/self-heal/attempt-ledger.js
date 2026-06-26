'use strict';

// scripts/self-heal/attempt-ledger.js
//
// Durable MEMORY ACROSS HEAL ATTEMPTS (ExampleCo, 2026-06-19: this is why self-heal
// never converged). For each card/defect the healer records every option it tried
// and WHY it failed, append-only, surviving across loop iterations AND across
// nights. The loop uses this to compute the next untried unique option and the TRUE
// exhaustion condition ("no more unique viable options remain"). Only at true
// exhaustion does verdict.js return 'blocked' and the honest L1-L4 hard-block render
// the attempt history (what I tried / why each failed / what I now need from ExampleCo).
//
// Persistence: append-only JSONL per card under <dataDir>/agent/heal-attempts/.
// dataDir is EC2-first (/opt/secondbrain/data) so the memory lives where the
// always-on heal loop runs and persists across nights, falling back to the desktop
// spine store, then the repo for tests. An injectable opts.dataDir keeps tests pure.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function defaultDataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain/data'))
    return '/opt/secondbrain/data';
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'secondbrain', 'data');
  return path.join(REPO_ROOT, 'data');
}

function ledgerDir(opts = {}) {
  return path.join(opts.dataDir || defaultDataDir(), 'agent', 'heal-attempts');
}

// A stable identity for an option so a retry of the same option is recognized as
// "already tried" rather than counted as a new unique option.
function optionKey(option) {
  return String(option || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[`'"]/g, '')
    .trim();
}

function safeCardId(cardId) {
  return String(cardId || 'ExampleCo').replace(/[^a-z0-9._-]/gi, '_');
}

function ledgerPath(cardId, opts = {}) {
  return path.join(ledgerDir(opts), `${safeCardId(cardId)}.jsonl`);
}

function append(cardId, row, opts = {}) {
  const dir = ledgerDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ledgerPath(cardId, opts), JSON.stringify(row) + '\n');
  return row;
}

// Record one heal attempt. outcome: 'failed' | 'succeeded' | 'deployed-verified' |
// 'partial' | 'deploy-failed'. A 'failed'/'deploy-failed'/'partial' attempt consumes
// that option (it did not heal the card); only 'deployed-verified' should be followed
// by recordResolved.
function recordAttempt(cardId, attempt, opts = {}) {
  const a = attempt || {};
  return append(
    cardId,
    {
      type: 'attempt',
      cardId,
      option: String(a.option || '').trim(),
      optionKey: optionKey(a.option),
      outcome: a.outcome || 'failed',
      failureReason: a.failureReason ? String(a.failureReason).trim() : '',
      commit: a.commit || null,
      deployRef: a.deployRef || null,
      ts: a.ts || null, // caller stamps real time; null is honest "untimed"
    },
    opts,
  );
}

// Mark the card resolved (deployed + verified green in prod). This resets the
// attempt window so a future recurrence of the same defect starts fresh.
function recordResolved(cardId, info = {}, opts = {}) {
  return append(
    cardId,
    {
      type: 'resolved',
      cardId,
      commit: info.commit || null,
      deployRef: info.deployRef || null,
      ts: info.ts || null,
    },
    opts,
  );
}

function readRows(cardId, opts = {}) {
  const p = ledgerPath(cardId, opts);
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

// Attempts since the most recent 'resolved' marker (memory is per defect-occurrence).
function attemptsSinceResolved(cardId, opts = {}) {
  const rows = readRows(cardId, opts);
  let lastResolvedIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type === 'resolved') {
      lastResolvedIdx = i;
      break;
    }
  }
  return rows.slice(lastResolvedIdx + 1).filter((r) => r.type === 'attempt');
}

// Option keys that have been tried and did NOT heal the card (failed/partial/deploy-failed)
// since the last resolution. These options are consumed.
function consumedOptionKeys(cardId, opts = {}) {
  const consumedOutcomes = new Set(['failed', 'partial', 'deploy-failed']);
  const keys = new Set();
  for (const a of attemptsSinceResolved(cardId, opts)) {
    if (consumedOutcomes.has(a.outcome)) keys.add(a.optionKey);
  }
  return keys;
}

// The ladder options not yet consumed: the unique viable options that remain.
function remainingUniqueOptions(cardId, ladder, opts = {}) {
  const consumed = consumedOptionKeys(cardId, opts);
  return (Array.isArray(ladder) ? ladder : []).filter((o) => !consumed.has(optionKey(o)));
}

// The single next option to try, or null if none remain.
function nextOption(cardId, ladder, opts = {}) {
  const rem = remainingUniqueOptions(cardId, ladder, opts);
  return rem.length ? rem[0] : null;
}

// TRUE exhaustion: no untried unique viable option remains. This is the condition
// that flips verdict.js from 'defect' (keep looping) to 'blocked' (give up honestly).
function isExhausted(cardId, ladder, opts = {}) {
  return remainingUniqueOptions(cardId, ladder, opts).length === 0;
}

// The attempt history for the honest L1-L4 hard-block: every option tried and why it
// failed, since the last resolution.
function summarizeForHonestBlock(cardId, opts = {}) {
  const attempts = attemptsSinceResolved(cardId, opts).map((a) => ({
    option: a.option,
    outcome: a.outcome,
    failureReason: a.failureReason,
    ts: a.ts,
  }));
  return { attempts, count: attempts.length };
}

module.exports = {
  optionKey,
  ledgerPath,
  recordAttempt,
  recordResolved,
  readRows,
  attemptsSinceResolved,
  consumedOptionKeys,
  remainingUniqueOptions,
  nextOption,
  isExhausted,
  summarizeForHonestBlock,
  defaultDataDir,
};
