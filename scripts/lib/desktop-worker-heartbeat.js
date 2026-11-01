'use strict';

// Desktop worker liveness, recorded and read on EC2.
//
// The PC desktop capability worker polls the EC2 claim route every 5 seconds
// through its relay tunnel. recordWorkerClaim (called by that route) stamps the
// last claim in data/agent/desktop-worker-heartbeat.json, so EC2 knows whether
// the worker, its tunnel and its relay auth are alive without any PC change.
// describeDesktopSnapshotFlow reads that heartbeat plus the snapshot-run
// receipt the worker ships, names which leg failed when the Dev Ops snapshot is
// stale or missing, and returns the PC runtime parity against the running
// release. The leg is detail text; the parity is a verdict input: the Dev Ops
// row is red whenever the release is known and the receipt's runtime SHA is
// missing or differs, in every snapshot state (Codex deploy review
// d024e4684aa9). It never changes the 3 hour limit and it never throws.

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomicRetry } = require('./write-json-atomic-retry.js');

const HEARTBEAT_SCHEMA = 'amy.desktop_worker_heartbeat.v1';
const WRITE_THROTTLE_MS = 30 * 1000;
const HEARTBEAT_FRESH_MS = 10 * 60 * 1000;
const RECEIPT_STALE_MS = 3 * 60 * 60 * 1000;
const WORKER_TASK_NAME = 'SecondBrain-DesktopCapabilityWorker';

const heartbeatPath = (dataDir) => path.join(dataDir, 'agent', 'desktop-worker-heartbeat.json');
const shippedReceiptPath = (dataDir) => path.join(dataDir, 'agent', 'desktop-snapshot-maintenance.json');

