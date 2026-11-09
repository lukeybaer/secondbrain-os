'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAIM_TTL_MS = 60 * 1000;
const RECENT_FINGERPRINT_LIMIT = 64;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requiredText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${field} is required for automated inference continuation`);
  return text;
}

function receiptPath(dataDir, outcomeId) {
  const key = crypto.createHash('sha256').update(outcomeId).digest('hex').slice(0, 24);
  return path.join(dataDir, 'agent', 'inference-continuations', `${key}.json`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

// This is an admission mutex, not a lease around the model call. The winner
// persists the admitted fingerprint before releasing, so a later process sees
// the receipt and denies duplicate work even while the first assessment runs.
function acquireClaim(file, nowMs) {
  const claimFile = `${file}.lock`;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(claimFile), { recursive: true });
  const attempt = () => {
    try {
      const fd = fs.openSync(claimFile, 'wx', 0o600);
      fs.writeFileSync(fd, `${token}\n${new Date(nowMs).toISOString()}\n${os.hostname()}\n`);
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return false;
    }
  };
  if (attempt()) return { acquired: true, claimFile, token };
  try {
    if (nowMs - fs.statSync(claimFile).mtimeMs > CLAIM_TTL_MS) {
      const [priorToken, , priorHost] = fs.readFileSync(claimFile, 'utf8').split(/\r?\n/);
      const priorPid = Number(String(priorToken || '').split(':')[0]);
      if ((!priorHost || priorHost === os.hostname()) && isPidAlive(priorPid)) {
        return { acquired: false, claimFile, token };
      }
      const quarantine = `${claimFile}.stale.${process.pid}.${crypto.randomUUID()}`;
      fs.renameSync(claimFile, quarantine);
      try {
        fs.unlinkSync(quarantine);
      } catch {
        /* the atomic rename already removed the stale claim from admission */
      }
      if (attempt()) return { acquired: true, claimFile, token };
    }
  } catch {
    if (attempt()) return { acquired: true, claimFile, token };
  }
  return { acquired: false, claimFile, token };
}

function releaseClaim(claim) {
  if (!claim?.acquired || !claim.claimFile || !claim.token) return false;
  try {
    const current = fs.readFileSync(claim.claimFile, 'utf8').split(/\r?\n/)[0];
    if (current !== claim.token) return false;
    fs.unlinkSync(claim.claimFile);
    return true;
  } catch {
    return false;
  }
}

function claimOwned(claim) {
  if (!claim?.acquired || !claim.claimFile || !claim.token) return false;
  try {
    return fs.readFileSync(claim.claimFile, 'utf8').split(/\r?\n/)[0] === claim.token;
  } catch {
    return false;
  }
}

function admitInferenceContinuation(opts = {}) {
  const outcomeId = requiredText(opts.outcomeId, 'outcomeId');
  const evidenceFingerprint = requiredText(opts.evidenceFingerprint, 'evidenceFingerprint');
  const trigger = requiredText(opts.trigger, 'trigger');
  const expectedNextState = requiredText(opts.expectedNextState, 'expectedNextState');
  const returnCondition = requiredText(opts.returnCondition, 'returnCondition');
  const dataDir = requiredText(opts.dataDir, 'dataDir');
  const file = receiptPath(dataDir, outcomeId);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const claim = acquireClaim(file, nowMs);
  if (!claim.acquired) {
    return {
      schema: 'amy.inference-continuation.v1',
      outcomeId,
      evidenceFingerprint,
      trigger,
      expectedNextState,
      returnCondition,
      allowed: false,
      reason: 'concurrent-admission',
      observedAt: new Date(nowMs).toISOString(),
      file,
    };
  }
  try {
    const prior = readJson(file);
    const recentFingerprints = Array.isArray(prior?.recentFingerprints)
      ? prior.recentFingerprints.map(String)
      : prior?.evidenceFingerprint
        ? [String(prior.evidenceFingerprint)]
        : [];
    let allowed = false;
    let reason = 'unchanged-evidence';
    if (opts.closureWork === true && prior?.closureComplete !== true) {
      allowed = true;
      reason = 'closure-work';
    } else if (!prior) {
      allowed = true;
      reason = 'first-evidence';
    } else if (
      prior.evidenceFingerprint !== evidenceFingerprint &&
      !recentFingerprints.includes(evidenceFingerprint)
    ) {
      allowed = true;
      reason = 'changed-evidence';
    } else if (prior.evidenceFingerprint !== evidenceFingerprint) {
      reason = 'previously-assessed-evidence';
    }
    const nextRecent = allowed
      ? [...recentFingerprints.filter((item) => item !== evidenceFingerprint), evidenceFingerprint]
          .slice(-RECENT_FINGERPRINT_LIMIT)
      : recentFingerprints;
    const receipt = {
      schema: 'amy.inference-continuation.v1',
      outcomeId,
      evidenceFingerprint: allowed
        ? evidenceFingerprint
        : String(prior?.evidenceFingerprint || evidenceFingerprint),
      requestedEvidenceFingerprint: evidenceFingerprint,
      lastDeniedFingerprint: allowed
        ? prior?.lastDeniedFingerprint || null
        : evidenceFingerprint,
      trigger,
      expectedNextState,
      returnCondition,
      allowed,
      reason,
      observedAt: new Date(nowMs).toISOString(),
      closureComplete: Boolean(prior?.closureComplete || (allowed && opts.closureWork === true)),
      recentFingerprints: nextRecent,
      deniedCount: Number(prior?.deniedCount || 0) + (allowed ? 0 : 1),
    };
    if (typeof opts.beforeCommit === 'function') opts.beforeCommit({ claim, file, receipt });
    if (!claimOwned(claim)) {
      return {
        ...receipt,
        allowed: false,
        reason: 'lost-admission-claim',
      };
    }
    writeJsonAtomic(file, receipt);
    return { ...receipt, file };
  } finally {
    releaseClaim(claim);
  }
}

module.exports = {
  CLAIM_TTL_MS,
  admitInferenceContinuation,
  claimOwned,
  receiptPath,
  releaseClaim,
};
