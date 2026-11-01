'use strict';

// Self-test dispatch lease.
//
// A self-test caller phone is a synthetic principal and is never allowed to
// dispatch real work. The one exception is an end-to-end proof of the phone
// dispatch path itself (call in, work runs, deploy, callback), which is only
// honest if the call can actually dispatch. An operator on the host grants a
// short lease; while it is live, a signed webhook from a self-test phone may
// run dispatch tools a bounded number of times. Every Task created this way is
// marked `meta.selfTest`, its callback dials the self-test line and never a
// person, and a self-test caller can only steer self-test Tasks.
//
// The lease lives on the host's data volume, so it cannot be granted by a
// caller, a model, or a webhook. It expires on its own.
//
// Scope: a 'dispatch' lease (the default, and every lease written before scopes
// existed) admits the dispatch tools. A 'directive-canary' lease admits only
// ask_amy's fixed canary turn (voice-directive-canary.js), so a canary proof can
// never start a runner and a dispatch proof never reaches ask_amy.

const fs = require('fs');
const path = require('path');

const SCHEMA = 'amy.voice-selftest-dispatch-lease.v1';
const MAX_MINUTES = 90;
const MAX_DISPATCHES = 5;
const SCOPES = new Set(['dispatch', 'directive-canary']);
function scopeOf(value) {
  return SCOPES.has(value) ? value : 'dispatch';
}

function leasePath(opts = {}) {
  const dataDir =
    opts.dataDir ||
    process.env.SECONDBRAIN_DATA_DIR ||
    (process.platform === 'linux' ? '/opt/secondbrain/data' : path.join(process.cwd(), 'data'));
  return opts.leasePath || path.join(dataDir, 'agent', 'voice-selftest-dispatch-lease.json');
}

function nowMs(opts = {}) {
  return typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readLease(opts = {}) {
  try {
    const lease = JSON.parse(fs.readFileSync(leasePath(opts), 'utf8'));
    return lease && lease.schema === SCHEMA ? lease : null;
  } catch {
    return null;
  }
}

function grantLease({ minutes = 30, maxDispatches = 2, grantedBy = '', purpose = '', scope = 'dispatch' } = {}, opts = {}) {
  // A mistyped scope must not grant dispatch; only an absent one means dispatch.
  if (scope != null && !SCOPES.has(scope)) throw new Error('Unknown lease scope: ' + scope);
  const mins = Math.min(MAX_MINUTES, Math.max(1, Number(minutes) || 30));
  const max = Math.min(MAX_DISPATCHES, Math.max(1, Number(maxDispatches) || 2));
  const now = nowMs(opts);
  const lease = {
    schema: SCHEMA,
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + mins * 60 * 1000).toISOString(),
    maxDispatches: max,
    used: 0,
    grantedBy: String(grantedBy || 'operator').slice(0, 120),
    purpose: String(purpose || '').slice(0, 300),
    scope: scopeOf(scope),
  };
  writeAtomic(leasePath(opts), lease);
  return lease;
}

// Live means unexpired. Steering and status never spend the dispatch budget.
function leaseLive(opts = {}) {
  const lease = readLease(opts);
  return Boolean(lease && scopeOf(lease.scope) === scopeOf(opts.scope) && Date.parse(lease.expiresAt) > nowMs(opts));
}

// Spend one dispatch. Returns the lease when admitted, null when not. The
// read-check-write runs under an exclusive lock file so concurrent tool calls
// cannot both read the same count and exceed the ceiling; a contended or stale
// lock fails closed (no dispatch).
function consumeDispatch(opts = {}) {
  const lock = `${leasePath(opts)}.lock`;
  let fd;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.unlinkSync(lock);
    } catch {
      /* no stale lock */
    }
    fd = fs.openSync(lock, 'wx');
  } catch {
    return null;
  }
  try {
    const lease = readLease(opts);
    if (!lease || Date.parse(lease.expiresAt) <= nowMs(opts)) return null;
    if (scopeOf(lease.scope) !== scopeOf(opts.scope)) return null;
    if (Number(lease.used || 0) >= Number(lease.maxDispatches || 0)) return null;
    const next = {
      ...lease,
      used: Number(lease.used || 0) + 1,
      lastUsedAt: new Date(nowMs(opts)).toISOString(),
    };
    writeAtomic(leasePath(opts), next);
    return next;
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already released */
    }
  }
}

// opts.grantedAt revokes only the lease that grant wrote, never a newer one.
function revokeLease(opts = {}) {
  try {
    if (opts.grantedAt && readLease(opts)?.grantedAt !== opts.grantedAt) return false;
    fs.unlinkSync(leasePath(opts));
    return true;
  } catch {
    return false;
  }
}

module.exports = { SCHEMA, consumeDispatch, grantLease, leaseLive, leasePath, readLease, revokeLease };
