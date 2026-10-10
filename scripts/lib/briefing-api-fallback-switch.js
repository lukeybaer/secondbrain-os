'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA = 'briefing_api_fallback_switch.v1';
const SCOPE = 'overnight-briefing';
const MAX_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_CAP_USD = 10;
const DEFAULT_CAP_USD = 10;
const DEFAULT_MAX_CALLS = 40;
const MAX_CALLS = 40;
const RESERVATION_USD = 0.25;
const MAX_PROMPT_CHARS = 16_000;
const VALID_APPROVERS = new Set(['ExampleCo', 'PRIVATE_NAME']);
// EC2 owns the overnight briefing without any laptop dependency. The reverse
// tunnel proxy is not an admissible proof rung for the cloud-only night.
const REQUIRED_SUBSCRIPTION_RUNGS = ['codex', 'claude-cli'];

function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = value == null ? new Date() : new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(NaN) : parsed;
}

function ctHour(dateLike) {
  const date = toDate(dateLike);
  if (Number.isNaN(date.getTime())) return NaN;
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(date),
  );
}

function ctDateString(dateLike) {
  const date = toDate(dateLike);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(date);
}

function previousDateString(day) {
  const [year, month, date] = String(day)
    .split('-')
    .map((part) => Number(part));
  if (![year, month, date].every(Number.isFinite)) return '';
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

function inOvernightWindow(dateLike) {
  const hour = ctHour(dateLike);
  return Number.isFinite(hour) && (hour >= 18 || hour < 6);
}

function overnightKey(dateLike) {
  const date = toDate(dateLike);
  const day = ctDateString(date);
  if (!day) return '';
  return ctHour(date) < 6 ? previousDateString(day) : day;
}

function overnightWindowEnd(dateLike) {
  const date = toDate(dateLike);
  if (Number.isNaN(date.getTime()) || !inOvernightWindow(date)) return new Date(NaN);
  let cursor = new Date(Math.floor(date.getTime() / 60_000) * 60_000);
  for (let minute = 0; minute <= 12 * 60; minute += 1) {
    if (!inOvernightWindow(cursor)) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return new Date(NaN);
}

function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.SECONDBRAIN_DATA_DIR) return path.resolve(env.SECONDBRAIN_DATA_DIR);
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'secondbrain', 'data');
  if (platform !== 'win32') return '/opt/secondbrain/data';
  return path.join(os.homedir(), '.secondbrain', 'data');
}

function switchFile(opts = {}) {
  return (
    opts.switchFile ||
    process.env.BRIEFING_API_FALLBACK_SWITCH_FILE ||
    path.join(opts.dataDir || defaultDataDir(), 'agent', 'briefing-api-fallback-switch.json')
  );
}

function usageFile(opts = {}) {
  return (
    opts.usageFile ||
    process.env.BRIEFING_API_FALLBACK_USAGE_FILE ||
    path.join(opts.dataDir || defaultDataDir(), 'agent', 'briefing-api-fallback-usage.jsonl')
  );
}

function atomicWriteJson(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsApi.renameSync(temp, file);
  try {
    fsApi.chmodSync(file, 0o600);
  } catch {}
  return value;
}

function disabledState({ now = new Date(), reason = 'owner-policy-default' } = {}) {
  return {
    schema: SCHEMA,
    enabled: false,
    scope: SCOPE,
    authorization: 'unauthorized',
    reason: String(reason || 'owner-policy-default'),
    updatedAt: toDate(now).toISOString(),
  };
}

function normalizeApprover(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+(ExampleCo)$/i, '');
}

function enabledState({
  approvedBy,
  authorizationText,
  now = new Date(),
  ttlHours = 12,
  capUsd = DEFAULT_CAP_USD,
  maxCalls = DEFAULT_MAX_CALLS,
  authorizationId = crypto.randomUUID(),
} = {}) {
  const authorizedAt = toDate(now);
  const approver = normalizeApprover(approvedBy);
  const text = String(authorizationText || '').trim();
  const ttl = Number(ttlHours);
  const cap = Number(capUsd);
  const calls = Number(maxCalls);
  if (!VALID_APPROVERS.has(approver)) throw new Error('approvedBy must be ExampleCo or PRIVATE_NAME');
  if (text.length < 12) throw new Error('authorizationText must contain the principal instruction');
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 12) throw new Error('ttlHours must be > 0 and <= 12');
  if (!Number.isFinite(cap) || cap <= 0 || cap > MAX_CAP_USD)
    throw new Error(`capUsd must be > 0 and <= ${MAX_CAP_USD}`);
  if (!Number.isInteger(calls) || calls <= 0 || calls > MAX_CALLS)
    throw new Error(`maxCalls must be an integer from 1 to ${MAX_CALLS}`);
  if (!inOvernightWindow(authorizedAt))
    throw new Error('the overnight briefing fallback may only be enabled from 6 PM to 6 AM CT');
  const requestedExpiry = new Date(authorizedAt.getTime() + ttl * 60 * 60 * 1000);
  const windowEnd = overnightWindowEnd(authorizedAt);
  const expiresAt = new Date(Math.min(requestedExpiry.getTime(), windowEnd.getTime()));
  return {
    schema: SCHEMA,
    enabled: true,
    scope: SCOPE,
    authorization: 'explicit-owner-window',
    authorizationId: String(authorizationId),
    approvedBy: approver,
    authorizationText: text,
    authorizedAt: authorizedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    night: overnightKey(authorizedAt),
    capUsd: cap,
    maxCalls: calls,
    reservationUsd: RESERVATION_USD,
    updatedAt: authorizedAt.toISOString(),
  };
}

