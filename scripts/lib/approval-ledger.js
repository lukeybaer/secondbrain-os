'use strict';

// Approval ledger (spine component). Logs each owner approval, edit and
// rejection by action type. A type approved PROMOTE_AFTER times in a row with
// no edit becomes "do it and report"; one rejection, regret or edit demotes it.
// Never-promote types (employer, money, new people) are pinned to "ask" in
// code, aligned with the never-list in memory/AMY_AUTHORIZATIONS.md. This file
// only decides ask-vs-proceed; it never authorizes anything the never-list bans.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA = 'amy.approval-ledger.event.v1';
const PROMOTE_AFTER = 10;
const OUTCOMES = Object.freeze(['approved', 'edited', 'rejected', 'regretted']);

// Types promoted by an explicit owner decision. The receipt travels with the type.
const SEEDS = Object.freeze({
  internal_fix_from_retrospective: {
    receipt:
      'ExampleCo 2026-10-05: tested internal fixes from a retrospective proceed after tests and review, then report.',
  },
});

// Never promotable, whatever the streak. Exact types plus name patterns.
const NEVER_PROMOTE_TYPES = Object.freeze([
  'application_submit',
  'send_email_new_contact',
  'send_message_new_contact',
  'outbound_call_new_contact',
  'move_money',
]);
const NEVER_PROMOTE_PATTERNS = Object.freeze([
  /ExampleCo/i, // reaches the owner's employer (ExampleCo.com)
  /employer/i,
  /(^|_)(money|payment|transfer|purchase|wire|trade)(_|$)/i,
  /new_(person|contact|recipient|human)/i,
  /(^|_)cold_(email|call|message|outreach)(_|$)/i,
]);

function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.SECONDBRAIN_DATA_DIR) return path.resolve(env.SECONDBRAIN_DATA_DIR);
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'secondbrain', 'data');
  if (platform !== 'win32') return '/opt/secondbrain/data';
  return path.join(os.homedir(), '.secondbrain', 'data');
}

function normalizeType(type) {
  const t = String(type || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!t) throw new Error('approval ledger action type is required');
  return t;
}

function isNeverPromote(type) {
  const t = normalizeType(type);
  return NEVER_PROMOTE_TYPES.includes(t) || NEVER_PROMOTE_PATTERNS.some((re) => re.test(t));
}

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn line is ignored.
    }
  }
  return rows;
}

function fold(type, events) {
  const seed = SEEDS[type] || null;
  const state = {
    type,
    streak: 0,
    approved: 0,
    edited: 0,
    rejected: 0,
    regretted: 0,
    promoted: Boolean(seed),
    promoted_by: seed ? 'seed' : null,
    receipt: seed ? seed.receipt : null,
    demotions: 0,
    last_event_at: null,
  };
  for (const ev of events) {
    if (ev.action_type !== type) continue;
    state.last_event_at = ev.ts || state.last_event_at;
    if (ev.outcome === 'approved') {
      state.approved += 1;
      state.streak += 1;
      if (!state.promoted && state.streak >= PROMOTE_AFTER) {
        state.promoted = true;
        state.promoted_by = 'streak';
        state.receipt = `${PROMOTE_AFTER} consecutive approvals with no edit, as of ${ev.ts}`;
      }
    } else if (OUTCOMES.includes(ev.outcome)) {
      state[ev.outcome] += 1;
      state.streak = 0;
      if (state.promoted) state.demotions += 1;
      state.promoted = false;
      state.promoted_by = null;
      state.receipt = null;
    }
  }
  state.never_promote = isNeverPromote(type);
  if (state.never_promote) {
    state.promoted = false;
    state.promoted_by = null;
    state.receipt = null;
  }
  state.mode = state.promoted ? 'do_and_report' : 'ask';
  return state;
}

function createApprovalLedger({ dataDir, ledgerPath, now = () => new Date().toISOString() } = {}) {
  const file =
    ledgerPath || path.join(dataDir || defaultDataDir(), 'agent', 'approval-ledger.jsonl');

  function status(type) {
    return fold(normalizeType(type), readEvents(file));
  }

  function record(type, outcome, meta = {}) {
    const actionType = normalizeType(type);
    if (!OUTCOMES.includes(outcome)) {
      throw new Error(`approval ledger outcome must be one of ${OUTCOMES.join(', ')}`);
    }
    const row = {
      schema: SCHEMA,
      ts: now(),
      action_type: actionType,
      outcome,
      source: meta.source ? String(meta.source).slice(0, 120) : null,
      note: meta.note ? String(meta.note).slice(0, 500) : null,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(row)}\n`, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return status(actionType);
  }

  function list() {
    const events = readEvents(file);
    const types = new Set([...Object.keys(SEEDS), ...events.map((e) => e.action_type)]);
    return [...types]
      .filter(Boolean)
      .sort()
      .map((t) => fold(t, events));
  }

  // True only when the type is promoted and not never-promote.
  function mayProceed(type) {
    return status(type).mode === 'do_and_report';
  }

  // asks: [{ type, summary, recommendation, default }]. Promoted types are not
  // asked; they come back in `proceed` for do-and-report.
  function batchAsks(asks = []) {
    const ask = [];
    const proceed = [];
    for (const item of asks) {
      (mayProceed(item.type) ? proceed : ask).push(item);
    }
    const lines = ask.map(
      (a, i) =>
        `${i + 1}. ${a.summary}\n   Recommendation: ${a.recommendation || 'none given'}\n   Default if you do not answer: ${a.default || 'hold, do nothing'}`,
    );
    const text = ask.length
      ? `${ask.length} item${ask.length === 1 ? '' : 's'} need your answer:\n${lines.join('\n')}`
      : '';
    return { text, ask, proceed };
  }

  return { file, record, status, list, mayProceed, batchAsks };
}

module.exports = {
  NEVER_PROMOTE_PATTERNS,
  NEVER_PROMOTE_TYPES,
  OUTCOMES,
  PROMOTE_AFTER,
  SEEDS,
  createApprovalLedger,
  isNeverPromote,
  normalizeType,
};
