'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  CT_ZONE,
  DELIVERY_HOUR_CT,
  DELIVERY_MINUTE_CT,
  INPUT_START_HOUR_CT,
  ctWallTimeToEpochMs,
  dateKeyInCt,
} = require('./briefing-run-window.js');

const SCHEMA = 'briefing-attended-action@1';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
// Ninety minutes of working time plus the governor's one-hour credited wait.
// Consumption anchors this duration so queue time cannot steal the repair tail.
const DEFAULT_RUN_TTL_MS = 150 * 60 * 1000;
const TRUSTED_ISSUERS = new Set([
  'attended-ssh-exact-card',
  'authenticated-briefing-button',
]);
const verifiedCapabilities = new WeakSet();

function actionRoot(dataDir) {
  return path.join(dataDir, 'agent', 'briefing-attended-actions');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function receiptPath(dataDir, token) {
  return path.join(actionRoot(dataDir), `${tokenHash(token)}.json`);
}

function consumedReceiptPath(dataDir, token) {
  return path.join(actionRoot(dataDir), `${tokenHash(token)}.consumed.json`);
}

function writeJsonAtomic(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fsApi.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsApi.renameSync(tmp, file);
}

function resolveAttendedActionSecret({ env = process.env, fsApi = fs } = {}) {
  const direct = String(env.BRIEFING_ATTENDED_ACTION_SECRET || '').trim();
  if (direct) return direct;
  try {
    const root = path.resolve(__dirname, '..', '..');
    const lines = fsApi.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/);
    const prefix = 'BRIEFING_ATTENDED_ACTION_SECRET=';
    const line = lines.find((row) => String(row).trim().startsWith(prefix));
    if (line) return String(line).trim().slice(prefix.length).trim();
  } catch {
    // Missing secret fails closed at mint/consume.
  }
  return '';
}

function signedFields(receipt) {
  return {
    schema: receipt.schema,
    tokenHash: receipt.tokenHash,
    date: receipt.date,
    cardId: receipt.cardId,
    workUnitId: receipt.workUnitId,
    issuer: receipt.issuer,
    issuerProof: receipt.issuerProof || null,
    issuedAtMs: Number(receipt.issuedAtMs),
    expiresAtMs: Number(receipt.expiresAtMs),
  };
}

function receiptSignature(receipt, secret) {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(JSON.stringify(signedFields(receipt)))
    .digest('hex');
}

function signatureMatches(receipt, secret) {
  const actual = Buffer.from(String(receipt && receipt.signature || ''), 'hex');
  const expected = Buffer.from(receiptSignature(receipt || {}, secret), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function canonicalWorkUnitScope(cardId, workUnitId) {
  const normalizedCard = String(cardId || '').trim().toLowerCase();
  let requested;
  if (Array.isArray(workUnitId)) {
    requested = workUnitId;
  } else {
    const raw = String(workUnitId === undefined || workUnitId === null ? normalizedCard : workUnitId)
      .trim()
      .toLowerCase();
    // Reserved internal encoding. Real work-unit ids may not use `<card>:set:`.
    const setPrefix = `${normalizedCard}:set:`;
    if (raw.startsWith(setPrefix)) {
      try {
        const decoded = JSON.parse(decodeURIComponent(raw.slice(setPrefix.length)));
        if (!Array.isArray(decoded)) throw new Error('not an array');
        requested = decoded;
      } catch {
        throw new Error('attended action work-unit set is malformed');
      }
    } else {
      requested = raw.split(',');
    }
  }
  const units = [...new Set(requested
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim().toLowerCase()))]
    .filter(Boolean)
    .sort();
  if (units.length === 0) {
    throw new Error('attended action requires one exact work unit');
  }
  if (
    units.some(
      (unit) => unit !== normalizedCard && !unit.startsWith(`${normalizedCard}:`),
    )
  ) {
    throw new Error('attended action work unit must remain inside its exact card');
  }
  if (units.length > 1 && units.includes(normalizedCard)) {
    throw new Error('attended action work-unit set cannot mix a whole card with sub-units');
  }
  if (units.length === 1) return units[0];
  return `${normalizedCard}:set:${encodeURIComponent(JSON.stringify(units))}`;
}

function normalizeScope({ date, cardId, workUnitId } = {}) {
  const normalizedDate = String(date || '').trim();
  const normalizedCard = String(cardId || '').trim().toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    throw new Error('attended action requires an exact briefing date');
  }
  if (!/^[a-z][a-z0-9_]*$/.test(normalizedCard)) {
    throw new Error('attended action requires one exact card');
  }
  const normalizedWorkUnit = canonicalWorkUnitScope(normalizedCard, workUnitId);
  return {
    date: normalizedDate,
    cardId: normalizedCard,
    workUnitId: normalizedWorkUnit,
  };
}