function readSwitchState(opts = {}) {
  try {
    return JSON.parse((opts.fsApi || fs).readFileSync(switchFile(opts), 'utf8'));
  } catch {
    return disabledState({ reason: 'missing-or-unreadable-switch' });
  }
}

function writeDisabledState(opts = {}) {
  const state = disabledState(opts);
  return atomicWriteJson(switchFile(opts), state, opts.fsApi || fs);
}

function writeSwitchState(state, opts = {}) {
  return atomicWriteJson(switchFile(opts), state, opts.fsApi || fs);
}

function writeEnabledState(input = {}, opts = {}) {
  const state = enabledState(input);
  return atomicWriteJson(switchFile(opts), state, opts.fsApi || fs);
}

function evaluateSwitchState(state, { now = new Date(), surface = '', briefingContext = false } = {}) {
  const instant = toDate(now);
  const fail = (reason) => ({ ok: false, reason, state });
  if (!state || state.schema !== SCHEMA) return fail('invalid-schema');
  if (state.enabled !== true || state.authorization !== 'explicit-owner-window')
    return fail('unauthorized');
  if (state.scope !== SCOPE || briefingContext !== true) return fail('wrong-scope');
  if (!String(surface || '').toLowerCase().includes('briefing')) return fail('wrong-surface');
  if (!VALID_APPROVERS.has(normalizeApprover(state.approvedBy))) return fail('invalid-approver');
  if (String(state.authorizationText || '').trim().length < 12) return fail('missing-owner-instruction');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(state.authorizationId || ''),
  )) return fail('invalid-authorization-id');
  const authorizedAt = toDate(state.authorizedAt);
  const expiresAt = toDate(state.expiresAt);
  if ([instant, authorizedAt, expiresAt].some((date) => Number.isNaN(date.getTime())))
    return fail('invalid-time');
  if (authorizedAt.getTime() > instant.getTime() + 5 * 60 * 1000) return fail('future-authorization');
  if (expiresAt.getTime() <= instant.getTime()) return fail('expired');
  if (expiresAt.getTime() - authorizedAt.getTime() > MAX_WINDOW_MS) return fail('window-too-long');
  if (!inOvernightWindow(instant) || state.night !== overnightKey(instant))
    return fail('outside-authorized-night');
  const capUsd = Number(state.capUsd);
  const maxCalls = Number(state.maxCalls);
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > MAX_CAP_USD) return fail('invalid-cap');
  if (!Number.isInteger(maxCalls) || maxCalls <= 0 || maxCalls > MAX_CALLS)
    return fail('invalid-call-limit');
  if (Number(state.reservationUsd) !== RESERVATION_USD) return fail('invalid-reservation');
  return { ok: true, state };
}

function subscriptionRungsExhausted(attempts = []) {
  const terminal = new Map();
  for (const attempt of attempts) {
    const outcome = String(attempt?.outcome || '');
    if (!attempt || outcome.startsWith('transient-retry:')) continue;
    terminal.set(String(attempt.rung || ''), outcome);
  }
  return REQUIRED_SUBSCRIPTION_RUNGS.every((name) => {
    const outcome = terminal.get(name) || '';
    return outcome === 'null' || outcome === 'sentinel-failure' || outcome.startsWith('threw:');
  });
}

function acquireLock(file, fsApi = fs, nowMs = Date.now()) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fsApi.openSync(file, 'wx', 0o600);
    fsApi.writeFileSync(fd, `${process.pid}\t${new Date(nowMs).toISOString()}\n`);
    return fd;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      try {
        const ageMs = nowMs - fsApi.statSync(file).mtimeMs;
        if (ageMs > 60_000) {
          fsApi.unlinkSync(file);
          const fd = fsApi.openSync(file, 'wx', 0o600);
          fsApi.writeFileSync(fd, `${process.pid}\t${new Date(nowMs).toISOString()}\n`);
          return fd;
        }
      } catch {}
    }
    return null;
  }
}

function releaseLock(file, fd, fsApi = fs) {
  try {
    if (fd != null) fsApi.closeSync(fd);
  } catch {}
  try {
    fsApi.unlinkSync(file);
  } catch {}
}

function readUsage(file, fsApi = fs) {
  try {
    const rows = fsApi
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { ok: true, rows };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, rows: [] };
    return { ok: false, rows: [] };
  }
}

