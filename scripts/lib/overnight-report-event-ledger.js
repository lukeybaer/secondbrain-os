'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPORT_EVENT_SCHEMA = 'overnight-report-event@2';
const LEGACY_REPORT_EVENT_SCHEMA = 'overnight-report-event@1';
const REPORT_EVENT_DIR = path.join('agent', 'overnight-report-events');
const TERMINAL_OUTCOMES = new Set(['cleared', 'blocked', 'stale', 'failed']);
const OUTCOMES = new Set(['running', ...TERMINAL_OUTCOMES]);

function compact(value, max = 1600) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function safeDate(value) {
  const date = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('report event date must be YYYY-MM-DD');
  return date;
}

function reportEventPath(dataDir, date) {
  if (!dataDir) throw new Error('report event dataDir is required');
  return path.join(String(dataDir), REPORT_EVENT_DIR, `${safeDate(date)}.jsonl`);
}

function stableEventId(row) {
  const semantic = {
    date: row.date,
    kind: row.kind,
    subjectId: row.subjectId,
    state: row.state,
    outcome: row.outcome,
    terminal: row.terminal,
    sourceComponent: row.sourceComponent,
    sourceRunId: row.sourceRunId,
    evidenceHash: row.evidenceHash,
    content: row.content,
  };
  return crypto.createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}

function normalizeOutcome(value, { state = '', terminal = false, content = {} } = {}) {
  const explicit = compact(value, 40).toLowerCase();
  if (OUTCOMES.has(explicit)) return explicit;
  const label = compact(state, 100).toLowerCase();
  if (!terminal) return 'running';
  if (/stale|expired|superseded/.test(label)) return 'stale';
  if (/block|exhaust|needs-owner|needs-human|unavailable/.test(label)) return 'blocked';
  if (/fail|error|red|survived|partial/.test(label)) return 'failed';
  if (content && (content.ok === false || content.passed === false)) return 'failed';
  return 'cleared';
}

function normalizeStoredRow(row) {
  if (!row || typeof row !== 'object') return row;
  const terminal = row.terminal === true;
  const outcome = normalizeOutcome(row.outcome, {
    state: row.state,
    terminal,
    content: row.content,
  });
  return {
    ...row,
    outcome,
    terminal: terminal || TERMINAL_OUTCOMES.has(outcome),
    subjectType: compact(row.subjectType || row.kind || 'unknown', 80).toLowerCase(),
    countsAsDefect:
      typeof row.countsAsDefect === 'boolean'
        ? row.countsAsDefect
        : ['blocked', 'stale', 'failed'].includes(outcome),
  };
}

function appendReportEvent({
  dataDir,
  date,
  kind,
  subjectId,
  state,
  outcome,
  terminal = false,
  subjectType,
  countsAsDefect,
  sourceComponent,
  sourceRunId,
  evidenceHash,
  content,
  ts = new Date().toISOString(),
} = {}) {
  const normalizedOutcome = normalizeOutcome(outcome, { state, terminal, content });
  const row = {
    schema: REPORT_EVENT_SCHEMA,
    ts: new Date(ts).toISOString(),
    date: safeDate(date),
    kind: compact(kind, 80).toLowerCase(),
    subjectId: compact(subjectId, 180).toLowerCase(),
    state: compact(state, 100).toLowerCase(),
    outcome: normalizedOutcome,
    terminal: terminal === true || TERMINAL_OUTCOMES.has(normalizedOutcome),
    subjectType: compact(subjectType || kind || 'unknown', 80).toLowerCase(),
    countsAsDefect:
      typeof countsAsDefect === 'boolean'
        ? countsAsDefect
        : ['blocked', 'stale', 'failed'].includes(normalizedOutcome),
    sourceComponent: compact(sourceComponent, 100),
    sourceRunId: compact(sourceRunId, 180),
    evidenceHash: compact(evidenceHash, 80),
    content: content && typeof content === 'object' && !Array.isArray(content) ? content : {},
  };
  if (!row.kind || !row.subjectId || !row.state || !row.sourceComponent) {
    throw new Error('report event kind, subjectId, state, and sourceComponent are required');
  }
  row.eventId = stableEventId(row);
  const file = reportEventPath(dataDir, row.date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // O_APPEND gives every producer one complete line without a shared rewrite.
  // Duplicate semantic rows are harmless and collapse by eventId on read.
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return { row, file };
}

function readReportEvents({ dataDir, date, startMs = -Infinity, endMs = Infinity } = {}) {
  const file = reportEventPath(dataDir, date);
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { file, present: false, rows: [], malformed: 0 };
    }
    return { file, present: true, rows: [], malformed: 1 };
  }
  const rowsById = new Map();
  let malformed = 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const at = Date.parse(row && row.ts);
      if (
        !row ||
        ![REPORT_EVENT_SCHEMA, LEGACY_REPORT_EVENT_SCHEMA].includes(row.schema) ||
        row.date !== safeDate(date) ||
        !row.eventId ||
        !Number.isFinite(at)
      ) {
        malformed += 1;
        continue;
      }
      if (at < startMs || at > endMs) continue;
      rowsById.set(row.eventId, normalizeStoredRow(row));
    } catch {
      malformed += 1;
    }
  }
  const rows = [...rowsById.values()].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.eventId.localeCompare(b.eventId),
  );
  return { file, present: true, rows, malformed };
}

