'use strict';

// spine-failure-diagnosis.js
//
// Nov 11 2026: an owner chat Task failed identically seven times, each in
// under a second, with an empty cause, and the harness only slowed the retries.
// Rule: no failure without a cause, and a supervised owner Task never repeats an
// identical failing step; it stops as `blocked` with `execution.diagnosis`
// needed, and the off-path sweep (spine-off-path.js) diagnoses and acts.
//
// Pure helpers shared by the attempt runner, the worker and the sweep.

const crypto = require('node:crypto');

const MAX_DIAGNOSIS_MOVES = 3;
const FAILURE_HISTORY_LIMIT = 5;
const CAUSE_MAX_BYTES = 500;

const SECRET_KEY = '[\\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key)[\\w-]*';
const QUOTED_VALUE = '(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')';
// A quoted key (JSON or JS object) with a quoted or bare value.
const QUOTED_PAIR = new RegExp(`(["'])(${SECRET_KEY})\\1\\s*:\\s*(?:${QUOTED_VALUE}|[^,}\\s]+)`, 'gi');
// key=value or key: value, bare or quoted value.
const BARE_PAIR = new RegExp(`\\b(${SECRET_KEY})\\s*[=:]\\s*(?:${QUOTED_VALUE}|\\S+)`, 'gi');
const TOKEN_SHAPES =
  /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|xox[abp]-[\w-]+|Bearer\s+[\w.~+/-]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$))/g;

function redactSecrets(text) {
  return String(text || '')
    .replace(QUOTED_PAIR, (_match, quote, key) => `${quote}${key}${quote}:${quote}[redacted]${quote}`)
    .replace(BARE_PAIR, '[redacted]')
    .replace(TOKEN_SHAPES, '[redacted]');
}

function clipBytes(text, maxBytes) {
  let value = String(text || '');
  if (Buffer.byteLength(value) <= maxBytes) return value;
  value = Buffer.from(value).subarray(0, maxBytes - 3).toString('utf8').replace(/[\uFFFD]+$/, '');
  return `${value}...`;
}

// One line, secrets redacted, byte-bounded: safe to store.
function scrubCause(text, maxBytes = CAUSE_MAX_BYTES) {
  const line = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return clipBytes(line, maxBytes);
}

// What the failure means, with the volatile parts removed, so the same defect
// fingerprints the same on every attempt.
function normalizeCause(raw) {
  const lines = String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  return scrubCause(lines, 400)
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<ts>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]*(?:tmp|temp)[^\s'"]*/gi, '<tmp>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .toLowerCase();
}

function fingerprintFailure(phase, raw) {
  return crypto
    .createHash('sha1')
    .update(`${String(phase || '')}|${normalizeCause(raw)}`)
    .digest('hex')
    .slice(0, 12);
}

// Deterministic refusals never clear with time, so they win over any transient
// wording in the same text. Transient causes are narrow anchored shapes (or an
// explicit failure.transient flag), never loose substrings like "steer".
const DETERMINISTIC_PATTERN =
  /capability broker refused|module not found|cannot find module|\bEACCES\b|\bEPERM\b|permission denied|\bforbidden\b|not authorized|\bunauthorized\b|receipt missing/i;
const TRANSIENT_PATTERNS = [
  /^briefing-night-circuit-denied:/m,
  /\bcodex\b[^\n]{0,40}\bheld\b/i,
  /\b(?:rate limit|usage limit|quota (?:exceeded|reached|window))\b/i,
  /\bHTTP 429\b|\bstatus (?:429|50[234])\b/i,
  /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE)\b/,
  /\bsocket hang up\b/i,
  /\b(?:network|connection|request|model) (?:timeout|timed out|error|unreachable)\b/i,
  /^attempt reached its deadline/m,
  /^attempt stopped because its lease moved/m,
  /^attempt interrupted by an owner change of plan/m,
  /^owner steer arrived as the attempt finished/m,
  /^parked on long jobs:/m,
];

// Temporary land failures (disk pressure, timeouts, lock contention). The worker
// retries these on a timer; the diagnosis rule shares the one classification.
function retryableLandFailure(value) {
  return /\bENOSPC\b|no space left on device|\bETIMEDOUT\b|timed?\s*out|temporar(?:y|ily) unavailable|another\s+(?:integration|land|git).*lock|lock.*held/i.test(
    String(value || ''),
  );
}

function isTransientCause(raw, failure = {}) {
  if (failure.consumesAttempt === false || failure.transient === true) return true;
  const text = String(raw || '');
  if (DETERMINISTIC_PATTERN.test(text)) return false;
  return retryableLandFailure(text) || TRANSIENT_PATTERNS.some((re) => re.test(text));
}

function historyOf(task) {
  const rows = task?.execution?.failureHistory;
  return Array.isArray(rows) ? rows : [];
}