function reserveCall(state, { now = new Date(), usageFile: file, fsApi = fs } = {}) {
  const target = file || usageFile();
  const lock = `${target}.lock`;
  const fd = acquireLock(lock, fsApi, toDate(now).getTime());
  if (fd == null) return { ok: false, reason: 'usage-lock-unavailable' };
  try {
    // The ceiling belongs to the CT night, not one authorization id. A second
    // activation in the same night cannot reset the call or dollar counters.
    const usage = readUsage(target, fsApi);
    if (!usage.ok) return { ok: false, reason: 'usage-ledger-unreadable' };
    const rows = usage.rows.filter(
      (row) => row.night === state.night && row.kind === 'reservation',
    );
    const reservedUsd = rows.reduce((sum, row) => sum + Number(row.reservedUsd || 0), 0);
    if (rows.length >= state.maxCalls) return { ok: false, reason: 'call-limit-reached' };
    if (reservedUsd + RESERVATION_USD > Number(state.capUsd) + 1e-9)
      return { ok: false, reason: 'night-cap-reached' };
    const reservation = {
      schema: 'briefing_api_fallback_usage.v1',
      kind: 'reservation',
      reservationId: crypto.randomUUID(),
      authorizationId: state.authorizationId,
      night: state.night,
      reservedUsd: RESERVATION_USD,
      createdAt: toDate(now).toISOString(),
    };
    try {
      fsApi.mkdirSync(path.dirname(target), { recursive: true });
      fsApi.appendFileSync(target, `${JSON.stringify(reservation)}\n`, { mode: 0o600 });
    } catch {
      return { ok: false, reason: 'usage-ledger-write-failed' };
    }
    return {
      ok: true,
      reservation,
      callsReserved: rows.length + 1,
      reservedUsd: Math.round((reservedUsd + RESERVATION_USD) * 100) / 100,
    };
  } finally {
    releaseLock(lock, fd, fsApi);
  }
}

function recordSettlement(
  authorization,
  {
    usage = {},
    estimatedUsd = 0,
    model = '',
    now = new Date(),
    usageFile: file,
    dataDir,
    fsApi = fs,
  } = {},
) {
  const target = file || usageFile({ dataDir });
  const row = {
    schema: 'briefing_api_fallback_usage.v1',
    kind: 'settlement',
    reservationId: authorization?.reservation?.reservationId || '',
    authorizationId: authorization?.state?.authorizationId || '',
    night: authorization?.state?.night || '',
    model,
    inputTokens: Number(usage.input_tokens || usage.inputTokens || 0),
    outputTokens: Number(usage.output_tokens || usage.outputTokens || 0),
    estimatedUsd: Number(estimatedUsd) || 0,
    createdAt: toDate(now).toISOString(),
  };
  fsApi.mkdirSync(path.dirname(target), { recursive: true });
  fsApi.appendFileSync(target, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return row;
}

function authorizeBriefingApiFallback({
  rungName,
  attempts = [],
  now = new Date(),
  surface = '',
  briefingContext = false,
  prompt = '',
  switchFile: statePath,
  usageFile: ledgerPath,
  dataDir,
  fsApi = fs,
} = {}) {
  if (String(rungName || '') !== 'bedrock')
    return { ok: false, outcome: 'charged-api-disabled:owner-policy' };
  if (String(prompt || '').length > MAX_PROMPT_CHARS)
    return { ok: false, outcome: 'briefing-api-switch:prompt-too-large' };
  const state = readSwitchState({ switchFile: statePath, dataDir, fsApi });
  const evaluated = evaluateSwitchState(state, { now, surface, briefingContext });
  if (!evaluated.ok)
    return { ok: false, outcome: `briefing-api-switch:${evaluated.reason}`, state };
  if (!subscriptionRungsExhausted(attempts))
    return { ok: false, outcome: 'briefing-api-switch:subscriptions-not-exhausted', state };
  const reservation = reserveCall(state, { now, usageFile: ledgerPath || usageFile({ dataDir }), fsApi });
  if (!reservation.ok)
    return { ok: false, outcome: `briefing-api-switch:${reservation.reason}`, state };
  return {
    ok: true,
    outcome: 'briefing-api-switch:authorized',
    state,
    reservation: reservation.reservation,
    callsReserved: reservation.callsReserved,
    reservedUsd: reservation.reservedUsd,
  };
}

module.exports = {
  DEFAULT_CAP_USD,
  DEFAULT_MAX_CALLS,
  MAX_CAP_USD,
  MAX_CALLS,
  MAX_PROMPT_CHARS,
  MAX_WINDOW_MS,
  REQUIRED_SUBSCRIPTION_RUNGS,
  RESERVATION_USD,
  SCHEMA,
  SCOPE,
  authorizeBriefingApiFallback,
  defaultDataDir,
  disabledState,
  enabledState,
  evaluateSwitchState,
  inOvernightWindow,
  overnightKey,
  overnightWindowEnd,
  readSwitchState,
  recordSettlement,
  reserveCall,
  subscriptionRungsExhausted,
  switchFile,
  usageFile,
  writeDisabledState,
  writeEnabledState,
  writeSwitchState,
};