function daytimeCapacityWindowEndMs(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CT_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minute = Number(byType.hour) * 60 + Number(byType.minute);
  // 23:00-05:30 CT belongs to autonomous input and delivery. A declared
  // daytime mode cannot mint capacity authority inside that real clock window.
  const inputStartMinute = INPUT_START_HOUR_CT * 60;
  const deliveryEndMinute = DELIVERY_HOUR_CT * 60 + DELIVERY_MINUTE_CT;
  if (minute >= inputStartMinute || minute < deliveryEndMinute) return nowMs - 1;
  return ctWallTimeToEpochMs(dateKeyInCt(nowMs), INPUT_START_HOUR_CT, 0);
}

function mintAttendedActionReceipt({
  dataDir,
  token,
  date,
  cardId,
  workUnitId,
  issuer,
  issuerProof = '',
  nowMs = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  fsApi = fs,
  secret = resolveAttendedActionSecret({ fsApi }),
  trustedIssuers = TRUSTED_ISSUERS,
} = {}) {
  if (!dataDir) throw new Error('attended action requires dataDir');
  if (!String(token || '').trim()) throw new Error('attended action requires a non-empty token');
  if (!trustedIssuers.has(String(issuer || '').trim())) {
    throw new Error('attended action requires a trusted issuer');
  }
  if (!String(secret || '').trim()) throw new Error('attended action signing secret unavailable');
  const scope = normalizeScope({ date, cardId, workUnitId });
  const digest = tokenHash(token);
  const file = receiptPath(dataDir, token);
  if (fsApi.existsSync(file) || fsApi.existsSync(consumedReceiptPath(dataDir, token))) {
    throw new Error('attended action token already exists');
  }
  const receipt = {
    schema: SCHEMA,
    tokenHash: digest,
    ...scope,
    issuer: String(issuer),
    issuerProof: String(issuerProof || '') || null,
    issuedAt: new Date(nowMs).toISOString(),
    issuedAtMs: nowMs,
    expiresAt: new Date(nowMs + Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS)).toISOString(),
    expiresAtMs: nowMs + Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS),
  };
  receipt.signature = receiptSignature(receipt, secret);
  writeJsonAtomic(file, receipt, fsApi);
  return { file, receipt };
}