function summarizeTerminalOutcomes(rows, kind = '') {
  const latest = latestReportEventsBySubject(rows, kind);
  const counts = { running: 0, cleared: 0, blocked: 0, stale: 0, failed: 0 };
  const subjects = [];
  for (const row of latest.values()) {
    const normalized = normalizeStoredRow(row);
    counts[normalized.outcome] += 1;
    subjects.push({
      subjectId: normalized.subjectId,
      subjectType: normalized.subjectType,
      outcome: normalized.outcome,
      terminal: normalized.terminal,
      countsAsDefect: normalized.countsAsDefect,
      ts: normalized.ts,
      eventId: normalized.eventId,
    });
  }
  subjects.sort((a, b) => a.subjectId.localeCompare(b.subjectId));
  const openDefects = subjects.filter((row) => row.countsAsDefect);
  return {
    counts,
    subjects,
    openDefects,
    allTerminal: subjects.length > 0 && subjects.every((row) => row.terminal),
    clean: subjects.length > 0 && openDefects.length === 0 && counts.running === 0,
  };
}

function latestReportEventsBySubject(rows, kind = '') {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (kind && row.kind !== kind) continue;
    const prior = latest.get(row.subjectId);
    if (!prior || Date.parse(row.ts) >= Date.parse(prior.ts)) latest.set(row.subjectId, row);
  }
  return latest;
}

// Terminal evidence envelope (2026-09-02): a per-card symptom line ("card X
// is red") tells a night-owner nothing about WHY a whole night's worth of
// integrations, deploys, or recovery relaunches died on the same underlying
// cause. Every producer that hits a terminal failure attaches one of these
// normalized, size-bounded envelopes so overnight-watch-report.js can
// aggregate across producers into a systemic-causes section instead of only
// ever seeing per-card symptoms. Bounded so one runaway stderr dump or stack
// trace can never blow up a report event row.
function normalizeStringList(list, maxItems, maxLen) {
  const source = Array.isArray(list) ? list : list == null ? [] : [list];
  const out = [];
  for (const item of source) {
    const text = compact(item, maxLen);
    if (text) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function evidenceEnvelope({
  node,
  arc,
  owner,
  guard,
  expected,
  observed,
  receiptPaths,
  stack,
  cardIds,
  error,
} = {}) {
  return {
    node: compact(node, 120),
    arc: compact(arc, 120),
    owner: compact(owner, 120),
    guard: compact(guard, 120),
    expected: compact(expected, 300),
    observed: compact(observed, 300),
    error: compact(error, 300),
    receiptPaths: normalizeStringList(receiptPaths, 8, 300),
    stack: normalizeStringList(stack, 12, 300),
    cardIds: normalizeStringList(cardIds, 20, 120),
  };
}

// Never throws into a producer: a ledger write failure (disk full, bad
// dataDir, etc.) must never take down the healer/coordinator/circuit/
// supervisor call site that is already mid-failure-handling. Callers get
// {ok:false, error} back and carry on with their own result unchanged.
function appendTerminalEvidenceEvent({
  dataDir,
  date,
  kind,
  subjectId,
  sourceComponent,
  sourceRunId,
  envelope,
  outcome = 'failed',
  ts,
} = {}) {
  try {
    const normalizedEnvelope = evidenceEnvelope(envelope || {});
    const { row, file } = appendReportEvent({
      dataDir,
      date,
      kind,
      subjectId,
      state: 'terminal-failure',
      outcome,
      terminal: true,
      countsAsDefect: true,
      sourceComponent,
      sourceRunId,
      content: { evidence: normalizedEnvelope },
      ts,
    });
    return { ok: true, row, file, evidence: normalizedEnvelope };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

module.exports = {
  REPORT_EVENT_SCHEMA,
  LEGACY_REPORT_EVENT_SCHEMA,
  REPORT_EVENT_DIR,
  TERMINAL_OUTCOMES,
  normalizeOutcome,
  reportEventPath,
  appendReportEvent,
  readReportEvents,
  latestReportEventsBySubject,
  summarizeTerminalOutcomes,
  evidenceEnvelope,
  appendTerminalEvidenceEvent,
};
