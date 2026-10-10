'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TERMINAL_STATE_SCHEMA = 'briefing-terminal-state@1';
const STATE_ORDER = Object.freeze({ running: 0, settling: 1, frozen: 2, delivered: 3 });

function terminalStatePath(dataDir, date) {
  return path.join(dataDir, 'agent', `briefing-terminal-state-${date}.json`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isCompleteDeliveryProof(proof) {
  return Boolean(
    proof?.telegram === 'sent' &&
      proof?.gmail === 'sent' &&
      /^[a-f0-9]{64}$/i.test(String(proof?.markerSha256 || '')) &&
      /^[a-f0-9]{64}$/i.test(String(proof?.reportSha256 || '')),
  );
}

function readTerminalState({ dataDir, date } = {}) {
  try {
    const row = JSON.parse(fs.readFileSync(terminalStatePath(dataDir, date), 'utf8'));
    if (
      row?.schema !== TERMINAL_STATE_SCHEMA ||
      row?.date !== String(date || '').slice(0, 10) ||
      !Object.hasOwn(STATE_ORDER, row?.state) ||
      (row?.state === 'delivered' && !isCompleteDeliveryProof(row?.proof))
    ) {
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

function inspectTerminalState({ dataDir, date } = {}) {
  const file = terminalStatePath(dataDir, date);
  if (!fs.existsSync(file)) return { status: 'absent', receipt: null, file };
  const receipt = readTerminalState({ dataDir, date });
  return receipt
    ? { status: 'valid', receipt, file }
    : { status: 'invalid', receipt: null, file };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // The rename normally consumed the temporary file.
    }
  }
}

function acquireTransitionLease(file, nowMs) {
  const lock = `${file}.lock`;
  const token = `${process.pid}-${nowMs}-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeFileSync(fd, token);
      fs.closeSync(fd);
      return { lock, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        // Lease age is a wall-clock fact. The injected transition timestamp is
        // evidence time and may be synthetic in tests or skewed by a caller;
        // it must never authorize stealing a live filesystem lock.
        if (Date.now() - fs.statSync(lock).mtimeMs > 2 * 60 * 1000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
}

function releaseTransitionLease(lease) {
  if (!lease) return;
  try {
    if (fs.readFileSync(lease.lock, 'utf8') === lease.token) fs.unlinkSync(lease.lock);
  } catch {
    // A stale transition lock is independently reclaimable.
  }
}

function transitionTerminalState({
  dataDir,
  date,
  state,
  nowMs = Date.now(),
  reason = '',
  proof = null,
} = {}) {
  const day = String(date || '').slice(0, 10);
  if (!dataDir) throw new Error('dataDir is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('date must be YYYY-MM-DD');
  if (!Object.hasOwn(STATE_ORDER, state)) throw new Error(`invalid terminal state: ${state}`);
  if (!Number.isFinite(Number(nowMs))) throw new Error('nowMs must be finite');
  if (state === 'delivered' && !isCompleteDeliveryProof(proof)) {
    return { ok: false, reason: 'terminal-delivery-proof-incomplete' };
  }

  const file = terminalStatePath(dataDir, day);
  const lease = acquireTransitionLease(file, Number(nowMs));
  if (!lease) return { ok: false, reason: 'terminal-state-transition-inflight' };
  try {
    const inspected = inspectTerminalState({ dataDir, date: day });
    if (inspected.status === 'invalid') {
      return { ok: false, reason: 'terminal-state-receipt-invalid' };
    }
    const prior = readTerminalState({ dataDir, date: day });
    const priorOrder = prior ? STATE_ORDER[prior.state] : STATE_ORDER.running;
    const nextOrder = STATE_ORDER[state];
    if (nextOrder < priorOrder) {
      return { ok: false, reason: 'terminal-state-regression-refused', prior };
    }
    if (prior?.state === 'delivered') {
      return { ok: state === 'delivered', unchanged: true, receipt: prior };
    }
    if (prior && nextOrder === priorOrder) {
      return { ok: true, unchanged: true, receipt: prior };
    }
    if (nextOrder > priorOrder + 1) {
      return { ok: false, reason: 'terminal-state-transition-skipped', prior };
    }
    const at = new Date(Number(nowMs)).toISOString();
    const transitions = Array.isArray(prior?.transitions) ? [...prior.transitions] : [];
    transitions.push({ from: prior?.state || 'running', to: state, at, reason: String(reason || '') });
    const receipt = {
      observation: prior?.observation || null,
      owner: prior?.owner || null,
      schema: TERMINAL_STATE_SCHEMA,
      date: day,
      state,
      updatedAt: at,
      settlingAt: state === 'settling' ? at : prior?.settlingAt || null,
      frozenAt: state === 'frozen' ? at : prior?.frozenAt || null,
      deliveredAt: state === 'delivered' ? at : prior?.deliveredAt || null,
      reason: String(reason || prior?.reason || ''),
      proof: proof || prior?.proof || null,
      transitions,
    };
    writeJsonAtomic(file, receipt);
    return { ok: true, unchanged: false, receipt };
  } finally {
    releaseTransitionLease(lease);
  }
}

// The terminal receipt also owns the current observation. Child execution
// receipts remain evidence; a second mutable night state is unnecessary.
function updateNightObservation({ dataDir, date, observation, nowMs = Date.now() }) {
  const day = String(date || '').slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('date must be YYYY-MM-DD');
  const file = terminalStatePath(dataDir, day);
  const lease = acquireTransitionLease(file, nowMs);
  if (!lease) return {...observation, unchanged:false, persisted:false, writeDeferred:'terminal-transition-busy'};
  try {
    const inspected = inspectTerminalState({ dataDir, date:day });
    if (inspected.status === 'invalid') throw new Error('night state is invalid');
    const prior = inspected.receipt;
    if (prior?.state === 'delivered') return {...(prior.observation || observation), unchanged:true, persisted:Boolean(prior.observation)};
    if (prior?.observation?.semanticHash === observation.semanticHash) {
      return { ...prior.observation, unchanged: true, persisted: true };
    }
    const row = prior || {
      schema: TERMINAL_STATE_SCHEMA, date:day, state: 'running',
      owner: {hostname:os.hostname(),pid:process.pid,attemptId:`night-${day}-${process.pid}`},
      updatedAt: new Date(nowMs).toISOString(), transitions: [], proof: null,
    };
    writeJsonAtomic(file, { ...row, observation });
    return { ...observation, unchanged: false, persisted: true };
  } finally {
    releaseTransitionLease(lease);
  }
}

function repairAdmissionDecision({ dataDir, date, nowMs = Date.now(), fixedCutoffMs } = {}) {
  const inspected = inspectTerminalState({ dataDir, date });
  if (inspected.status === 'invalid') {
    return {
      allowed: false,
      reason: 'briefing-terminal-receipt-invalid',
      state: 'invalid',
      receipt: null,
    };
  }
  const receipt = inspected.receipt;
  if (receipt && STATE_ORDER[receipt.state] >= STATE_ORDER.settling) {
    return {
      allowed: false,
      reason: `briefing-terminal-${receipt.state}`,
      state: receipt.state,
      receipt,
    };
  }
  if (Number.isFinite(Number(fixedCutoffMs)) && Number(nowMs) >= Number(fixedCutoffMs)) {
    return { allowed: false, reason: 'briefing-terminal-settlement-cutoff', state: 'running' };
  }
  return { allowed: true, reason: 'briefing-terminal-running', state: receipt?.state || 'running' };
}

function terminalDeliveryProof(marker, { markerFile = '' } = {}) {
  // briefing-notify persists the marker in this exact canonical form. Hash the
  // bytes on disk, not a compact re-serialization that cannot be independently
  // verified against the delivery artifact.
  const canonicalBytes = `${JSON.stringify(marker || {}, null, 2)}\n`;
  let bytes = canonicalBytes;
  if (markerFile) {
    try {
      bytes = fs.readFileSync(markerFile);
      if (!bytes.equals(Buffer.from(canonicalBytes))) {
        return {
          markerSha256: null,
          linksHash: marker?.linksHash || null,
          reportSha256: marker?.reportFreezeProof?.frozenSha256 || null,
          telegram: marker?.telegram?.status || null,
          gmail: marker?.email?.status || null,
        };
      }
    } catch {
      return {
        markerSha256: null,
        linksHash: marker?.linksHash || null,
        reportSha256: marker?.reportFreezeProof?.frozenSha256 || null,
        telegram: marker?.telegram?.status || null,
        gmail: marker?.email?.status || null,
      };
    }
  }
  return {
    markerSha256: sha256(bytes),
    linksHash: marker?.linksHash || null,
    reportSha256: marker?.reportFreezeProof?.frozenSha256 || null,
    telegram: marker?.telegram?.status || null,
    gmail: marker?.email?.status || null,
  };
}

module.exports = {
  TERMINAL_STATE_SCHEMA,
  STATE_ORDER,
  terminalStatePath,
  readTerminalState,
  inspectTerminalState,
  transitionTerminalState,
  updateNightObservation,
  repairAdmissionDecision,
  terminalDeliveryProof,
  isCompleteDeliveryProof,
};
