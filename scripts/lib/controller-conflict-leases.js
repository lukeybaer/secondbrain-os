'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FEATURE_ENV = 'BRIEFING_CONTROLLER_CONFLICT_LEASES';
const SHADOW_PASSED_ENV = 'BRIEFING_CONTROLLER_CONFLICT_LEASES_SHADOW_PASSED';
const DEFAULT_LEASE_MS = 75 * 60 * 1000;
const DEFAULT_STALE_MS = 3 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;
const ATTENDED_SOURCE_PREEMPT_MIN_AGE_MS = 60 * 1000;
const VALID_KEY = /^(?:controller|source|group):[a-z0-9][a-z0-9._:\-]*$/;

function pathsFor(dataDir) {
  const root = path.join(dataDir, 'agent', 'card-controller', 'conflict-leases');
  return {
    root,
    lock: path.join(root, '.state-lock'),
    state: path.join(root, 'state.json'),
    events: path.join(root, 'events.jsonl'),
    runHeartbeats: path.join(root, 'runs'),
    shadowPassed: path.join(root, 'shadow-passed.json'),
  };
}

function safeJson(file, fallback = null, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsApi.renameSync(temporary, file);
}

function appendEvent(file, value, fsApi = fs) {
  try {
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    fsApi.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
  } catch {
    // Lease correctness is carried by state.json. Telemetry is best effort.
  }
}

