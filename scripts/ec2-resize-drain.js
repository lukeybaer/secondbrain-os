#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { statePaths, activeLeaseRows } = require('./lib/host-work-admission.js');
const {
  observedInstanceType: fetchObservedInstanceType,
} = require('./lib/ec2-instance-metadata.js');
const { resizeExpectation } = require('./lib/nightly-resize-schedule.js');

// 'prepare' drains ahead of a scheduled resize we control end-to-end (the
// AWS-ResizeInstance automation itself measures ~3-4 min); bound its expiry
// to the requested wait plus a modest safety margin, not a flat hour.
// 'shutdown' drains an AWS-owned stop that can legitimately be delayed, so it
// keeps the longer fallback.
const PREPARE_EXPIRY_MARGIN_MS = 15 * 60 * 1000;
const SHUTDOWN_EXPIRY_MARGIN_MS = 60 * 60 * 1000;

const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data';
const REPORT_DIR = path.join(DATA_DIR, 'agent');
const ACTIVE_COMMAND =
  /(?:ec2-(?:card-controller|morning-briefing|overnight-watcher|otter-[a-z0-9-]+|global-identity-cap)-run\.sh|otter-call-processing-healer|overnight-agentic-healer|deploy-ec2-server\.sh|(?:voice-global-recluster|voice-incremental-recluster|apply-voice-cluster-resolutions)\.js)/i;