// Records one consumed failure and says whether it repeats the one before it.
// Deferrals never reach here, so they never break "consecutive".
function classifyFailure({ current, failure = {}, raw, phase, ts }) {
  const transient = isTransientCause(raw, failure);
  const fingerprint = fingerprintFailure(phase, raw);
  const history = historyOf(current);
  const previous = history[history.length - 1];
  const repeated = Boolean(previous && previous.fingerprint === fingerprint && !previous.transient && !transient);
  const entry = { ts, fingerprint, cause: scrubCause(raw, 300), ...(transient ? { transient: true } : {}) };
  return { transient, fingerprint, repeated, cause: entry.cause, history: [...history, entry].slice(-FAILURE_HISTORY_LIMIT) };
}

// Plain English for the owner, by category only: raw text never reaches a notice, so
// the real notifier's operational-leak guard cannot suppress it.
const GENERIC_PLAIN_CAUSE = 'the same step kept failing the same way';
function plainCause(cause) {
  const text = String(cause || '');
  if (/capability broker refused|receipt missing/i.test(text)) return 'the safety check that lets this run use its tools refused it';
  if (/prompt read failed/i.test(text)) return 'the run could not read its instructions';
  if (/spawn error/i.test(text)) return 'the coding agent could not be started';
  if (/unclassified attempt failure/i.test(text)) return 'the run ended with no recorded reason';
  if (/module not found|cannot find module/i.test(text)) return 'a required part of the system was missing';
  if (/permission|forbidden|unauthorized|not authorized|EACCES|EPERM/i.test(text)) return 'the run was not permitted to do something it needed';
  return GENERIC_PLAIN_CAUSE;
}

// ": <plain cause>" for a sentence that already says the step failed the same
// way, or nothing when the cause is only that generic phrase, so the status
// never reads "failed the same way: the same step kept failing the same way".
function plainCauseSuffix(cause) {
  const plain = plainCause(cause);
  return plain === GENERIC_PLAIN_CAUSE ? '' : `: ${plain}`;
}

function nextMoveNumber(diagnosis) {
  const moves = Array.isArray(diagnosis?.moves) ? diagnosis.moves : [];
  return moves.length + (diagnosis?.state === 'repairing' ? 0 : 1);
}

const REPLAN_KEYS = new Set(['prompt', 'title']);
const MOVE_KINDS = new Set(['fix-harness', 'replan', 'ask-owner']);

// The repair agent only DECIDES: its last message carries one structured line,
// DIAGNOSIS_MOVE: {"move": ...}. The host-side sweep validates and executes it.
function parseDiagnosisMove(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^DIAGNOSIS_MOVE:/i.test(line));
  if (lines.length === 0) return { ok: false, move: null, error: 'missing' };
  if (lines.length > 1) return { ok: false, move: null, error: 'duplicate-line' };
  let data;
  try {
    data = JSON.parse(lines[0].replace(/^DIAGNOSIS_MOVE:\s*/i, ''));
  } catch {
    return { ok: false, move: null, error: 'invalid-json' };
  }
  if (!data || typeof data !== 'object' || !MOVE_KINDS.has(data.move)) return { ok: false, move: null, error: 'invalid-move' };
  const str = (value, max) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);
  if (data.move === 'fix-harness') {
    return { ok: true, move: 'fix-harness', note: scrubCause(data.summary || '', 300), data: {} };
  }
  if (data.move === 'replan') {
    const patch = data.patch;
    const keys = patch && typeof patch === 'object' ? Object.keys(patch) : [];
    const reason = str(data.reason, 300);
    if (!keys.length || keys.some((key) => !REPLAN_KEYS.has(key)) || !reason) return { ok: false, move: 'replan', error: 'invalid-replan' };
    const clean = {};
    if ('prompt' in patch) clean.prompt = str(patch.prompt, 4000);
    if ('title' in patch) clean.title = str(patch.title, 200);
    if (Object.values(clean).some((value) => value === null)) return { ok: false, move: 'replan', error: 'invalid-replan' };
    return { ok: true, move: 'replan', note: scrubCause(reason, 300), data: { patch: clean, reason } };
  }
  const question = str(data.question, 400);
  const options = Array.isArray(data.options) ? data.options.map((option) => str(option, 160)) : [];
  if (!question || options.length < 2 || options.length > 4 || options.some((option) => option === null)) {
    return { ok: false, move: 'ask-owner', error: 'invalid-question' };
  }
  return { ok: true, move: 'ask-owner', note: scrubCause(question, 300), data: { question, options } };
}

module.exports = {
  CAUSE_MAX_BYTES,
  FAILURE_HISTORY_LIMIT,
  MAX_DIAGNOSIS_MOVES,
  classifyFailure,
  fingerprintFailure,
  isTransientCause,
  nextMoveNumber,
  normalizeCause,
  parseDiagnosisMove,
  plainCause,
  plainCauseSuffix,
  redactSecrets,
  retryableLandFailure,
  scrubCause,
};
