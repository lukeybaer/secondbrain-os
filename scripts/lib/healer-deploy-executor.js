'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SHA_RE = /^[0-9a-f]{40}$/i;
const DEFAULT_COALESCE_MS = 250;
const JOURNAL_SCHEMA = 'healer-deploy-batch@2';

function errorText(error) {
  return String((error && error.message) || error || 'unknown deploy executor failure').slice(0, 1000);
}

function ctClock(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(byType.hour) * 60 + Number(byType.minute);
}

function deliveryWindowState({ nowMs = Date.now(), supervised = false } = {}) {
  if (supervised) return { phase: 'open', admit: true, drain: false };
  const minute = ctClock(nowMs);
  if (minute >= 17 * 60 || minute < 5 * 60) {
    return { phase: 'open', admit: true, drain: false };
  }
  if (minute < 5 * 60 + 30) {
    return { phase: 'drain', admit: false, drain: true };
  }
  return { phase: 'closed', admit: false, drain: false };
}

function defaultJournalPath(dataDir) {
  return path.join(dataDir, 'agent', 'healer-deploy-executor', 'active-batch.json');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function jsonSafe(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { serializationError: 'receipt was not JSON serializable' };
  }
}

function proofReceiptComplete(proof, deployedSha = '') {
  if (!proof || proof.ran !== true || proof.controllerReceiptMatched !== true) return false;
  const provedSha = String(proof.deployedReleaseSha || '').toLowerCase();
  return !provedSha || provedSha === String(deployedSha || '').toLowerCase();
}

function requestReceipt(request, phase = request.phase || 'admitted') {
  return {
    waiterKey: request.waiterKey,
    requestId: request.requestId,
    cardId: request.cardId,
    workUnitId: request.workUnitId,
    closureId: request.closureId,
    requestedSha: request.requestedSha,
    changedPaths: Array.isArray(request.changedPaths) ? [...request.changedPaths] : [],
    admittedAt: request.admittedAt,
    deadlineMs: Number.isFinite(request.deadlineMs) ? request.deadlineMs : null,
    phase,
  };
}

async function isolateFailedBatch(requests, probe) {
  if (!Array.isArray(requests) || !requests.length) {
    return {
      failedRequestIds: [],
      passedRequestIds: [],
      indeterminateRequestIds: [],
      interactionRequestIds: [],
      probes: [],
    };
  }
  if (typeof probe !== 'function') {
    return {
      failedRequestIds: requests.map((request) => request.requestId),
      passedRequestIds: [],
      indeterminateRequestIds: [],
      interactionRequestIds: [],
      probes: [],
      conservative: true,
    };
  }
  const probes = [];
  const checkPrefix = async (endIndex) => {
    const subset = requests.slice(0, endIndex + 1);
    const targetSha = subset[subset.length - 1].requestedSha;
    let result;
    try {
      result = await probe({
        requests: subset.map(requestReceipt),
        targetSha,
      });
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    const ok = result === true || !!(result && result.ok);
    probes.push({
      requestIds: subset.map((request) => request.requestId),
      targetSha,
      ok,
      result: jsonSafe(result),
    });
    return ok;
  };

  // A coalesced lineage is cumulative. Probe exact historical prefix SHAs,
  // never arbitrary request-id subsets that cannot exist as git revisions.
  if (await checkPrefix(requests.length - 1)) {
    return {
      failedRequestIds: [],
      passedRequestIds: [],
      indeterminateRequestIds: [],
      interactionRequestIds: requests.map((request) => request.requestId),
      probes,
      reproducible: false,
    };
  }
  let low = 0;
  let high = requests.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (await checkPrefix(middle)) low = middle + 1;
    else high = middle;
  }
  return {
    failedRequestIds: [requests[low].requestId],
    passedRequestIds: requests.slice(0, low).map((request) => request.requestId),
    indeterminateRequestIds: requests.slice(low + 1).map((request) => request.requestId),
    interactionRequestIds: [],
    probes,
    firstFailingTargetSha: requests[low].requestedSha,
  };
}