let lastWrite = { key: null, ms: 0 };

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function timeMs(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

function relativeAgo(value, nowMs) {
  const t = timeMs(value);
  if (!Number.isFinite(t)) return 'time unknown';
  const mins = Math.max(0, Math.round((nowMs - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Called on every claim poll. At most one write per 30s per worker id; a write
// failure is swallowed so the claim route is never broken by the heartbeat.
function recordWorkerClaim({ dataDir, workerId, nowMs = Date.now() } = {}) {
  try {
    const id = String(workerId || '').trim().slice(0, 200);
    if (!dataDir || !id) return { written: false, reason: 'dataDir and workerId required' };
    const key = `${path.resolve(dataDir)}\u0000${id}`;
    const sinceLast = nowMs - lastWrite.ms;
    if (lastWrite.key === key && sinceLast >= 0 && sinceLast < WRITE_THROTTLE_MS) {
      return { written: false, reason: 'throttled' };
    }
    writeJsonAtomicRetry(heartbeatPath(dataDir), {
      schema: HEARTBEAT_SCHEMA,
      worker_id: id,
      last_claim_at: new Date(nowMs).toISOString(),
    });
    lastWrite = { key, ms: nowMs };
    return { written: true };
  } catch (error) {
    return { written: false, reason: String((error && error.message) || error).slice(0, 200) };
  }
}

function readWorkerHeartbeat(dataDir) {
  if (!dataDir) return null;
  const row = readJsonFile(heartbeatPath(dataDir));
  if (!row || !row.last_claim_at) return null;
  return { worker_id: row.worker_id || null, last_claim_at: row.last_claim_at };
}

// The first producer that did not run, ship and pass, else the run's own error.
function failedRunReason(receipt) {
  const producers = Array.isArray(receipt.producers) ? receipt.producers : [];
  const failed = producers.find((row) => row && !(row.ok && row.ran && row.shipped) && row.error);
  if (failed) return `${failed.id || 'unknown producer'}: ${String(failed.error)}`.slice(0, 200);
  if (receipt.error) return String(receipt.error).slice(0, 200);
  const unshipped = producers.find((row) => row && !(row.ok && row.ran && row.shipped));
  if (unshipped) return `${unshipped.id || 'unknown producer'} did not run or ship`.slice(0, 200);
  return 'no error text recorded';
}

const SHA40_RE = /^[0-9a-f]{40}$/;

// Runtime parity: the PC runtime the run receipt was produced from, against the
// release EC2 is running. The desktop provisioner installs that runtime, not the
// EC2 deploy, so a receipt whose source SHA is missing or differs means the PC
// worker was not refreshed from this release. The receipt is written by the
// registered scheduled task from the installed runtime manifest, so a fresh
// receipt carrying the release SHA proves both the runtime and the registration.
// red is true whenever the release is known and the receipt does not carry that
// exact SHA; with the release unknown ('' off EC2) parity is not asserted.
function runtimeParity(receipt, releaseSha, releaseOrder = []) {
  const runtime = String((receipt && receipt.source_sha) || '').toLowerCase();
  const release = String(releaseSha || '').toLowerCase();
  const short = (sha) => sha.slice(0, 12);
  if (!SHA40_RE.test(release)) {
    return { status: 'release-unknown', red: false, runtimeSha: SHA40_RE.test(runtime) ? runtime : null, releaseSha: null, note: '' };
  }
  if (!SHA40_RE.test(runtime)) {
    const why = receipt ? 'its run receipt carries no source SHA' : 'no run receipt has reached the cloud';
    return {
      status: 'missing',
      red: true,
      runtimeSha: null,
      releaseSha: release,
      note: `; PC worker runtime unknown against release ${short(release)} (${why}): the PC runtime was not refreshed from this release`,
    };
  }
  if (runtime === release) {
    return { status: 'match', red: false, runtimeSha: runtime, releaseSha: release, note: `; PC worker runtime ${short(runtime)} matches release ${short(release)}` };
  }
  // EC2 checks release currency itself (The owner, S-3, 2026-10-22): a runtime that
  // is a known earlier release EC2 has deployed is a PC worker catching up,
  // yellow with the release named. A runtime EC2 cannot place stays red.
  const order = (releaseOrder || []).map((sha) => String(sha || '').toLowerCase());
  const at = order.indexOf(runtime);
  const now = order.indexOf(release);
  if (at > now && now >= 0) {
    const behind = at - now;
    return {
      status: 'behind',
      red: false,
      yellow: true,
      behind,
      runtimeSha: runtime,
      releaseSha: release,
      note: `; PC worker is ${behind === 1 ? 'one release' : `${behind} releases`} behind (runtime ${short(runtime)}, release ${short(release)}): the PC runtime refresh is catching up`,
    };
  }
  return {
    status: 'differs',
    red: true,
    runtimeSha: runtime,
    releaseSha: release,
    note: `; PC worker runtime ${short(runtime)} differs from release ${short(release)}: the PC runtime was not refreshed from this release`,
  };
}

// Returns { state, detail, runtime } for the Dev Ops snapshot row: the failing
// leg (detail) and the runtime parity verdict (see runtimeParity).
function describeDesktopSnapshotFlow({
  dataDir,
  nowMs = Date.now(),
  snapshotGeneratedAt = null,
  releaseSha = null,
  releaseOrder = [],
} = {}) {
  try {
    const receipt = dataDir ? readJsonFile(shippedReceiptPath(dataDir)) : null;
    const runtime = runtimeParity(receipt, releaseSha, releaseOrder);
    const parity = runtime.note;
    const heartbeat = readWorkerHeartbeat(dataDir);
    const claimMs = heartbeat ? timeMs(heartbeat.last_claim_at) : NaN;
    if (!Number.isFinite(claimMs) || nowMs - claimMs > HEARTBEAT_FRESH_MS) {
      const lastClaim = Number.isFinite(claimMs)
        ? `last relay claim ${relativeAgo(heartbeat.last_claim_at, nowMs)}`
        : 'no relay claim recorded';
      return {
        state: 'heartbeat-missing',
        detail: `PC worker heartbeat missing (${lastClaim}): the desktop capability worker is not running or its relay tunnel is down; restart scheduled task ${WORKER_TASK_NAME} on the PC${parity}`,
        runtime,
      };
    }
    const completedMs = receipt ? timeMs(receipt.completed_at) : NaN;
    if (receipt && receipt.ok === false) {
      return {
        state: 'run-failed',
        detail: `PC worker is alive but its last snapshot run failed (${relativeAgo(receipt.completed_at, nowMs)}): ${failedRunReason(receipt)}${parity}`,
        runtime,
      };
    }
    if (!receipt || !Number.isFinite(completedMs) || nowMs - completedMs > RECEIPT_STALE_MS) {
      const since = receipt && Number.isFinite(completedMs)
        ? `since the last run receipt (${relativeAgo(receipt.completed_at, nowMs)})`
        : '(no run receipt recorded)';
      return {
        state: 'run-or-upload-failing',
        detail: `PC worker is alive but no snapshot run has reached the cloud ${since}: the snapshot run is not starting or its upload is failing${parity}`,
        runtime,
      };
    }
    const snapshotMs = timeMs(snapshotGeneratedAt);
    if (!Number.isFinite(snapshotMs) || completedMs > snapshotMs) {
      const snapshotState = Number.isFinite(snapshotMs) ? 'older' : 'missing or unreadable';
      return {
        state: 'upload-disagrees',
        detail: `PC worker reports a good snapshot run ${relativeAgo(receipt.completed_at, nowMs)} but the snapshot file is ${snapshotState}: upload verification disagrees${parity}`,
        runtime,
      };
    }
    const reached = `PC worker is alive and its last snapshot run reached the cloud ${relativeAgo(receipt.completed_at, nowMs)}${parity}`;
    // A good, fresh run from a runtime that is not this release is red, not ok:
    // the release's desktop changes are not what produced this snapshot.
    if (runtime.red) return { state: 'runtime-stale', detail: reached, runtime };
    if (runtime.yellow) return { state: 'runtime-behind', detail: reached, runtime };
    return { state: 'run-ok', detail: reached, runtime };
  } catch (error) {
    return {
      state: 'unknown',
      detail: `PC worker state unknown (${String((error && error.message) || error).slice(0, 120)})`,
      runtime: { status: 'unknown', red: false, runtimeSha: null, releaseSha: null, note: '' },
    };
  }
}

module.exports = {
  HEARTBEAT_SCHEMA,
  WRITE_THROTTLE_MS,
  HEARTBEAT_FRESH_MS,
  RECEIPT_STALE_MS,
  heartbeatPath,
  shippedReceiptPath,
  recordWorkerClaim,
  readWorkerHeartbeat,
  runtimeParity,
  describeDesktopSnapshotFlow,
};
