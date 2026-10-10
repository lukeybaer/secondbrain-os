'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  SHA_RE,
  deliveryWindowState,
  isolateFailedBatch,
  proofReceiptComplete,
} = require('./healer-deploy-executor.js');
const { appendTerminalEvidenceEvent } = require('./overnight-report-event-ledger.js');
const { dateKeyInCt } = require('./briefing-run-window.js');
const { firstPassInFlight, FIRST_PASS_HOLD_MAX_MS } = require('./first-pass-schedule.js');

const SCHEMA = 'healer-deploy-coordinator@1';

// A failed batch's raw stderr/error text is the only place a deploy-window-
// guard refusal is ever recorded (2026-09-01 incident: nine healer
// integrations landed and then silently lost their deploy to the guard, and
// nothing the report reads said why). These two helpers pull the REFUSE
// bullets (or the last FAIL line) out of that text so the terminal evidence
// envelope below carries the real reason, not just "deploy failed".
function deployFailureText(deployResult) {
  return String(
    (deployResult && (deployResult.stderr || deployResult.error || deployResult.stdout)) || '',
  );
}

function deployFailureGuard(deployResult) {
  return /\[deploy-window-guard]\s*REFUSE/.test(deployFailureText(deployResult))
    ? 'deploy-window-guard'
    : 'deploy-ec2-server.sh';
}

function deployFailureObserved(deployResult) {
  const text = deployFailureText(deployResult);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const guardBullets = lines.filter((line) => /\[deploy-window-guard]\s*(REFUSE|-)/.test(line));
  if (guardBullets.length) return guardBullets.join(' ');
  const failLines = lines.filter((line) => /\bFAIL\b/.test(line));
  if (failLines.length) return failLines[failLines.length - 1];
  return text || (deployResult && deployResult.error) || 'coordinator deploy failed';
}

function errorText(error) {
  return String((error && error.message) || error || 'shared deploy coordinator failure').slice(
    0,
    1000,
  );
}

function coordinatorRoot(dataDir) {
  return path.join(dataDir, 'agent', 'healer-deploy-coordinator');
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
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return value;
}

function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { serializationError: 'receipt was not JSON serializable' };
  }
}

function keySlug(waiterKey) {
  return crypto.createHash('sha256').update(String(waiterKey)).digest('hex');
}