function createHealerDeployExecutor({
  dataDir,
  journalPath = dataDir ? defaultJournalPath(dataDir) : '',
  coalesceMs = DEFAULT_COALESCE_MS,
  now = Date.now,
  supervised = false,
  windowState = deliveryWindowState,
  isAncestor = async (ancestor, descendant) => ancestor === descendant,
  recover = async () => ({ ok: true, action: 'atomic-release-recovers-before-next-swap' }),
  readDeployedSha = () => '',
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  afterPersist = () => {},
  log = () => {},
} = {}) {
  const queue = [];
  const recoveredWaiters = new Map();
  const recoveredResults = new Map();
  const initialJournal = journalPath ? readJson(journalPath) : null;
  const recoveryAdmissionKeys = new Set(
    initialJournal &&
    ['deploying', 'deployed', 'proving', 'awaiting-waiters', 'recovered-awaiting-waiters'].includes(
      String(initialJournal.phase),
    )
      ? (initialJournal.requests || []).map((row) => String(row.waiterKey || row.requestId || ''))
      : [],
  );
  let timer = null;
  let running = false;
  let stopped = false;
  let recoveryError = '';
  let activeBatch = null;

  const persist = (state) => {
    activeBatch = state;
    if (journalPath) writeJsonAtomic(journalPath, state);
    afterPersist(state);
    return state;
  };

  const patchJournalWaiter = (waiterKey, patch) => {
    const requests = (activeBatch.requests || []).map((row) =>
      row.waiterKey === waiterKey ? { ...row, ...jsonSafe(patch) } : row,
    );
    persist({ ...activeBatch, requests });
    return requests.find((row) => row.waiterKey === waiterKey) || null;
  };

  const readyPromise = (async () => {
    if (!journalPath) return null;
    const prior = initialJournal;
    if (
      !prior ||
      !['deploying', 'deployed', 'proving', 'awaiting-waiters', 'recovered-awaiting-waiters'].includes(
        String(prior.phase),
      )
    ) {
      return prior;
    }
    let recovery;
    try {
      recovery = await recover(prior);
    } catch (error) {
      recovery = { ok: false, error: errorText(error) };
    }
    if (!recovery || !recovery.ok) {
      recoveryError = errorText((recovery && recovery.error) || 'recovery failed');
      persist({
        ...prior,
        phase: 'recovery-failed',
        recoveredAt: new Date(now()).toISOString(),
        recovery: jsonSafe(recovery),
      });
      return recovery;
    }
    const liveSha = String(await readDeployedSha()).toLowerCase();
    const targetStillLive =
      prior.phase !== 'deploying' && liveSha === String(prior.targetSha || '').toLowerCase();
    const requests = (prior.requests || []).map((row) => {
      if (row.phase === 'proved' && row.result && row.result.ok) return row;
      return {
        ...row,
        phase: targetStillLive ? 'deployed-pending-proof' : 'redeploy-required',
        deployedSha: targetStillLive ? liveSha : '',
        recoveryDisposition: targetStillLive ? 'resume-proof' : 'redeploy-exact-sha',
      };
    });
    for (const row of requests) {
      const key = String(row.waiterKey || row.requestId || '');
      if (!key) continue;
      if (row.phase === 'proved' && row.result && row.result.ok) recoveredResults.set(key, row.result);
      else recoveredWaiters.set(key, row);
    }
    persist({
      ...prior,
      schema: JOURNAL_SCHEMA,
      phase: recoveredWaiters.size ? 'recovered-awaiting-waiters' : 'complete',
      requests,
      recoveredAt: new Date(now()).toISOString(),
      recoveredLiveSha: liveSha,
      recovery: jsonSafe(recovery),
    });
    return recovery;
  })();

  const rejectAdmission = (input, code, state) =>
    Promise.resolve({
      ok: false,
      code,
      failureOwner: 'executor',
      retryable: true,
      requestedSha: String(input.requestedSha || '').toLowerCase(),
      deployedSha: '',
      deliveryWindow: state,
      attemptCharge: 0,
      fingerprintRecorded: false,
    });

  const orderLineage = async (requests) => {
    const ordered = [];
    for (const request of requests) {
      let inserted = false;
      for (let index = 0; index < ordered.length; index += 1) {
        if (
          request.requestedSha !== ordered[index].requestedSha &&
          (await isAncestor(request.requestedSha, ordered[index].requestedSha))
        ) {
          ordered.splice(index, 0, request);
          inserted = true;
          break;
        }
      }
      if (!inserted) ordered.push(request);
    }
    ordered.target = ordered[ordered.length - 1];
    return ordered;
  };

  const selectLineageBatch = async () => {
    const first = queue.shift();
    if (!first) return [];
    const compatibleRequests = [first];
    let target = first;
    for (let index = 0; index < queue.length; ) {
      const candidate = queue[index];
      let compatible = false;
      try {
        if (await isAncestor(target.requestedSha, candidate.requestedSha)) {
          target = candidate;
          compatible = true;
        } else if (await isAncestor(candidate.requestedSha, target.requestedSha)) {
          compatible = true;
        }
      } catch {
        compatible = false;
      }
      if (compatible) {
        compatibleRequests.push(candidate);
        queue.splice(index, 1);
      } else {
        index += 1;
      }
    }
    return orderLineage(compatibleRequests);
  };

  const settleDeployFailure = async (batch, deployResult, batchId) => {
    const failureOwner = String(deployResult.failureOwner || 'executor');
    const isolation =
      failureOwner === 'batch-member'
        ? await isolateFailedBatch(batch, batch.target.probeBatch)
        : null;
    const failed = new Set((isolation && isolation.failedRequestIds) || []);
    const interaction = new Set((isolation && isolation.interactionRequestIds) || []);
    const peers = new Set([
      ...((isolation && isolation.passedRequestIds) || []),
      ...((isolation && isolation.indeterminateRequestIds) || []),
    ]);
    persist({
      ...activeBatch,
      phase: 'failed',
      failedAt: new Date(now()).toISOString(),
      deploy: jsonSafe(deployResult),
      isolation: jsonSafe(isolation),
    });
    for (const request of batch) {
      const isolatedMember = failed.has(request.requestId);
      const interactionMember = interaction.has(request.requestId);
      request.resolve({
        ok: false,
        code: isolatedMember
          ? 'isolated-batch-member-failure'
          : interactionMember
            ? 'batch-interaction-failure'
            : peers.has(request.requestId)
              ? 'batch-peer-failure'
              : 'deploy-failed',
        batchId,
        requestId: request.requestId,
        waiterKey: request.waiterKey,
        requestedSha: request.requestedSha,
        deployedSha: '',
        failureOwner: isolatedMember || interactionMember ? 'batch-member' : failureOwner,
        isolated: isolatedMember,
        retryable: !isolatedMember,
        deploy: deployResult,
        isolation,
        attemptCharge: 0,
        fingerprintRecorded: false,
      });
    }
  };

  const proofResult = async ({ request, batchId, deployedSha, satisfaction, deployResult }) => {
    if (!satisfaction) {
      return {
        ok: false,
        code: 'requested-sha-not-deployed',
        batchId,
        requestId: request.requestId,
        waiterKey: request.waiterKey,
        requestedSha: request.requestedSha,
        deployedSha,
        failureOwner: 'executor',
        retryable: true,
        deploy: deployResult,
        attemptCharge: 0,
        fingerprintRecorded: false,
      };
    }
    let proof = null;
    let proofError = '';
    try {
      proof =
        typeof request.prove === 'function'
          ? await request.prove({
              batchId,
              requestId: request.requestId,
              requestedSha: request.requestedSha,
              deployedSha,
              satisfaction,
              deploy: deployResult,
            })
          : null;
    } catch (error) {
      proofError = errorText(error);
    }
    const proofComplete = !proofError && proofReceiptComplete(proof, deployedSha);
    return {
      ok: proofComplete,
      code: proofComplete ? 'deployed' : 'deployed-pending-proof',
      batchId,
      requestId: request.requestId,
      waiterKey: request.waiterKey,
      requestedSha: request.requestedSha,
      deployedSha,
      deployed: true,
      satisfaction,
      deploy: deployResult,
      proof,
      proofError:
        proofError ||
        (proofComplete
          ? ''
          : 'card-controller transport proof was not run or its exact receipt did not match'),
      repairState: proofComplete ? '' : 'deployed_pending_proof',
      resumeStage: proofComplete ? '' : 'proof',
      failureStage: proofComplete ? '' : 'proof',
      retryable: !proofComplete,
      attemptCharge: proofComplete ? 1 : 0,
      fingerprintRecorded: false,
    };
  };

  const executeProof = async ({
    request,
    batchId,
    deployedSha,
    satisfaction,
    deployResult,
    completeBatch = false,
  }) => {
    patchJournalWaiter(request.waiterKey, {
      phase: 'proving',
      deployedSha,
      satisfaction,
      proofStartedAt: new Date(now()).toISOString(),
    });
    const result = await proofResult({ request, batchId, deployedSha, satisfaction, deployResult });
    const phase = result.ok ? 'proved' : 'deployed-pending-proof';
    const row = patchJournalWaiter(request.waiterKey, {
      phase,
      deployedSha,
      satisfaction,
      result: jsonSafe(result),
      proofCompletedAt: result.ok ? new Date(now()).toISOString() : '',
      proofPendingAt: result.ok ? '' : new Date(now()).toISOString(),
    });
    if (recoveredWaiters.has(request.waiterKey)) {
      if (result.ok) {
        recoveredWaiters.delete(request.waiterKey);
        recoveryAdmissionKeys.delete(request.waiterKey);
      }
      else recoveredWaiters.set(request.waiterKey, row);
    }
    if (
      completeBatch ||
      (!recoveredWaiters.size && activeBatch.phase === 'recovered-awaiting-waiters')
    ) {
      persist({ ...activeBatch, phase: 'complete', completedAt: new Date(now()).toISOString() });
    }
    request.resolve(result);
    return result;
  };

  const executeBatch = async (batch) => {
    const target = batch.target;
    const batchId = `healer-deploy-${now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const journal = {
      schema: JOURNAL_SCHEMA,
      batchId,
      phase: 'deploying',
      targetSha: target.requestedSha,
      startedAt: new Date(now()).toISOString(),
      requests: batch.map((request) => requestReceipt(request, 'deploying')),
    };
    persist(journal);
    let deployResult;
    try {
      deployResult = await target.deploy({
        batchId,
        targetSha: target.requestedSha,
        requests: batch.map(requestReceipt),
      });
    } catch (error) {
      deployResult = { ok: false, failureOwner: 'executor', error: errorText(error) };
    }
    const deployedSha = String((deployResult && deployResult.deployedSha) || '').toLowerCase();
    if (!deployResult || !deployResult.ok || deployedSha !== target.requestedSha) {
      if (deployResult && deployResult.ok && deployedSha !== target.requestedSha) {
        deployResult = {
          ...deployResult,
          ok: false,
          failureOwner: 'executor',
          error: `deploy proved ${deployedSha || 'no SHA'}, expected exact target ${target.requestedSha}`,
        };
      }
      await settleDeployFailure(batch, deployResult || { ok: false }, batchId);
      return;
    }
    const proofInputs = [];
    for (const request of batch) {
      let satisfaction = '';
      try {
        satisfaction =
          request.requestedSha === deployedSha
            ? 'exact'
            : (await isAncestor(request.requestedSha, deployedSha))
              ? 'ancestor'
              : '';
      } catch {
        satisfaction = '';
      }
      proofInputs.push({ request, satisfaction });
    }
    persist({
      ...journal,
      phase: 'proving',
      deployedAt: new Date(now()).toISOString(),
      proofStartedAt: new Date(now()).toISOString(),
      deploy: jsonSafe(deployResult),
      requests: journal.requests.map((row) => {
        const proofInput = proofInputs.find((input) => input.request.waiterKey === row.waiterKey);
        return {
          ...row,
          phase: 'deployed-pending-proof',
          deployedSha,
          satisfaction: proofInput ? proofInput.satisfaction : '',
        };
      }),
    });
    // Proofs are intentionally persisted and settled one waiter at a time.
    // A process crash cannot erase which cards already proved this release.
    for (let index = 0; index < proofInputs.length; index += 1) {
      const { request, satisfaction } = proofInputs[index];
      await executeProof({
        request,
        batchId,
        deployedSha,
        satisfaction,
        deployResult,
        completeBatch: index === proofInputs.length - 1,
      });
    }
  };

  const reconcileRecoveredQueue = async () => {
    if (!recoveredWaiters.size && !recoveredResults.size) return;
    const liveSha = String(await readDeployedSha()).toLowerCase();
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const request = queue[index];
      const savedResult = recoveredResults.get(request.waiterKey);
      if (savedResult) {
        queue.splice(index, 1);
        recoveredResults.delete(request.waiterKey);
        recoveryAdmissionKeys.delete(request.waiterKey);
        request.resolve(savedResult);
        continue;
      }
      const row = recoveredWaiters.get(request.waiterKey);
      if (!row) continue;
      queue.splice(index, 1);
      if (row.phase === 'proved' && row.result && row.result.ok) {
        recoveredWaiters.delete(request.waiterKey);
        recoveryAdmissionKeys.delete(request.waiterKey);
        if (!recoveredWaiters.size) {
          persist({ ...activeBatch, phase: 'complete', completedAt: new Date(now()).toISOString() });
        }
        request.resolve(row.result);
        continue;
      }
      let satisfaction = '';
      try {
        satisfaction =
          request.requestedSha === liveSha
            ? 'exact'
            : (await isAncestor(request.requestedSha, liveSha))
              ? 'ancestor'
              : '';
      } catch {
        satisfaction = '';
      }
      if (satisfaction) {
        await executeProof({
          request,
          batchId: activeBatch.batchId,
          deployedSha: liveSha,
          satisfaction,
          deployResult: activeBatch.deploy || row.result?.deploy || null,
        });
      } else {
        recoveredWaiters.delete(request.waiterKey);
        recoveryAdmissionKeys.delete(request.waiterKey);
        queue.push(request);
      }
    }
  };

  const drain = async () => {
    if (running || stopped) return;
    running = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    try {
      await readyPromise;
      if (recoveryError) {
        while (queue.length) {
          const request = queue.shift();
          request.resolve({
            ok: false,
            code: 'recovery-required',
            failureOwner: 'executor',
            retryable: true,
            requestedSha: request.requestedSha,
            deployedSha: '',
            error: recoveryError,
            attemptCharge: 0,
            fingerprintRecorded: false,
          });
        }
        return;
      }
      await reconcileRecoveredQueue();
      if (recoveredWaiters.size) {
        while (queue.length) {
          const request = queue.shift();
          request.resolve({
            ok: false,
            code: 'recovery-waiter-resubmission-required',
            failureOwner: 'executor',
            retryable: true,
            requestedSha: request.requestedSha,
            deployedSha: '',
            pendingWaiterKeys: [...recoveredWaiters.keys()],
            attemptCharge: 0,
            fingerprintRecorded: false,
          });
        }
        return;
      }
      while (queue.length) {
        const state = windowState({ nowMs: now(), supervised });
        if (state.phase === 'closed') {
          while (queue.length) {
            const request = queue.shift();
            request.resolve(await rejectAdmission(request, 'delivery-window-closed', state));
          }
          break;
        }
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const request = queue[index];
          if (!Number.isFinite(request.deadlineMs) || now() < request.deadlineMs) continue;
          queue.splice(index, 1);
          request.resolve({
            ok: false,
            code: 'deploy-deadline-elapsed',
            requestId: request.requestId,
            requestedSha: request.requestedSha,
            deployedSha: '',
            failureOwner: 'executor',
            retryable: true,
            attemptCharge: 0,
            fingerprintRecorded: false,
          });
        }
        const batch = await selectLineageBatch();
        if (batch.length) await executeBatch(batch);
      }
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    if (timer || running || stopped) return;
    timer = setTimer(() => {
      timer = null;
      drain().catch((error) => log(`[healer-deploy-executor] ${errorText(error)}`));
    }, Math.max(0, Number(coalesceMs) || 0));
  };

  const request = (input = {}) => {
    const requestedSha = String(input.requestedSha || '').trim().toLowerCase();
    if (!SHA_RE.test(requestedSha)) {
      return rejectAdmission(input, 'invalid-requested-sha', null);
    }
    if (typeof input.deploy !== 'function') {
      return rejectAdmission(input, 'missing-deploy-adapter', null);
    }
    const suppliedWaiterKey = String(input.waiterKey || input.requestId || '').trim();
    const state = windowState({ nowMs: now(), supervised });
    if (!state.admit && !recoveryAdmissionKeys.has(suppliedWaiterKey)) {
      return rejectAdmission(
        input,
        state.phase === 'drain' ? 'delivery-window-draining' : 'delivery-window-closed',
        state,
      );
    }
    return new Promise((resolve) => {
      const requestId =
        String(input.requestId || '').trim() ||
        `deploy-request-${now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      queue.push({
        ...input,
        requestedSha,
        requestId,
        waiterKey: suppliedWaiterKey || requestId,
        cardId: String(input.cardId || ''),
        workUnitId: String(input.workUnitId || ''),
        closureId: String(input.closureId || ''),
        changedPaths: Array.isArray(input.changedPaths) ? [...input.changedPaths] : [],
        admittedAt: new Date(now()).toISOString(),
        deadlineMs: Number(input.deadlineMs),
        resolve,
      });
      schedule();
    });
  };

  return {
    request,
    ready: () => readyPromise,
    drain,
    stop: () => {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    snapshot: () => ({
      running,
      stopped,
      queued: queue.length,
      activeBatch,
      recoveryError,
      recoveredWaiterKeys: [...recoveredWaiters.keys()],
      recoveredResultKeys: [...recoveredResults.keys()],
    }),
  };
}

module.exports = {
  DEFAULT_COALESCE_MS,
  JOURNAL_SCHEMA,
  SHA_RE,
  ctClock,
  deliveryWindowState,
  defaultJournalPath,
  proofReceiptComplete,
  isolateFailedBatch,
  createHealerDeployExecutor,
};