function consumeAttendedActionReceipt({
  dataDir,
  token,
  date,
  cardId,
  workUnitId,
  runId,
  mode,
  nowMs = Date.now(),
  runTtlMs = DEFAULT_RUN_TTL_MS,
  hardStopAtMs = null,
  fsApi = fs,
  secret = resolveAttendedActionSecret({ fsApi }),
  trustedIssuers = TRUSTED_ISSUERS,
} = {}) {
  if (!dataDir || !String(token || '').trim()) {
    return { verified: false, reason: 'attended-action-token-absent' };
  }
  if (!['midday', 'button'].includes(String(mode || ''))) {
    return { verified: false, reason: 'attended-action-mode-not-daytime' };
  }
  let scope;
  try {
    scope = normalizeScope({ date, cardId, workUnitId });
  } catch (error) {
    return { verified: false, reason: String(error.message || error) };
  }
  const file = receiptPath(dataDir, token);
  const consumedFile = consumedReceiptPath(dataDir, token);
  const lock = `${file}.lock`;
  try {
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    fsApi.mkdirSync(lock);
  } catch (error) {
    return {
      verified: false,
      reason: error && error.code === 'EEXIST'
        ? 'attended-action-consume-in-progress'
        : 'attended-action-lock-failed',
    };
  }
  try {
    let receipt;
    try {
      receipt = JSON.parse(fsApi.readFileSync(file, 'utf8'));
    } catch {
      return { verified: false, reason: 'attended-action-receipt-missing' };
    }
    const valid =
      receipt.schema === SCHEMA &&
      receipt.tokenHash === tokenHash(token) &&
      receipt.date === scope.date &&
      receipt.cardId === scope.cardId &&
      receipt.workUnitId === scope.workUnitId &&
      trustedIssuers.has(String(receipt.issuer || '')) &&
      String(secret || '').trim() &&
      signatureMatches(receipt, secret) &&
      Number(receipt.expiresAtMs || 0) >= nowMs &&
      !fsApi.existsSync(consumedFile);
    if (!valid) {
      return { verified: false, reason: 'attended-action-receipt-invalid-or-consumed' };
    }
    const runExpiresAtMs = Math.min(
      nowMs + Math.max(1, Number(runTtlMs) || DEFAULT_RUN_TTL_MS),
      Number.isFinite(Number(hardStopAtMs)) && Number(hardStopAtMs) > nowMs
        ? Number(hardStopAtMs)
        : Number.POSITIVE_INFINITY,
      daytimeCapacityWindowEndMs(nowMs),
    );
    if (!Number.isFinite(runExpiresAtMs) || runExpiresAtMs < nowMs) {
      return { verified: false, reason: 'attended-action-outside-daytime-window' };
    }
    // One-use is structural. Removing the mint path atomically means a writer
    // cannot clear a JSON field and replay the same signed receipt.
    fsApi.renameSync(file, consumedFile);
    const consumed = {
      ...receipt,
      consumedAt: new Date(nowMs).toISOString(),
      consumedAtMs: nowMs,
      consumedByRunId: String(runId || ''),
      runExpiresAt: new Date(runExpiresAtMs).toISOString(),
      runExpiresAtMs,
    };
    writeJsonAtomic(consumedFile, consumed, fsApi);
    const capability = Object.freeze({
      issuer: consumed.issuer,
      tokenHash: consumed.tokenHash,
      runExpiresAtMs: consumed.runExpiresAtMs,
      consumedByRunId: consumed.consumedByRunId,
    });
    verifiedCapabilities.add(capability);
    return {
      verified: true,
      reason: 'attended-action-receipt-consumed',
      receipt: consumed,
      file: consumedFile,
      capability,
    };
  } finally {
    try {
      fsApi.rmSync(lock, { recursive: true, force: true });
    } catch {
      // The receipt is already consumed; a stale lock only makes later replays fail closed.
    }
  }
}

function linuxParentPid(pid, fsApi = fs) {
  const stat = fsApi.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')');
  if (close < 0) return 0;
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  return Number(fields[1] || 0);
}

function hasSshdAncestor({ pid = process.ppid, fsApi = fs, maxDepth = 8 } = {}) {
  let current = Number(pid || 0);
  for (let depth = 0; depth < maxDepth && current > 1; depth += 1) {
    let command = '';
    try {
      command = fsApi.readFileSync(`/proc/${current}/comm`, 'utf8').trim();
    } catch {
      return false;
    }
    if (/^sshd(?:-session|-auth)?$/.test(command)) return true;
    try {
      current = linuxParentPid(current, fsApi);
    } catch {
      return false;
    }
  }
  return false;
}

function isVerifiedAttendedActionCapability(capability, { nowMs = Date.now() } = {}) {
  return Boolean(
    capability &&
      verifiedCapabilities.has(capability) &&
      Number(capability.runExpiresAtMs || 0) >= nowMs,
  );
}

module.exports = {
  SCHEMA,
  DEFAULT_TTL_MS,
  DEFAULT_RUN_TTL_MS,
  TRUSTED_ISSUERS,
  actionRoot,
  tokenHash,
  receiptPath,
  consumedReceiptPath,
  canonicalWorkUnitScope,
  normalizeScope,
  daytimeCapacityWindowEndMs,
  mintAttendedActionReceipt,
  consumeAttendedActionReceipt,
  resolveAttendedActionSecret,
  receiptSignature,
  signatureMatches,
  isVerifiedAttendedActionCapability,
  linuxParentPid,
  hasSshdAncestor,
};