function writeJsonAtomic(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fsApi.renameSync(temp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bootId(fsApi = fs) {
  try {
    return fsApi.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return '';
  }
}

function liveWorkProcesses({ procRoot = '/proc', fsApi = fs } = {}) {
  let pids = [];
  try {
    pids = fsApi.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const rows = [];
  for (const pid of pids) {
    if (Number(pid) === process.pid || Number(pid) === process.ppid) continue;
    try {
      const command = fsApi
        .readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8')
        .replace(/\0/g, ' ')
        .trim();
      if (!ACTIVE_COMMAND.test(command)) continue;
      rows.push({ pid: Number(pid), command: command.slice(0, 240) });
    } catch {
      // Process exited during inspection.
    }
  }
  return rows;
}

function liveLeases(dataDir = DATA_DIR, nowMs = Date.now()) {
  const paths = statePaths(dataDir);
  try {
    const state = JSON.parse(fs.readFileSync(paths.leases, 'utf8').replace(/^\uFEFF/, ''));
    return activeLeaseRows(state.leases, { nowMs });
  } catch {
    return [];
  }
}

function setDrainMarker({
  mode,
  maxWaitMs,
  nowMs = Date.now(),
  dataDir = DATA_DIR,
  fsApi = fs,
  currentBootId = bootId(fsApi),
}) {
  const paths = statePaths(dataDir);
  if (!currentBootId) throw new Error('resize drain requires Linux boot-id proof');
  // 'shutdown' drains an AWS-owned stop that may be delayed, so it keeps the
  // full hour fallback; the next boot also clears a prior-boot marker
  // immediately. 'prepare' drains a resize we trigger and measure ourselves,
  // so its expiry is bounded to the requested wait plus a modest margin
  // instead of riding the same flat hour (see PREPARE_EXPIRY_MARGIN_MS).
  const margin = mode === 'shutdown' ? SHUTDOWN_EXPIRY_MARGIN_MS : PREPARE_EXPIRY_MARGIN_MS;
  const marker = {
    schema: 'secondbrain.host-resize-drain.v1',
    active: true,
    mode,
    ownerPid: process.pid,
    bootId: currentBootId,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + maxWaitMs + margin).toISOString(),
    expiresAtMs: nowMs + maxWaitMs + margin,
  };
  writeJsonAtomic(paths.resizeDrain, marker, fsApi);
  return marker;
}

// boot_id-changes-on-resize was verified live on this instance/AMI
// (Nitro-based, i-01004b72d9a54c706) on 2026-09-01: prepare/shutdown markers
// armed at 10:30:01/10:35:26 UTC both carried bootId 94410567-b546-4940-
// a850-c39bcfb99f10; the live boot_id immediately after was a4e4b8ec-df13-
// 4bf0-a081-0acc2b87c153, and resize-drain.json recorded clearedAt
// 10:36:45.016Z with clearReason "new-boot-after-resize" -- proof the
// priorBootEnded branch below actually fired for a real AWS-ResizeInstance
// stop/start, not just a service-enable boot. That said, journald on this
// host is not persistent across boots, so the Aug 23/24/28 incidents (which
// ran to the full flat-hour expiry instead of clearing early) cannot be
// re-audited to confirm this path fired correctly on every occasion. Treat
// this branch as a working but unaudited-per-incident optimization, and the
// bounded TTL in setDrainMarker's PREPARE_EXPIRY_MARGIN_MS as the primary,
// always-fires backstop.
function clearStaleMarker(nowMs = Date.now()) {
  const paths = statePaths(DATA_DIR);
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(paths.resizeDrain, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return false;
  }
  if (marker?.active !== true) return false;
  const currentBootId = bootId();
  const priorBootEnded = Boolean(currentBootId && marker.bootId && marker.bootId !== currentBootId);
  if (!priorBootEnded && Number(marker.expiresAtMs || 0) > nowMs) return false;
  writeJsonAtomic(paths.resizeDrain, {
    ...marker,
    active: false,
    clearedAt: new Date(nowMs).toISOString(),
    clearReason: priorBootEnded ? 'new-boot-after-resize' : 'expired-after-resize-or-restart',
  });
  return true;
}

function clearSatisfiedNoopMarker({
  dataDir = DATA_DIR,
  marker = null,
  drainReceipt = null,
  observedInstanceType = '',
  expectedInstanceType = '',
  transition = false,
  currentBootId = bootId(),
  nowMs = Date.now(),
  fsApi = fs,
  pidAlive = (pid) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  },
} = {}) {
  const paths = statePaths(dataDir);
  const currentMarker =
    marker ||
    (() => {
      try {
        return JSON.parse(fsApi.readFileSync(paths.resizeDrain, 'utf8').replace(/^\uFEFF/, ''));
      } catch {
        return null;
      }
    })();
  if (currentMarker?.active !== true) return { cleared: false, reason: 'marker-inactive' };
  if (!expectedInstanceType || observedInstanceType !== expectedInstanceType) {
    // Still inside the scheduled transition and the type hasn't proved out
    // yet: that's the one case the transition window is actually protecting
    // against a race with the in-flight resize. Once the receipt below also
    // matches, the transition window alone stops being a reason to wait.
    if (transition) return { cleared: false, reason: 'transition-still-open' };
    return { cleared: false, reason: 'expected-instance-type-not-proved' };
  }
  if (!currentBootId || !currentMarker.bootId || currentMarker.bootId !== currentBootId) {
    return { cleared: false, reason: 'same-boot-noop-not-proved' };
  }
  if (Number(currentMarker.expiresAtMs || 0) <= nowMs) {
    return { cleared: false, reason: 'marker-already-expired' };
  }
  if (Number(currentMarker.ownerPid || 0) > 0 && pidAlive(currentMarker.ownerPid)) {
    return { cleared: false, reason: 'drain-owner-still-active' };
  }
  const matchingReceipt =
    drainReceipt?.schema === 'secondbrain.ec2-resize-drain-receipt.v1' &&
    drainReceipt?.status === 'green' &&
    drainReceipt?.drained === true &&
    drainReceipt?.marker?.createdAt === currentMarker.createdAt &&
    drainReceipt?.marker?.bootId === currentMarker.bootId &&
    drainReceipt?.marker?.mode === currentMarker.mode;
  if (!matchingReceipt) return { cleared: false, reason: 'matching-green-drain-not-proved' };
  // A proved-matching green drain receipt for THIS marker is itself the
  // proof that there is no more race to protect against, so a proved no-op
  // clears even inside the transition window (relaxed from the flat
  // outside-window-only gate above).

  const clearedAt = new Date(nowMs).toISOString();
  const cleared = {
    ...currentMarker,
    active: false,
    clearedAt,
    clearReason: 'expected-instance-type-already-active',
    expectedInstanceType,
    observedInstanceType,
  };
  writeJsonAtomic(paths.resizeDrain, cleared, fsApi);
  return { cleared: true, reason: cleared.clearReason, marker: cleared };
}

// Default no-op fast-path lookups. Overridable in tests / by callers so the
// path can be proven without a real EC2 metadata endpoint.
function defaultObservedInstanceType() {
  return fetchObservedInstanceType();
}

function defaultExpectedInstanceType(nowMs) {
  return resizeExpectation(new Date(nowMs)).expectedType;
}

async function drain({
  mode = 'prepare',
  maxWaitMs = 240_000,
  pollMs = 2_000,
  dataDir = DATA_DIR,
  reportDir = REPORT_DIR,
  getObservedInstanceType = defaultObservedInstanceType,
  getExpectedInstanceType = defaultExpectedInstanceType,
  fsApi = fs,
  currentBootId = bootId(fsApi),
} = {}) {
  const startedAt = Date.now();
  const marker = setDrainMarker({
    mode,
    maxWaitMs,
    nowMs: startedAt,
    dataDir,
    fsApi,
    currentBootId,
  });
  let processes = [];
  let leases = [];
  while (true) {
    processes = liveWorkProcesses();
    leases = liveLeases(dataDir);
    if (!processes.length && !leases.length) break;
    if (Date.now() - startedAt >= maxWaitMs) break;
    await sleep(Math.min(pollMs, maxWaitMs - (Date.now() - startedAt)));
  }
  const drained = !processes.length && !leases.length;
  const completedAtMs = Date.now();
  const row = {
    schema: 'secondbrain.ec2-resize-drain-receipt.v1',
    status: drained ? 'green' : 'red',
    mode,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    elapsedMs: completedAtMs - startedAt,
    drained,
    remainingProcesses: processes,
    remainingLeases: leases.map((lease) => ({
      kind: lease.kind,
      pid: lease.pid,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
    })),
    marker,
  };

  // No-op fast path: a 'prepare' drain that finished clean and already sits
  // on the night's target instance type doesn't need to wait for the marker
  // to age out (bounded, but still up to PREPARE_EXPIRY_MARGIN_MS) or for the
  // next clearSatisfiedNoopMarker cron tick. Clear it immediately. Best
  // effort: any lookup failure just leaves the bounded TTL / cron fallback
  // in place instead of failing the drain.
  row.noopFastPath = { attempted: false, cleared: false, reason: 'not-attempted' };
  if (mode === 'prepare' && drained) {
    row.noopFastPath.attempted = true;
    try {
      const observedType = await getObservedInstanceType();
      const expectedType = getExpectedInstanceType(completedAtMs);
      if (observedType && expectedType && observedType === expectedType) {
        const paths = statePaths(dataDir);
        const clearedAt = new Date(completedAtMs).toISOString();
        writeJsonAtomic(
          paths.resizeDrain,
          {
            ...marker,
            active: false,
            clearedAt,
            clearReason: 'expected-instance-type-already-active-immediate',
            expectedInstanceType: expectedType,
            observedInstanceType: observedType,
          },
          fsApi,
        );
        row.noopFastPath = {
          attempted: true,
          cleared: true,
          reason: 'expected-instance-type-already-active-immediate',
          observedInstanceType: observedType,
          expectedInstanceType: expectedType,
        };
      } else {
        row.noopFastPath.reason = 'expected-instance-type-not-proved';
        row.noopFastPath.observedInstanceType = observedType;
        row.noopFastPath.expectedInstanceType = expectedType;
      }
    } catch (error) {
      row.noopFastPath.reason = `lookup-failed: ${String(error?.message || error)}`;
    }
  }

  writeJsonAtomic(path.join(reportDir, 'ec2-resize-drain-latest.json'), row, fsApi);
  writeJsonAtomic(path.join(reportDir, `ec2-resize-drain-${mode}-latest.json`), row, fsApi);
  return row;
}

function parseArgs(argv) {
  const out = { mode: 'prepare', maxWaitMs: 240_000, clearStale: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--prepare') out.mode = 'prepare';
    else if (arg === '--shutdown') out.mode = 'shutdown';
    else if (arg === '--clear-stale') out.clearStale = true;
    else if (arg === '--max-wait-ms') out.maxWaitMs = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.maxWaitMs) || out.maxWaitMs < 0 || out.maxWaitMs > 300_000) {
    throw new Error('--max-wait-ms must be between 0 and 300000');
  }
  return out;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.clearStale) {
      console.log(JSON.stringify({ cleared: clearStaleMarker() }));
      return;
    }
    const row = await drain(options);
    console.log(JSON.stringify(row));
    if (!row.drained) process.exitCode = 1;
  } catch (error) {
    console.error(`[ec2-resize-drain] ${error.message || error}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  ACTIVE_COMMAND,
  PREPARE_EXPIRY_MARGIN_MS,
  SHUTDOWN_EXPIRY_MARGIN_MS,
  bootId,
  clearStaleMarker,
  clearSatisfiedNoopMarker,
  drain,
  liveLeases,
  liveWorkProcesses,
  parseArgs,
  setDrainMarker,
};
