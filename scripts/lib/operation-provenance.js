'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomicRetry } = require('./write-json-atomic-retry.js');

const SCHEMA = 'amy.operation_provenance.v1';
const OPERATION_ID_RE = /^op_[A-Za-z0-9_.-]{8,160}$/;

function runtimeDataDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.SECONDBRAIN_DATA_DIR) return path.resolve(process.env.SECONDBRAIN_DATA_DIR);
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'secondbrain', 'data');
  }
  if (fs.existsSync('/opt/secondbrain')) return '/opt/secondbrain/data';
  return path.join(os.homedir(), '.secondbrain', 'data');
}

function provenancePaths(dataDir) {
  const root = path.join(runtimeDataDir(dataDir), 'agent', 'operation-provenance');
  return {
    root,
    ledgerDir: path.join(root, 'ledger'),
    activeCache: path.join(root, 'active.json'),
  };
}

function safeReadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(file, value) {
  writeJsonAtomicRetry(file, value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeKey(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function createOperationId({ nowMs = Date.now(), randomHex } = {}) {
  const suffix = randomHex || crypto.randomBytes(8).toString('hex');
  return `op_${nowMs}_${suffix}`;
}

function isOperationId(value) {
  return OPERATION_ID_RE.test(String(value || ''));
}

function activeKeys({ sessionId, session_id, cwd, branch } = {}) {
  const keys = [];
  const session = String(sessionId || session_id || '').trim();
  if (session) keys.push(`session:${session}`);
  const normalizedCwd = normalizeKey(cwd);
  if (normalizedCwd) keys.push(`cwd:${normalizedCwd}`);
  const normalizedBranch = normalizeKey(branch);
  if (normalizedBranch) keys.push(`branch:${normalizedBranch}`);
  return keys;
}

function bindActiveOperation(operationId, input = {}, { dataDir, now = new Date() } = {}) {
  if (!isOperationId(operationId)) throw new Error(`invalid operation id: ${operationId}`);
  const keys = activeKeys(input);
  if (!keys.length) return [];
  const paths = provenancePaths(dataDir);
  const cache = safeReadJson(paths.activeCache, {}) || {};
  const value = {
    operation_id: operationId,
    updated_at: now.toISOString(),
  };
  for (const key of keys) cache[key] = value;
  atomicWriteJson(paths.activeCache, cache);
  return keys;
}

function resolveOperationId(input = {}, options = {}) {
  const explicit = String(
    input.operationId ||
      input.operation_id ||
      options.operationId ||
      process.env.SB_OPERATION_ID ||
      '',
  ).trim();
  if (explicit) {
    if (!isOperationId(explicit)) throw new Error(`invalid operation id: ${explicit}`);
    bindActiveOperation(explicit, input, options);
    return { operationId: explicit, source: 'explicit' };
  }
  const cache = safeReadJson(provenancePaths(options.dataDir).activeCache, {}) || {};
  for (const key of activeKeys(input)) {
    if (isOperationId(cache[key]?.operation_id)) {
      return { operationId: cache[key].operation_id, source: key };
    }
  }
  const operationId = createOperationId(options);
  bindActiveOperation(operationId, input, options);
  return { operationId, source: 'created' };
}

function cleanSegment(value, fallback) {
  const clean = String(value || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return clean || fallback;
}

function canonicalEvent(event) {
  return JSON.stringify({
    schema: event.schema,
    event_id: event.event_id,
    operation_id: event.operation_id,
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    surface: event.surface,
    session_id: event.session_id,
    actor: event.actor,
    status: event.status,
    commit: event.commit,
    base_sha: event.base_sha,
    cwd: event.cwd,
    branch: event.branch,
    receipt_path: event.receipt_path,
    receipt_sha256: event.receipt_sha256,
    details: event.details,
  });
}

function recordOperationEvent(input = {}, options = {}) {
  const now = options.now || new Date();
  const resolved = resolveOperationId(input, { ...options, now });
  const event = {
    schema: SCHEMA,
    event_id:
      input.eventId ||
      input.event_id ||
      `oe_${now.getTime()}_${options.randomHex || crypto.randomBytes(6).toString('hex')}`,
    operation_id: resolved.operationId,
    event_type: String(input.eventType || input.event_type || 'operation.observed'),
    occurred_at: now.toISOString(),
    surface: String(input.surface || 'unknown'),
    session_id: String(input.sessionId || input.session_id || ''),
    actor: String(input.actor || process.env.USERNAME || process.env.USER || ''),
    status: String(input.status || 'observed'),
    commit: String(input.commit || ''),
    base_sha: String(input.baseSha || input.base_sha || ''),
    cwd: String(input.cwd || ''),
    branch: String(input.branch || ''),
    receipt_path: String(input.receiptPath || input.receipt_path || ''),
    receipt_sha256: String(input.receiptSha256 || input.receipt_sha256 || ''),
    details: input.details && typeof input.details === 'object' ? input.details : {},
  };
  event.event_sha256 = sha256(canonicalEvent(event));
  const paths = provenancePaths(options.dataDir);
  fs.mkdirSync(paths.ledgerDir, { recursive: true });
  // Each process/surface owns its append file. Readers merge these immutable
  // spools, avoiding a global lock while retaining every event as authority.
  const writer = `${cleanSegment(event.surface, 'surface')}-${process.pid}`;
  const ledgerPath = path.join(paths.ledgerDir, `${writer}.jsonl`);
  fs.appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  bindActiveOperation(event.operation_id, input, { ...options, now });
  return { event, ledgerPath, operationSource: resolved.source };
}

function readOperationEvents({ dataDir } = {}) {
  const dir = provenancePaths(dataDir).ledgerDir;
  if (!fs.existsSync(dir)) return [];
  const events = [];
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    const file = path.join(dir, name);
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.schema !== SCHEMA || !isOperationId(event.operation_id)) continue;
        if (event.event_sha256 !== sha256(canonicalEvent(event))) continue;
        events.push({ ...event, ledger_path: file });
      } catch {
        // A torn final append is ignored; earlier immutable rows remain usable.
      }
    }
  }
  return events.sort(
    (a, b) => (Date.parse(a.occurred_at) || 0) - (Date.parse(b.occurred_at) || 0),
  );
}

module.exports = {
  OPERATION_ID_RE,
  SCHEMA,
  activeKeys,
  bindActiveOperation,
  createOperationId,
  isOperationId,
  provenancePaths,
  readOperationEvents,
  recordOperationEvent,
  resolveOperationId,
  runtimeDataDir,
};
