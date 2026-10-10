'use strict';

// Tokens and repair class per healer repair, on the EXISTING repair record.
//
// The record is the healer receipt (overnight-agentic-healer-runs/<date>.jsonl,
// phase 'final'). Each sessions[] row already carries a correlationId that the
// exact token report (token-spend-pareto.js, sessionGraph rows with
// meta.routeReceipt.correlationId) joins on. This module copies the measured
// tokens back onto the session row and totals them per cleared repair for the
// morning receipt. No new ledger: a night with no token report leaves
// `tokens` null and the receipt says unmeasured, never a guess.

const fs = require('node:fs');
const datedLedger = require('./dated-jsonl-ledger.js');
const { declaredRepairClass, isSystemHealthRowId } = require('./system-health-repair-class.js');

const LEDGER = 'overnight-agentic-healer-runs';

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// correlationId -> processed tokens, from an exact token-spend report.
function tokensByCorrelationId(report) {
  const out = new Map();
  for (const platform of ['claude', 'codex']) {
    const rows = report && report.platforms && report.platforms[platform];
    for (const row of rows && Array.isArray(rows.sessionGraph) ? rows.sessionGraph : []) {
      const id = row && row.meta && row.meta.routeReceipt && row.meta.routeReceipt.correlationId;
      if (!id) continue;
      out.set(String(id), (out.get(String(id)) || 0) + num(row.tokens));
    }
  }
  return out;
}

function sessionRows(record) {
  return Array.isArray(record && record.sessions) ? record.sessions.filter(Boolean) : [];
}

// Write measured tokens onto sessions[].tokens (and modelWork.tokens) of the
// final receipts for the given dates. Idempotent; only fills null tokens; the
// file is rewritten atomically and only when something changed.
function attachTokensToRepairRecords({ dataDir, dates, tokenMap }) {
  let attached = 0;
  let files = 0;
  if (!(tokenMap instanceof Map) || !tokenMap.size) return { attached, files };
  for (const date of dates) {
    const file = datedLedger.ledgerDatePath(dataDir, LEDGER, date);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let changed = false;
    const lines = text.split('\n').map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        return line;
      }
      if (!row || row.phase !== 'final') return line;
      let rowChanged = false;
      let total = 0;
      for (const session of sessionRows(row)) {
        const id = String(session.correlationId || '');
        if (session.tokens == null && tokenMap.has(id)) {
          session.tokens = tokenMap.get(id);
          attached += 1;
          rowChanged = true;
        }
        total += num(session.tokens);
      }
      if (!rowChanged) return line;
      if (row.modelWork && typeof row.modelWork === 'object') row.modelWork.tokens = total;
      if (row.session && row.session.correlationId && tokenMap.has(String(row.session.correlationId))) {
        row.session.tokens = tokenMap.get(String(row.session.correlationId));
      }
      changed = true;
      return JSON.stringify(row);
    });
    if (!changed) continue;
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
    fs.renameSync(tmp, file);
    files += 1;
  }
  return { attached, files };
}

// The class a historical or current session's target row has. Records written
// before this change carry no repairClass, so derive it from the target row.
function sessionRepairClass(session, record) {
  if (session && session.repairClass) return session.repairClass;
  let unitId = String((session && session.targetWorkUnitId) || '');
  if (!unitId && session && session.targetDefect) {
    const hit = (Array.isArray(record && record.perDefect) ? record.perDefect : []).find(
      (d) => d && d.defect === session.targetDefect && d.workUnitId,
    );
    unitId = hit ? String(hit.workUnitId) : '';
  }
  if (!unitId || !isSystemHealthRowId(unitId)) return '';
  return declaredRepairClass(unitId);
}

// Totals for the morning receipt and the replay. `offClass` is every session
// that targeted a row whose class forbids a model session (including
// unclassified); `offClassTokens` is what the gate would not have spent.
function summarizeRepairTokens(records) {
  const out = {
    sessions: 0,
    measuredSessions: 0,
    tokens: 0,
    cleared: 0,
    tokensPerCleared: null,
    byClass: {},
    offClassSessions: 0,
    offClassTokens: 0,
    offClassRows: {},
  };
  for (const record of records || []) {
    if (!record || record.phase !== 'final') continue;
    out.cleared += (Array.isArray(record.perDefect) ? record.perDefect : []).filter(
      (d) => d && d.outcome === 'cleared',
    ).length;
    for (const session of sessionRows(record)) {
      // A suppressed dispatch started no model; it spent nothing.
      if (session.category === 'suppressed-no-dispatch' || !(num(session.promptBytes) > 0)) continue;
      const cls = sessionRepairClass(session, record) || 'not-a-health-row';
      const tokens = session.tokens == null ? null : num(session.tokens);
      out.sessions += 1;
      const bucket = (out.byClass[cls] = out.byClass[cls] || { sessions: 0, tokens: 0 });
      bucket.sessions += 1;
      if (tokens != null) {
        out.measuredSessions += 1;
        out.tokens += tokens;
        bucket.tokens += tokens;
      }
      if (cls !== 'code_fixable' && cls !== 'not-a-health-row') {
        out.offClassSessions += 1;
        out.offClassTokens += tokens || 0;
        const unit = String(session.targetWorkUnitId || session.targetDefect || 'unknown');
        out.offClassRows[unit] = (out.offClassRows[unit] || 0) + (tokens || 0);
      }
    }
  }
  if (out.cleared > 0) out.tokensPerCleared = Math.round(out.tokens / out.cleared);
  return out;
}

function readRepairRecords({ dataDir, dates }) {
  const rows = [];
  for (const date of dates) {
    rows.push(
      ...datedLedger.readJsonlFileBounded(datedLedger.ledgerDatePath(dataDir, LEDGER, date)),
    );
  }
  return rows.filter((row) => row && row.phase === 'final');
}

function tokenLabel(n) {
  const v = num(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(v);
}

// One sentence for the morning receipt.
function repairTokensSentence(summary) {
  if (!summary || !summary.sessions) return 'No repair sessions ran.';
  const head =
    summary.measuredSessions === 0
      ? `${summary.sessions} repair session(s) ran; their tokens were not yet measured.`
      : `Repair sessions used ${tokenLabel(summary.tokens)} tokens across ${summary.measuredSessions} of ${summary.sessions} measured session(s); ` +
        (summary.cleared > 0
          ? `${summary.cleared} repair(s) cleared, ${tokenLabel(summary.tokensPerCleared)} tokens per cleared repair.`
          : 'no repair cleared with live proof.');
  const off = summary.offClassSessions
    ? ` ${summary.offClassSessions} session(s) (${tokenLabel(summary.offClassTokens)} tokens) targeted rows code cannot fix.`
    : ' No session targeted a row that code cannot fix.';
  return `${head}${off}`;
}

module.exports = {
  LEDGER,
  tokensByCorrelationId,
  attachTokensToRepairRecords,
  sessionRepairClass,
  summarizeRepairTokens,
  readRepairRecords,
  repairTokensSentence,
};