function normalizeConflictKeys(keys) {
  const normalized = [
    ...new Set(
      (Array.isArray(keys) ? keys : [])
        .map((value) =>
          String(value || '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ].sort();
  if (!normalized.length) throw new Error('at least one conflict key is required');
  const invalid = normalized.find((key) => !VALID_KEY.test(key));
  if (invalid) throw new Error(`invalid conflict key '${invalid}'`);
  return normalized;
}

function scopeHash(keys) {
  return crypto.createHash('sha256').update(normalizeConflictKeys(keys).join('\n')).digest('hex');
}

function safeRunId(value) {
  return String(value || 'unknown')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 160);
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function linuxProcessStartTime(pid, { fsApi = fs, procRoot = '/proc' } = {}) {
  try {
    const stat = String(
      fsApi.readFileSync(path.join(procRoot, String(Number(pid)), 'stat'), 'utf8'),
    );
    const close = stat.lastIndexOf(')');
    if (close < 0) return '';
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    return /^\d+$/.test(String(fields[19] || '')) ? String(fields[19]) : '';
  } catch {
    return '';
  }
}

function rolloutMode({ dataDir, env = process.env, fsApi = fs } = {}) {
  const requested = String(env[FEATURE_ENV] || 'off')
    .trim()
    .toLowerCase();
  const normalized = ['off', 'shadow', 'enforce'].includes(requested) ? requested : 'off';
  const marker = dataDir ? safeJson(pathsFor(dataDir).shadowPassed, null, fsApi) : null;
  const shadowPassed = env[SHADOW_PASSED_ENV] === '1' || marker?.passed === true;
  if (normalized === 'enforce' && !shadowPassed) {
    return {
      requested: normalized,
      effective: 'shadow',
      effectiveConcurrency: 1,
      concurrencyPolicy: 'singleton-shadow',
      shadowPassed: false,
      reason: 'shadow-proof-required',
    };
  }
  return {
    requested: normalized,
    effective: normalized,
    effectiveConcurrency: normalized === 'enforce' ? null : 1,
    concurrencyPolicy: normalized === 'enforce' ? 'resource-governed' : 'singleton',
    shadowPassed,
    reason: normalized === 'enforce' ? 'shadow-proof-accepted' : 'flag-selected',
  };
}

function initialState() {
  return { schema: 'secondbrain.controller-conflict-leases.v1', nextFenceByKey: {}, leases: [] };
}

function lockOwner({ nowMs, hostname, pid, processStartTime }) {
  return { hostname, pid, processStartTime, acquiredAtMs: nowMs };
}

function ownerIsSameProcess(
  owner,
  { hostname = os.hostname(), pidAlive = processAlive, processStart = linuxProcessStartTime } = {},
) {
  if (!owner || String(owner.hostname || '') !== String(hostname || '')) return null;
  const pid = Number(owner.pid);
  if (!pidAlive(pid)) return false;
  const expected = String(owner.processStartTime || '');
  const actual = String(processStart(pid) || '');
  // Missing start-time proof must never authorize same-host reclaim of a live PID.
  if (!expected || !actual) return true;
  return expected === actual;
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStateLock(paths, worker, options = {}) {
  const fsApi = options.fsApi || fs;
  const now = options.now || Date.now;
  const hostname = options.hostname || os.hostname();
  const pid = Number(options.pid || process.pid);
  const processStart = options.processStart || linuxProcessStartTime;
  const processStartTime = String(options.processStartTime || processStart(pid) || '');
  const waitMs = Math.max(0, Number(options.waitMs ?? 2_000));
  const staleMs = Math.max(1_000, Number(options.lockStaleMs || 15_000));
  const deadline = now() + waitMs;
  fsApi.mkdirSync(paths.root, { recursive: true });
  while (true) {
    try {
      fsApi.mkdirSync(paths.lock);
      writeJsonAtomic(
        path.join(paths.lock, 'owner.json'),
        lockOwner({
          nowMs: now(),
          hostname,
          pid,
          processStartTime,
        }),
        fsApi,
      );
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const owner = safeJson(path.join(paths.lock, 'owner.json'), null, fsApi);
      const sameProcess = ownerIsSameProcess(owner, {
        hostname,
        pidAlive: options.pidAlive,
        processStart,
      });
      let acquiredAtMs = Number(owner?.acquiredAtMs || 0);
      if (!acquiredAtMs) {
        try {
          acquiredAtMs = Number(fsApi.statSync(paths.lock).mtimeMs || 0);
        } catch {
          acquiredAtMs = now();
        }
      }
      const age = Math.max(0, now() - acquiredAtMs);
      // A live same-host owner is never evicted by age alone. Cross-host or
      // unreadable ownership can be quarantined after the bounded stale window
      // because this lock only protects a synchronous state-file transaction.
      if (sameProcess === false || (sameProcess === null && age > staleMs)) {
        const quarantine = `${paths.lock}.stale.${pid}.${now()}`;
        try {
          fsApi.renameSync(paths.lock, quarantine);
          fsApi.rmSync(quarantine, { recursive: true, force: true });
          continue;
        } catch {
          // Another host or process won the stale-lock race.
        }
      }
      if (now() >= deadline)
        throw Object.assign(new Error('controller conflict lease state lock held'), {
          code: 'CONFLICT_STATE_LOCKED',
        });
      sleepSync(Math.min(25, Math.max(1, deadline - now())));
    }
  }
  try {
    return worker();
  } finally {
    try {
      const owner = safeJson(path.join(paths.lock, 'owner.json'), null, fsApi);
      if (
        owner &&
        String(owner.hostname || '') === String(hostname || '') &&
        Number(owner.pid) === pid &&
        String(owner.processStartTime || '') === processStartTime
      ) {
        fsApi.rmSync(paths.lock, { recursive: true, force: true });
      }
    } catch {
      // A later acquisition is never removed by an old owner's cleanup.
    }
  }
}

function leaseOwnerState(lease, options = {}) {
  const hostname = options.hostname || os.hostname();
  if (String(lease?.hostname || '') !== String(hostname || '')) return 'cross-host';
  const alive = (options.pidAlive || processAlive)(Number(lease.pid));
  if (!alive) return 'dead';
  const expected = String(lease.processStartTime || '');
  const actual = String((options.processStart || linuxProcessStartTime)(Number(lease.pid)) || '');
  if (expected && actual && expected !== actual) return 'pid-reused';
  return 'alive';
}

function pruneReclaimable(state, { nowMs, staleMs = DEFAULT_STALE_MS, ...options } = {}) {
  const active = [];
  const reclaimed = [];
  for (const lease of Array.isArray(state.leases) ? state.leases : []) {
    const ownerState = leaseOwnerState(lease, options);
    const heartbeatAtMs = Number(lease.heartbeatAtMs || lease.acquiredAtMs || 0);
    const expired = Number(lease.expiresAtMs || 0) <= nowMs;
    const heartbeatStale = nowMs - heartbeatAtMs > staleMs;
    const reclaim =
      ownerState === 'dead' ||
      ownerState === 'pid-reused' ||
      (ownerState === 'cross-host' && expired && heartbeatStale);
    if (reclaim)
      reclaimed.push({
        lease,
        reason: ownerState === 'cross-host' ? 'cross-host-fenced-expiry' : ownerState,
      });
    else active.push(lease);
  }
  state.leases = active;
  return reclaimed;
}

// Proactive dead-lease sweep for a caller (the night supervisor) that runs
// independently of any acquireConflictLease() attempt. pruneReclaimable()
// only runs as a side effect of an actual acquisition, so a dead-PID lease
// can otherwise sit here for the whole night while nothing is trying to
// acquire a conflicting key. This is deliberately MORE conservative than
// pruneReclaimable()'s own immediate dead/pid-reused reclaim: an unattended
// sweep only touches a lease once its owner is both dead AND past its own
// heartbeat stale window, never on liveness alone. A live same-host owner is
// still never evicted (leaseOwnerState() unchanged), and cross-host/expired
// leases are left for the existing acquire-time path exactly as before.
function sweepDeadLeases({
  dataDir,
  nowMs = Date.now(),
  staleMs = DEFAULT_STALE_MS,
  hostname = os.hostname(),
  pidAlive = processAlive,
  processStart = linuxProcessStartTime,
  fsApi = fs,
} = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const paths = pathsFor(dataDir);
  return withStateLock(
    paths,
    () => {
      const state = safeJson(paths.state, initialState(), fsApi) || initialState();
      const active = [];
      const reclaimed = [];
      for (const lease of Array.isArray(state.leases) ? state.leases : []) {
        const ownerState = leaseOwnerState(lease, { hostname, pidAlive, processStart });
        const heartbeatAtMs = Number(lease.heartbeatAtMs || lease.acquiredAtMs || 0);
        const heartbeatStale = nowMs - heartbeatAtMs > staleMs;
        const reclaim = ownerState === 'dead' && heartbeatStale;
        if (reclaim) reclaimed.push({ lease, reason: 'dead-owner-past-heartbeat-stale-window' });
        else active.push(lease);
      }
      if (reclaimed.length) {
        state.leases = active;
        for (const row of reclaimed) {
          appendEvent(
            paths.events,
            {
              ts: new Date(nowMs).toISOString(),
              event: 'proactive-swept',
              token: row.lease.token,
              runId: row.lease.runId,
              reason: row.reason,
              keys: row.lease.keys,
            },
            fsApi,
          );
        }
        writeJsonAtomic(paths.state, state, fsApi);
      }
      return { swept: reclaimed.length, reclaimed, file: paths.state };
    },
    { fsApi },
  );
}

function controllerHasActiveHostWork(dataDir, lease, { nowMs = Date.now(), fsApi = fs } = {}) {
  const file = path.join(dataDir, 'agent', 'host-work-admission', 'leases.json');
  let state;
  try {
    if (!fsApi.existsSync(file)) return true;
    state = JSON.parse(String(fsApi.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return true;
  }
  if (!state || !Array.isArray(state.leases)) return true;
  return state.leases.some(
    (row) => Number(row?.pid) === Number(lease?.pid) && Number(row?.expiresAtMs || 0) > nowMs,
  );
}

function fenceIdleSourceConflicts(
  state,
  conflicts,
  {
    dataDir,
    runId,
    requestedKeys,
    nowMs,
    hostname,
    pidAlive,
    processStart,
    minAgeMs = ATTENDED_SOURCE_PREEMPT_MIN_AGE_MS,
    hasActiveHostWork = controllerHasActiveHostWork,
    fsApi = fs,
  } = {},
) {
  const candidates = conflicts.map((lease) => {
    const overlappingSourceKeys = lease.keys.filter(
      (key) => requestedKeys.includes(key) && key.startsWith('source:'),
    );
    const overlappingNonSource = lease.keys.some(
      (key) => requestedKeys.includes(key) && !key.startsWith('source:'),
    );
    const oldEnough = nowMs - Number(lease.acquiredAtMs || 0) >= minAgeMs;
    const eligible =
      overlappingSourceKeys.length > 0 &&
      !overlappingNonSource &&
      String(lease.mode || '') === 'midday' &&
      String(lease.priority || 'ordinary') !== 'attended' &&
      String(lease.stage || '') === 'cards' &&
      leaseOwnerState(lease, { hostname, pidAlive, processStart }) === 'alive' &&
      oldEnough &&
      !hasActiveHostWork(dataDir, lease, { nowMs, fsApi });
    return { lease, overlappingSourceKeys, eligible };
  });
  // The acquisition is atomic: never fence one holder unless every conflict
  // blocking this exact attended request can be resolved in the same state
  // transaction and the new lease can be granted immediately afterward.
  if (candidates.some((candidate) => !candidate.eligible)) return [];

  const preempted = [];
  for (const { lease, overlappingSourceKeys } of candidates) {
    const fenced = new Set(overlappingSourceKeys);
    lease.keys = lease.keys.filter((key) => !fenced.has(key));
    lease.fences = Object.fromEntries(
      Object.entries(lease.fences || {}).filter(([key]) => !fenced.has(key)),
    );
    lease.scopeHash = lease.keys.length ? scopeHash(lease.keys) : '';
    // Delegations are exact-scope capabilities. If any key is fenced the whole
    // capability must be revoked; narrowing it in place would manufacture a
    // token the child never received or consented to.
    lease.delegations = (Array.isArray(lease.delegations) ? lease.delegations : []).filter(
      (delegation) => !delegation.keys.some((key) => fenced.has(key)),
    );
    preempted.push({
      runId: lease.runId,
      keys: overlappingSourceKeys,
      reason: 'attended-source-priority',
    });
  }
  state.leases = state.leases.filter((lease) => lease.keys.length > 0);
  return preempted;
}

function acquireConflictLease({
  dataDir,
  runId,
  mode = 'midday',
  date = '',
  keys,
  leaseMs = DEFAULT_LEASE_MS,
  staleMs = DEFAULT_STALE_MS,
  nowMs = Date.now(),
  hostname = os.hostname(),
  pid = process.pid,
  processStart = linuxProcessStartTime,
  pidAlive = processAlive,
  delegationScopeToken = '',
  attendedPriority = false,
  attendedPreemptMinAgeMs = ATTENDED_SOURCE_PREEMPT_MIN_AGE_MS,
  hasActiveHostWork = controllerHasActiveHostWork,
  fsApi = fs,
} = {}) {
  if (!dataDir || !runId) throw new Error('dataDir and runId are required');
  const normalizedKeys = normalizeConflictKeys(keys);
  const paths = pathsFor(dataDir);
  return withStateLock(
    paths,
    () => {
      const state = safeJson(paths.state, initialState(), fsApi) || initialState();
      const reclaimed = pruneReclaimable(state, {
        nowMs,
        staleMs,
        hostname,
        pidAlive,
        processStart,
      });
      for (const row of reclaimed)
        appendEvent(
          paths.events,
          {
            ts: new Date(nowMs).toISOString(),
            event: 'reclaimed',
            token: row.lease.token,
            runId: row.lease.runId,
            reason: row.reason,
            keys: row.lease.keys,
          },
          fsApi,
        );

      if (delegationScopeToken) {
        const verification = verifyScopeTokenInState(state, delegationScopeToken, normalizedKeys, {
          nowMs,
        });
        if (!verification.ok) {
          // A dead parent is exactly what fails verification here. Persist the
          // prune, or the dead lease survives and every caller re-reclaims it
          // (2026-09-30: 73k reclaim events, every key held all day).
          if (reclaimed.length) writeJsonAtomic(paths.state, state, fsApi);
          return { acquired: false, delegated: true, reason: verification.reason, reclaimed };
        }
        writeJsonAtomic(paths.state, state, fsApi);
        return {
          acquired: true,
          delegated: true,
          file: paths.state,
          lease: verification.lease,
          scope: verification.delegation,
          keys: normalizedKeys,
          reclaimed,
        };
      }

      let conflicts = state.leases.filter((lease) =>
        lease.keys.some((key) => normalizedKeys.includes(key)),
      );
      let preempted = [];
      if (conflicts.length && attendedPriority) {
        preempted = fenceIdleSourceConflicts(state, conflicts, {
          dataDir,
          runId,
          requestedKeys: normalizedKeys,
          nowMs,
          hostname,
          pidAlive,
          processStart,
          minAgeMs: attendedPreemptMinAgeMs,
          hasActiveHostWork,
          fsApi,
        });
        for (const row of preempted)
          appendEvent(
            paths.events,
            {
              ts: new Date(nowMs).toISOString(),
              event: 'attended-source-preempted',
              runId,
              priorRunId: row.runId,
              keys: row.keys,
              reason: row.reason,
            },
            fsApi,
          );
        conflicts = state.leases.filter((lease) =>
          lease.keys.some((key) => normalizedKeys.includes(key)),
        );
      }
      if (conflicts.length) {
        writeJsonAtomic(paths.state, state, fsApi);
        return {
          acquired: false,
          reason: 'conflict-held',
          conflicts: conflicts.map((lease) => ({
            runId: lease.runId,
            hostname: lease.hostname,
            pid: lease.pid,
            keys: lease.keys.filter((key) => normalizedKeys.includes(key)),
          })),
          reclaimed,
          preempted,
        };
      }
      const processStartTime = String(processStart(pid) || '');
      if (!processStartTime && process.platform !== 'win32') {
        return { acquired: false, reason: 'process-start-time-unavailable', reclaimed };
      }
      const fences = {};
      for (const key of normalizedKeys) {
        const next = Math.max(0, Number(state.nextFenceByKey[key] || 0)) + 1;
        state.nextFenceByKey[key] = next;
        fences[key] = next;
      }
      const token = crypto.randomBytes(24).toString('hex');
      const lease = {
        token,
        runId: String(runId),
        mode: String(mode),
        date: String(date),
        hostname: String(hostname),
        pid: Number(pid),
        processStartTime,
        keys: normalizedKeys,
        scopeHash: scopeHash(normalizedKeys),
        fences,
        acquiredAt: new Date(nowMs).toISOString(),
        acquiredAtMs: nowMs,
        leaseMs: Math.max(1, Number(leaseMs) || DEFAULT_LEASE_MS),
        heartbeatAt: new Date(nowMs).toISOString(),
        heartbeatAtMs: nowMs,
        expiresAt: new Date(nowMs + Math.max(1, Number(leaseMs) || DEFAULT_LEASE_MS)).toISOString(),
        expiresAtMs: nowMs + Math.max(1, Number(leaseMs) || DEFAULT_LEASE_MS),
        delegations: [],
        priority: attendedPriority ? 'attended' : 'ordinary',
      };
      state.leases.push(lease);
      writeJsonAtomic(paths.state, state, fsApi);
      appendEvent(
        paths.events,
        {
          ts: lease.acquiredAt,
          event: 'acquired',
          token,
          runId: lease.runId,
          keys: lease.keys,
          fences: lease.fences,
        },
        fsApi,
      );
      return {
        acquired: true,
        file: paths.state,
        lease,
        keys: normalizedKeys,
        reclaimed,
        preempted,
      };
    },
    { fsApi, hostname, pid, processStart, pidAlive },
  );
}

function delegateLeaseScope({
  dataDir,
  leaseToken,
  parentScopeToken = '',
  keys,
  nowMs = Date.now(),
  expiresAtMs,
  fsApi = fs,
  dryRun = false,
} = {}) {
  const normalizedKeys = normalizeConflictKeys(keys);
  const paths = pathsFor(dataDir);
  return withStateLock(
    paths,
    () => {
      const state = safeJson(paths.state, initialState(), fsApi) || initialState();
      const lease = state.leases.find((row) => row.token === String(leaseToken || ''));
      if (!lease) return { delegated: false, reason: 'lease-not-current' };
      if (!normalizedKeys.every((key) => lease.keys.includes(key))) {
        return { delegated: false, reason: 'scope-expansion-refused' };
      }
      if (parentScopeToken) {
        const parent = (Array.isArray(lease.delegations) ? lease.delegations : []).find(
          (row) => row.token === String(parentScopeToken),
        );
        if (!parent || Number(parent.expiresAtMs || 0) <= nowMs) {
          return { delegated: false, reason: 'parent-scope-not-current' };
        }
        if (!normalizedKeys.every((key) => parent.keys.includes(key))) {
          return { delegated: false, reason: 'parent-scope-expansion-refused' };
        }
      }
      const token = crypto.randomBytes(24).toString('hex');
      const delegationExpiresAtMs = Math.min(
        Number(expiresAtMs || lease.expiresAtMs),
        Number(lease.expiresAtMs),
      );
      if (!Number.isFinite(delegationExpiresAtMs) || delegationExpiresAtMs <= nowMs) {
        return { delegated: false, reason: 'lease-expired' };
      }
      // A dry run answers "would this scope be delegated?" without recording a
      // delegation, so a caller can refuse before it waits for host capacity.
      if (dryRun) return { delegated: true, dryRun: true, keys: normalizedKeys };
      const delegation = {
        token,
        keys: normalizedKeys,
        scopeHash: scopeHash(normalizedKeys),
        fences: Object.fromEntries(normalizedKeys.map((key) => [key, lease.fences[key]])),
        createdAt: new Date(nowMs).toISOString(),
        expiresAtMs: delegationExpiresAtMs,
      };
      lease.delegations = [
        ...(Array.isArray(lease.delegations) ? lease.delegations : []),
        delegation,
      ];
      writeJsonAtomic(paths.state, state, fsApi);
      appendEvent(
        paths.events,
        {
          ts: delegation.createdAt,
          event: 'delegated',
          runId: lease.runId,
          scopeHash: delegation.scopeHash,
          keys: delegation.keys,
        },
        fsApi,
      );
      return { delegated: true, runId: lease.runId, leaseToken: lease.token, ...delegation };
    },
    { fsApi },
  );
}

function verifyScopeTokenInState(state, token, requiredKeys, { nowMs = Date.now() } = {}) {
  const normalizedKeys = normalizeConflictKeys(requiredKeys);
  for (const lease of Array.isArray(state.leases) ? state.leases : []) {
    const delegation = (Array.isArray(lease.delegations) ? lease.delegations : []).find(
      (row) => row.token === String(token || ''),
    );
    if (!delegation) continue;
    if (Number(delegation.expiresAtMs || 0) <= nowMs)
      return { ok: false, reason: 'scope-token-expired' };
    if (scopeHash(normalizedKeys) !== delegation.scopeHash)
      return { ok: false, reason: 'scope-token-not-exact' };
    for (const key of normalizedKeys) {
      if (
        Number(state.nextFenceByKey?.[key]) !== Number(delegation.fences?.[key]) ||
        Number(lease.fences?.[key]) !== Number(delegation.fences?.[key])
      ) {
        return { ok: false, reason: 'scope-token-fenced' };
      }
    }
    return { ok: true, lease, delegation };
  }
  return { ok: false, reason: 'scope-token-not-current' };
}

function verifyScopeToken({ dataDir, token, keys, nowMs = Date.now(), fsApi = fs } = {}) {
  const paths = pathsFor(dataDir);
  const state = safeJson(paths.state, initialState(), fsApi) || initialState();
  return verifyScopeTokenInState(state, token, keys, { nowMs });
}

function heartbeatConflictLease(
  lease,
  { dataDir, stage = 'running', nowMs = Date.now(), fsApi = fs } = {},
) {
  if (!lease?.token || !dataDir) return false;
  const paths = pathsFor(dataDir);
  return withStateLock(
    paths,
    () => {
      const state = safeJson(paths.state, initialState(), fsApi) || initialState();
      const current = state.leases.find((row) => row.token === lease.token);
      if (!current) return false;
      const renewalMs = Math.max(
        1,
        Number(current.leaseMs) ||
          Number(current.expiresAtMs) - Number(current.acquiredAtMs) ||
          DEFAULT_LEASE_MS,
      );
      const renewedExpiresAtMs = nowMs + renewalMs;
      current.heartbeatAt = new Date(nowMs).toISOString();
      current.heartbeatAtMs = nowMs;
      current.leaseMs = renewalMs;
      current.expiresAt = new Date(renewedExpiresAtMs).toISOString();
      current.expiresAtMs = renewedExpiresAtMs;
      current.stage = String(stage || 'running');
      // A progressing owner renews scopes that were current when this beat
      // arrived. A scope that already expired during a heartbeat gap is never
      // resurrected by a later beat; the child must obtain a fresh delegation.
      current.delegations = (Array.isArray(current.delegations) ? current.delegations : []).map(
        (delegation) =>
          Number(delegation.expiresAtMs || 0) > nowMs
            ? { ...delegation, expiresAtMs: renewedExpiresAtMs }
            : delegation,
      );
      writeJsonAtomic(paths.state, state, fsApi);
      writeJsonAtomic(
        path.join(paths.runHeartbeats, `${safeRunId(current.runId)}.json`),
        {
          schema: 'secondbrain.controller-run-heartbeat.v1',
          runId: current.runId,
          date: current.date,
          hostname: current.hostname,
          pid: current.pid,
          processStartTime: current.processStartTime,
          scopeHash: current.scopeHash,
          keys: current.keys,
          fences: current.fences,
          stage: current.stage,
          lastBeatAt: current.heartbeatAt,
        },
        fsApi,
      );
      return true;
    },
    { fsApi },
  );
}

function createConflictLeaseHeartbeat(lease, options = {}) {
  let stopped = false;
  let stage = 'starting';
  const beat = (nextStage) => {
    if (stopped) return false;
    if (nextStage) stage = String(nextStage);
    return heartbeatConflictLease(lease, { ...options, stage });
  };
  const intervalMs = Math.max(0, Number(options.intervalMs ?? DEFAULT_HEARTBEAT_MS));
  const timer = intervalMs ? setInterval(() => beat(), intervalMs) : null;
  if (timer?.unref) timer.unref();
  beat();
  return {
    beat,
    stop(nextStage = 'finished') {
      if (stopped) return;
      beat(nextStage);
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

function releaseConflictLease(lease, { dataDir, nowMs = Date.now(), fsApi = fs } = {}) {
  if (!lease?.token || !dataDir) return false;
  const paths = pathsFor(dataDir);
  return withStateLock(
    paths,
    () => {
      const state = safeJson(paths.state, initialState(), fsApi) || initialState();
      const before = state.leases.length;
      state.leases = state.leases.filter((row) => row.token !== lease.token);
      const removed = state.leases.length !== before;
      if (removed) {
        writeJsonAtomic(paths.state, state, fsApi);
        appendEvent(
          paths.events,
          {
            ts: new Date(nowMs).toISOString(),
            event: 'released',
            token: lease.token,
            runId: lease.runId,
            keys: lease.keys,
          },
          fsApi,
        );
      }
      return removed;
    },
    { fsApi },
  );
}

function mutationFenceEnv(delegation) {
  if (!delegation?.delegated) return {};
  return {
    BRIEFING_CONTROLLER_MUTATION_REQUIRED: '1',
    CARD_CONTROLLER_SCOPE_TOKEN: delegation.token,
    CARD_CONTROLLER_SCOPE_KEYS: delegation.keys.join(','),
    CARD_CONTROLLER_SCOPE_HASH: delegation.scopeHash,
  };
}

function assertControllerMutationFence({ dataDir, env = process.env, keys, fsApi = fs } = {}) {
  const token = String(env.CARD_CONTROLLER_SCOPE_TOKEN || '').trim();
  const mutationRequired =
    env.BRIEFING_CONTROLLER_MUTATION_REQUIRED === '1' ||
    env.BRIEFING_CONTROLLER_TRANSACTION === '1';
  const rollout = rolloutMode({ dataDir, env, fsApi });
  if (mutationRequired && rollout.effective === 'enforce' && !token) {
    throw Object.assign(
      new Error('controller mutation fence refused: exact scope token required'),
      {
        code: 'CONTROLLER_MUTATION_FENCED',
        reason: 'scope-token-required',
      },
    );
  }
  if (!token) return null;
  return assertMutationFenceFromEnv({ dataDir, env, keys, fsApi });
}

function assertMutationFenceFromEnv({ dataDir, env = process.env, keys, fsApi = fs } = {}) {
  const requiredKeys = normalizeConflictKeys(
    keys || String(env.CARD_CONTROLLER_SCOPE_KEYS || '').split(','),
  );
  const token = String(env.CARD_CONTROLLER_SCOPE_TOKEN || '');
  const verification = verifyScopeToken({ dataDir, token, keys: requiredKeys, fsApi });
  if (!verification.ok) {
    throw Object.assign(new Error(`controller mutation fence refused: ${verification.reason}`), {
      code: 'CONTROLLER_MUTATION_FENCED',
      reason: verification.reason,
    });
  }
  return verification;
}

module.exports = {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_STALE_MS,
  ATTENDED_SOURCE_PREEMPT_MIN_AGE_MS,
  FEATURE_ENV,
  SHADOW_PASSED_ENV,
  acquireConflictLease,
  assertControllerMutationFence,
  assertMutationFenceFromEnv,
  createConflictLeaseHeartbeat,
  controllerHasActiveHostWork,
  delegateLeaseScope,
  heartbeatConflictLease,
  leaseOwnerState,
  linuxProcessStartTime,
  mutationFenceEnv,
  normalizeConflictKeys,
  pathsFor,
  pruneReclaimable,
  sweepDeadLeases,
  releaseConflictLease,
  rolloutMode,
  scopeHash,
  verifyScopeToken,
  verifyScopeTokenInState,
  withStateLock,
};