function processAlive(pid) {
  const candidate = Number(pid);
  if (!Number.isInteger(candidate) || candidate <= 0) return false;
  try {
    process.kill(candidate, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function tryAcquireLease(file, now = Date.now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date(now()).toISOString() })}\n`,
      );
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(file);
        } catch {
          // A process death leaves the lease for dead-PID takeover.
        }
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return null;
      const prior = readJson(file);
      if (!prior) {
        try {
          if (now() - fs.statSync(file).mtimeMs < 30_000) return null;
        } catch {
          return null;
        }
      }
      if (prior && processAlive(prior.pid)) return null;
      try {
        fs.unlinkSync(file);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

function serializableRequest(input, now) {
  const admittedMs = now();
  return {
    schema: SCHEMA,
    waiterKey: input.waiterKey,
    requestId: input.requestId,
    cardId: input.cardId,
    workUnitId: input.workUnitId,
    closureId: input.closureId,
    requestedSha: input.requestedSha,
    changedPaths: Array.isArray(input.changedPaths) ? [...input.changedPaths] : [],
    deployDescriptor: jsonSafe(input.deployDescriptor || null),
    proofDescriptor: jsonSafe(input.proofDescriptor || null),
    admittedAt: new Date(admittedMs).toISOString(),
    admittedMs,
    deadlineMs: Number.isFinite(input.deadlineMs) ? input.deadlineMs : null,
    // Delivery-window authority belongs to the request, not the executor: a
    // supervised executor may batch only supervised rows while the ordinary
    // window is shut (Codex deploy review 2026-09-29).
    supervised: input.supervised === true,
    // Lineage for the first-pass deploy hold: the controller run whose healer
    // asked for this deploy.
    controllerRunId: String(input.controllerRunId || ''),
    ownerPid: process.pid,
    phase: 'admitted',
    batchId: '',
    result: null,
  };
}

function createCrossProcessHealerDeployExecutor({
  dataDir,
  root = coordinatorRoot(dataDir),
  coalesceMs = 250,
  pollMs = 100,
  now = Date.now,
  supervised = false,
  // Only the explicitly supervised standing owner (an operator run) may batch
  // unsupervised orphans while the ordinary window is closed.
  batchesUnsupervisedRows = false,
  windowState = deliveryWindowState,
  isAncestor = async (ancestor, descendant) => ancestor === descendant,
  recover = async () => ({ ok: true, action: 'none' }),
  // FIRST-PASS DEPLOY HOLD (Oct 5 2026): an unattended healer deploy waits
  // while the night's production is in flight. Returns { inFlight, ... }.
  deployHold = (nowMs) => firstPassInFlight(dataDir, { nowMs }),
  // The controller run that owns this executor; stamped on its requests.
  controllerRunId = '',
  firstPassHoldMaxMs = FIRST_PASS_HOLD_MAX_MS,
  readDeployedSha = () => '',
  deployFromRequest = null,
  probeFromBatch = null,
  proveFromRequest = null,
  log = () => {},
} = {}) {
  if (!dataDir) throw new Error('cross-process healer deploy coordinator requires dataDir');
  const inboxDir = path.join(root, 'inbox');
  const batchesDir = path.join(root, 'batches');
  const coordinatorLease = path.join(root, 'coordinator.lock');
  const localRequests = new Map();
  let stopped = false;
  let recoveryError = '';

  const rowPath = (waiterKey) => path.join(inboxDir, `${keySlug(waiterKey)}.json`);
  const batchPath = (batchId) => path.join(batchesDir, `${batchId}.json`);
  const listRows = () => {
    try {
      return fs
        .readdirSync(inboxDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(inboxDir, name)))
        .filter((row) => row && row.schema === SCHEMA);
    } catch {
      return [];
    }
  };
  const listBatches = () => {
    try {
      return fs
        .readdirSync(batchesDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(batchesDir, name)))
        .filter((batch) => batch && batch.schema === SCHEMA);
    } catch {
      return [];
    }
  };

  const readyPromise = (async () => {
    const recoveryLease = path.join(root, 'recovery.lock');
    let release = null;
    while (!release) {
      release = tryAcquireLease(recoveryLease, now);
      if (!release) await delay(pollMs);
    }
    let result;
    try {
      result = await recover();
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    } finally {
      release();
    }
    if (!result || !result.ok) recoveryError = errorText(result && result.error);
    // An in-flight atomic release is NOT a settled world. recoverTransaction
    // reports ok:true because declining to recover is a clean no-op, but this
    // coordinator must not advance batches, accept a live SHA, or prove
    // anything while the symlink can still be rolled back by the deploy that
    // owns it: after the swap readDeployedSha() ALREADY observes the new SHA
    // even though health and commit have not happened yet. Hold this pass as a
    // retryable barrier and let the next one re-evaluate once it settles.
    else if (String(result.action || '') === 'deploy-in-flight') {
      recoveryError = `atomic release ${result.sha || '<active>'} is still in flight (${result.reason || 'owner alive'}); holding until the transaction settles`;
    }
    return result;
  })();

  const orderLineage = async (rows) => {
    const ordered = [];
    for (const row of rows) {
      let inserted = false;
      for (let index = 0; index < ordered.length; index += 1) {
        if (
          row.requestedSha !== ordered[index].requestedSha &&
          (await isAncestor(row.requestedSha, ordered[index].requestedSha))
        ) {
          ordered.splice(index, 0, row);
          inserted = true;
          break;
        }
      }
      if (!inserted) ordered.push(row);
    }
    return ordered;
  };

  // While the ordinary delivery window is closed, a request may advance a
  // batch that does not hold it only when every request in that batch was
  // admitted under supervision (or this is the explicitly supervised standing
  // owner). An attended card never advances an unrelated unattended batch
  // (Codex deploy review 2026-09-29); its own batch stays resumable.
  const ordinaryWindowClosed = () =>
    windowState({ nowMs: now(), supervised: false }).phase === 'closed';
  // Checked immediately before a foreign batch would deploy, after any
  // rolled-back reset, so a deployed or proving batch that falls back to
  // awaiting-deploy cannot slip through on its earlier phase.
  // Supervised (attended) rows and the explicitly supervised operator owner
  // are never held; only unattended healer deploys wait for the first pass.
  // A hold reader that throws is no hold: it must never wedge the inbox.
  const currentFirstPassHold = () => {
    try {
      const state = deployHold(now());
      return state && state.inFlight === true ? state : null;
    } catch {
      return null;
    }
  };
  // Held until production settles. Released early for this run's own healer
  // once its sources finished (the run waits on those healers), and for any
  // row that has already waited firstPassHoldMaxMs.
  const heldByFirstPass = (row, hold) => {
    if (!hold || batchesUnsupervisedRows === true || !row || row.supervised === true) return false;
    const runId = String(row.controllerRunId || '');
    if (hold.sourcesFinished === true && runId && runId === String(hold.runId || '')) return false;
    const sinceMs = Date.parse(row.firstPassHold && row.firstPassHold.since);
    if (Number.isFinite(sinceMs) && now() - sinceMs >= firstPassHoldMaxMs) return false;
    return true;
  };
  const noteFirstPassHold = (row, hold) => {
    if (!row || row.firstPassHold) return;
    writeJsonAtomic(rowPath(row.waiterKey), {
      ...row,
      firstPassHold: {
        since: new Date(now()).toISOString(),
        runId: hold.runId || '',
        date: hold.date || '',
        reason: hold.reason || '',
      },
    });
    log(
      `[healer-deploy-coordinator] holding unattended deploy ${row.requestedSha} for ${row.cardId || row.waiterKey} until the night's production settles (${hold.reason || 'in flight'})`,
    );
  };
  const batchAuthorized = (batch) =>
    !ordinaryWindowClosed() ||
    batchesUnsupervisedRows === true ||
    (Array.isArray(batch && batch.requests) &&
      batch.requests.length > 0 &&
      batch.requests.every((row) => row && row.supervised === true));

  const formBatch = async () => {
    const release = tryAcquireLease(coordinatorLease, now);
    if (!release) return null;
    try {
      const active = listBatches().find((batch) =>
        ['awaiting-deploy', 'deployed', 'proving'].includes(batch.phase),
      );
      if (active) return active;
      // Outside the ordinary delivery window only rows admitted under
      // supervision may be batched, so one attended card cannot carry an
      // unrelated unattended candidate into a daytime deploy.
      // The drain still finishes work admitted before 05:00.
      const windowClosed = ordinaryWindowClosed();
      const hold = currentFirstPassHold();
      const pending = listRows()
        .filter((row) => row.phase === 'admitted' && !row.batchId)
        .filter(
          (row) => !windowClosed || row.supervised === true || batchesUnsupervisedRows === true,
        )
        .filter((row) => {
          if (!heldByFirstPass(row, hold)) return true;
          noteFirstPassHold(row, hold);
          return false;
        })
        .sort((left, right) => Number(left.admittedMs) - Number(right.admittedMs));
      const first = pending.shift();
      if (!first) return null;
      const compatible = [first];
      let target = first;
      for (const candidate of pending) {
        let matches = false;
        try {
          if (await isAncestor(target.requestedSha, candidate.requestedSha)) {
            target = candidate;
            matches = true;
          } else if (await isAncestor(candidate.requestedSha, target.requestedSha)) {
            matches = true;
          }
        } catch {
          matches = false;
        }
        if (matches) compatible.push(candidate);
      }
      const ordered = await orderLineage(compatible);
      target = ordered[ordered.length - 1];
      const batchId = `shared-healer-deploy-${now().toString(36)}-${crypto
        .randomBytes(4)
        .toString('hex')}`;
      const batch = {
        schema: SCHEMA,
        batchId,
        phase: 'awaiting-deploy',
        targetSha: target.requestedSha,
        targetWaiterKey: target.waiterKey,
        createdAt: new Date(now()).toISOString(),
        requests: ordered.map((row) => ({
          waiterKey: row.waiterKey,
          requestId: row.requestId,
          cardId: row.cardId,
          workUnitId: row.workUnitId,
          closureId: row.closureId,
          requestedSha: row.requestedSha,
          changedPaths: row.changedPaths,
          deployDescriptor: row.deployDescriptor,
          proofDescriptor: row.proofDescriptor,
          admittedAt: row.admittedAt,
          deadlineMs: row.deadlineMs,
          ownerPid: row.ownerPid,
          supervised: row.supervised === true,
          controllerRunId: String(row.controllerRunId || ''),
        })),
      };
      writeJsonAtomic(batchPath(batchId), batch);
      for (const row of ordered) {
        writeJsonAtomic(rowPath(row.waiterKey), { ...row, phase: 'batched', batchId });
      }
      return batch;
    } finally {
      release();
    }
  };

  const writeFailureSettlements = async (batch, deployResult) => {
    // Terminal evidence envelope (2026-09-02): one event per failed batch,
    // covering every card the batch was carrying, so overnight-watch-report.js
    // can see "deploy-window-guard refused N cards" as a single systemic
    // cause instead of N unrelated per-card "deploy failed" symptoms.
    // appendTerminalEvidenceEvent never throws, so a bad dataDir cannot
    // prevent the batch/request settlement writes below.
    appendTerminalEvidenceEvent({
      dataDir,
      date: dateKeyInCt(batch.createdAt || now()),
      kind: 'healer-deploy-coordinator',
      subjectId: batch.batchId,
      sourceComponent: 'healer-deploy-coordinator',
      sourceRunId: batch.batchId,
      envelope: {
        node: 'healer-deploy-coordinator',
        arc: 'deploy',
        owner: 'healer-deploy-coordinator',
        guard: deployFailureGuard(deployResult),
        expected: 'batch target SHA deployed and proven live',
        observed: deployFailureObserved(deployResult),
        receiptPaths: [batchPath(batch.batchId)],
        cardIds: batch.requests.map((request) => request.cardId).filter(Boolean),
      },
    });
    const isolation =
      deployResult.failureOwner === 'batch-member'
        ? await isolateFailedBatch(
            batch.requests,
            typeof probeFromBatch === 'function'
              ? ({ requests, targetSha }) => probeFromBatch({ requests, targetSha, batch })
              : null,
          )
        : null;
    const failed = new Set((isolation && isolation.failedRequestIds) || []);
    const interaction = new Set((isolation && isolation.interactionRequestIds) || []);
    const peers = new Set([
      ...((isolation && isolation.passedRequestIds) || []),
      ...((isolation && isolation.indeterminateRequestIds) || []),
    ]);
    for (const request of batch.requests) {
      const isolated = failed.has(request.requestId);
      const interactionMember = interaction.has(request.requestId);
      const result = {
        ok: false,
        code: isolated
          ? 'isolated-batch-member-failure'
          : interactionMember
            ? 'batch-interaction-failure'
            : peers.has(request.requestId)
              ? 'batch-peer-failure'
              : 'deploy-failed',
        batchId: batch.batchId,
        requestId: request.requestId,
        waiterKey: request.waiterKey,
        requestedSha: request.requestedSha,
        deployedSha: '',
        failureOwner: isolated || interactionMember ? 'batch-member' : deployResult.failureOwner,
        isolated,
        retryable: !isolated,
        deploy: deployResult,
        isolation,
        attemptCharge: 0,
        fingerprintRecorded: false,
      };
      const row = readJson(rowPath(request.waiterKey)) || request;
      writeJsonAtomic(rowPath(request.waiterKey), {
        ...row,
        phase: 'settled-failure',
        result: jsonSafe(result),
      });
    }
    writeJsonAtomic(batchPath(batch.batchId), {
      ...batch,
      phase: 'failed',
      failedAt: new Date(now()).toISOString(),
      deploy: jsonSafe(deployResult),
      isolation: jsonSafe(isolation),
    });
  };

  const tryDeploy = async (batch) => {
    if (!batch || batch.phase !== 'awaiting-deploy') return;
    const batchedTarget = batch.requests.find((row) => row.waiterKey === batch.targetWaiterKey);
    const target = readJson(rowPath(batch.targetWaiterKey)) || batchedTarget;
    const localTarget = localRequests.get(batch.targetWaiterKey);
    if (typeof deployFromRequest !== 'function' && !(localTarget && localTarget.deploy)) return;
    const claimPath = path.join(batchesDir, `${batch.batchId}.deploy.lock`);
    const release = tryAcquireLease(claimPath, now);
    if (!release) return;
    try {
      const current = readJson(batchPath(batch.batchId));
      if (!current || current.phase !== 'awaiting-deploy') return;
      // A batch formed just before the first pass began still waits for it.
      const hold = currentFirstPassHold();
      if (hold) {
        const held = current.requests
          .map((row) => readJson(rowPath(row.waiterKey)) || row)
          .filter((row) => heldByFirstPass(row, hold));
        if (held.length) {
          // Stamping each held row starts its own bounded wait.
          for (const row of held) noteFirstPassHold(row, hold);
          return;
        }
      }
      // Pre-deploy containment check (kept as descendant-aware on purpose,
      // Codex follow-up 2026-09-02): when a newer release already contains the
      // target commit, redeploying the exact older SHA would roll production
      // back over that newer release. The batch therefore moves to
      // deployed-pending-proof, and the closure completes only when each
      // request's scoped live proof of the requested behavior passes; a
      // descendant that reverted the fix fails that proof and never closes.
      // The post-swap recheck below is different: it must prove THIS call's
      // own swap, so it requires the exact target SHA.
      let alreadyLiveSha = '';
      try {
        const liveSha = String(await readDeployedSha())
          .trim()
          .toLowerCase();
        if (
          SHA_RE.test(liveSha) &&
          (liveSha === current.targetSha || (await isAncestor(current.targetSha, liveSha)))
        ) {
          alreadyLiveSha = liveSha;
        }
      } catch {
        alreadyLiveSha = '';
      }
      if (alreadyLiveSha) {
        const recoveredDeploy = {
          ok: true,
          deployedSha: alreadyLiveSha,
          recoveredAlreadyLive: true,
          requestedTargetSha: current.targetSha,
        };
        writeJsonAtomic(batchPath(current.batchId), {
          ...current,
          phase: 'deployed',
          deployedSha: alreadyLiveSha,
          deployedAt: new Date(now()).toISOString(),
          deploy: recoveredDeploy,
          recoveryDisposition: 'target-already-contained-in-live-release',
        });
        for (const request of current.requests) {
          const row = readJson(rowPath(request.waiterKey)) || request;
          writeJsonAtomic(rowPath(request.waiterKey), {
            ...row,
            phase: 'deployed-pending-proof',
            deployedSha: alreadyLiveSha,
          });
        }
        return;
      }
      let deployResult;
      try {
        deployResult =
          typeof deployFromRequest === 'function'
            ? await deployFromRequest(target, current)
            : await localTarget.deploy({
                batchId: current.batchId,
                targetSha: current.targetSha,
                requests: current.requests,
              });
      } catch (error) {
        deployResult = { ok: false, failureOwner: 'executor', error: errorText(error) };
      }
      const deployedSha = String((deployResult && deployResult.deployedSha) || '').toLowerCase();
      if (!deployResult || !deployResult.ok || deployedSha !== current.targetSha) {
        // 2026-09-02 batch 04:41Z: the atomic swap landed the target release,
        // but an optional post-swap stage (the Graphiti canary) failed, so
        // deployResult.ok was false even though the release was already
        // live. Re-read the live SHA before settling failure: a post-swap
        // stage failure can never block an already-live integration.
        let postSwapLiveSha = '';
        try {
          const liveSha = String(await readDeployedSha())
            .trim()
            .toLowerCase();
          // Exact target only (Codex review 2026-09-02): a descendant release
          // may revert the target's behavior, so only the exact target SHA
          // proves this failed call's own swap landed.
          if (SHA_RE.test(liveSha) && liveSha === current.targetSha) {
            postSwapLiveSha = liveSha;
          }
        } catch {
          postSwapLiveSha = '';
        }
        if (postSwapLiveSha) {
          const recoveredDeploy = {
            ...(deployResult || {}),
            ok: true,
            deployedSha: postSwapLiveSha,
            postSwapFailure: {
              exitCode: deployResult && deployResult.exitCode,
              error: errorText((deployResult && deployResult.error) || 'deploy failed'),
              stderrTail: String((deployResult && deployResult.stderr) || '').slice(-2000),
            },
          };
          writeJsonAtomic(batchPath(current.batchId), {
            ...current,
            phase: 'deployed',
            deployedSha: postSwapLiveSha,
            deployedAt: new Date(now()).toISOString(),
            deploy: jsonSafe(recoveredDeploy),
            recoveryDisposition: 'target-live-after-failed-post-swap-stage',
          });
          for (const request of current.requests) {
            const row = readJson(rowPath(request.waiterKey)) || request;
            writeJsonAtomic(rowPath(request.waiterKey), {
              ...row,
              phase: 'deployed-pending-proof',
              deployedSha: postSwapLiveSha,
            });
          }
          return;
        }
        const failure = {
          ...(deployResult || {}),
          ok: false,
          failureOwner: String((deployResult && deployResult.failureOwner) || 'executor'),
          error:
            deployResult && deployResult.ok
              ? `deploy proved ${deployedSha || 'no SHA'}, expected exact target ${current.targetSha}`
              : errorText((deployResult && deployResult.error) || 'deploy failed'),
        };
        await writeFailureSettlements(current, failure);
        return;
      }
      writeJsonAtomic(batchPath(current.batchId), {
        ...current,
        phase: 'deployed',
        deployedSha,
        deployedAt: new Date(now()).toISOString(),
        deploy: jsonSafe(deployResult),
      });
      for (const request of current.requests) {
        const row = readJson(rowPath(request.waiterKey)) || request;
        writeJsonAtomic(rowPath(request.waiterKey), {
          ...row,
          phase: 'deployed-pending-proof',
          deployedSha,
        });
      }
    } finally {
      release();
    }
  };

  const resetRolledBackBatch = async (batch) => {
    if (!batch || !['deployed', 'proving'].includes(batch.phase)) return batch;
    const liveSha = String(await readDeployedSha()).toLowerCase();
    if (liveSha === batch.deployedSha) return batch;
    let liveContainsBatch = false;
    if (SHA_RE.test(liveSha)) {
      try {
        liveContainsBatch = await isAncestor(batch.targetSha, liveSha);
      } catch {
        liveContainsBatch = false;
      }
    }
    const release = tryAcquireLease(coordinatorLease, now);
    if (!release) return { ...batch, phase: 'recovery-wait' };
    try {
      const current = readJson(batchPath(batch.batchId));
      if (!current || !['deployed', 'proving'].includes(current.phase)) return current || batch;
      if (liveContainsBatch) {
        const advanced = {
          ...current,
          phase: 'deployed',
          deployedSha: liveSha,
          recoveryDisposition: 'later-live-descendant-satisfies-proof-only-waiters',
        };
        writeJsonAtomic(batchPath(current.batchId), advanced);
        for (const request of current.requests) {
          const row = readJson(rowPath(request.waiterKey)) || request;
          if (row.phase === 'proved' && row.result && row.result.ok) continue;
          writeJsonAtomic(rowPath(request.waiterKey), {
            ...row,
            phase: 'deployed-pending-proof',
            deployedSha: liveSha,
            result: null,
          });
        }
        return advanced;
      }
      const reset = {
        ...current,
        phase: 'awaiting-deploy',
        deployedSha: '',
        deploy: null,
        recoveryDisposition: 'atomic-release-not-live-redeploy-exact-sha',
      };
      writeJsonAtomic(batchPath(current.batchId), reset);
      for (const request of current.requests) {
        const row = readJson(rowPath(request.waiterKey)) || request;
        writeJsonAtomic(rowPath(request.waiterKey), {
          ...row,
          phase: 'batched',
          deployedSha: '',
          result: null,
        });
      }
      return reset;
    } finally {
      release();
    }
  };

  const finalizeBatch = (batch) => {
    const release = tryAcquireLease(coordinatorLease, now);
    if (!release) return;
    try {
      const current = readJson(batchPath(batch.batchId));
      if (!current || !['deployed', 'proving'].includes(current.phase)) return;
      const rows = current.requests.map((request) => readJson(rowPath(request.waiterKey)));
      if (
        rows.every(
          (row) =>
            row &&
            ['proved', 'deployed-pending-proof', 'settled-failure'].includes(row.phase) &&
            row.result,
        )
      ) {
        writeJsonAtomic(batchPath(current.batchId), {
          ...current,
          phase: 'complete',
          completedAt: new Date(now()).toISOString(),
        });
      }
    } finally {
      release();
    }
  };

  const tryProof = async (request, batch) => {
    const rowFile = rowPath(request.waiterKey);
    const row = readJson(rowFile);
    if (!row || row.result || !['deployed-pending-proof', 'proving'].includes(row.phase)) return;
    const claimPath = path.join(
      batchesDir,
      `${batch.batchId}.${keySlug(request.waiterKey)}.proof.lock`,
    );
    const release = tryAcquireLease(claimPath, now);
    if (!release) return;
    try {
      const currentRow = readJson(rowFile);
      if (!currentRow || currentRow.result) return;
      writeJsonAtomic(rowFile, {
        ...currentRow,
        phase: 'proving',
        proofStartedAt: new Date(now()).toISOString(),
      });
      let satisfaction = '';
      try {
        satisfaction =
          request.requestedSha === batch.deployedSha
            ? 'exact'
            : (await isAncestor(request.requestedSha, batch.deployedSha))
              ? 'ancestor'
              : '';
      } catch {
        satisfaction = '';
      }
      let proof = null;
      let proofError = '';
      try {
        proof =
          typeof request.prove === 'function'
            ? await request.prove({
                batchId: batch.batchId,
                requestId: request.requestId,
                requestedSha: request.requestedSha,
                deployedSha: batch.deployedSha,
                satisfaction,
                deploy: batch.deploy,
              })
            : typeof proveFromRequest === 'function'
              ? await proveFromRequest(request, {
                  batchId: batch.batchId,
                  requestId: request.requestId,
                  requestedSha: request.requestedSha,
                  deployedSha: batch.deployedSha,
                  satisfaction,
                  deploy: batch.deploy,
                })
              : null;
      } catch (error) {
        proofError = errorText(error);
      }
      const complete =
        !!satisfaction && !proofError && proofReceiptComplete(proof, batch.deployedSha);
      const result = {
        ok: complete,
        code: complete ? 'deployed' : 'deployed-pending-proof',
        batchId: batch.batchId,
        requestId: request.requestId,
        waiterKey: request.waiterKey,
        requestedSha: request.requestedSha,
        deployedSha: batch.deployedSha,
        deployed: true,
        satisfaction,
        deploy: batch.deploy,
        proof,
        proofError:
          proofError ||
          (complete ? '' : 'card-controller transport proof was not run or did not exactly match'),
        repairState: complete ? '' : 'deployed_pending_proof',
        resumeStage: complete ? '' : 'proof',
        failureStage: complete ? '' : 'proof',
        retryable: !complete,
        attemptCharge: complete ? 1 : 0,
        fingerprintRecorded: false,
      };
      writeJsonAtomic(rowFile, {
        ...currentRow,
        phase: complete ? 'proved' : 'deployed-pending-proof',
        deployedSha: batch.deployedSha,
        satisfaction,
        result: jsonSafe(result),
        proofSettledAt: new Date(now()).toISOString(),
      });
      finalizeBatch(batch);
    } finally {
      release();
    }
  };

  const tryBatchProofs = async (batch) => {
    for (const batchedRequest of batch.requests) {
      const durableRequest = readJson(rowPath(batchedRequest.waiterKey)) || batchedRequest;
      const local = localRequests.get(durableRequest.waiterKey);
      if (local) {
        await tryProof(local, batch);
      } else if (!processAlive(durableRequest.ownerPid) && typeof proveFromRequest === 'function') {
        await tryProof(durableRequest, batch);
      }
    }
  };

  const advanceBatch = async (candidate, { foreign = false } = {}) => {
    let batch = await resetRolledBackBatch(candidate);
    if (batch && batch.phase === 'awaiting-deploy') {
      if (foreign && !batchAuthorized(batch)) return batch;
      await tryDeploy(batch);
    }
    batch = batch && readJson(batchPath(batch.batchId));
    if (batch && ['deployed', 'proving'].includes(batch.phase)) {
      await tryBatchProofs(batch);
      finalizeBatch(batch);
    }
    return batch;
  };

  // GAP 5 (2026-08-24): batching, deploy, and proof were only ever driven by
  // the REQUESTING process's own participate() polling loop, so a durable
  // inbox row whose submitter died (or gave up on a transient lane lock) sat
  // unwatched forever and the deploy had to be retried by hand. ownerPass is
  // the standing-owner drive: it adopts orphaned rows whose submitter PID is
  // dead, then runs the same lease-guarded batch machinery a live participant
  // would, without enqueueing any request of its own. Every step reuses the
  // existing single-writer leases, so a live requester and the owner never
  // double-deploy or double-prove.
  const ownerPass = async () => {
    await readyPromise;
    const base = { at: new Date(now()).toISOString(), ownerPid: process.pid };
    if (recoveryError) {
      return {
        ...base,
        ok: false,
        code: 'recovery-required',
        error: recoveryError,
        adopted: [],
        settled: [],
        unsettledOrphans: 0,
      };
    }
    const delivery = windowState({ nowMs: now(), supervised });
    const adopted = [];
    const orphanKeys = new Set();
    for (const row of listRows()) {
      if (row.result || processAlive(row.ownerPid)) continue;
      orphanKeys.add(row.waiterKey);
      if (row.adoptedByOwnerPid !== process.pid) {
        writeJsonAtomic(rowPath(row.waiterKey), {
          ...row,
          adoptedByOwnerPid: process.pid,
          adoptedAt: new Date(now()).toISOString(),
        });
      }
      adopted.push({
        waiterKey: row.waiterKey,
        requestId: row.requestId,
        phase: row.phase,
        deadSubmitterPid: row.ownerPid,
      });
    }
    if (delivery.phase === 'closed') {
      // Mirrors participate(): a closed delivery window stops all machinery.
      // Adoption bookkeeping is durable, so the next open-window pass resumes.
      return {
        ...base,
        ok: true,
        code: 'delivery-window-closed',
        deliveryWindow: delivery,
        adopted,
        settled: [],
        unsettledOrphans: orphanKeys.size,
      };
    }
    if (adopted.some((row) => row.phase === 'admitted')) {
      await formBatch();
    }
    for (const batch of listBatches()) {
      if (['awaiting-deploy', 'deployed', 'proving'].includes(batch.phase)) {
        await advanceBatch(batch);
      }
    }
    // Proof-only resume for orphans whose batch already completed (a retrying
    // submitter cleared the result and then died before proving).
    for (const key of orphanKeys) {
      const row = readJson(rowPath(key));
      if (!row || row.result || row.phase !== 'deployed-pending-proof' || !row.batchId) continue;
      const batch = readJson(batchPath(row.batchId));
      if (!batch || batch.phase !== 'complete') continue;
      const liveSha = String(await readDeployedSha())
        .trim()
        .toLowerCase();
      await tryProof(row, {
        ...batch,
        deployedSha: SHA_RE.test(liveSha) ? liveSha : '',
        deploy: {
          ...(batch.deploy || {}),
          proofOnlyResume: true,
          originalBatchDeployedSha: batch.deployedSha,
        },
      });
    }
    const rowsAfter = listRows();
    const settled = rowsAfter
      .filter((row) => orphanKeys.has(row.waiterKey) && row.result)
      .map((row) => ({
        waiterKey: row.waiterKey,
        requestId: row.requestId,
        phase: row.phase,
        ok: row.result.ok === true,
        code: String(row.result.code || ''),
        deployedSha: String(row.deployedSha || ''),
      }));
    const unsettledOrphans = rowsAfter.filter(
      (row) => !row.result && !processAlive(row.ownerPid),
    ).length;
    return {
      ...base,
      ok: true,
      code: 'owner-pass-complete',
      deliveryWindow: delivery,
      adopted,
      settled,
      unsettledOrphans,
    };
  };

  const participate = async (request) => {
    await readyPromise;
    if (recoveryError) {
      return {
        ok: false,
        code: 'recovery-required',
        requestedSha: request.requestedSha,
        deployedSha: '',
        error: recoveryError,
        attemptCharge: 0,
        fingerprintRecorded: false,
      };
    }
    await delay(coalesceMs);
    while (!stopped) {
      let row = readJson(rowPath(request.waiterKey));
      if (row && row.result) return row.result;
      const delivery = windowState({ nowMs: now(), supervised });
      if (delivery.phase === 'closed') {
        return {
          ok: false,
          code: row && row.deployedSha ? 'deployed-pending-proof' : 'delivery-window-closed',
          requestId: request.requestId,
          waiterKey: request.waiterKey,
          requestedSha: request.requestedSha,
          deployedSha: String((row && row.deployedSha) || ''),
          deployed: !!(row && row.deployedSha),
          repairState:
            row && row.deployedSha ? 'deployed_pending_proof' : 'repaired_pending_deploy',
          resumeStage: row && row.deployedSha ? 'proof' : 'deploy',
          deliveryWindow: delivery,
          retryable: true,
          attemptCharge: 0,
          fingerprintRecorded: false,
        };
      }
      if (Number.isFinite(request.deadlineMs) && now() >= request.deadlineMs) {
        return {
          ok: false,
          code: row && row.deployedSha ? 'deployed-pending-proof' : 'deploy-deadline-elapsed',
          requestId: request.requestId,
          waiterKey: request.waiterKey,
          requestedSha: request.requestedSha,
          deployedSha: String((row && row.deployedSha) || ''),
          deployed: !!(row && row.deployedSha),
          retryable: true,
          attemptCharge: 0,
          fingerprintRecorded: false,
        };
      }
      if (!row || !row.batchId) {
        const elected = await formBatch();
        row = readJson(rowPath(request.waiterKey));
        // Advancing a batch that does not hold this request needs that
        // batch's own supervision while the ordinary window is closed.
        if ((!row || !row.batchId) && elected) {
          await advanceBatch(elected, { foreign: true });
        }
      }
      if (row && row.batchId) {
        let batch = readJson(batchPath(row.batchId));
        if (batch && ['awaiting-deploy', 'deployed', 'proving'].includes(batch.phase)) {
          await advanceBatch(batch);
        } else if (
          batch &&
          batch.phase === 'complete' &&
          row.phase === 'deployed-pending-proof' &&
          !row.result
        ) {
          const liveSha = String(await readDeployedSha())
            .trim()
            .toLowerCase();
          await tryProof(request, {
            ...batch,
            deployedSha: SHA_RE.test(liveSha) ? liveSha : '',
            deploy: {
              ...(batch.deploy || {}),
              proofOnlyResume: true,
              originalBatchDeployedSha: batch.deployedSha,
            },
          });
        }
      }
      await delay(pollMs);
    }
    return {
      ok: false,
      code: 'executor-stopped',
      requestedSha: request.requestedSha,
      deployedSha: '',
      attemptCharge: 0,
      fingerprintRecorded: false,
    };
  };

  const request = (input = {}) => {
    const requestedSha = String(input.requestedSha || '')
      .trim()
      .toLowerCase();
    const requestId =
      String(input.requestId || '').trim() ||
      `deploy-request-${now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const waiterKey = String(input.waiterKey || requestId).trim();
    if (!SHA_RE.test(requestedSha)) {
      return Promise.resolve({
        ok: false,
        code: 'invalid-requested-sha',
        requestedSha,
        attemptCharge: 0,
        fingerprintRecorded: false,
      });
    }
    if (typeof deployFromRequest !== 'function' && typeof input.deploy !== 'function') {
      return Promise.resolve({
        ok: false,
        code: 'missing-deploy-adapter',
        requestedSha,
        attemptCharge: 0,
        fingerprintRecorded: false,
      });
    }
    const prior = readJson(rowPath(waiterKey));
    if (prior && prior.requestedSha !== requestedSha) {
      return Promise.resolve({
        ok: false,
        code: 'waiter-key-collision',
        requestedSha,
        priorRequestedSha: prior.requestedSha,
        attemptCharge: 0,
        fingerprintRecorded: false,
      });
    }
    const pendingProofRetry = !!(
      prior &&
      prior.batchId &&
      prior.result &&
      prior.result.code === 'deployed-pending-proof'
    );
    const recoveryRequest = !!(prior && prior.batchId && (!prior.result || pendingProofRetry));
    const state = windowState({ nowMs: now(), supervised });
    const mayResumeDuringDrain = recoveryRequest && state.phase === 'drain';
    if (!state.admit && !mayResumeDuringDrain) {
      return Promise.resolve({
        ok: false,
        code: state.phase === 'drain' ? 'delivery-window-draining' : 'delivery-window-closed',
        requestedSha,
        deployedSha: '',
        deliveryWindow: state,
        attemptCharge: 0,
        fingerprintRecorded: false,
      });
    }
    const request = {
      ...input,
      requestedSha,
      requestId,
      waiterKey,
      cardId: String(input.cardId || ''),
      workUnitId: String(input.workUnitId || ''),
      closureId: String(input.closureId || ''),
      deadlineMs: Number(input.deadlineMs),
      supervised: supervised === true,
      controllerRunId: String(input.controllerRunId || controllerRunId || ''),
    };
    localRequests.set(waiterKey, request);
    if (pendingProofRetry) {
      writeJsonAtomic(rowPath(waiterKey), {
        ...prior,
        requestId: request.requestId,
        cardId: request.cardId || prior.cardId,
        workUnitId: request.workUnitId || prior.workUnitId,
        closureId: request.closureId || prior.closureId,
        proofDescriptor: jsonSafe(request.proofDescriptor || prior.proofDescriptor || null),
        phase: 'deployed-pending-proof',
        result: null,
        proofRetryAt: new Date(now()).toISOString(),
        ownerPid: process.pid,
      });
    } else if (prior && prior.batchId && !prior.result) {
      writeJsonAtomic(rowPath(waiterKey), {
        ...prior,
        requestId: request.requestId,
        cardId: request.cardId || prior.cardId,
        workUnitId: request.workUnitId || prior.workUnitId,
        closureId: request.closureId || prior.closureId,
        deployDescriptor: jsonSafe(request.deployDescriptor || prior.deployDescriptor || null),
        proofDescriptor: jsonSafe(request.proofDescriptor || prior.proofDescriptor || null),
        ownerPid: process.pid,
        recoveryClaimedAt: new Date(now()).toISOString(),
      });
    } else if (!prior || (prior.result && prior.result.retryable)) {
      writeJsonAtomic(
        rowPath(waiterKey),
        serializableRequest(
          {
            ...request,
            deadlineMs: Number.isFinite(request.deadlineMs) ? request.deadlineMs : null,
          },
          now,
        ),
      );
    } else if (prior.result) {
      return Promise.resolve(prior.result);
    }
    return participate(request).catch((error) => {
      log(`[healer-deploy-coordinator] ${errorText(error)}`);
      return {
        ok: false,
        code: 'coordinator-fault',
        requestedSha,
        deployedSha: '',
        error: errorText(error),
        attemptCharge: 0,
        fingerprintRecorded: false,
      };
    });
  };

  return {
    request,
    ownerPass,
    ready: () => readyPromise,
    stop: () => {
      stopped = true;
    },
    snapshot: () => ({
      stopped,
      recoveryError,
      rows: listRows(),
      batches: listBatches(),
    }),
  };
}

module.exports = {
  SCHEMA,
  coordinatorRoot,
  keySlug,
  processAlive,
  tryAcquireLease,
  createCrossProcessHealerDeployExecutor,
};
